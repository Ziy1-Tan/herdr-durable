const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const {
  captureAll,
  captureFromEvent,
  sessionExists,
  restorePanes,
  readRecord,
  launchArgv,
  normalizeAgent,
  parseEvent,
  readProcArgv,
  shellCommand,
  shouldRestore,
  status,
  validSession,
} = require('./plugin.js');
const { updateConfig } = require('./configure.js');

test('normalizes supported agents', () => {
  assert.equal(normalizeAgent('Codex'), 'codex');
  assert.equal(normalizeAgent('unsupported'), null);
});

test('parses capture events', () => {
  assert.deepEqual(parseEvent(JSON.stringify({
      event: 'pane_agent_detected',
    data: { pane_id: 'w1:p1', agent: 'codex' },
  })), { name: 'pane_agent_detected', paneId: 'w1:p1', agent: 'codex' });
  assert.equal(parseEvent('{}'), null);
});

test('captures only events that match pane agent metadata', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-durable-'));
  const executable = path.join(directory, 'herdr');
  const claudeDirectory = path.join(directory, 'claude');
  fs.mkdirSync(claudeDirectory, { recursive: true });
  fs.writeFileSync(path.join(claudeDirectory, 'csess.jsonl'), '');
  fs.writeFileSync(executable, `#!/bin/sh
case "$1 $2" in
  'pane list') printf '%s\\n' '{"id":"x","result":{"panes":[{"pane_id":"w1:p1","agent":"claude","agent_session":{"agent":"claude","kind":"id","value":"csess"}}]}}' ;;
  'pane get') printf '%s\\n' '{"id":"x","result":{"pane":{"pane_id":"w1:p1","agent":"claude","agent_session":{"agent":"claude","kind":"id","value":"csess"}}}}' ;;
  'pane process-info') printf '%s\\n' '{"id":"x","result":{"process_info":{"foreground_processes":[{"pid":999999999,"name":"claude","argv":["/claude","--model","x"]}]}}}' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`);
  fs.chmodSync(executable, 0o755);
  process.env.HERDR_BIN_PATH = executable;
  process.env.HERDR_PLUGIN_STATE_DIR = directory;
  process.env.HERDR_DURABLE_CLAUDE_SESSIONS = claudeDirectory;

  const mismatch = captureFromEvent(JSON.stringify({
    event: 'pane_agent_detected',
    data: { pane_id: 'w1:p1', agent: 'codex' },
  }));
  assert.equal(mismatch.captured, false);
  assert.equal(mismatch.reason, 'agent_mismatch');
  assert.equal(readRecord('w1:p1'), null);

  const match = captureFromEvent(JSON.stringify({
    event: 'pane_agent_detected',
    data: { pane_id: 'w1:p1', agent: 'claude' },
  }));
  assert.equal(match.captured, true);
  assert.deepEqual(readRecord('w1:p1'), {
    agent: 'claude',
    session: 'csess',
    argv: ['/claude', '--model', 'x'],
  });
  fs.rmSync(path.join(directory, 'panes', 'w1%3Ap1.json'));
  assert.deepEqual(captureAll(), {
    captured: 1,
    actions: [{ pane_id: 'w1:p1', captured: true }],
    pruned: 0,
  });

  fs.rmSync(directory, { recursive: true, force: true });
  delete process.env.HERDR_BIN_PATH;
  delete process.env.HERDR_PLUGIN_STATE_DIR;
  delete process.env.HERDR_DURABLE_CLAUDE_SESSIONS;
});

