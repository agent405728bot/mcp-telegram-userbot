# mcp-telegram-userbot

A **standalone npm package** for running a Telegram user account as an MCP server accessible via HTTP.

**No Docker required.** Just install and run:

```bash
npm install @agent405728bot/mcp-telegram-userbot
mcp-telegram-userbot
```

Or with `npx`:

```bash
npx @agent405728bot/mcp-telegram-userbot
```

## Prerequisites

- **Node.js** 18+
- **npm** with access to GitHub Packages (private registry)
- **Telegram API credentials** from https://my.telegram.org/apps

## Installation

### As a dependency in your project

```bash
npm install @agent405728bot/mcp-telegram-userbot
```

### Direct CLI usage

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

## Integration with Moltis

Once logged in, add to your `moltis.toml`:

```toml
[mcp.servers.telegram-userbot]
command = "npx"
args = ["-y", "@agent405728bot/mcp-telegram-userbot"]
env = { TELEGRAM_API_ID = "...", TELEGRAM_API_HASH = "..." }
```

Then restart Moltis. Your agent now has Telegram tools.

## Integration with Claude Desktop

Add to your Claude Desktop config:

```json
{
  "mcpServers": {
    "telegram": {
      "command": "npx",
      "args": ["-y", "@agent405728bot/mcp-telegram-userbot"],
      "env": {
        "TELEGRAM_API_ID": "your-api-id",
        "TELEGRAM_API_HASH": "your-api-hash"
      }
    }
  }
}
```

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

### Authentication issues with GitHub Packages

Ensure your `.npmrc` has GitHub Packages configured:

```
@agent405728bot:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
```

Or set the token via environment:
```bash
export NPM_TOKEN=your_github_token
npm install
```

## Publishing

This package is published to GitHub Packages (private registry) automatically via GitHub Actions on git tags.

To publish a new version:

```bash
npm version patch  # or minor/major
git push origin main --tags
```

The GitHub Actions workflow will automatically publish to GitHub Packages.

## License

MIT

## Credits

Built on [@overpod/mcp-telegram](https://www.npmjs.com/package/@overpod/mcp-telegram)
