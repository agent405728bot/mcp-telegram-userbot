# mcp-telegram-userbot

A **standalone npm package** that runs a Telegram user account as an MCP server accessible via HTTP.

**No Docker required.** Just:

```bash
npx @agent405728bot/mcp-telegram-userbot
```

## Quick Start

### 1. Get Telegram API Credentials

- Go to https://my.telegram.org/apps
- Log in with your phone number
- Create an app (or use existing)
- Copy the **API ID** and **API hash**

### 2. Start the Server

```bash
export TELEGRAM_API_ID=your_api_id
export TELEGRAM_API_HASH=your_api_hash
npx @agent405728bot/mcp-telegram-userbot
```

Server starts on `http://localhost:3000`

### 3. First Time: Log In

```bash
curl http://localhost:3000/login
```

- **Check the terminal** for a QR code
- Scan it in **Telegram app**: Settings → Devices → Link Desktop Device
- Session saves to `~/.mcp-telegram-session`
- Server automatically uses the saved session on restart

## Add to Moltis

Once logged in, add to your `moltis.toml`:

```toml
[mcp.servers.telegram-userbot]
transport = "streamable-http"
url = "http://localhost:3000/mcp"
```

Then restart Moltis. Your agent now has Telegram tools.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Check status & session state |
| `GET` | `/login` | Start login (scan QR code) |
| `POST` | `/mcp` | MCP JSON-RPC (set `Mcp-Session-Id` header) |

## Environment Variables

| Variable | Required | Notes |
|----------|----------|-------|
| `TELEGRAM_API_ID` | Yes | From my.telegram.org |
| `TELEGRAM_API_HASH` | Yes | From my.telegram.org |
| `TELEGRAM_SESSION_PATH` | No | Session file path (default: `~/.mcp-telegram-session`) |
| `PORT` | No | HTTP port (default: `3000`) |

## How It Works

1. **npx runs** the CLI entry point
2. **HTTP server** spawns on port 3000
3. **@overpod/mcp-telegram** subprocess runs internally
4. **Session management** via file (`~/.mcp-telegram-session`)
5. **MCP clients** (like Moltis) connect via HTTP

## Differences from Docker

| Aspect | Docker | NPX |
|--------|--------|-----|
| Setup | `docker run` | `npx` |
| Process | Containerized | Direct process |
| Session | `/data/session` | `~/.mcp-telegram-session` |
| Port binding | Manual `-p` | Auto on 3000 |
| Node.js | In image | On host |

## Troubleshooting

### Can't scan QR code

- Run `curl http://localhost:3000/login` in a terminal that can display logs
- Check the previous 30 seconds of output
- Terminal must support Unicode for QR display

### "Session not found"

- First login required: `curl http://localhost:3000/login`
- Check `~/.mcp-telegram-session` exists

### Port 3000 already in use

```bash
PORT=3001 npx @agent405728bot/mcp-telegram-userbot
```

## License

MIT

## Credits

Built on [@overpod/mcp-telegram](https://www.npmjs.com/package/@overpod/mcp-telegram)
