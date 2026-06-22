# mcp-telegram-userbot

A Docker image that wraps [@overpod/mcp-telegram](https://www.npmjs.com/package/@overpod/mcp-telegram) with an HTTP bridge, making it usable as a **Streamable HTTP MCP server** instead of stdio-only.

## How it works

- Runs an HTTP server on port `3000`
- Each MCP session spawns a `mcp-telegram` subprocess connected to Telegram via your session file
- Routes MCP JSON-RPC over HTTP (`POST /mcp`) with session tracking via `Mcp-Session-Id` header
- **Built-in login endpoint** (`GET /login`) — scan QR code to authenticate
- Health check at `GET /health`

## Docker image

Pre-built image available at:
```
ghcr.io/agent405728bot/mcp-telegram-userbot:latest
```

## Quick Start (No Pre-Existing Session)

```bash
# Run the container
docker run -d \
  --name mcp-telegram \
  --restart=always \
  -p 3000:3000 \
  -e TELEGRAM_API_ID=34259509 \
  -e TELEGRAM_API_HASH=8aaf4251d4f520d90037a32bf6a524ea \
  -v /tmp/tg-session:/data \
  ghcr.io/agent405728bot/mcp-telegram-userbot:latest

# Check logs to see the login URL
docker logs mcp-telegram -f

# In another terminal, login via HTTP
curl http://localhost:3000/login

# Follow the instructions:
# 1. Check logs for QR code
# 2. Scan in Telegram app: Settings → Devices → Link Desktop Device
# 3. Session will be saved to /tmp/tg-session
# 4. Restart container: docker restart mcp-telegram
```

## Usage with Existing Session

If you already have a Telegram session file:

```bash
docker run -d \
  --name mcp-telegram \
  --restart=always \
  -p 3000:3000 \
  -e TELEGRAM_API_ID=34259509 \
  -e TELEGRAM_API_HASH=8aaf4251d4f520d90037a32bf6a524ea \
  -v /path/to/session.session:/data/session.session:ro \
  ghcr.io/agent405728bot/mcp-telegram-userbot:latest
```

## API Endpoints

### Health Check
```bash
GET /health
```
Response: `{"status":"ok","sessions":0,"sessionPath":"/data/session","hasSession":true}`

### Login
```bash
GET /login
```
Returns QR code and instructions. Keep checking logs while scanning:
```bash
docker logs mcp-telegram -f
```

### MCP Server
```
POST /mcp
Header: Mcp-Session-Id: <session-id>
Body: JSON-RPC message
```

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `TELEGRAM_API_ID` | Your Telegram API ID from my.telegram.org | Required |
| `TELEGRAM_API_HASH` | Your Telegram API hash | Required |
| `TELEGRAM_SESSION_PATH` | Session file path inside container | `/data/session` |
| `PORT` | HTTP port | `3000` |

## MCP Server config (moltis / mcp-servers.json)

```json
{
  "servers": {
    "telegram-userbot": {
      "transport": "streamable-http",
      "url": "http://localhost:3000/mcp",
      "display_name": "Telegram Userbot"
    }
  }
}
```

Then restart Moltis to load the server.

## Troubleshooting

### I need to login

1. Run `curl http://localhost:3000/login`
2. Check container logs: `docker logs mcp-telegram -f`
3. Look for the QR code in the logs
4. Scan it in Telegram: **Settings → Devices → Link Desktop Device**
5. The session saves to `/data/session` (or your mapped volume)
6. Restart: `docker restart mcp-telegram`

### Session file not being created

- Check volume mount: `docker exec mcp-telegram ls -la /data/`
- Verify API credentials are correct
- Check logs: `docker logs mcp-telegram`

### Connection refused

- Is the container running? `docker ps | grep mcp-telegram`
- Is port 3000 in use? `netstat -tlnp | grep 3000`
- Try a different port: `-p 3001:3000`
