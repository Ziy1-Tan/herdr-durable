#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function configPath() {
  return process.env.HERDR_CONFIG_PATH || path.join(os.homedir(), '.config', 'herdr', 'config.toml');
}

function nativeResumeEnabled() {
  let content;
  try {
    content = fs.readFileSync(configPath(), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }

  let section = '';
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/\s+#.*$/, '');
    if (!line || line.startsWith('#')) continue;
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      section = header[1].trim();
      continue;
    }
    const setting = line.match(/^(session\.)?resume_agents_on_restore\s*=\s*(true|false)$/);
    if (!setting) continue;
    if (section === 'session' || (section === '' && setting[1])) return setting[2] === 'true';
  }
  return true;
}

function main() {
  if (process.argv[2] !== 'check') throw new Error('Usage: node configure.js check');
  if (!nativeResumeEnabled()) {
    throw new Error('session.resume_agents_on_restore is false; remove it or set it to true (see README)');
  }
}

let invokedAsScript = false;
try {
  invokedAsScript = process.argv[1] !== undefined
    && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
} catch {}

if (invokedAsScript) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

export { nativeResumeEnabled };
