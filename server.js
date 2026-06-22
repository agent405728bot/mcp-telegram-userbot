#!/usr/bin/env node
/**
 * Thin launcher for @overpod/mcp-telegram (stdio MCP).
 * Moltis and other MCP hosts spawn this binary and talk JSON-RPC over stdin/stdout.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
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

function resolveOverpodEntry() {
  // ESM way (Node >= 14.13.1)
  if (typeof import.meta.resolve === 'function') {
    try {
      const resolved = import.meta.resolve('@overpod/mcp-telegram');
      // import.meta.resolve returns a file:// URL
      return fileURLToPath(resolved);
    } catch {
      // fall through
    }
  }

  // CommonJS fallback via createRequire
  const require = createRequire(import.meta.url);
  try {
    return require.resolve('@overpod/mcp-telegram');
  } catch {
    // fall through
  }

  // Legacy hardcoded paths (npm v6 / flat mode / pnpm)
  const candidates = [
    path.join(__dirname, 'node_modules', '@overpod', 'mcp-telegram', 'dist', 'index.js'),
    path.join(__dirname, '..', '@overpod', 'mcp-telegram', 'dist', 'index.js'),
    path.join(__dirname, '..', '..', '@overpod', 'mcp-telegram', 'dist', 'index.js'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      return p;
    }
  }

  console.error('ERROR: Cannot find @overpod/mcp-telegram package. Is it installed?');
  process.exit(1);
}

const telegramEntry = resolveOverpodEntry();

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
