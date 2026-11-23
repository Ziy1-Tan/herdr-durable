#!/usr/bin/env node
// Reports Claude Code and Codex resume commands that keep the original launch flags.
// Herdr saves the command with the pane and runs it after a server restart.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nativeResumeEnabled } from './configure.js';

const SOURCE = 'plugin:herdr-durable';
const HERDR_TIMEOUT_MS = 5_000;
const DETECT_WAIT_MS = 20_000;
const POLL_MS = 500;
const MAX_RESUME_ARGS = 64;
const MAX_RESUME_BYTES = 8192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTERPRETERS = new Set(['node', 'bun', 'deno', 'sh', 'bash', 'zsh', 'dash', 'env', 'python', 'python3']);

// Every launch option is kept unless listed in drop. drop holds only options that select a
// different session or do one-time work on start (new worktree, attachments, cloud sessions).
// value/optional/variadic say how an option consumes the tokens after it, so values are never
// mistaken for positionals. Positionals (prompts, session ids, subcommands) are always removed.
// A blocker means the process is not an interactive session that can be resumed.
const AGENTS = {
  claude: {
    value: [
      '--agent', '--agents', '--append-system-prompt', '--append-system-prompt-file', '--autocompact',
      '--debug-file', '--effort', '--environment', '--fallback-model', '--input-format', '--json-schema',
      '--max-budget-usd', '--model', '-n', '--name', '--output-format', '--permission-mode',
      '--permission-prompts', '--plugin-dir', '--plugin-url', '--remote-control-session-name-prefix',
      '--session-id', '--setting-sources', '--settings', '--system-prompt', '--system-prompt-file',
      '--system-prompt-snapshot',
    ],
    optional: [
      '-d', '--debug', '-r', '--resume', '--cloud', '--from-pr', '--remote-control', '--teleport',
      '-w', '--worktree', '--prompt-suggestions',
    ],
    variadic: [
      '--add-dir', '--allowedTools', '--allowed-tools', '--betas', '--disallowedTools',
      '--disallowed-tools', '--file', '--mcp-config', '--tools',
    ],
    drop: [
      '-c', '--continue', '-r', '--resume', '--session-id', '--fork-session', '--from-pr', '--teleport',
      '--cloud', '--environment', '-w', '--worktree', '--tmux', '--file',
    ],
    blockers: ['-p', '--print', '--bg', '--background', '--desktop', '-h', '--help', '-v', '--version'],
    resume: (flags, id) => ['claude', ...flags, '--resume', id],
    // Herdr keeps the pane's Claude session id across a fresh start, so reuse that id.
    restart: (flags, id) => ['claude', ...flags, '--session-id', id],
    launchSession: args => optionValue(args, ['--resume', '-r', '--session-id']),
    sessionExists: claudeSessionExists,
  },
  codex: {
    value: [
      '-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env', '-m', '--model',
      '--local-provider', '-p', '--profile', '-s', '--sandbox', '-C', '--cd', '--add-dir',
      '-a', '--ask-for-approval',
    ],
    optional: [],
    variadic: ['-i', '--image'],
    drop: ['-i', '--image', '--worktree', '--last', '--all', '--include-non-interactive'],
    blockers: ['-h', '--help', '-V', '--version'],
    // Without a subcommand the first positional is a prompt; resume and fork open sessions too.
    interactive: first => first === undefined || first === 'resume' || first === 'fork' || !CODEX_SUBCOMMANDS.has(first),
    resume: (flags, id) => ['codex', ...flags, 'resume', id],
    // Codex reports its new session on startup, and Herdr accepts the replacement.
    restart: flags => ['codex', ...flags],
    // "codex resume <id>" names its session; codex only reports it to Herdr on the first turn.
    launchSession: (args, positionals) => (positionals[0] === 'resume' && UUID.test(positionals[1] || '') ? positionals[1] : null),
    sessionExists: codexSessionExists,
  },
};

const CODEX_SUBCOMMANDS = new Set([
  'agents', 'exec', 'e', 'review', 'login', 'logout', 'mcp', 'plugin', 'app-server', 'remote-control', 'app',
  'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'queue', 'archive', 'delete',
  'migrate-rollouts', 'migrate-nfs-db', 'unarchive', 'cloud', 'exec-server', 'features', 'help',
]);

for (const spec of Object.values(AGENTS)) {
  spec.arity = new Map([
    ...spec.value.map(option => [option, 'value']),
    ...spec.optional.map(option => [option, 'optional']),
    ...spec.variadic.map(option => [option, 'variadic']),
  ]);
  spec.drop = new Set(spec.drop);
  spec.blockers = new Set(spec.blockers);
}

function isOption(token) {
  return token.length > 1 && token.startsWith('-');
}

