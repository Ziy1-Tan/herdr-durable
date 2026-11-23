#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERDR = process.env.HERDR_BIN_PATH || 'herdr';
const ROOT = dirname(fileURLToPath(import.meta.url));

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function waitFor(predicate, description, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('timeout waiting for ' + description);
    sleep(100);
  }
}

function makeHome(prefix) {
  const root = mkdtempSync(join('/tmp', 'hd-' + prefix + '-'));
  const home = join(root, 'home');
  mkdirSync(join(home, '.config', 'herdr'), { recursive: true });
  writeFileSync(join(home, '.zshrc'), '');
  writeFileSync(join(home, '.bashrc'), '');
  writeFileSync(join(home, '.config', 'herdr', 'config.toml'), 'onboarding = false\n');
  return { root, home };
}

function cleanEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home, SHELL: '/bin/sh', ...extra };
  for (const key of Object.keys(env)) {
    if (key.startsWith('HERDR_') || key.startsWith('CODEX_') || key.startsWith('CLAUDE')) delete env[key];
  }
  return { ...env, ...extra };
}

function linkPlugin(env) {
  const result = spawnSync(HERDR, ['plugin', 'link', ROOT], { env, encoding: 'utf8', timeout: 15_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('herdr plugin link failed: ' + (result.stderr || result.stdout));
}

function herdr(session, env, args) {
  const result = spawnSync(HERDR, ['--session', session, ...args], {
    encoding: 'utf8',
    env,
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('herdr ' + args.join(' ') + ' failed: ' + (result.stderr || result.stdout));
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function startServer(session, env, cwd) {
  const child = spawn(HERDR, ['--session', session, 'server'], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const run = args => herdr(session, env, args);
  waitFor(() => {
    try {
      run(['pane', 'list']);
      return true;
    } catch {
      return false;
    }
  }, 'Herdr API ready');
  return {
    run,
    output: () => output,
    async stop() {
      try {
        spawnSync(HERDR, ['session', 'stop', session], { env, encoding: 'utf8', timeout: 10_000 });
      } catch {}
      try {
        child.kill('SIGTERM');
      } catch {}
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('timeout waiting for Herdr server exit')), 10_000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
  };
}

async function restart({ session, env, cwd, root, before, after, diagnose }) {
  let server;
  const started = Date.now();
  try {
    server = startServer(session, env, cwd);
    await before(server);
    await server.stop();
    server = startServer(session, env, cwd);
    const result = await after(server);
    await server.stop();
    return { result, ms: Date.now() - started };
  } catch (error) {
    if (server) console.error(server.output());
    if (diagnose && server) console.error(JSON.stringify(diagnose(server), null, 2));
    throw error;
  } finally {
    try {
      await server?.stop();
    } catch {}
    if (!process.env.HERDR_DURABLE_DEBUG) rmSync(root, { recursive: true, force: true });
  }
}

function processArgv(process) {
  if (Array.isArray(process.argv)) return process.argv;
  try {
    return readFileSync(`/proc/${process.pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

const FAKE_CASES = [
  {
    label: 'claude-saved',
    agent: 'claude',
    session: '11111111-1111-4111-8111-111111111111',
    saved: true,
    launch: ['claude', '--dangerously-skip-permissions', '--model', 'opus', 'first prompt'],
    resumed: ['--dangerously-skip-permissions', '--model', 'opus', '--resume', '11111111-1111-4111-8111-111111111111'],
  },
  {
    label: 'claude-new',
    agent: 'claude',
    session: '22222222-2222-4222-8222-222222222222',
    saved: false,
    launch: ['claude', '--dangerously-skip-permissions'],
    resumed: ['--dangerously-skip-permissions', '--session-id', '22222222-2222-4222-8222-222222222222'],
  },
  {
    label: 'codex-saved',
    agent: 'codex',
    session: '01a1e775-d57d-7bb1-b899-4f42050f326f',
    saved: true,
    launch: ['codex', '--no-daemon', '--dangerously-bypass-approvals-and-sandbox', 'resume', '01a1e775-d57d-7bb1-b899-4f42050f326f'],
    resumed: ['--no-daemon', '--dangerously-bypass-approvals-and-sandbox', 'resume', '01a1e775-d57d-7bb1-b899-4f42050f326f'],
  },
];

async function fake() {
  const { root, home } = makeHome('e2e');
  const project = join(root, 'project');
  const runs = join(root, 'runs');
  const bin = join(root, 'bin');
  const claudeHome = join(root, 'claude-config');
  const codexHome = join(root, 'codex-home');
  for (const dir of [project, runs, bin, join(claudeHome, 'projects', 'p'), join(codexHome, 'sessions', '2026')]) {
    mkdirSync(dir, { recursive: true });
  }
  const env = cleanEnv(home, {
    PATH: bin + ':' + process.env.PATH,
    CLAUDE_CONFIG_DIR: claudeHome,
    CODEX_HOME: codexHome,
  });
  writeFileSync(join(home, '.profile'), 'PATH=' + JSON.stringify(env.PATH) + '; export PATH\n');

  for (const agent of ['claude', 'codex']) {
    writeFileSync(join(bin, agent), '#!/bin/sh\n' +
      'label="$(cat "$PWD/.label-$HERDR_PANE_ID" 2>/dev/null)"\n' +
      'printf "%s\\n" "$@" > ' + JSON.stringify(runs) + '/"$label".' + agent + '.$$\n' +
      'session="$(cat "$PWD/.session-$HERDR_PANE_ID")"\n' +
      '"$HERDR_BIN_PATH" pane report-agent-session "$HERDR_PANE_ID" --source herdr:' + agent +
      ' --agent ' + agent + ' --seq "$(date +%s)000000000" --agent-session-id "$session" >/dev/null\n' +
      'sleep 600\n', { mode: 0o755 });
  }
  for (const item of FAKE_CASES.filter(item => item.saved)) {
    const file = item.agent === 'claude'
      ? join(claudeHome, 'projects', 'p', item.session + '.jsonl')
      : join(codexHome, 'sessions', '2026', 'rollout-2026-11-23T10-00-00-' + item.session + '.jsonl');
    writeFileSync(file, '');
  }
  linkPlugin(env);

  const session = 'durable-e2e';
  const expected = FAKE_CASES.map(item => [item.agent, ...item.resumed].join(' '));
  const savedResume = () => {
    const file = join(home, '.config', 'herdr', 'sessions', session, 'session.json');
    if (!existsSync(file)) return {};
    const snapshot = JSON.parse(readFileSync(file, 'utf8'));
    const panes = snapshot.workspaces.flatMap(workspace => workspace.tabs
      .flatMap(tab => Object.values(tab.panes)));
    return Object.fromEntries(panes.filter(pane => pane.agent_resume)
      .map(pane => [pane.agent_resume.argv.join(' '), pane.agent_resume]));
  };
  const runsFor = item => readdirSync(runs)
    .filter(name => name.startsWith(item.label + '.' + item.agent + '.'))
    .map(name => readFileSync(join(runs, name), 'utf8').trim().split('\n').filter(Boolean));

  const { result, ms } = await restart({
    session, env, cwd: project, root, diagnose: savedResume,
    before(server) {
      let paneId = server.run(['workspace', 'create', '--cwd', project, '--label', 'e2e']).result.root_pane.pane_id;
      const paneIds = [paneId];
      while (paneIds.length < FAKE_CASES.length) {
        paneId = server.run(['pane', 'split', paneId, '--direction', 'right', '--cwd', project, '--no-focus']).result.pane.pane_id;
        paneIds.push(paneId);
      }
      FAKE_CASES.forEach((item, index) => {
        writeFileSync(join(project, '.label-' + paneIds[index]), item.label);
        writeFileSync(join(project, '.session-' + paneIds[index]), item.session);
        server.run(['pane', 'run', paneIds[index], item.launch.join(' ')]);
      });
      waitFor(() => {
        const saved = savedResume();
        return expected.every(command => saved[command]?.source === 'plugin:herdr-durable');
      }, 'Herdr to save every resume command', 45_000);
    },
    after(server) {
      for (const item of FAKE_CASES) {
        const resumed = waitFor(
          () => runsFor(item).find(args => args.join(' ') === item.resumed.join(' ')),
          item.label + ' to resume with ' + item.resumed.join(' '),
        );
        assert.ok(resumed);
      }
      sleep(300);
      return FAKE_CASES.map(item => item.label);
    },
  });
  console.log(JSON.stringify({ resumed: result, ms }));
}

const REAL_FLAGS = {
  claude: ['--dangerously-skip-permissions'],
  codex: ['--no-daemon', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust'],
};

function sessionCwd(agent, session) {
  const claudeConfig = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  const dir = agent === 'claude' ? join(claudeConfig, 'projects') : join(codexHome, 'sessions');
  const suffix = agent === 'claude' ? '/' + session + '.jsonl' : '-' + session + '.jsonl';
  const match = readdirSync(dir, { recursive: true }).map(String).find(file => ('/' + file).endsWith(suffix));
  if (!match) throw new Error(agent + ' session ' + session + ' not found under ' + dir);
  for (const line of readFileSync(join(dir, match), 'utf8').split('\n')) {
    try {
      const entry = JSON.parse(line);
      const cwd = entry.cwd || entry.payload?.cwd;
      if (cwd) return cwd;
    } catch {}
  }
  throw new Error('no cwd recorded in ' + agent + ' session ' + session);
}

async function real(args) {
  const cases = [];
  for (let i = 0; i < args.length; i += 2) {
    const [agent, session] = [args[i], args[i + 1]];
    if (!REAL_FLAGS[agent] || !session) throw new Error('usage: node e2e.js real claude <session-id> codex <session-id>');
    cases.push({ agent, session, cwd: sessionCwd(agent, session) });
  }
  if (cases.length === 0) throw new Error('usage: node e2e.js real claude <session-id> codex <session-id>');
  for (const item of cases) {
    item.argv = item.agent === 'claude'
      ? ['claude', ...REAL_FLAGS.claude, '--resume', item.session]
      : ['codex', ...REAL_FLAGS.codex, 'resume', item.session];
  }

  const { root, home } = makeHome('real');
  const env = cleanEnv(home, {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
    CODEX_HOME: process.env.CODEX_HOME || join(homedir(), '.codex'),
  });
  writeFileSync(join(home, '.profile'), 'PATH=' + JSON.stringify(process.env.PATH) + '; export PATH\n');
  linkPlugin(env);
  const session = 'durable-real';

  const { result, ms } = await restart({
    session, env, cwd: root, root,
    diagnose(server) {
      try {
        const logs = server.run(['plugin', 'log', 'list', '--plugin', 'herdr-durable']).result.logs;
        return {
          logs: logs.map(({ event, status, stdout, stderr }) => ({ event, status, stdout, stderr })),
          panes: cases.map(item => {
            const pane = server.run(['pane', 'get', item.paneId]).result.pane;
            const screen = spawnSync(HERDR, ['--session', session, 'pane', 'read', item.paneId, '--lines', '20'], { env, encoding: 'utf8' }).stdout;
            return { agent: item.agent, status: pane.agent_status, screen };
          }),
        };
      } catch (error) {
        return { error: error.message };
      }
    },
    before(server) {
      for (const item of cases) {
        item.paneId = server.run([
          'workspace', 'create', '--cwd', item.cwd, '--label', item.agent, '--env', 'HOME=' + homedir(),
        ]).result.root_pane.pane_id;
        server.run(['pane', 'run', item.paneId, item.argv.join(' ')]);
      }
      const logs = () => server.run(['plugin', 'log', 'list', '--plugin', 'herdr-durable']).result.logs;
      for (const item of cases) {
        waitFor(() => logs().some(log => (log.stdout || '').includes(JSON.stringify(item.argv))),
          'plugin to report ' + item.argv.join(' '), 30_000);
      }
      for (const item of cases) {
        const info = server.run(['pane', 'process-info', '--pane', item.paneId]).result.process_info;
        item.pid = (info.foreground_processes || []).find(p => processArgv(p).includes(item.session))?.pid;
        assert.ok(item.pid, item.agent + ' is not running before the restart');
      }
    },
    after(server) {
      const results = [];
      for (const item of cases) {
        const restored = waitFor(() => {
          try {
            const info = server.run(['pane', 'process-info', '--pane', item.paneId]).result.process_info;
            return (info.foreground_processes || [])
              .find(p => p.pid !== item.pid && processArgv(p).includes(item.session));
          } catch {
            return null;
          }
        }, item.agent + ' to come back after restart', 90_000);
        const argv = processArgv(restored);
        for (const flag of REAL_FLAGS[item.agent]) {
          assert.ok(argv.includes(flag), item.agent + ' lost ' + flag);
        }
        const settled = waitFor(() => {
          const pane = server.run(['pane', 'get', item.paneId]).result.pane;
          return pane.agent_status === 'idle' && pane.agent === item.agent ? pane : null;
        }, item.agent + ' to report idle after restore', 60_000);
        const screen = spawnSync(HERDR, ['--session', session, 'pane', 'read', item.paneId, '--lines', '12'], {
          env,
          encoding: 'utf8',
        }).stdout;
        assert.doesNotMatch(screen, /Hooks need review|No conversation found|Do you trust/,
          item.agent + ' stopped after restore:\n' + screen);
        results.push({
          agent: item.agent,
          pane_id: item.paneId,
          pid_before: item.pid,
          pid_after: restored.pid,
          status: settled.agent_status,
          argv,
        });
      }
      return results;
    },
  });
  console.log(JSON.stringify({ results: result, ms }, null, 2));
}

const [mode, ...args] = process.argv.slice(2);
if (mode === 'real') await real(args);
else if (mode === undefined || mode === 'fake') await fake();
else throw new Error('usage: node e2e.js [fake | real claude <session-id> codex <session-id>]');
