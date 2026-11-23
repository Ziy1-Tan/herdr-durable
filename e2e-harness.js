import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
const HERDR = process.env.HERDR_BIN_PATH || 'herdr';

export function makeHome(prefix) {
  // macOS TMPDIR is too long for the Unix socket path limit, so use /tmp.
  const root = mkdtempSync(join('/tmp', 'hd-' + prefix + '-'));
  const home = join(root, 'home');
  mkdirSync(join(home, '.config', 'herdr'), { recursive: true });
  writeFileSync(join(home, '.zshrc'), '');
  writeFileSync(join(home, '.bashrc'), '');
  writeFileSync(join(home, '.config', 'herdr', 'config.toml'), 'onboarding = false\n');
  return { root, home };
}

// Environment for a Herdr server that cannot see the user's real sessions or plugins.
export function cleanEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home, SHELL: '/bin/sh', ...extra };
  for (const key of Object.keys(env)) {
    if (key.startsWith('HERDR_') || key.startsWith('CODEX_') || key.startsWith('CLAUDE')) delete env[key];
  }
  return { ...env, ...extra };
}

export function linkPlugin(env) {
  const result = spawnSync(HERDR, ['plugin', 'link', REPO_ROOT], { env, encoding: 'utf8', timeout: 15_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('herdr plugin link failed: ' + (result.stderr || result.stdout));
}

export function runHerdr(session, env, args, { timeout = 30_000 } = {}) {
  const result = spawnSync(HERDR, ['--session', session, ...args], {
    encoding: 'utf8',
    env,
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('herdr ' + args.join(' ') + ' failed: ' + (result.stderr || result.stdout));
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

export function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function waitFor(predicate, description, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('timeout waiting for ' + description);
    sleep(100);
  }
}

export function startServer({ session, env, cwd }) {
  const child = spawn(HERDR, ['--session', session, 'server'], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const run = (args, options) => runHerdr(session, env, args, options);

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
      await waitForExit(child);
    },
  };
}

function waitForExit(child, timeout = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error('timeout waiting for Herdr server exit'));
    }, timeout);
    function onExit() {
      clearTimeout(timer);
      resolve();
    }
    child.once('exit', onExit);
  });
}
