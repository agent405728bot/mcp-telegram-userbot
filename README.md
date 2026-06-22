# mcp-telegram-userbot

MCP server for Telegram user account access via HTTP.

## Quick Start

### 1. Get Telegram API Credentials
Go to https://my.telegram.org/apps and grab **API ID** and **API hash**.

### 2. Install & Run
```bash
export TELEGRAM_API_ID=your_id
export TELEGRAM_API_HASH=your_hash
npx @agent405728bot/mcp-telegram-userbot
```

Server runs on `http://localhost:3000`

### 3. First Login
```bash
curl http://localhost:3000/login
```
Check terminal for QR code, scan in Telegram: **Settings → Devices → Link Desktop Device**

## Add to Moltis
```toml
[mcp.servers.telegram-userbot]
command = "npx"
args = ["-y", "@agent405728bot/mcp-telegram-userbot"]
env = { TELEGRAM_API_ID = "...", TELEGRAM_API_HASH = "..." }
```

## Authentication Setup
```bash
npm login --registry https://npm.pkg.github.com
# or add to ~/.npmrc:
# @agent405728bot:registry=https://npm.pkg.github.com
# //npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
```

## Endpoints
- `GET /health` - Check status
- `GET /login` - Start QR login
- `POST /mcp` - MCP JSON-RPC

## Environment Variables
- `TELEGRAM_API_ID` - Required
- `TELEGRAM_API_HASH` - Required
- `TELEGRAM_SESSION_PATH` - Session file path (default: `~/.mcp-telegram-session`)
- `PORT` - HTTP port (default: `3000`)

## Publishing
Automatic via GitHub Actions on git tags:
```bash
npm version patch
git push origin main --tags
```

## License
MIT
