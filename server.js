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
const loginSessions = new Map();

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
  let qrCodeAscii = null;

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
    
    if (text.includes('Scan the QR code') || text.includes('https://qr.telegram.org')) {
      const match = text.match(/https:\/\/qr\.telegram\.org\/[^\s]+/);
      if (match) {
        qrCode = match[0];
      }
    }
    
    if (text.match(/[▄▀█]/)) {
      qrCodeAscii = text;
    }
  });

  child.on('exit', code => console.error('[tg] exited with code', code));

  return {
    child,
    pending,
    getQrCode: () => qrCode,
    getQrCodeAscii: () => qrCodeAscii,
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

const tools = [
  {
    name: 'telegram_login_start',
    description: 'Start a Telegram login session and get QR code for scanning',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'telegram_login_status',
    description: 'Check the status of a login session and get the QR code',
    inputSchema: {
      type: 'object',
      properties: {
        login_id: {
          type: 'string',
          description: 'The login session ID returned by telegram_login_start',
        },
      },
      required: ['login_id'],
    },
  },
  {
    name: 'telegram_list_sessions',
    description: 'List all active Telegram sessions',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      sessions: sessions.size,
      loginSessions: loginSessions.size,
      sessionPath: SESSION_PATH,
      hasSession: fs.existsSync(SESSION_PATH),
      port: PORT,
    }));
    return;
  }

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

  // Handle tool calls
  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params;

    try {
      let result;

      if (name === 'telegram_login_start') {
        const loginId = randomUUID();
        const loginSession = spawnTelegram();
        loginSessions.set(loginId, {
          session: loginSession,
          createdAt: Date.now(),
          qrCode: null,
          qrCodeAscii: null,
        });

        await loginSession.send({
          jsonrpc: '2.0',
          id: 'login-init',
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'login-client', version: '1' },
          },
        }).catch(e => console.error('Login init error:', e));

        const captureInterval = setInterval(() => {
          const qr = loginSession.getQrCode();
          const qrAscii = loginSession.getQrCodeAscii();
          const loginData = loginSessions.get(loginId);
          if (loginData) {
            if (qr) loginData.qrCode = qr;
            if (qrAscii) loginData.qrCodeAscii = qrAscii;
          }
        }, 500);

        setTimeout(() => {
          clearInterval(captureInterval);
          loginSession.child.kill();
          loginSessions.delete(loginId);
        }, 300000);

        result = {
          content: [
            {
              type: 'text',
              text: `Login session started.\nLogin ID: ${loginId}\n\nUse telegram_login_status with this ID to check progress and get the QR code.`,
            },
          ],
        };
      } else if (name === 'telegram_login_status') {
        const loginId = args.login_id;
        const loginData = loginSessions.get(loginId);

        if (!loginData) {
          result = {
            content: [
              {
                type: 'text',
                text: `Login session not found: ${loginId}`,
              },
            ],
            isError: true,
          };
        } else {
          let statusText = `Login Session: ${loginId}\n\n`;
          statusText += `Status: Active\n`;
          statusText += `Duration: ${Math.floor((Date.now() - loginData.createdAt) / 1000)}s\n\n`;

          if (loginData.qrCode) {
            statusText += `QR Code URL:\n${loginData.qrCode}\n\n`;
          }

          if (loginData.qrCodeAscii) {
            statusText += `QR Code (ASCII):\n\`\`\`\n${loginData.qrCodeAscii}\n\`\`\`\n\n`;
          } else {
            statusText += `(Waiting for QR code... Check your terminal output)\n\n`;
          }

          statusText += `📱 Instructions:\n`;
          statusText += `1. Open Telegram\n`;
          statusText += `2. Go to Settings → Devices\n`;
          statusText += `3. Click "Link Desktop Device"\n`;
          statusText += `4. Scan the QR code above\n`;

          result = {
            content: [
              {
                type: 'text',
                text: statusText,
              },
            ],
          };
        }
      } else if (name === 'telegram_list_sessions') {
        let output = `Active Sessions: ${sessions.size}\n`;
        output += `Active Login Sessions: ${loginSessions.size}\n\n`;

        for (const [id, data] of loginSessions) {
          output += `- Login ${id.slice(0, 8)}...\n`;
          if (data.qrCode) {
            output += `  QR: Available ✓\n`;
          }
        }

        result = {
          content: [
            {
              type: 'text',
              text: output,
            },
          ],
        };
      } else {
        result = {
          content: [
            {
              type: 'text',
              text: `Unknown tool: ${name}`,
            },
          ],
          isError: true,
        };
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        content: [{ type: 'text', text: `Error: ${e.message}` }],
        isError: true,
      }));
    }
    return;
  }

  if (msg.method === 'initialize') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: 'telegram-userbot',
        version: '1.1.0',
      },
    }));
    return;
  }

  if (msg.method === 'tools/list') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tools }));
    return;
  }

  let sessionId = req.headers['mcp-session-id'];

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
  console.log(`\n✨ MCP Telegram Userbot v1.1.0`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📍 MCP:    http://localhost:${PORT}/mcp`);
  console.log(`🏥 Health: http://localhost:${PORT}/health`);
  console.log(`\n🛠️ MCP Tools Available:`);
  console.log(`  • telegram_login_start    - Start a login session`);
  console.log(`  • telegram_login_status   - Check login & get QR code`);
  console.log(`  • telegram_list_sessions  - List active sessions\n`);
});

process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  for (const [, session] of sessions) {
    session.child.kill();
  }
  for (const [, data] of loginSessions) {
    data.session.child.kill();
  }
  server.close();
  process.exit(0);
});