test('waits for the agent session to be reported before capturing', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-durable-'));
  const executable = path.join(directory, 'herdr');
  const codexDirectory = path.join(directory, 'codex');
  fs.mkdirSync(codexDirectory, { recursive: true });
  fs.writeFileSync(path.join(codexDirectory, 'rollout-sess.jsonl'), '');
  fs.writeFileSync(executable, `#!/bin/sh
case "$1 $2" in
  'pane get')
    calls=$(cat ${JSON.stringify(path.join(directory, 'calls'))} 2>/dev/null || echo 0)
    calls=$((calls + 1)); printf '%s' "$calls" > ${JSON.stringify(path.join(directory, 'calls'))}
    if [ "$calls" -lt 2 ]; then
      printf '%s\\n' '{"id":"x","result":{"pane":{"pane_id":"w1:p1","agent":"codex"}}}'
    else
      printf '%s\\n' '{"id":"x","result":{"pane":{"pane_id":"w1:p1","agent":"codex","agent_session":{"agent":"codex","kind":"id","value":"sess"}}}}'
    fi ;;
  'pane process-info') printf '%s\\n' '{"id":"x","result":{"process_info":{"foreground_processes":[{"pid":999999999,"name":"codex","argv":["codex","--yolo"]}]}}}' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`);
  fs.chmodSync(executable, 0o755);
  process.env.HERDR_BIN_PATH = executable;
  process.env.HERDR_PLUGIN_STATE_DIR = directory;
  process.env.HERDR_DURABLE_CODEX_SESSIONS = codexDirectory;

  const result = captureFromEvent(JSON.stringify({
    event: 'pane_agent_detected',
    data: { pane_id: 'w1:p1', agent: 'codex' },
  }));
  assert.equal(result.captured, true);
  assert.deepEqual(readRecord('w1:p1'), {
    agent: 'codex',
    session: 'sess',
    argv: ['codex', '--yolo'],
  });

  fs.rmSync(directory, { recursive: true, force: true });
  delete process.env.HERDR_BIN_PATH;
  delete process.env.HERDR_PLUGIN_STATE_DIR;
  delete process.env.HERDR_DURABLE_CODEX_SESSIONS;
});

test('prunes records whose panes are gone during save', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-durable-'));
  const executable = path.join(directory, 'herdr');
  const panes = [{ pane_id: 'w1:p1' }];
  fs.writeFileSync(executable, `#!/bin/sh
case "$1 $2" in
  'pane list') printf '%s\\n' '${JSON.stringify({ id: 'x', result: { panes } })}' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`);
  fs.chmodSync(executable, 0o755);
  fs.mkdirSync(path.join(directory, 'panes'), { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'panes', 'w9%3Ap9.json'),
    JSON.stringify({ agent: 'pi', session: 'gone', argv: ['pi'] }),
  );
  fs.writeFileSync(
    path.join(directory, 'panes', 'w9%3Ap9.json.123.tmp'),
    JSON.stringify({ agent: 'pi', session: 'stray', argv: ['pi'] }),
  );
  process.env.HERDR_BIN_PATH = executable;
  process.env.HERDR_PLUGIN_STATE_DIR = directory;

  assert.deepEqual(captureAll(), {
    captured: 0,
    actions: [{ pane_id: 'w1:p1', skipped: 'no_agent' }],
    pruned: 1,
  });
  assert.equal(readRecord('w9:p9'), null);
  assert.ok(
    fs.existsSync(path.join(directory, 'panes', 'w9%3Ap9.json.123.tmp')),
    'non-record files must be left alone',
  );

  fs.rmSync(directory, { recursive: true, force: true });
  delete process.env.HERDR_BIN_PATH;
  delete process.env.HERDR_PLUGIN_STATE_DIR;
});

