#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SUPPORTED_AGENTS = new Set(['claude', 'codex', 'pi']);
const API_TIMEOUT_MS = 10_000;
const API_COMMAND_TIMEOUT_MS = 1_000;
const API_SLEEP_INTERVAL_MS = 100;
const RESUME_ARGUMENTS = {
  codex: 'resume',
  claude: '--resume',
  pi: '--session',
};

function herdr() {
  return process.env.HERDR_BIN_PATH || 'herdr';
}

function runHerdr(args, options = {}) {
  return spawnSync(herdr(), args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: API_COMMAND_TIMEOUT_MS,
    ...options,
  });
}

function herdrJson(args) {
  const deadline = Date.now() + API_TIMEOUT_MS;
  let result;
  for (;;) {
    result = runHerdr(args);
    if (result.status === 0 && result.stdout.trim()) break;
    if (Date.now() >= deadline) {
      throw new Error(`${herdr()} ${args.join(' ')} failed: ${result.stderr || result.stdout || 'empty response'}`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, API_SLEEP_INTERVAL_MS);
  }
  const response = JSON.parse(result.stdout);
  if (!response?.result) throw new Error(`${herdr()} ${args.join(' ')} failed: no result`);
  return response;
}

function runPaneCommand(paneId, command, agent) {
  const result = runHerdr(['pane', 'run', paneId, command], { timeout: 30_000 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'pane run failed');
  return true;
}

function stateFile() {
  const root = process.env.HERDR_PLUGIN_STATE_DIR;
  if (!root) throw new Error('HERDR_PLUGIN_STATE_DIR is not set; run through Herdr');
  return path.join(root, 'state.json');
}

function readState() {
  try {
    const raw = fs.readFileSync(stateFile(), 'utf8');
    const value = raw.trim() ? JSON.parse(raw) : null;
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`herdr-durable: ignoring unreadable state: ${error.message}`);
    }
  }
  return { version: 1, panes: {} };
}

function writeState(state) {
  const file = stateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function parseEvent(raw) {
  if (!raw) return null;
  const event = JSON.parse(raw);
  const name = event?.event?.replaceAll('.', '_');
  const data = event?.data;
  if ((name !== 'pane_agent_detected' && name !== 'pane_agent_status_changed')
      || typeof data?.pane_id !== 'string') return null;
  return { name, paneId: data.pane_id, agent: data.agent };
}

function normalizeAgent(value) {
  const agent = typeof value === 'string' ? value.toLowerCase() : '';
  return SUPPORTED_AGENTS.has(agent) ? agent : null;
}

function shellQuote(value) {
  if (value === '') return "''";
  if (!/[^A-Za-z0-9_\-./:@%+=]/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shellCommand(argv) {
  return argv.map(shellQuote).join(' ');
}

function validSession(value) {
  return typeof value === 'string' && value.length <= 1024 && !value.includes('\0');
}

function launchArgv(agent, argv, session) {
  const resumeCommand = RESUME_ARGUMENTS[agent];
  const flags = argv.slice(1).filter((argument, index, values) => {
    if (argument === resumeCommand) return false;
    return values[index - 1] !== resumeCommand;
  });
  return [agent, ...flags, resumeCommand, session];
}

function readPane(paneId) {
  const response = herdrJson(['pane', 'get', paneId]);
  const pane = response?.result?.pane;
  if (!pane) throw new Error(`pane get returned no pane: ${JSON.stringify(response)}`);
  return pane;
}

function processInfo(paneId) {
  const response = herdrJson(['pane', 'process-info', '--pane', paneId]);
  const info = response?.result?.process_info;
  if (!info) throw new Error(`process-info returned no process_info: ${JSON.stringify(response)}`);
  return info;
}

function firstAgentProcess(info, agent) {
  return (info.foreground_processes || []).find(process => {
    if (process.name !== agent || typeof process.pid !== 'number') return false;
    return true;
  });
}

function readProcArgv(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`);
    const argv = raw.toString('utf8').split('\0').filter(value => value !== '');
    return argv.length > 0 ? argv : null;
  } catch {
    return null;
  }
}

function capturePane(paneId, agentOverride) {
  const pane = readPane(paneId);
  const agent = normalizeAgent(agentOverride || pane.agent);
  if (!agent || !pane.agent_session) return false;

  const session = pane.agent_session.value;
  if (!validSession(session)) return false;

  const info = processInfo(paneId);
  const process = firstAgentProcess(info, agent);
  const argv = process
    ? (readProcArgv(process.pid) || (Array.isArray(process.argv) ? process.argv : null))
    : null;
  if (!argv || argv.length === 0) return false;

  const state = readState();
  state.panes[paneId] = {
    agent,
    session,
    session_kind: pane.agent_session.kind,
    cwd: pane.cwd,
    argv,
    saved_at: new Date().toISOString(),
  };
  writeState(state);
  return true;
}

function captureFromEvent(rawEvent) {
  const event = parseEvent(rawEvent);
  if (!event) return { captured: false, reason: 'ignored_event' };
  const captured = capturePane(event.paneId, event.agent);
  return { captured, pane_id: event.paneId, agent: event.agent || null };
}

function shouldRestore(record, pane) {
  if (!record || !record.argv || !record.session) return false;
  const session = pane.agent_session;
  if (!session) return false;
  return session.agent === record.agent && session.value === record.session;
}

function restorePanes({ dryRun = false } = {}) {
  const state = readState();
  const response = herdrJson(['pane', 'list']);
  const panes = response?.result?.panes || [];
  const actions = [];

  for (const pane of panes) {
    const record = state.panes[pane.pane_id];
    if (!shouldRestore(record, pane)) continue;
    const info = processInfo(pane.pane_id);
    if (firstAgentProcess(info, record.agent)) continue;
    const argv = launchArgv(record.agent, record.argv, record.session);
    const command = shellCommand(argv);
    const action = { pane_id: pane.pane_id, agent: record.agent, session: record.session, command };
    if (!dryRun) {
      try {
        runPaneCommand(pane.pane_id, command, record.agent);
        delete state.panes[pane.pane_id];
        writeState(state);
      } catch (error) {
        action.error = error.message;
      }
    }
    actions.push(action);
  }

  return { restored: actions.length, actions };
}

function main() {
  const mode = process.argv[2] || 'restore';
  if (mode === 'capture') {
    const result = captureFromEvent(process.env.HERDR_PLUGIN_EVENT_JSON);
    console.log(JSON.stringify(result));
    return;
  }
  if (mode === 'restore') {
    console.log(JSON.stringify(restorePanes()));
    return;
  }
  if (mode === 'dry-run') {
    console.log(JSON.stringify(restorePanes({ dryRun: true })));
    return;
  }
  if (mode === 'status') {
    const state = readState();
    console.log(JSON.stringify({ panes: Object.keys(state.panes).length }));
    return;
  }
  throw new Error(`unknown mode: ${mode}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`herdr-durable: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  SUPPORTED_AGENTS,
  captureFromEvent,
  launchArgv,
  normalizeAgent,
  parseEvent,
  readState,
  restorePanes,
  shellCommand,
  readProcArgv,
  shellQuote,
  shouldRestore,
  validSession,
};
