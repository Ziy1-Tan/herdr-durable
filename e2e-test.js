#!/usr/bin/env node
// Runs a real headless Herdr with this plugin linked in an isolated HOME. Fake claude and
// codex executables log their argv and report a session the way Herdr's integrations do.
// Then Herdr is restarted and the resumed argv is checked.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanEnv, linkPlugin, makeHome, sleep, startServer, waitFor } from './e2e-harness.js';

const started = Date.now();
const { root, home } = makeHome('e2e');
const project = join(root, 'project');
const runs = join(root, 'runs');
const bin = join(root, 'bin');
const claudeHome = join(root, 'claude-config');
const codexHome = join(root, 'codex-home');
for (const directory of [project, runs, bin, join(claudeHome, 'projects', 'p'), join(codexHome, 'sessions', '2026')]) {
  mkdirSync(directory, { recursive: true });
}

const env = cleanEnv(home, {
  PATH: bin + ':' + process.env.PATH,
  CLAUDE_CONFIG_DIR: claudeHome,
  CODEX_HOME: codexHome,
});
// Login shells rebuild PATH with path_helper, so put the fake agents first again.
writeFileSync(join(home, '.profile'), 'PATH=' + JSON.stringify(bin) + ':"$PATH"; export PATH\n');

// Each fake agent logs its argv under the pane's label and reports the pane's session id.
// It stays a running "sh .../claude ..." process so Herdr detects it like a wrapped agent.
for (const agent of ['claude', 'codex']) {
  writeFileSync(join(bin, agent), '#!/bin/sh\n' +
    'label="$(cat "$PWD/.label-$HERDR_PANE_ID" 2>/dev/null)"\n' +
    'printf "%s\\n" "$@" > ' + JSON.stringify(runs) + '/"$label".' + agent + '.$$\n' +
    'session="$(cat "$PWD/.session-$HERDR_PANE_ID")"\n' +
    '"$HERDR_BIN_PATH" pane report-agent-session "$HERDR_PANE_ID" --source herdr:' + agent +
    ' --agent ' + agent + ' --seq "$(date +%s)000000000" --agent-session-id "$session" >/dev/null\n' +
    'sleep 600\n', { mode: 0o755 });
}

const cases = [
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

for (const item of cases) {
  if (!item.saved) continue;
  const file = item.agent === 'claude'
    ? join(claudeHome, 'projects', 'p', item.session + '.jsonl')
    : join(codexHome, 'sessions', '2026', 'rollout-2026-11-23T10-00-00-' + item.session + '.jsonl');
  writeFileSync(file, '');
}

function runsFor(label, agent) {
  const prefix = label + '.' + agent + '.';
  return readdirSync(runs)
    .filter(name => name.startsWith(prefix))
    .map(name => readFileSync(join(runs, name), 'utf8').trim().split('\n').filter(Boolean));
}

// Resume commands Herdr saved in the session snapshot, keyed by command line.
function savedResume(sessionName) {
  const file = join(home, '.config', 'herdr', 'sessions', sessionName, 'session.json');
  if (!existsSync(file)) return {};
  const snapshot = JSON.parse(readFileSync(file, 'utf8'));
  const byCommand = {};
  for (const workspace of snapshot.workspaces) {
    for (const tab of workspace.tabs) {
      for (const pane of Object.values(tab.panes)) {
        if (pane.agent_resume) byCommand[pane.agent_resume.argv.join(' ')] = pane.agent_resume;
      }
    }
  }
  return byCommand;
}

const sessionName = 'durable-e2e';
writeFileSync(join(home, '.config', 'herdr', 'config.toml'), 'onboarding = false\n');
linkPlugin(env);

let server;
try {
  server = startServer({ session: sessionName, env, cwd: project });
  const first = server.run(['workspace', 'create', '--cwd', project, '--label', 'e2e']).result.root_pane;
  const paneIds = [first.pane_id];
  while (paneIds.length < cases.length) {
    const pane = server.run(['pane', 'split', paneIds.at(-1), '--direction', 'right', '--cwd', project, '--no-focus']).result.pane;
    paneIds.push(pane.pane_id);
  }
  cases.forEach((item, index) => {
    item.paneId = paneIds[index];
    writeFileSync(join(project, '.label-' + item.paneId), item.label);
    writeFileSync(join(project, '.session-' + item.paneId), item.session);
    server.run(['pane', 'run', item.paneId, item.launch.join(' ')]);
  });

  const expected = cases.map(item => [item.agent, ...item.resumed].join(' '));
  waitFor(() => {
    const saved = savedResume(sessionName);
    return expected.every(command => saved[command]?.source === 'plugin:herdr-durable');
  }, 'Herdr to save every resume command', 45_000);

  await server.stop();
  server = startServer({ session: sessionName, env, cwd: project });
  for (const item of cases) {
    const resumed = waitFor(() => runsFor(item.label, item.agent).find(args => args.join(' ') === item.resumed.join(' ')),
      item.label + ' to resume with ' + item.resumed.join(' '));
    assert.ok(resumed);
  }
  sleep(300);
  await server.stop();

  console.log(JSON.stringify({ resumed: cases.map(item => item.label), ms: Date.now() - started }));
} catch (error) {
  if (server) console.error(server.output());
  console.error(JSON.stringify(savedResume(sessionName), null, 2));
  throw error;
} finally {
  try {
    await server?.stop();
  } catch {}
  if (!process.env.HERDR_DURABLE_DEBUG) rmSync(root, { recursive: true, force: true });
}