test('captures a pi session whose file is not written yet', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-durable-'));
  const executable = path.join(directory, 'herdr');
  const piDirectory = path.join(directory, 'pi');
  fs.mkdirSync(piDirectory, { recursive: true });
  const sessionPath = path.join(piDirectory, 'not-yet-written.jsonl');
  fs.writeFileSync(executable, `#!/bin/sh
case "$1 $2" in
  'pane get') printf '%s\\n' '${JSON.stringify({ id: 'x', result: { pane: { pane_id: 'w1:p1', agent: 'pi', agent_session: { agent: 'pi', kind: 'path', value: sessionPath } } } })}' ;;
  'pane process-info') printf '%s\\n' '{"id":"x","result":{"process_info":{"foreground_processes":[{"pid":999999999,"name":"pi","argv":["pi"]}]}}}' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`);
  fs.chmodSync(executable, 0o755);
  process.env.HERDR_BIN_PATH = executable;
  process.env.HERDR_PLUGIN_STATE_DIR = directory;
  process.env.HERDR_DURABLE_PI_SESSIONS = piDirectory;

  const result = captureFromEvent(JSON.stringify({
    event: 'pane_agent_detected',
    data: { pane_id: 'w1:p1', agent: 'pi' },
  }));
  assert.equal(result.captured, true);
  assert.deepEqual(readRecord('w1:p1'), {
    agent: 'pi',
    session: sessionPath,
    argv: ['pi'],
  });

  fs.rmSync(directory, { recursive: true, force: true });
  delete process.env.HERDR_BIN_PATH;
  delete process.env.HERDR_PLUGIN_STATE_DIR;
  delete process.env.HERDR_DURABLE_PI_SESSIONS;
});

test('restores pi without a session file and skips codex sessions that vanished', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-durable-'));
  const executable = path.join(directory, 'herdr');
  const piDirectory = path.join(directory, 'pi');
  const codexDirectory = path.join(directory, 'codex');
  fs.mkdirSync(piDirectory, { recursive: true });
  fs.mkdirSync(codexDirectory, { recursive: true });
  const sessionPath = path.join(piDirectory, 'gone.jsonl');
  const panes = [
    { pane_id: 'w1:p1', agent: 'pi', agent_session: { agent: 'pi', kind: 'path', value: sessionPath } },
    { pane_id: 'w1:p2', agent: 'codex', agent_session: { agent: 'codex', kind: 'id', value: 'vanished' } },
  ];
  fs.writeFileSync(executable, `#!/bin/sh
case "$1 $2" in
  'pane list') printf '%s\\n' '${JSON.stringify({ id: 'x', result: { panes } })}' ;;
  'pane process-info') printf '%s\\n' '{"id":"x","result":{"process_info":{"foreground_processes":[{"pid":123,"name":"zsh"}]}}}' ;;
  'pane run') printf '%s\\n' "$*" >> ${JSON.stringify(path.join(directory, 'runs'))}; printf '%s\\n' '{"id":"x","result":{"ok":true}}' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`);
  fs.chmodSync(executable, 0o755);
  fs.mkdirSync(path.join(directory, 'panes'), { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'panes', 'w1%3Ap1.json'),
    JSON.stringify({ agent: 'pi', session: sessionPath, argv: ['pi'] }),
  );
  fs.writeFileSync(
    path.join(directory, 'panes', 'w1%3Ap2.json'),
    JSON.stringify({ agent: 'codex', session: 'vanished', argv: ['/codex', '--yolo'] }),
  );
  process.env.HERDR_BIN_PATH = executable;
  process.env.HERDR_PLUGIN_STATE_DIR = directory;
  process.env.HERDR_DURABLE_PI_SESSIONS = piDirectory;
  process.env.HERDR_DURABLE_CODEX_SESSIONS = codexDirectory;

  const result = restorePanes();
  assert.equal(result.restored, 1);
  assert.deepEqual(result.actions.map(action => [action.pane_id, action.skipped ?? null]), [
    ['w1:p1', null],
    ['w1:p2', 'missing_session'],
  ]);
  const commands = fs.readFileSync(path.join(directory, 'runs'), 'utf8').trim().split('\n');
  assert.deepEqual(commands, [`pane run w1:p1 pi --session ${sessionPath}`]);

  fs.rmSync(directory, { recursive: true, force: true });
  delete process.env.HERDR_BIN_PATH;
  delete process.env.HERDR_PLUGIN_STATE_DIR;
  delete process.env.HERDR_DURABLE_PI_SESSIONS;
  delete process.env.HERDR_DURABLE_CODEX_SESSIONS;
});

