#!/usr/bin/env node
import { spawn } from 'node:child_process';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.PORT || 3000);
const SESSION_PATH = process.env.TELEGRAM_SESSION_PATH || path.join(process.cwd(), '.session', 'telegram-session');
const TG_BIN = process.env.TELEGRAM_MCP_BIN || path.join(process.cwd(), 'node_modules', '@overpod', 'mcp-telegram', 'dist', 'index.js');
const sessions = new Map();

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

ensureDir(SESSION_PATH);

function spawnTelegram() {
  const child = spawn('node', [TG_BIN], {
    env: {
      ...process.env,
      TELEGRAM_SESSION_PATH: SESSION_PATH,
      MCP_TELEGRAM_DAEMON: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();
  let buf = '';
  let qrCode = '';

  child.stdout.on('data', d => {
    buf += d.toString();
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg?.id !== undefined && pending.has(msg.id)) {
          const { resolve } = pending.get(msg.id);
          pending.delete(msg.id);
          resolve(msg);
        }
      } catch {}
    }
  });

  child.stderr.on('data', d => {
    const text = d.toString();
    process.stderr.write('[tg] ' + text);
    if (text.includes('Scan the QR code') || text.includes('▄▄▄')) qrCode = text;
  });

  child.on('exit', code => console.error('[tg] exited with code', code));

  return {
    child,
    qrCode: () => qrCode,
    send(msg, timeoutMs = 120000) {
      return new Promise((resolve, reject) => {
        const id = msg.id ?? randomUUID();
        msg.id = id;
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify(msg) + '\n');
        const t = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error('mcp-telegram timeout'));
          }
        }, timeoutMs);
        t.unref?.();
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
  if (req.method === 'OPTIONS') return void res.writeHead(204).end();

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return void res.end(JSON.stringify({
      status: 'ok',
      sessions: sessions.size,
      sessionPath: SESSION_PATH,
      hasSession: fs.existsSync(SESSION_PATH),
      telegramBin: TG_BIN,
      port: PORT,
    }));
  }

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
      if (qr && !qrOutput.includes(qr)) qrOutput.push(qr);
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
      }));
    }, 35000);
    return;
  }

  if (req.url !== '/mcp') return void (res.writeHead(404), res.end('Not found'));

  let body = '';
  req.on('data', c => (body += c));
  await new Promise(r => req.on('end', r));

  let msg;
  try { msg = JSON.parse(body); } catch { return void (res.writeHead(400), res.end('Invalid JSON')); }

  let sessionId = req.headers['mcp-session-id'];
  if (msg.method === 'initialize' || !sessionId) {
    sessionId = randomUUID();
    const session = spawnTelegram();
    sessions.set(sessionId, session);
    session.child.on('exit', () => sessions.delete(sessionId));
    try {
      const result = await session.send(msg);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': sessionId });
      return void res.end(JSON.stringify(result));
    } catch (e) {
      sessions.delete(sessionId);
      res.writeHead(500);
      return void res.end(e.message);
    }
  }

  const session = sessions.get(sessionId);
  if (!session) return void (res.writeHead(404), res.end('Session not found'));

  if (msg.id === undefined) {
    session.notify(msg);
    return void (res.writeHead(202), res.end());
  }

  try {
    const result = await session.send(msg);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': sessionId });
    res.end(JSON.stringify(result));
  } catch (e) {
    res.writeHead(500);
    res.end(e.message);
  }
});

server.on('error', err => {
  console.error('[mcp-bridge] server error:', err.message);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[mcp-bridge] running on http://0.0.0.0:${PORT}/mcp`);
  console.log(`[mcp-bridge] health http://0.0.0.0:${PORT}/health`);
  console.log(`[mcp-bridge] login http://0.0.0.0:${PORT}/login`);
});
