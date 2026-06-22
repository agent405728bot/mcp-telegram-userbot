# mcp-telegram-userbot

MCP server for Telegram user account access via HTTP with interactive login tools.

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

## MCP Tools

The server exposes three MCP tools for interactive login:

### `telegram_login_start`
Start a new Telegram login session and begin QR code generation.

**Usage:**
```
Call with no arguments to initiate a login session.
```

**Returns:**
- `login_id`: Use this ID with `telegram_login_status` to check progress

### `telegram_login_status`
Check the status of a login session and retrieve the QR code.

**Parameters:**
- `login_id` (required): The login session ID from `telegram_login_start`

**Returns:**
- Login session status (Active)
- Session duration
- QR code URL (if available)
- QR code as ASCII art (if available)
- Scan instructions

### `telegram_list_sessions`
List all active Telegram sessions and login attempts.

**Usage:**
```
Call with no arguments to list sessions.
```

**Returns:**
- Count of active MCP sessions
- Count of active login sessions
- Details of each login session

## Login Flow

1. **Start login:** Call `telegram_login_start`
2. **Poll for QR:** Repeatedly call `telegram_login_status` with the login ID
3. **Scan QR:** Open Telegram → Settings → Devices → Link Desktop Device
4. **Scan the QR code** from the response
5. **Session established:** The Telegram session will be saved

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
- `GET /health` - Server status and session counts
- `POST /mcp` - MCP JSON-RPC endpoint with tool support

## Environment Variables
- `TELEGRAM_API_ID` - Required
- `TELEGRAM_API_HASH` - Required
- `TELEGRAM_SESSION_PATH` - Session file path (default: `~/.mcp-telegram-session`)
- `PORT` - HTTP port (default: `3000`)

## Architecture

- **MCP Tools**: Interactive login with QR code capture in chat
- **Session Management**: Separate tracking for login vs. active sessions
- **Auto-cleanup**: Login sessions auto-expire after 5 minutes
- **QR Capture**: Supports both URL-based and ASCII art QR codes

## Publishing
Automatic via GitHub Actions on every commit to main:
```bash
git push origin main
# Workflow will auto-publish with version-commit_hash
```

## License
MIT
