# mcp-telegram-userbot

Stdio MCP server for Telegram user account access. This package wraps [`@overpod/mcp-telegram`](https://www.npmjs.com/package/@overpod/mcp-telegram) with env validation and a stable GitHub Packages name for `npx` installs.

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

## Versioning

Published versions use semver **`1.0.N`**, where `N` is a monotonic build number from [`onyxmueller/build-tag-number`](https://github.com/onyxmueller/build-tag-number) in CI.

- Source `package.json` stays at `1.0.0` (placeholder).
- Each push to `main` publishes `1.0.{build}` and tags `v1.0.{build}`.

Pin a specific build:

```bash
npx @agent405728bot/mcp-telegram-userbot@1.0.42
```

## Publishing

Publishing is automatic on push to `main` via `.github/workflows/publish.yml`. Manual runs are supported via **workflow_dispatch**.

## License

MIT
