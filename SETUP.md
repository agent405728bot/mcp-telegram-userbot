# Setup Instructions for mcp-telegram-userbot

This guide explains how to run the pre-built Docker image and configure it as an MCP server for Moltis.

---

## Step 1: Get your Telegram Session File

The image needs a Telegram session file to authenticate. If you don't have one yet:

```bash
# Clone the mcp-telegram repo and create a session
git clone https://github.com/mcp-telegram/mcp-telegram.git
cd mcp-telegram

# Login (interactive - follow the QR code prompt)
TELEGRAM_API_ID=34259509 \
TELEGRAM_API_HASH=8aaf4251d4f520d90037a32bf6a524ea \
npx @overpod/mcp-telegram login

# Your session is now saved to ~/.mcp-telegram/session
```

Copy the session file to a known location on your machine:
```bash
cp ~/.mcp-telegram/session /path/to/your/tg-session.session
```

---

## Step 2: Run the Docker Container

```bash
docker run -d \
  --name mcp-telegram \
  --restart=always \
  -p 3000:3000 \
  -e TELEGRAM_API_ID=34259509 \
  -e TELEGRAM_API_HASH=8aaf4251d4f520d90037a32bf6a524ea \
  -v /path/to/your/tg-session.session:/data/session.session:ro \
  ghcr.io/agent405728bot/mcp-telegram-userbot:latest
```

Replace `/path/to/your/tg-session.session` with the actual path to your session file.

### Verify it's running

```bash
# Check container status
docker ps | grep mcp-telegram

# Check logs
docker logs mcp-telegram

# Test health endpoint
curl http://localhost:3000/health
# Should return: {"status":"ok","sessions":0}
```

---

## Step 3: Add MCP Server to Moltis

Edit your **`mcp-servers.json`** file (usually at `~/.moltis/mcp-servers.json` or `/root/.moltis/mcp-servers.json`):

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

Then restart Moltis (or reload via the UI).

---

## Step 4: Test the MCP Server

In Moltis, you should now have access to Telegram tools. Test with:

```
Run telegram-status
```

This will call the `telegram-status` tool from the MCP server running in Docker.

---

## Troubleshooting

### Container won't start
```bash
# Check logs
docker logs mcp-telegram -f

# Common issues:
# - Missing session file: ensure -v flag points to existing file
# - Port 3000 already in use: change to -p 3001:3000
# - Wrong API credentials: verify TELEGRAM_API_ID and TELEGRAM_API_HASH
```

### Connection refused
```bash
# Verify the container is listening
docker exec mcp-telegram netstat -tlnp 2>/dev/null | grep 3000

# Or from host
netstat -tlnp | grep 3000
```

### Session file issues
The session file must exist at the path you mount. It's read-only (`:ro`), so permission issues are unlikely.

If you need to regenerate the session:
```bash
# Inside the container or via npx
npx @overpod/mcp-telegram login
```

---

## How it Works

The Docker image runs a lightweight Node.js HTTP server that:
1. Listens on port 3000 at `/mcp` endpoint
2. Accepts MCP JSON-RPC messages
3. Spawns `mcp-telegram` subprocesses on demand for each session
4. Routes messages between Moltis (HTTP) and Telegram (stdio)
5. Maintains session state (each client is stateful per `Mcp-Session-Id` header)

This allows Moltis to use Telegram tools via HTTP instead of requiring stdio access.
