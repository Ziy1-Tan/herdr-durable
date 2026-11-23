import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  agentProcess,
  launchFlags,
  launchInfo,
  parseEvent,
  parseLaunchArgs,
  resumeArgv,
  resumeArgvProblem,
  syncAll,
  syncPane,
} from './plugin.js';
import { nativeResumeEnabled } from './configure.js';

function tempDir(prefix = 'herdr-durable-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Stands in for the herdr binary and records every call it receives.
function fakeHerdr(directory, responses) {
  const log = path.join(directory, 'calls.log');
  const script = path.join(directory, 'herdr');
  fs.writeFileSync(script, '#!/bin/sh\n' +
    'printf "%s\n" "$*" >> ' + JSON.stringify(log) + '\n' +
    'case "$1 $2" in\n' +
    Object.entries(responses)
      .map(([key, value]) => '  ' + JSON.stringify(key) + ') cat <<"JSON"\n' + JSON.stringify(value) + '\nJSON\n;;')
      .join('\n') +
    '\nesac\n', { mode: 0o755 });
  process.env.HERDR_BIN_PATH = script;
  return () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
}

function paneInfo(agent, kind, value, extra = {}) {
  return {
    result: {
      pane: {
        pane_id: 'w1:p1',
        agent,
        agent_session: { source: 'herdr:' + agent, agent, kind, value },
        ...extra,
      },
    },
  };
}

function processInfo(pid, name, argv, groupId = pid) {
  return {
    result: {
      process_info: {
        pane_id: 'w1:p1',
        foreground_process_group_id: groupId,
        foreground_processes: [{ pid, name, argv }],
      },
    },
  };
}

test('keeps launch flags and drops the resumed session from positional arguments', () => {
  assert.deepEqual(
    launchFlags('claude', ['/opt/homebrew/bin/claude', '--dangerously-skip-permissions', '--model', 'opus']),
    ['--dangerously-skip-permissions', '--model', 'opus'],
  );
  assert.deepEqual(
    launchFlags('claude', ['claude', '--dangerously-skip-permissions', '--resume', 'abc', '--continue']),
    ['--dangerously-skip-permissions'],
  );
  assert.deepEqual(
    launchFlags('claude', ['claude', '--dangerously-skip-permissions', 'fix the build']),
    ['--dangerously-skip-permissions'],
  );
  assert.deepEqual(
    launchFlags('codex', ['codex', '--no-daemon', '--yolo', 'resume', '01a1e775']),
    ['--no-daemon', '--yolo'],
  );
  assert.deepEqual(
    launchFlags('codex', ['codex', '--dangerously-bypass-approvals-and-sandbox', '-p', 'work', 'explain this']),
    ['--dangerously-bypass-approvals-and-sandbox', '-p', 'work'],
  );
  // Unknown and identity options are kept; session selection and one-time work are dropped.
  assert.deepEqual(
    launchFlags('claude', ['claude', '--some-new-flag', '-n', 'worker-1', '--worktree', 'feat', '--tmux', '--file', 'f:a.txt']),
    ['--some-new-flag', '-n', 'worker-1'],
  );
  assert.deepEqual(
    launchFlags('codex', ['codex', '--yolo', '-c', 'model="o3"', '--worktree', '-i', 'a.png', 'b.png', '--search']),
    ['--yolo', '-c', 'model="o3"', '--search'],
  );
});

test('parses option values the way the CLIs do', () => {
  assert.deepEqual(
    parseLaunchArgs('claude', ['--allowedTools', 'Bash Edit', 'Write', '--verbose']),
    { flags: ['--allowedTools', 'Bash Edit', 'Write', '--verbose'], positionals: [], blocked: false },
  );
  assert.deepEqual(
    parseLaunchArgs('claude', ['--model=sonnet', '--resume=abc', 'hello']),
    { flags: ['--model=sonnet'], positionals: ['hello'], blocked: false },
  );
  assert.deepEqual(
    parseLaunchArgs('claude', ['--resume', '--verbose']),
    { flags: ['--verbose'], positionals: [], blocked: false },
  );
  // --add-dir and --append-system-prompt consume their value, so it is not mistaken for a flag.
  assert.deepEqual(
    parseLaunchArgs('claude', ['--append-system-prompt', '--model sonnet', '--add-dir', 'a', 'b', '--verbose']),
    {
      flags: ['--append-system-prompt', '--model sonnet', '--add-dir', 'a', 'b', '--verbose'],
      positionals: [],
      blocked: false,
    },
  );
  assert.deepEqual(
    parseLaunchArgs('claude', ['--', '--model', 'x']),
    { flags: [], positionals: ['--model', 'x'], blocked: false },
  );
});

test('rejects processes that are not interactive sessions', () => {
  for (const argv of [
    ['claude', '--dangerously-skip-permissions', '-p', 'summarize this'],
    ['claude', '--help'],
    ['codex', 'exec', '--yolo', 'run tests'],
    ['codex', 'mcp', 'list'],
  ]) {
    assert.equal(launchFlags(argv[0], argv), null, argv.join(' '));
  }
  // A first positional is a prompt for codex, so it stays interactive.
  assert.deepEqual(launchFlags('codex', ['codex', '--yolo', 'explain this']), ['--yolo']);
});

test('finds the agent process through wrappers and .exe names', () => {
  assert.equal(
    agentProcess(processInfo(1, 'claude.exe', ['claude', '--model', 'opus']).result.process_info, 'claude')?.pid,
    1,
  );
  assert.equal(
    agentProcess(processInfo(2, 'node', ['node', '/usr/local/bin/codex', '--yolo']).result.process_info, 'codex')?.pid,
    2,
  );
  assert.equal(
    agentProcess(processInfo(3, 'node', ['node', '/usr/local/bin/other-tool', 'codex']).result.process_info, 'codex'),
    null,
  );
  assert.equal(
    agentProcess(processInfo(4, 'codex', ['codex', 'exec', 'ls']).result.process_info, 'claude'),
    null,
  );
  const two = {
    pane_id: 'w1:p1',
    foreground_process_group_id: 7,
    foreground_processes: [
      { pid: 6, name: 'codex', argv: ['codex', 'exec', 'ls'] },
      { pid: 7, name: 'codex', argv: ['codex', '--yolo'] },
    ],
  };
  assert.equal(agentProcess(two, 'codex')?.pid, 7);
});

test('rejects resume commands Herdr would refuse', () => {
  assert.equal(resumeArgvProblem(['claude', '--resume', 'abc']), null);
  assert.match(resumeArgvProblem(['claude', '--add-dir', "o'brien"]), /apostrophe/);
  assert.match(resumeArgvProblem(['claude', '--resume', 'a\u0007b']), /control character/);
  assert.match(resumeArgvProblem(['claude', ...Array(64).fill('x')]), /64 arguments/);
  assert.match(resumeArgvProblem(['claude', 'x'.repeat(9000)]), /8 KiB/);
});

test('starts a new session instead of resuming one that was never saved', () => {
  const home = tempDir();
  process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude');
  process.env.CODEX_HOME = path.join(home, 'codex');
  fs.mkdirSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-tmp-proj'), { recursive: true });
  fs.mkdirSync(path.join(process.env.CODEX_HOME, 'sessions', '2026', '11', '23'), { recursive: true });
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-tmp-proj', 'live.jsonl'), '');
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'sessions', '2026', '11', '23', 'rollout-2026-11-23T10-00-00-live.jsonl'), '');

  assert.deepEqual(resumeArgv('claude', ['--dangerously-skip-permissions'], 'live'), [
    'claude', '--dangerously-skip-permissions', '--resume', 'live',
  ]);
  assert.deepEqual(resumeArgv('claude', ['--dangerously-skip-permissions'], 'missing'), [
    'claude', '--dangerously-skip-permissions', '--session-id', 'missing',
  ]);
  assert.deepEqual(resumeArgv('codex', ['--yolo'], 'live'), ['codex', '--yolo', 'resume', 'live']);
  assert.deepEqual(resumeArgv('codex', ['--yolo'], 'missing'), ['codex', '--yolo']);
});

