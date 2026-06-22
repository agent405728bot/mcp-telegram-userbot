#!/usr/bin/env node
/**
 * Thin launcher for @overpod/mcp-telegram (stdio MCP).
 * Moltis and other MCP hosts spawn this binary and talk JSON-RPC over stdin/stdout.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const telegramEntry = path.join(
  __dirname,
  'node_modules',
  '@overpod',
  'mcp-telegram',
  'dist',
  'index.js',
);

const child = spawn(process.execPath, [telegramEntry], {
  env: { ...process.env, MCP_TELEGRAM_DAEMON: '0' },
  stdio: 'inherit',
});

child.on('error', (err) => {
  console.error('Failed to start @overpod/mcp-telegram:', err.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