test('builds agent-specific resume commands', () => {
  assert.deepEqual(launchArgv('codex', ['/codex', '--yolo'], 'id'), ['codex', '--yolo', 'resume', 'id']);
  assert.deepEqual(launchArgv('codex', ['/codex', '--yolo', 'resume', 'old'], 'id'), ['codex', '--yolo', 'resume', 'id']);
  assert.deepEqual(launchArgv('claude', ['/claude', '--model', 'x'], 'id'), ['claude', '--model', 'x', '--resume', 'id']);
  assert.deepEqual(launchArgv('claude', ['/claude', '--model', 'x', '--resume', 'old'], 'id'), ['claude', '--model', 'x', '--resume', 'id']);
  assert.deepEqual(launchArgv('pi', ['/pi', '--profile', 'x'], 'path'), ['pi', '--profile', 'x', '--session', 'path']);
  assert.deepEqual(launchArgv('pi', ['/pi', '--profile', 'x', '--session', 'old'], 'path'), ['pi', '--profile', 'x', '--session', 'path']);
  assert.deepEqual(launchArgv('pi', ['pi'], 'path'), ['pi', '--session', 'path']);
  assert.deepEqual(launchArgv('codex', ['/bin/sh', '/tmp/bin/codex', '--yolo'], 'id'), ['codex', '--yolo', 'resume', 'id']);
  assert.deepEqual(launchArgv('claude', ['node', '/tmp/bin/claude', '--model', 'x'], 'id'), ['claude', '--model', 'x', '--resume', 'id']);
});

test('shell quotes safely', () => {
  assert.equal(shellCommand(['echo', "it's"]), "echo 'it'\\''s'");
});

test('restores only matching idle panes', () => {
  const record = { agent: 'codex', session: 'id', argv: ['codex'] };
  assert.equal(shouldRestore(record, { agent: null, agent_session: { agent: 'codex', value: 'id' } }), true);
  assert.equal(shouldRestore(record, { agent: 'codex', agent_session: { agent: 'codex', value: 'id' } }), true);
  assert.equal(shouldRestore(record, { agent: null, agent_session: { agent: 'codex', value: 'other' } }), false);
});

test('validates sessions', () => {
  assert.equal(validSession('id'), true);
  assert.equal(validSession('bad\0id'), false);
});

test('validates persisted agent sessions', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-durable-'));
  const codexDirectory = path.join(directory, 'codex');
  const claudeDirectory = path.join(directory, 'claude');
  const piDirectory = path.join(directory, 'pi-sessions');
  fs.mkdirSync(codexDirectory, { recursive: true });
  fs.mkdirSync(claudeDirectory, { recursive: true });
  fs.mkdirSync(piDirectory, { recursive: true });
  fs.writeFileSync(path.join(codexDirectory, 'rollout-id.jsonl'), '');
  fs.writeFileSync(path.join(claudeDirectory, 'id.jsonl'), '');
  fs.writeFileSync(path.join(piDirectory, 'psess.jsonl'), '');
  process.env.HERDR_DURABLE_CODEX_SESSIONS = codexDirectory;
  process.env.HERDR_DURABLE_CLAUDE_SESSIONS = claudeDirectory;
  process.env.HERDR_DURABLE_PI_SESSIONS = piDirectory;
  assert.equal(sessionExists('codex', 'id'), true);
  assert.equal(sessionExists('claude', 'id'), true);
  assert.equal(sessionExists('claude', 'missing'), false);
  assert.equal(sessionExists('pi', 'psess'), true);
  assert.equal(sessionExists('pi', path.join(piDirectory, 'psess.jsonl')), true);
  assert.equal(sessionExists('pi', path.join(piDirectory, 'missing.jsonl')), true);
  assert.equal(sessionExists('pi', path.join(directory, 'outside.jsonl')), false);
  assert.equal(sessionExists('pi', '/tmp/escape.jsonl'), false);
  fs.rmSync(directory, { recursive: true, force: true });
  delete process.env.HERDR_DURABLE_CODEX_SESSIONS;
  delete process.env.HERDR_DURABLE_CLAUDE_SESSIONS;
  delete process.env.HERDR_DURABLE_PI_SESSIONS;
});

