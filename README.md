# mcp-telegram-userbot

A Docker image that wraps [@overpod/mcp-telegram](https://www.npmjs.com/package/@overpod/mcp-telegram) with an HTTP bridge, making it usable as a **Streamable HTTP MCP server** instead of stdio-only.

## How it works

- Runs an HTTP server on port `3000`
- Each MCP session spawns a `mcp-telegram` subprocess connected to Telegram via your session file
- Routes MCP JSON-RPC over HTTP (`POST /mcp`) with session tracking via `Mcp-Session-Id` header
- Health check at `GET /health`

## Docker image

Pre-built image available at:
```
ghcr.io/agent405728bot/mcp-telegram-userbot:latest
```

## Usage

```bash
docker run -d \
  --name mcp-telegram \
  --restart=always \
  -p 3000:3000 \
  -e TELEGRAM_API_ID=your_api_id \
  -e TELEGRAM_API_HASH=your_api_hash \
  -v /path/to/session.session:/data/session.session \
  ghcr.io/agent405728bot/mcp-telegram-userbot:latest
```

## Environment variables

| Variable | Description |
|---|---|
| `TELEGRAM_API_ID` | Your Telegram API ID from my.telegram.org |
| `TELEGRAM_API_HASH` | Your Telegram API hash |
| `TELEGRAM_SESSION_PATH` | Session file path inside container (default: `/data/session`) |
| `PORT` | HTTP port (default: `3000`) |

## MCP Server config (moltis / mcp-servers.json)

```json
{
  "telegram-userbot": {
    "transport": "streamable-http",
    "url": "http://localhost:3000/mcp"
  }
}
```
