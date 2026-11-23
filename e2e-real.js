#!/usr/bin/env node
// Restarts real Claude Code / Codex sessions through Herdr and checks that they come back
// with their launch flags. It resumes existing sessions without sending prompts, so no
// model calls are made. Herdr runs in an isolated HOME; agent panes get the real HOME so
// their trusted Herdr integration hooks report sessions as usual.
//
//   node e2e-real.js claude <session-id> codex <session-id>
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cleanEnv, linkPlugin, makeHome, startServer, waitFor } from './e2e-harness.js';

const FLAGS = {
  claude: ['--dangerously-skip-permissions'],
  // Hook trust is per invocation here so the test never writes the user's Codex trust state.
  codex: ['--no-daemon', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust'],
};
const claudeConfig = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');

const cases = [];
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  const [agent, session] = [args[index], args[index + 1]];
  if (!FLAGS[agent] || !session) throw new Error('usage: node e2e-real.js claude <session-id> codex <session-id>');
  cases.push({ agent, session, cwd: sessionCwd(agent, session) });
}
if (cases.length === 0) throw new Error('usage: node e2e-real.js claude <session-id> codex <session-id>');

function sessionFile(agent, session) {
  const root = agent === 'claude' ? join(claudeConfig, 'projects') : join(codexHome, 'sessions');
  const suffix = agent === 'claude' ? '/' + session + '.jsonl' : '-' + session + '.jsonl';
  const match = readdirSync(root, { recursive: true }).map(String).find(file => ('/' + file).endsWith(suffix));
  if (!match) throw new Error(agent + ' session ' + session + ' not found under ' + root);
  return join(root, match);
}

function sessionCwd(agent, session) {
  for (const line of readFileSync(sessionFile(agent, session), 'utf8').split('\n')) {
    try {
      const entry = JSON.parse(line);
      const cwd = entry.cwd || entry.payload?.cwd;
      if (cwd) return cwd;
    } catch {}
  }
  throw new Error('no cwd recorded in ' + agent + ' session ' + session);
}

function expectedArgv(item) {
  return item.agent === 'claude'
    ? ['claude', ...FLAGS.claude, '--resume', item.session]
    : ['codex', ...FLAGS.codex, 'resume', item.session];
}

const started = Date.now();
const { root, home } = makeHome('real');
const env = cleanEnv(home, { CLAUDE_CONFIG_DIR: claudeConfig, CODEX_HOME: codexHome });
writeFileSync(join(home, '.profile'), 'PATH=' + JSON.stringify(process.env.PATH) + '; export PATH\n');
linkPlugin(env);
const sessionName = 'durable-real';

let server;
try {
  server = startServer({ session: sessionName, env, cwd: root });
  for (const item of cases) {
    const pane = server.run([
      'workspace', 'create', '--cwd', item.cwd, '--label', item.agent, '--env', 'HOME=' + homedir(),
    ]).result.root_pane;
    item.paneId = pane.pane_id;
    server.run(['pane', 'run', item.paneId, expectedArgv(item).join(' ')]);
  }

  const logs = () => server.run(['plugin', 'log', 'list', '--plugin', 'herdr-durable']).result.logs;
  for (const item of cases) {
    waitFor(() => logs().some(log => (log.stdout || '').includes(JSON.stringify(expectedArgv(item)))),
      'plugin to report ' + expectedArgv(item).join(' '), 30_000);
  }

  for (const item of cases) {
    const info = server.run(['pane', 'process-info', '--pane', item.paneId]).result.process_info;
    item.pid = (info.foreground_processes || []).find(candidate => candidate.argv?.includes(item.session))?.pid;
    assert.ok(item.pid, item.agent + ' is not running before the restart');
  }

  await server.stop();
  server = startServer({ session: sessionName, env, cwd: root });
  const results = [];
  for (const item of cases) {
    // Panes keep their ids across a restart but may answer pane_not_found while restoring.
    const restored = waitFor(() => {
      try {
        const info = server.run(['pane', 'process-info', '--pane', item.paneId]).result.process_info;
        return (info.foreground_processes || [])
          .find(candidate => candidate.pid !== item.pid && candidate.argv?.includes(item.session));
      } catch {
        return null;
      }
    }, item.agent + ' to come back after restart', 90_000);
    const argv = restored.argv;
    for (const flag of FLAGS[item.agent]) assert.ok(argv.includes(flag), item.agent + ' lost ' + flag + ': ' + argv.join(' '));
    // A restored agent that stopped at a prompt still has the right argv; check it is idle.
    const settled = waitFor(() => {
      const pane = server.run(['pane', 'get', item.paneId]).result.pane;
      return pane.agent_status === 'idle' && pane.agent === item.agent ? pane : null;
    }, item.agent + ' to report idle after restore', 60_000);
    const screen = spawnSync(process.env.HERDR_BIN_PATH || 'herdr', ['--session', sessionName, 'pane', 'read', item.paneId, '--lines', '12'], {
      env,
      encoding: 'utf8',
    }).stdout;
    assert.doesNotMatch(screen, /Hooks need review|No conversation found|Do you trust/, item.agent + ' stopped after restore:\n' + screen);
    results.push({ agent: item.agent, pane_id: item.paneId, pid_before: item.pid, pid_after: restored.pid, status: settled.agent_status, argv });
  }
  await server.stop();
  console.log(JSON.stringify({ results, ms: Date.now() - started }, null, 2));
} catch (error) {
  if (server) console.error(server.output());
  throw error;
} finally {
  try {
    await server?.stop();
  } catch {}
  if (!process.env.HERDR_DURABLE_DEBUG) rmSync(root, { recursive: true, force: true });
}