test('reads argv from proc', () => {
  assert.equal(readProcArgv(999999999), null);
  assert.equal(readProcArgv(process.pid)[0], process.execPath);
});

test('restores multiple panes and sends each command once', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-durable-'));
  const executable = path.join(directory, 'herdr');
  const codexDirectory = path.join(directory, 'codex');
  const claudeDirectory = path.join(directory, 'claude');
  const piDirectory = path.join(directory, 'pi');
  const panes = [
    { pane_id: 'w1:p1', agent: 'codex', agent_session: { agent: 'codex', value: 'sess' } },
    { pane_id: 'w1:p2', agent: 'claude', agent_session: { agent: 'claude', value: 'csess' } },
    { pane_id: 'w1:p3', agent: 'pi', agent_session: { agent: 'pi', value: 'psess' } },
  ];
  const records = [
    ['w1:p1', { agent: 'codex', session: 'sess', argv: ['/codex', '--yolo'] }],
    ['w1:p2', { agent: 'claude', session: 'csess', argv: ['/claude', '--model', 'x'] }],
    ['w1:p3', { agent: 'pi', session: 'psess', argv: ['/pi', '--profile', 'x'] }],
  ];
  fs.writeFileSync(executable, `#!/bin/sh
case "$1 $2" in
  'pane list') printf '%s\\n' '${JSON.stringify({ id: 'x', result: { panes } })}' ;;
  'pane process-info')
    if [ -f ${JSON.stringify(path.join(directory, 'runs'))} ] && [ "$(wc -l < ${JSON.stringify(path.join(directory, 'runs'))})" -ge 3 ]; then
      printf '%s\\n' '{"id":"x","result":{"process_info":{"foreground_processes":[{"pid":123,"name":"codex"},{"pid":124,"name":"claude"},{"pid":125,"name":"pi"}]}}}'
    else
      printf '%s\\n' '{"id":"x","result":{"process_info":{"foreground_processes":[{"pid":123,"name":"zsh"}]}}}'
    fi ;;
  'pane run') printf '%s\\n' "$*" >> ${JSON.stringify(path.join(directory, 'runs'))}; printf '%s\\n' '{"id":"x","result":{"ok":true}}' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`);
  fs.chmodSync(executable, 0o755);
  fs.mkdirSync(codexDirectory, { recursive: true });
  fs.mkdirSync(claudeDirectory, { recursive: true });
  fs.mkdirSync(piDirectory, { recursive: true });
  fs.writeFileSync(path.join(codexDirectory, 'rollout-sess.jsonl'), '');
  fs.writeFileSync(path.join(claudeDirectory, 'csess.jsonl'), '');
  fs.writeFileSync(path.join(piDirectory, 'psess.jsonl'), '');
  process.env.HERDR_DURABLE_CODEX_SESSIONS = codexDirectory;
  process.env.HERDR_DURABLE_CLAUDE_SESSIONS = claudeDirectory;
  process.env.HERDR_DURABLE_PI_SESSIONS = piDirectory;
  fs.mkdirSync(path.join(directory, 'panes'), { recursive: true });
  for (const [paneId, record] of records) {
    fs.writeFileSync(path.join(directory, 'panes', `${encodeURIComponent(paneId)}.json`), JSON.stringify(record));
  }

  process.env.HERDR_BIN_PATH = executable;
  process.env.HERDR_PLUGIN_STATE_DIR = directory;
  const result = restorePanes();
  assert.equal(result.restored, 3);
  const second = restorePanes();
  assert.equal(second.restored, 0);
  assert.deepEqual(second.actions.map(action => action.skipped), ['agent_running', 'agent_running', 'agent_running']);
  const commands = fs.readFileSync(path.join(directory, 'runs'), 'utf8').trim().split('\n');
  assert.equal(commands.length, 3);
  assert.deepEqual(commands, [
    'pane run w1:p1 codex --yolo resume sess',
    'pane run w1:p2 claude --model x --resume csess',
    'pane run w1:p3 pi --profile x --session psess',
  ]);
  fs.rmSync(directory, { recursive: true, force: true });
  delete process.env.HERDR_BIN_PATH;
  delete process.env.HERDR_PLUGIN_STATE_DIR;
  delete process.env.HERDR_DURABLE_CODEX_SESSIONS;
  delete process.env.HERDR_DURABLE_CLAUDE_SESSIONS;
  delete process.env.HERDR_DURABLE_PI_SESSIONS;
});