test('reports the resume command for a running agent pane', () => {
  const directory = tempDir();
  process.env.CLAUDE_CONFIG_DIR = path.join(directory, 'claude');
  fs.mkdirSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-tmp-proj'), { recursive: true });
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-tmp-proj', 'sess-1.jsonl'), '');
  const calls = fakeHerdr(directory, {
    'pane get': paneInfo('claude', 'id', 'sess-1'),
    'pane process-info': processInfo(42, 'claude.exe', ['claude', '--dangerously-skip-permissions', '--model', 'opus']),
    'pane report-agent-session': { result: {} },
  });
  try {
    const outcome = syncPane('w1:p1');
    assert.deepEqual(outcome, {
      pane_id: 'w1:p1',
      agent: 'claude',
      reported: ['claude', '--dangerously-skip-permissions', '--model', 'opus', '--resume', 'sess-1'],
    });
    const report = calls().find(call => call.startsWith('pane report-agent-session'));
    assert.match(report, /--source plugin:herdr-durable --agent claude --seq \d+ -- claude --dangerously-skip-permissions --model opus --resume sess-1$/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('uses the launch session until the agent reports one', () => {
  assert.equal(launchInfo('codex', ['codex', '--yolo', 'resume', '01a1e775-d57d-7bb1-b899-4f42050f326f']).session,
    '01a1e775-d57d-7bb1-b899-4f42050f326f');
  assert.equal(launchInfo('codex', ['codex', '--yolo', 'resume', '--last']).session, null);
  assert.equal(launchInfo('codex', ['codex', '--yolo', 'resume', 'my-thread-name']).session, null);
  assert.equal(launchInfo('claude', ['claude', '--resume', 'abc', '--verbose']).session, 'abc');
  assert.equal(launchInfo('claude', ['claude', '--session-id=abc']).session, 'abc');
  assert.equal(launchInfo('claude', ['claude', '--dangerously-skip-permissions']).session, null);

  const directory = tempDir();
  process.env.CODEX_HOME = path.join(directory, 'codex');
  fs.mkdirSync(path.join(process.env.CODEX_HOME, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'sessions', 'rollout-x-01a1e775-d57d-7bb1-b899-4f42050f326f.jsonl'), '');
  fakeHerdr(directory, {
    'pane get': { result: { pane: { pane_id: 'w1:p1', agent: 'codex' } } },
    'pane process-info': processInfo(42, 'codex', ['codex', '--yolo', 'resume', '01a1e775-d57d-7bb1-b899-4f42050f326f']),
    'pane report-agent-session': { result: {} },
  });
  try {
    assert.deepEqual(syncPane('w1:p1').reported, ['codex', '--yolo', 'resume', '01a1e775-d57d-7bb1-b899-4f42050f326f']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('prefers the session Herdr reports over the launch session', () => {
  const directory = tempDir();
  process.env.CLAUDE_CONFIG_DIR = path.join(directory, 'claude');
  fs.mkdirSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'p'), { recursive: true });
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'p', 'after-clear.jsonl'), '');
  fakeHerdr(directory, {
    'pane get': paneInfo('claude', 'id', 'after-clear'),
    'pane process-info': processInfo(42, 'claude', ['claude', '--dangerously-skip-permissions', '--resume', 'before-clear']),
    'pane report-agent-session': { result: {} },
  });
  try {
    assert.deepEqual(syncPane('w1:p1').reported, ['claude', '--dangerously-skip-permissions', '--resume', 'after-clear']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('waits when neither Herdr nor the launch names a session', () => {
  const directory = tempDir();
  fakeHerdr(directory, {
    'pane get': { result: { pane: { pane_id: 'w1:p1', agent: 'codex' } } },
    'pane process-info': processInfo(42, 'codex', ['codex', '--yolo']),
  });
  try {
    assert.equal(syncPane('w1:p1').skipped, 'no_session');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('ignores panes without a supported agent', () => {
  const directory = tempDir();
  const calls = fakeHerdr(directory, {
    'pane get': paneInfo(undefined, undefined, undefined),
    'pane list': { result: { panes: [{ pane_id: 'w1:p1', agent: 'vim' }] } },
  });
  try {
    assert.equal(syncPane('w1:p1').skipped, 'unsupported_agent');
    assert.deepEqual(syncAll(), []);
    assert.equal(calls().some(call => call.startsWith('pane process-info')), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('parses plugin events and ignores anything else', () => {
  assert.deepEqual(
    parseEvent(JSON.stringify({ event: 'pane.agent_detected', data: { pane_id: 'w1:p1' } })),
    { paneId: 'w1:p1', detected: true },
  );
  assert.deepEqual(
    parseEvent(JSON.stringify({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1' } })),
    { paneId: 'w1:p1', detected: false },
  );
  assert.equal(parseEvent(JSON.stringify({ event: 'pane.closed', data: { pane_id: 'w1:p1' } })), null);
  assert.equal(parseEvent(JSON.stringify({ event: 'pane.agent_detected', data: { pane_id: 'w1:p1', agent: 'pi' } })), null);
  assert.equal(
    parseEvent(JSON.stringify({ event: 'pane.agent_detected', data: { pane_id: 'w1:p1', agent: 'claude', released: true } })),
    null,
  );
  assert.deepEqual(
    parseEvent(JSON.stringify({ event: 'pane.agent_status_changed', data: { pane_id: 'w1:p1', agent: 'codex' } })),
    { paneId: 'w1:p1', detected: false },
  );
  assert.equal(parseEvent('not json'), null);
  assert.equal(parseEvent(''), null);
});

test('checks that Herdr will run reported resume commands', () => {
  const home = tempDir();
  process.env.HERDR_CONFIG_PATH = path.join(home, 'config.toml');
  fs.writeFileSync(process.env.HERDR_CONFIG_PATH, 'onboarding = false\n');
  assert.equal(nativeResumeEnabled(), true);
  fs.writeFileSync(process.env.HERDR_CONFIG_PATH, '[session]\nresume_agents_on_restore = false\n');
  assert.equal(nativeResumeEnabled(), false);
  fs.writeFileSync(process.env.HERDR_CONFIG_PATH, 'session.resume_agents_on_restore = false\n');
  assert.equal(nativeResumeEnabled(), false);
  fs.writeFileSync(process.env.HERDR_CONFIG_PATH, '[session]\nresume_agents_on_restore = true\n');
  assert.equal(nativeResumeEnabled(), true);
  // Another section's key must not count.
  fs.writeFileSync(process.env.HERDR_CONFIG_PATH, '[ui]\nresume_agents_on_restore = false\n');
  assert.equal(nativeResumeEnabled(), true);
  fs.rmSync(home, { recursive: true, force: true });
});