// Splits launch arguments the way the agent CLI parses them.
function parseLaunchArgs(agent, args) {
  const spec = AGENTS[agent];
  const flags = [];
  const positionals = [];
  let blocked = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--') {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (!isOption(token)) {
      positionals.push(token);
      continue;
    }
    const equals = token.startsWith('--') ? token.indexOf('=') : -1;
    const name = equals > 0 ? token.slice(0, equals) : token;
    const option = [token];
    if (equals < 0) {
      const arity = spec.arity.get(name);
      const next = args[index + 1];
      if (arity === 'value' && next !== undefined) {
        option.push(args[++index]);
      } else if (arity === 'optional' && next !== undefined && !isOption(next)) {
        option.push(args[++index]);
      } else if (arity === 'variadic') {
        while (index + 1 < args.length && !isOption(args[index + 1])) option.push(args[++index]);
      }
    }
    if (spec.blockers.has(name)) blocked = true;
    if (!spec.drop.has(name)) flags.push(...option);
  }
  return { flags, positionals, blocked };
}

function commandName(value) {
  return path.basename(String(value || '')).toLowerCase().replace(/\.(exe|cmd|bat|js|mjs|cjs)$/, '');
}

// Index of the agent executable in argv, allowing wrappers such as "node /path/claude".
function agentArgIndex(argv, agent) {
  if (!Array.isArray(argv)) return -1;
  for (let index = 0; index < argv.length && index < 4; index += 1) {
    const name = commandName(argv[index]);
    if (name === agent) return index;
    const wrapperOption = index > 0 && argv[index].startsWith('-');
    if (!INTERPRETERS.has(name) && !wrapperOption) return -1;
  }
  return -1;
}

function agentProcess(info, agent) {
  const processes = Array.isArray(info?.foreground_processes) ? info.foreground_processes : [];
  const matches = processes.filter(process => agentArgIndex(process.argv, agent) >= 0);
  return matches.find(process => process.pid === info.foreground_process_group_id) || matches[0] || null;
}

// Launch flags worth keeping and the session the process was started on, or null when the
// process is not an interactive session.
function launchInfo(agent, argv) {
  const start = agentArgIndex(argv, agent);
  if (start < 0) return null;
  const args = argv.slice(start + 1);
  const { flags, positionals, blocked } = parseLaunchArgs(agent, args);
  if (blocked) return null;
  const interactive = AGENTS[agent].interactive;
  if (interactive && !interactive(positionals[0])) return null;
  return { flags, session: AGENTS[agent].launchSession(args, positionals) };
}

function launchFlags(agent, argv) {
  return launchInfo(agent, argv)?.flags ?? null;
}

// Value of the last --name/--name=value occurrence among args.
function optionValue(args, names) {
  let value = null;
  args.forEach((arg, index) => {
    for (const name of names) {
      if (arg === name && index + 1 < args.length && !isOption(args[index + 1])) value = args[index + 1];
      else if (arg.startsWith(name + '=')) value = arg.slice(name.length + 1);
    }
  });
  return value;
}

// Mirrors Herdr's resume_argv checks so a bad command is skipped instead of rejected.
function resumeArgvProblem(argv) {
  if (argv.length > MAX_RESUME_ARGS) return 'more than ' + MAX_RESUME_ARGS + ' arguments';
  if (argv.reduce((total, arg) => total + Buffer.byteLength(arg), 0) > MAX_RESUME_BYTES) return 'longer than 8 KiB';
  if (argv.some(arg => arg.includes("'"))) return 'an argument contains an apostrophe';
  if (argv.some(arg => /\p{Cc}/u.test(arg))) return 'an argument contains a control character';
  return null;
}

// A new session has no file until its first prompt and cannot be resumed yet,
// so until then the agent starts a new session with the same flags.
function resumeArgv(agent, flags, sessionId) {
  const spec = AGENTS[agent];
  return spec.sessionExists(sessionId) === false ? spec.restart(flags, sessionId) : spec.resume(flags, sessionId);
}

function claudeSessionExists(id) {
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  let projects;
  try {
    projects = fs.readdirSync(root);
  } catch {
    return null;
  }
  return projects.some(project => fs.existsSync(path.join(root, project, id + '.jsonl')));
}

function codexSessionExists(id) {
  const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  let files;
  try {
    files = fs.readdirSync(root, { recursive: true });
  } catch {
    return null;
  }
  return files.some(file => String(file).endsWith('-' + id + '.jsonl'));
}

