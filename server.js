#!/usr/bin/env node
import { spawn } from 'node:child_process';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const SESSION_PATH = process.env.TELEGRAM_SESSION_PATH || path.join(os.homedir(), '.mcp-telegram-session');

if (!process.env.TELEGRAM_API_ID || !process.env.TELEGRAM_API_HASH) {
  console.error('ERROR: Missing required environment variables:');
  console.error('  TELEGRAM_API_ID - Get from https://my.telegram.org/apps');
  console.error('  TELEGRAM_API_HASH - Get from https://my.telegram.org/apps');
  process.exit(1);
}

const sessions = new Map();

// Ensure session directory exists
const sessionDir = path.dirname(SESSION_PATH);
if (!fs.existsSync(sessionDir)) {
  fs.mkdirSync(sessionDir, { recursive: true });
}

function spawnTelegram() {
  const telegramPath = path.join(__dirname, 'node_modules', '@overpod', 'mcp-telegram', 'dist', 'index.js');
  const child = spawn('node', [telegramPath], {
    env: { ...process.env, MCP_TELEGRAM_DAEMON: '0' },
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
        }, 120000);
      });
    },
    notify(msg) {
      child.stdin.write(JSON.stringify(msg) + '\n');
    },
  };
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      sessions: sessions.size,
      sessionPath: SESSION_PATH,
      hasSession: fs.existsSync(SESSION_PATH),
      port: PORT,
    }));
    return;
  }

  // Login endpoint
  if (req.method === 'GET' && req.url === '/login') {
    const loginSession = spawnTelegram();

    loginSession.send({
      jsonrpc: '2.0',
      id: 'login-init',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'login-client', version: '1' },
      },
    }).catch(e => console.error('Login init error:', e));

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
          '📱 Check the terminal output above for the QR code',
          '👀 Scan it in the Telegram app: Settings → Devices → Link Desktop Device',
          '⏱️  You have ~30 seconds to scan',
          '💾 The session will be saved to: ' + SESSION_PATH,
          '🔄 Once logged in, the server will automatically use the saved session',
        ],
      }));
    }, 35000);
    return;
  }

  // MCP endpoint
  if (req.url !== '/mcp') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  let body = '';
  req.on('data', c => (body += c));
  await new Promise(r => req.on('end', r));

  let msg;
  try {
    msg = JSON.parse(body);
  } catch {
    res.writeHead(400);
    res.end('Invalid JSON');
    return;
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
      res.writeHead(500);
      res.end(e.message);
    }
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    res.writeHead(404);
    res.end('Session not found');
    return;
  }

  // Notifications (no id) — fire and forget
  if (msg.id === undefined) {
    session.notify(msg);
    res.writeHead(202);
    res.end();
    return;
  }

  try {
    const result = await session.send(msg);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Mcp-Session-Id': sessionId,
    });
    res.end(JSON.stringify(result));
  } catch (e) {
    res.writeHead(500);
    res.end(e.message);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✨ MCP Telegram Userbot`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📍 MCP:    http://localhost:${PORT}/mcp`);
  console.log(`🏥 Health: http://localhost:${PORT}/health`);
  console.log(`🔐 Login:  http://localhost:${PORT}/login`);
  console.log(`\n1️⃣  curl http://localhost:${PORT}/login`);
  console.log(`2️⃣  Scan QR in terminal`);
  console.log(`3️⃣  Settings → Devices → Link Desktop Device\n`);
});

process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  for (const [, session] of sessions) {
    session.child.kill();
  }
  server.close();
  process.exit(0);
});