test('treats missing or invalid pane state as empty', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-durable-'));
  process.env.HERDR_PLUGIN_STATE_DIR = directory;
  const file = path.join(directory, 'panes', 'w1%3Ap1.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  assert.equal(readRecord('w1:p1'), null);
  fs.writeFileSync(file, '{');
  assert.equal(readRecord('w1:p1'), null);
  fs.rmSync(directory, { recursive: true, force: true });
  delete process.env.HERDR_PLUGIN_STATE_DIR;
});

test('reports why a pane record was skipped', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-durable-'));
  const executable = path.join(directory, 'herdr');
  const panes = [
    { pane_id: 'w1:p1', agent: 'claude', agent_session: { agent: 'claude', value: 'csess' } },
  ];
  fs.writeFileSync(executable, `#!/bin/sh
case "$1 $2" in
  'pane list') printf '%s\\n' '${JSON.stringify({ id: 'x', result: { panes } })}' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`);
  fs.chmodSync(executable, 0o755);
  fs.mkdirSync(path.join(directory, 'panes'), { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'panes', 'w1%3Ap1.json'),
    JSON.stringify({ agent: 'codex', session: 'csess', argv: ['/codex'] }),
  );
  process.env.HERDR_BIN_PATH = executable;
  process.env.HERDR_PLUGIN_STATE_DIR = directory;

  assert.deepEqual(restorePanes(), {
    restored: 0,
    actions: [{
      pane_id: 'w1:p1',
      agent: 'codex',
      session: 'csess',
      skipped: 'stale_record',
      pane_agent: 'claude',
      pane_session: 'csess',
    }],
  });

  fs.rmSync(directory, { recursive: true, force: true });
  delete process.env.HERDR_BIN_PATH;
  delete process.env.HERDR_PLUGIN_STATE_DIR;
});

