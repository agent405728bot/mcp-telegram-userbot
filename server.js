#!/usr/bin/env node
/**
 * Launcher for bundled MCP Telegram server (stdio MCP).
 * Moltis and other MCP hosts spawn this binary and talk JSON-RPC over stdin/stdout.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`ERROR: Missing required environment variable: ${name}`);
    console.error('  Get TELEGRAM_API_ID and TELEGRAM_API_HASH from https://my.telegram.org/apps');
    process.exit(1);
  }
  return value;
}

requireEnv('TELEGRAM_API_ID');
requireEnv('TELEGRAM_API_HASH');

const localEntry = path.join(__dirname, 'dist', 'index.js');
if (!existsSync(localEntry)) {
  console.error('ERROR: Cannot find dist/index.js. Did you forget to build?');
  process.exit(1);
}

const child = spawn(process.execPath, [localEntry], {
  env: { ...process.env, MCP_TELEGRAM_DAEMON: '0' },
  stdio: 'inherit',
});

child.on('error', (err) => {
  console.error('Failed to start MCP Telegram server:', err.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
