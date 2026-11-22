#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONFIG_COMMENT = '# herdr-durable: disable built-in argv-less agent resume';
const DISABLED_SESSION = `${CONFIG_COMMENT}\n[session]\nresume_agents_on_restore = false\n`;

function configPath() {
  return process.env.HERDR_CONFIG_PATH || path.join(os.homedir(), '.config', 'herdr', 'config.toml');
}

function updateConfig(enableRestore) {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let content = '';
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const lines = content.split(/\r?\n/);
  const withoutSetting = lines.filter(line => line.trim() !== 'resume_agents_on_restore = false');
  const next = withoutSetting.filter(line => line.trim() !== CONFIG_COMMENT);
  if (!enableRestore) next.push('', DISABLED_SESSION);
  fs.writeFileSync(file, `${next.join('\n').replace(/\n{3,}/g, '\n\n')}\n`);
}

function main() {
  const mode = process.argv[2];
  if (mode !== 'enable' && mode !== 'disable') {
    throw new Error('Usage: node configure.js <enable|disable>');
  }
  updateConfig(mode === 'enable');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { DISABLED_SESSION, updateConfig };