test('reports saved records and their pane state', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-durable-'));
  const executable = path.join(directory, 'herdr');
  const codexDirectory = path.join(directory, 'codex');
  const piDirectory = path.join(directory, 'pi');
  const panes = [
    { pane_id: 'w1:p1', label: 'one', agent_session: { agent: 'codex', value: 'sess' } },
  ];
  fs.writeFileSync(executable, `#!/bin/sh
case "$1 $2" in
  'pane list') printf '%s\\n' '${JSON.stringify({ id: 'x', result: { panes } })}' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`);
  fs.chmodSync(executable, 0o755);
  fs.mkdirSync(codexDirectory, { recursive: true });
  fs.mkdirSync(piDirectory, { recursive: true });
  fs.writeFileSync(path.join(codexDirectory, 'rollout-sess.jsonl'), '');
  fs.mkdirSync(path.join(directory, 'panes'), { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'panes', 'w1%3Ap1.json'),
    JSON.stringify({ agent: 'codex', session: 'sess', argv: ['/codex'] }),
  );
  fs.writeFileSync(
    path.join(directory, 'panes', 'w9%3Ap9.json'),
    JSON.stringify({ agent: 'pi', session: path.join(piDirectory, 'gone.jsonl'), argv: ['/pi'] }),
  );
  process.env.HERDR_BIN_PATH = executable;
  process.env.HERDR_PLUGIN_STATE_DIR = directory;
  process.env.HERDR_DURABLE_CODEX_SESSIONS = codexDirectory;
  process.env.HERDR_DURABLE_PI_SESSIONS = piDirectory;

  assert.deepEqual(status(), {
    saved: 2,
    records: [
      {
        pane_id: 'w1:p1',
        label: 'one',
        saved_agent: 'codex',
        saved_session: 'sess',
        pane_agent: 'codex',
        pane_session: 'sess',
        matches_pane: true,
        session_exists: true,
        orphaned: false,
      },
      {
        pane_id: 'w9:p9',
        label: null,
        saved_agent: 'pi',
        saved_session: path.join(piDirectory, 'gone.jsonl'),
        pane_agent: null,
        pane_session: null,
        matches_pane: false,
        session_exists: true,
        orphaned: true,
      },
    ],
  });

  fs.rmSync(directory, { recursive: true, force: true });
  delete process.env.HERDR_BIN_PATH;
  delete process.env.HERDR_PLUGIN_STATE_DIR;
  delete process.env.HERDR_DURABLE_CODEX_SESSIONS;
  delete process.env.HERDR_DURABLE_PI_SESSIONS;
});

test('startup retries until the Herdr API returns data', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-durable-'));
  const executable = path.join(directory, 'herdr');
  fs.writeFileSync(executable, `#!/bin/sh\ncount_file="$PWD/count"\ncount=$(cat "$count_file" 2>/dev/null || echo 0)\ncount=$((count + 1))\necho "$count" > "$count_file"\nif [ "$count" -lt 3 ]; then\n  exit 1\nfi\nprintf '%s\\n' '{"id":"x","result":{"panes":[]}}'\n`);
  fs.chmodSync(executable, 0o755);
  process.env.HERDR_BIN_PATH = executable;
  const child = spawn(
    process.execPath,
    [path.join(__dirname, 'plugin.js'), 'restore'],
    {
      env: { ...process.env, HERDR_BIN_PATH: executable, HERDR_PLUGIN_STATE_DIR: directory },
      cwd: directory,
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [exit] = await once(child, 'exit');
  if (exit !== 0) throw new Error(stderr || `plugin exited with ${exit}`);
  const output = JSON.parse(stdout);
  assert.deepEqual(output, { restored: 0, actions: [] });
  fs.rmSync(directory, { recursive: true, force: true });
  delete process.env.HERDR_BIN_PATH;
});

test('installer edits resume setting idempotently', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-durable-'));
  const file = path.join(directory, 'config.toml');
  process.env.HERDR_CONFIG_PATH = file;
  updateConfig(false);
  assert.match(fs.readFileSync(file, 'utf8'), /resume_agents_on_restore = false/);
  updateConfig(false);
  assert.equal(fs.readFileSync(file, 'utf8').match(/resume_agents_on_restore = false/g).length, 1);
  updateConfig(true);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /resume_agents_on_restore/);
  delete process.env.HERDR_CONFIG_PATH;
});

test('installer preserves an existing session section', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-durable-'));
  const file = path.join(directory, 'config.toml');
  fs.writeFileSync(file, '[session]\nresume_agents_on_restore = true\n');
  process.env.HERDR_CONFIG_PATH = file;
  updateConfig(false);
  const content = fs.readFileSync(file, 'utf8');
  assert.equal(content.match(/^\[session\]$/gm).length, 1);
  assert.match(content, /\[session\]\nresume_agents_on_restore = false\n/);
  updateConfig(true);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /resume_agents_on_restore/);
  fs.rmSync(directory, { recursive: true, force: true });
  delete process.env.HERDR_CONFIG_PATH;
});