function herdr(args) {
  const result = spawnSync(process.env.HERDR_BIN_PATH || 'herdr', args, {
    encoding: 'utf8',
    timeout: HERDR_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  let response = null;
  try {
    response = JSON.parse(result.stdout);
  } catch {}
  if (result.status !== 0 || response?.error) {
    const detail = response?.error?.message || result.stderr || result.stdout || result.error?.message || 'failed';
    throw new Error('herdr ' + args.slice(0, 2).join(' ') + ': ' + String(detail).trim());
  }
  return response?.result ?? null;
}

// Herdr ignores reports whose seq is not above the last one from this source,
// across processes and restarts, so use wall-clock nanoseconds like Herdr's own hooks.
function reportSeq() {
  return String(BigInt(Date.now()) * 1_000_000n + process.hrtime.bigint() % 1_000_000n);
}

// One attempt for one pane. retry marks states that settle on their own shortly.
function syncPane(paneId) {
  const pane = herdr(['pane', 'get', paneId])?.pane;
  const agent = pane?.agent;
  if (!Object.hasOwn(AGENTS, agent)) return { pane_id: paneId, skipped: 'unsupported_agent' };
  const info = herdr(['pane', 'process-info', '--pane', paneId])?.process_info;
  const process = agentProcess(info, agent);
  if (!process) return { pane_id: paneId, agent, skipped: 'no_process', retry: true };
  const launch = launchInfo(agent, process.argv);
  if (!launch) return { pane_id: paneId, agent, skipped: 'not_interactive' };
  // Herdr's session is current after /clear or a resume picker; the launch argv covers the
  // time before the agent's first report.
  const reported = pane.agent_session;
  const session = reported?.source === 'herdr:' + agent && reported.agent === agent && reported.kind === 'id' && reported.value
    ? reported.value
    : launch.session;
  if (!session) return { pane_id: paneId, agent, skipped: 'no_session', retry: true };
  const argv = resumeArgv(agent, launch.flags, session);
  const problem = resumeArgvProblem(argv);
  if (problem) return { pane_id: paneId, agent, skipped: 'invalid_argv', error: problem };
  herdr(['pane', 'report-agent-session', paneId, '--source', SOURCE, '--agent', agent, '--seq', reportSeq(), '--', ...argv]);
  return { pane_id: paneId, agent, reported: argv };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function syncPaneUntilSettled(paneId, waitMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    let outcome;
    try {
      outcome = syncPane(paneId);
    } catch (error) {
      outcome = { pane_id: paneId, error: error.message, retry: true };
    }
    if (!outcome.retry || Date.now() >= deadline) {
      delete outcome.retry;
      return outcome;
    }
    sleep(POLL_MS);
  }
}

function parseEvent(raw) {
  let event;
  try {
    event = JSON.parse(raw || '');
  } catch {
    return null;
  }
  const name = String(event?.event || '').replaceAll('.', '_');
  const data = event?.data;
  const paneId = data?.pane_id;
  if (typeof paneId !== 'string') return null;
  if (name !== 'pane_agent_detected' && name !== 'pane_agent_status_changed') return null;
  // Skip other agents and releases without starting any herdr calls.
  if (data.released || (data.agent != null && !Object.hasOwn(AGENTS, data.agent))) return null;
  return { paneId, detected: name === 'pane_agent_detected' };
}

function syncAll() {
  const panes = herdr(['pane', 'list'])?.panes || [];
  return panes
    .filter(pane => Object.hasOwn(AGENTS, pane.agent))
    .map(pane => {
      try {
        const outcome = syncPane(pane.pane_id);
        delete outcome.retry;
        return outcome;
      } catch (error) {
        return { pane_id: pane.pane_id, error: error.message };
      }
    });
}

function main(mode) {
  if (!nativeResumeEnabled()) {
    console.error('herdr-durable: session.resume_agents_on_restore is false, so Herdr will not run resume commands');
    return null;
  }
  if (mode === 'event') {
    const event = parseEvent(process.env.HERDR_PLUGIN_EVENT_JSON);
    if (!event) return null;
    // The session id arrives shortly after detection; status changes need one look.
    return syncPaneUntilSettled(event.paneId, event.detected ? DETECT_WAIT_MS : 0);
  }
  if (mode === 'sync') return syncAll();
  throw new Error('usage: node plugin.js event|sync');
}

let invokedAsScript = false;
try {
  invokedAsScript = process.argv[1] !== undefined
    && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
} catch {}

if (invokedAsScript) {
  try {
    const result = main(process.argv[2]);
    if (result) console.log(JSON.stringify(result));
  } catch (error) {
    console.error('herdr-durable: ' + error.message);
    process.exitCode = 1;
  }
}

export {
  SOURCE,
  agentProcess,
  launchFlags,
  launchInfo,
  parseEvent,
  parseLaunchArgs,
  resumeArgv,
  resumeArgvProblem,
  syncAll,
  syncPane,
  syncPaneUntilSettled,
};
