const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const {
  readState,
  launchArgv,
  normalizeAgent,
  parseEvent,
  readProcArgv,
  shellCommand,
  shouldRestore,
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

test('builds agent-specific resume commands', () => {
  assert.deepEqual(launchArgv('codex', ['/codex', '--yolo'], 'id'), ['codex', '--yolo', 'resume', 'id']);
  assert.deepEqual(launchArgv('codex', ['/codex', '--yolo', 'resume', 'old'], 'id'), ['codex', '--yolo', 'resume', 'id']);
  assert.deepEqual(launchArgv('claude', ['/claude', '--model', 'x'], 'id'), ['claude', '--model', 'x', '--resume', 'id']);
  assert.deepEqual(launchArgv('claude', ['/claude', '--model', 'x', '--resume', 'old'], 'id'), ['claude', '--model', 'x', '--resume', 'id']);
  assert.deepEqual(launchArgv('pi', ['/pi', '--profile', 'x'], 'path'), ['pi', '--profile', 'x', '--session', 'path']);
  assert.deepEqual(launchArgv('pi', ['/pi', '--profile', 'x', '--session', 'old'], 'path'), ['pi', '--profile', 'x', '--session', 'path']);
  assert.deepEqual(launchArgv('pi', ['pi'], 'path'), ['pi', '--session', 'path']);
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

test('reads argv from proc', () => {
  assert.equal(readProcArgv(999999999), null);
  assert.equal(readProcArgv(process.pid)[0], process.execPath);
});

test('treats missing or invalid state as empty', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-durable-'));
  process.env.HERDR_PLUGIN_STATE_DIR = directory;
  fs.writeFileSync(path.join(directory, 'state.json'), '');
  assert.deepEqual(readState(), { version: 1, panes: {} });
  fs.writeFileSync(path.join(directory, 'state.json'), '{');
  assert.deepEqual(readState(), { version: 1, panes: {} });
  fs.rmSync(directory, { recursive: true, force: true });
  delete process.env.HERDR_PLUGIN_STATE_DIR;
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
