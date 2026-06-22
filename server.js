#!/usr/bin/env node
// MCP stdio -> Streamable HTTP bridge for mcp-telegram
import { spawn } from 'node:child_process';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.PORT || 3000;
const SESSION_PATH = process.env.TELEGRAM_SESSION_PATH || '/data/session';
const sessions = new Map();

// Ensure session directory exists
const sessionDir = path.dirname(SESSION_PATH);
if (!fs.existsSync(sessionDir)) {
  fs.mkdirSync(sessionDir, { recursive: true });
}

function spawnTelegram() {
  const child = spawn('node', [
    '/app/node_modules/@overpod/mcp-telegram/dist/index.js'
  ], {
    env: {
      PATH: process.env.PATH,
      TELEGRAM_API_ID: process.env.TELEGRAM_API_ID,
      TELEGRAM_API_HASH: process.env.TELEGRAM_API_HASH,
      TELEGRAM_SESSION_PATH: SESSION_PATH,
      MCP_TELEGRAM_DAEMON: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();
  let buf = '';
  let qrCode = null;

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

  child.stderr.on('data', d => {
    const text = d.toString();
    process.stderr.write('[tg] ' + text);
    // Check if QR code is being output
    if (text.includes('Scan the QR code') || text.includes('▄▄▄')) {
      qrCode = text;
    }
  });

  child.on('exit', code => console.error('[tg] exited with code', code));

  return {
    child,
    pending,
    qrCode: () => qrCode,
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
        }, 120000); // 2 minute timeout for login
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

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok', 
      sessions: sessions.size,
      sessionPath: SESSION_PATH,
      hasSession: fs.existsSync(SESSION_PATH)
    }));
    return;
  }

  // Login endpoint - spawns mcp-telegram login process
  if (req.method === 'GET' && req.url === '/login') {
    const loginSession = spawnTelegram();
    
    // Send login command
    loginSession.send({
      jsonrpc: '2.0',
      id: 'login-init',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'login-client', version: '1' }
      }
    }).catch(e => console.error('Login init error:', e));

    // Capture QR output for ~30 seconds
    const qrOutput = [];
    const captureInterval = setInterval(() => {
      const qr = loginSession.qrCode();
      if (qr && !qrOutput.includes(qr)) {
        qrOutput.push(qr);
        console.log('[login] QR captured');
      }
    }, 500);

    setTimeout(() => {
      clearInterval(captureInterval);
      loginSession.child.kill();
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'qr_ready',
        message: 'Scan the QR code in Telegram: Settings → Devices → Link Desktop Device',
        qr: qrOutput.join('\n'),
        sessionPath: SESSION_PATH,
        notes: [
          'Check the docker logs: docker logs mcp-telegram -f',
          'Scan the QR code in the Telegram app within 30 seconds',
          'The session will be saved to: ' + SESSION_PATH,
          'Once logged in, restart the container'
        ]
      }));
    }, 35000);

    return;
  }

  // MCP endpoint
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
  console.log(`[mcp-bridge] Login endpoint: GET http://0.0.0.0:${PORT}/login`);
  console.log(`[mcp-bridge] Session file: ${SESSION_PATH}`);
});
