# mcp-telegram-userbot

Stdio MCP server for Telegram user account access. This package bundles [`@overpod/mcp-telegram`](https://www.npmjs.com/package/@overpod/mcp-telegram) with enhanced QR login (image + ASCII art + direct URL) and a stable GitHub Packages name for `npx` installs.

## Quick start

### 1. Get Telegram API credentials

Create an app at https://my.telegram.org/apps and copy **API ID** and **API hash**.

### 2. Authenticate with GitHub Packages

```bash
npm login --registry https://npm.pkg.github.com
```

Or add to `~/.npmrc`:

```ini
@agent405728bot:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
```

### 3. Run

```bash
export TELEGRAM_API_ID=your_id
export TELEGRAM_API_HASH=your_hash
export TELEGRAM_SESSION_PATH=~/.mcp-telegram-session   # optional

npx @agent405728bot/mcp-telegram-userbot
```

The process speaks MCP over **stdio** (stdin/stdout JSON-RPC). Use it with Moltis, Cursor, or any MCP host that spawns a subprocess.

## Add to Moltis

```json
{
  "telegram-userbot": {
    "command": "npx",
    "args": ["-y", "@agent405728bot/mcp-telegram-userbot"],
    "env": {
      "TELEGRAM_API_ID": "your_id",
      "TELEGRAM_API_HASH": "your_hash",
      "TELEGRAM_SESSION_PATH": "/path/to/session"
    }
  }
}
```

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_API_ID` | yes | Telegram API ID |
| `TELEGRAM_API_HASH` | yes | Telegram API hash |
| `TELEGRAM_SESSION_PATH` | no | Session file path (default: `~/.mcp-telegram-session`) |
| `TELEGRAM_2FA_PASSWORD` | no | Two-step verification cloud password (required if 2FA is enabled) |

## QR Login

The `telegram-login` tool now returns:
- **QR image** – standard PNG QR code
- **Login URL** – the raw `tg://login?token=...` URL for copy-paste
- **ASCII QR** – terminal-friendly block-art QR for clients that can't render images

## Versioning

Published versions use semver. Each push to `main` publishes a new version and tags it automatically.

Pin a specific build:

```bash
npx @agent405728bot/mcp-telegram-userbot@1.1.0
```

## Publishing

Publishing is automatic on push to `main` via `.github/workflows/publish.yml`. Manual runs are supported via **workflow_dispatch**.

## License

MIT
