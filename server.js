#!/usr/bin/env node
// MCP stdio -> Streamable HTTP bridge for mcp-telegram
import { spawn } from 'node:child_process';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = process.env.PORT || 3000;
const sessions = new Map();

function spawnTelegram() {
  const child = spawn('node', [
    '/app/node_modules/@overpod/mcp-telegram/dist/index.js'
  ], {
    env: {
      PATH: process.env.PATH,
      TELEGRAM_API_ID: process.env.TELEGRAM_API_ID,
      TELEGRAM_API_HASH: process.env.TELEGRAM_API_HASH,
      TELEGRAM_SESSION_PATH: process.env.TELEGRAM_SESSION_PATH || '/data/session',
      // Keep daemon mode disabled inside container — each session is standalone
      MCP_TELEGRAM_DAEMON: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();
  let buf = '';

  child.stdout.on('data', d => {
    buf += d.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const id = msg.id;
        if (id !== undefined && pending.has(id)) {
          const { resolve } = pending.get(id);
          pending.delete(id);
          resolve(msg);
        }
      } catch {}
    }
  });

  child.stderr.on('data', d => process.stderr.write('[tg] ' + d));
  child.on('exit', code => console.error('[tg] exited with code', code));

  return {
    child,
    pending,
    send(msg) {
      return new Promise((resolve, reject) => {
        const id = msg.id ?? randomUUID();
        msg.id = id;
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify(msg) + '\n');
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error('mcp-telegram timeout'));
          }
        }, 60000);
      });
    },
    notify(msg) {
      child.stdin.write(JSON.stringify(msg) + '\n');
    }
  };
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', sessions: sessions.size }));
    return;
  }

  if (req.url !== '/mcp') { res.writeHead(404); res.end('Not found'); return; }

  let body = '';
  req.on('data', c => body += c);
  await new Promise(r => req.on('end', r));

  let msg;
  try { msg = JSON.parse(body); } catch {
    res.writeHead(400); res.end('Invalid JSON'); return;
  }

  let sessionId = req.headers['mcp-session-id'];

  // New session on initialize or missing session ID
  if (msg.method === 'initialize' || !sessionId) {
    sessionId = randomUUID();
    const session = spawnTelegram();
    sessions.set(sessionId, session);
    console.log('[bridge] new session', sessionId, '| total:', sessions.size);

    session.child.on('exit', () => {
      sessions.delete(sessionId);
      console.log('[bridge] session ended', sessionId);
    });

    try {
      const result = await session.send(msg);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Mcp-Session-Id': sessionId,
      });
      res.end(JSON.stringify(result));
    } catch (e) {
      sessions.delete(sessionId);
      res.writeHead(500); res.end(e.message);
    }
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) { res.writeHead(404); res.end('Session not found'); return; }

  // Notifications (no id) — fire and forget
  if (msg.id === undefined) {
    session.notify(msg);
    res.writeHead(202); res.end();
    return;
  }

  try {
    const result = await session.send(msg);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': sessionId });
    res.end(JSON.stringify(result));
  } catch (e) {
    res.writeHead(500); res.end(e.message);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[mcp-bridge] MCP HTTP bridge running on http://0.0.0.0:${PORT}/mcp`);
  console.log(`[mcp-bridge] Health check: GET http://0.0.0.0:${PORT}/health`);
});
