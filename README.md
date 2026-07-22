# Claude Code credential proxy

A tiny, **zero-dependency** reverse proxy that lets a friend use *your* Claude
subscription through their own Claude Code CLI — **without ever handing over
your credentials or session files**.

The friend points their CLI's `ANTHROPIC_BASE_URL` at this proxy and sends a
shared secret header. The proxy authenticates them, throws away whatever auth
they sent, injects *your* OAuth token, and forwards everything to
`api.anthropic.com`. Streamed responses (SSE) pass straight through in
real-time.

```
┌──────────────────┐   x-proxy-secret    ┌───────────┐  Bearer <your token>  ┌──────────────────┐
│ Friend's CLI     │ ──────────────────▶ │  proxy    │ ────────────────────▶ │ api.anthropic.com │
│ ANTHROPIC_BASE_  │ ◀────────────────── │ (this app)│ ◀──────────────────── │                   │
│ URL=your-proxy   │    streamed SSE     └───────────┘     streamed SSE       └──────────────────┘
└──────────────────┘
```

## What it does

1. **Listens** for HTTP requests from a remote Claude Code CLI.
2. **Secures** the endpoint with a configurable shared-secret header
   (constant-time comparison) so only your friend can use it.
3. **Overrides** the incoming auth headers — strips the client's
   `authorization` / `x-api-key`, injects your OAuth token as
   `Authorization: Bearer …`, sets the `Host` to `api.anthropic.com`, and
   ensures the `oauth-2025-04-20` beta flag is present.
4. **Streams** Server-Sent Events back to the client with no buffering
   (`TCP_NODELAY` + immediate header flush + direct pipe).
5. **Reads** all configuration (port, secret, token) from a `.env` file.

## Setup (you, the host)

Requires Node.js 18+ (no `npm install` needed — it uses only built-ins).

```bash
# 1. Configure
cp .env.example .env
$EDITOR .env            # set PROXY_SECRET and ANTHROPIC_OAUTH_TOKEN

# 2. Run
npm start               # ≡ node server.js
```

You'll see:

```
[proxy] listening on http://0.0.0.0:8787
[proxy] forwarding to https://api.anthropic.com
[proxy] shared-secret header: x-proxy-secret
```

### Where's my OAuth token?

On the machine where you're logged into Claude Code:

- **Linux:** `~/.claude/.credentials.json` → `.claudeAiOauth.accessToken`
  ```bash
  cat ~/.claude/.credentials.json | grep -o '"accessToken":"[^"]*"'
  ```
- **macOS:** Keychain item **"Claude Code"** (or the same
  `~/.claude/.credentials.json` file).

It starts with `sk-ant-oat…`. **These tokens expire** — if upstream starts
returning `401`, refresh the value in `.env` and restart.

### Generate a strong shared secret

```bash
openssl rand -hex 32
```

## Setup (your friend, the client)

Expose the proxy to them (LAN IP, a tunnel like `cloudflared` / `ngrok`, or a
small VPS), then they run their CLI against it:

```bash
export ANTHROPIC_BASE_URL="http://YOUR_PROXY_HOST:8787"
export ANTHROPIC_CUSTOM_HEADERS="x-proxy-secret: the-shared-secret-you-gave-them"
claude
```

`ANTHROPIC_CUSTOM_HEADERS` makes the CLI attach the shared secret to every
request. (If you changed `PROXY_SECRET_HEADER`, use that header name instead.)

## Windows (PowerShell) quickstart

The proxy is cross-platform; only the shell commands differ. Run these in
**PowerShell**.

**Host (you):**

```powershell
git clone https://github.com/shanuflash/claude-code-proxy.git
cd claude-code-proxy
Copy-Item .env.example .env

# Read your Claude Code OAuth token:
(Get-Content "$env:USERPROFILE\.claude\.credentials.json" | ConvertFrom-Json).claudeAiOauth.accessToken

# Generate a strong shared secret:
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })

notepad .env      # paste PROXY_SECRET and ANTHROPIC_OAUTH_TOKEN, save
npm start         # needs Node 18+ (winget install OpenJS.NodeJS if missing)
```

**Client (your friend, also Windows):**

```powershell
$env:ANTHROPIC_BASE_URL   = "http://YOUR_PROXY_HOST:8787"
$env:ANTHROPIC_CUSTOM_HEADERS = "x-proxy-secret: the-shared-secret-you-gave-them"
claude
```

Notes:
- If both of you are on the **same PC** (just trialing), use
  `http://localhost:8787` and leave `HOST=0.0.0.0` (or set `HOST=127.0.0.1`).
- Across the internet, expose it with a tunnel — e.g. `cloudflared.exe tunnel
  --url http://localhost:8787` — and give your friend the resulting `https://…`
  URL. This also encrypts the shared secret in transit.
- Windows Firewall may prompt the first time the port is opened — allow it.

## Test it locally

```bash
# Health check (no auth):
curl http://localhost:8787/health
# -> {"status":"ok"}

# Wrong / missing secret is rejected:
curl -i http://localhost:8787/v1/messages -X POST
# -> HTTP/1.1 401 Unauthorized

# A real, authenticated call proxied to Anthropic (streams SSE back):
curl -N http://localhost:8787/v1/messages \
  -H "x-proxy-secret: $PROXY_SECRET" \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
        "model": "claude-sonnet-5",
        "max_tokens": 64,
        "stream": true,
        "messages": [{"role": "user", "content": "Say hi in 3 words."}]
      }'
```

## Configuration reference

| Variable                | Required | Default             | Description                                        |
| ----------------------- | -------- | ------------------- | -------------------------------------------------- |
| `PORT`                  | no       | `8787`              | Port to listen on.                                 |
| `HOST`                  | no       | `0.0.0.0`           | Bind interface (`127.0.0.1` = localhost only).     |
| `PROXY_SECRET`          | **yes**  | —                   | Shared secret the client must send.                |
| `PROXY_SECRET_HEADER`   | no       | `x-proxy-secret`    | Header name carrying the secret.                   |
| `ANTHROPIC_OAUTH_TOKEN` | **yes**  | —                   | Your subscription OAuth token (injected upstream). |
| `UPSTREAM_HOST`         | no       | `api.anthropic.com` | Upstream API host.                                 |

## Security notes

- The real `.env` is git-ignored — **never commit your token**.
- Anyone with the shared secret can spend your subscription quota. Treat it
  like a password; rotate it (`PROXY_SECRET`) if it leaks.
- Prefer terminating TLS in front of the proxy (tunnel / reverse proxy) so the
  shared secret isn't sent in clear text over the public internet.
- This is intended for a quick, trusted trial — not a hardened multi-tenant
  gateway.
