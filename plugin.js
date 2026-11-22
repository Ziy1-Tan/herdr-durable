#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const API_TIMEOUT_MS = 10_000;
const API_COMMAND_TIMEOUT_MS = 1_000;
const API_SLEEP_INTERVAL_MS = 100;
const RESUME_ARGUMENTS = {
  codex: 'resume',
  claude: '--resume',
  pi: '--session',
};
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'node', 'bun', 'deno', 'python', 'python3', 'env']);
const SUPPORTED_AGENTS = new Set(Object.keys(RESUME_ARGUMENTS));
const SESSION_DIRECTORIES = {
  claude: path.join(os.homedir(), '.claude', 'projects'),
  codex: path.join(os.homedir(), '.codex', 'sessions'),
  pi: path.join(os.homedir(), '.pi', 'agent', 'sessions'),
};
const SESSION_DIRECTORY_ENV = {
  claude: 'HERDR_DURABLE_CLAUDE_SESSIONS',
  codex: 'HERDR_DURABLE_CODEX_SESSIONS',
  pi: 'HERDR_DURABLE_PI_SESSIONS',
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

function runPaneCommand(paneId, command) {
  const result = runHerdr(['pane', 'run', paneId, command], { timeout: 30_000 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'pane run failed');
  return true;
}

function stateRoot() {
  const root = process.env.HERDR_PLUGIN_STATE_DIR;
  if (!root) throw new Error('HERDR_PLUGIN_STATE_DIR is not set; run through Herdr');
  return path.join(root, 'panes');
}

function stateFile(paneId) {
  return path.join(stateRoot(), `${encodeURIComponent(paneId)}.json`);
}

function readRecord(paneId) {
  try {
    const raw = fs.readFileSync(stateFile(paneId), 'utf8');
    const value = raw.trim() ? JSON.parse(raw) : null;
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`herdr-durable: ignoring state for ${paneId}: ${error.message}`);
    }
  }
  return null;
}

function writeRecord(paneId, record) {
  const file = stateFile(paneId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function deleteRecord(paneId) {
  fs.rmSync(stateFile(paneId), { force: true });
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

function sessionExists(agent, session) {
  if (!validSession(session)) return false;
  const directory = process.env[SESSION_DIRECTORY_ENV[agent]] || SESSION_DIRECTORIES[agent];
  if (!directory) return false;
  if (agent === 'pi') {
    const root = path.resolve(directory);
    const file = path.resolve(root, session.endsWith('.jsonl') ? session : `${session}.jsonl`);
    return file.startsWith(`${root}${path.sep}`) && fs.existsSync(file);
  }
  try {
    return fs.readdirSync(directory, { recursive: true }).some(file => (
      agent === 'codex'
        ? path.basename(file).endsWith(`-${session}.jsonl`)
        : path.basename(file) === `${session}.jsonl`
    ));
  } catch {
    return false;
  }
}

function launchArgv(agent, argv, session) {
  const resumeCommand = RESUME_ARGUMENTS[agent];
  let offset = 1;
  while (offset < argv.length && INTERPRETERS.has(path.basename(argv[offset - 1]))) {
    offset += 1;
  }
  const flags = argv.slice(offset).filter((argument, index, values) => {
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
  const agent = normalizeAgent(agentOverride || pane.agent || pane.agent_session?.agent);
  if (!agent || !pane.agent_session) return false;
  if (pane.agent_session.agent !== agent) return false;

  const session = pane.agent_session.value;
  if (!validSession(session)) return false;
  if (!sessionExists(agent, session)) return false;

  const info = processInfo(paneId);
  const process = firstAgentProcess(info, agent);
  const argv = process
    ? (readProcArgv(process.pid) || (Array.isArray(process.argv) ? process.argv : null))
    : null;
  if (!argv || argv.length === 0) return false;

  writeRecord(paneId, {
    agent,
    session,
    argv,
  });
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
  const response = herdrJson(['pane', 'list']);
  const panes = response?.result?.panes || [];
  const actions = [];
  let restored = 0;

  for (const pane of panes) {
    const record = readRecord(pane.pane_id);
    if (!record) continue;
    const action = { pane_id: pane.pane_id, agent: record.agent, session: record.session };
    if (!shouldRestore(record, pane)) {
      action.skipped = 'stale_record';
      action.pane_agent = pane.agent_session?.agent || null;
      action.pane_session = pane.agent_session?.value || null;
      actions.push(action);
      continue;
    }
    if (!sessionExists(record.agent, record.session)) {
      action.skipped = 'missing_session';
      actions.push(action);
      continue;
    }
    try {
      const info = processInfo(pane.pane_id);
      if (firstAgentProcess(info, record.agent)) {
        action.skipped = 'agent_running';
        actions.push(action);
        continue;
      }
      const command = shellCommand(launchArgv(record.agent, record.argv, record.session));
      action.command = command;
      if (dryRun) {
        actions.push(action);
        continue;
      }
      runPaneCommand(pane.pane_id, command);
      deleteRecord(pane.pane_id);
      restored += 1;
      actions.push(action);
    } catch (error) {
      action.error = error.message;
      actions.push(action);
    }
  }

  return { restored, actions };
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
    fs.mkdirSync(stateRoot(), { recursive: true });
    console.log(JSON.stringify({ panes: fs.readdirSync(stateRoot()).filter(file => file.endsWith('.json')).length }));
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
  readRecord,
  restorePanes,
  shellCommand,
  readProcArgv,
  shellQuote,
  shouldRestore,
  sessionExists,
  validSession,
};
