# Claude Code credential proxy

A tiny, **zero-dependency** reverse proxy that lets a friend use *your* Claude
subscription through their own Claude Code CLI — **without ever handing over
your credentials or session files**.

The friend points their CLI's `ANTHROPIC_BASE_URL` at this proxy and sends a
shared secret header. The proxy authenticates them, throws away whatever auth
they sent, injects *your* OAuth token, and forwards everything to
`api.anthropic.com`. Streamed responses (SSE) pass straight through in
real-time.

Your token is **discovered automatically** from your local Claude Code login
and **refreshed on the fly** when it expires — so the only thing you configure
is a shared secret to hand your friend.

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
5. **Auto-discovers** your OAuth token from your local Claude Code credentials
   and **auto-refreshes** it when it expires — writing the new token back so
   your own CLI stays in sync.
6. **Reads** configuration from a `.env` file (only the shared secret is required).

## Setup (you, the host)

Requires Node.js 18+ and that **you're logged into Claude Code on this machine**
(`claude` at least once). No `npm install` needed — it uses only built-ins.

```bash
# 1. Configure — the only required value is the shared secret
cp .env.example .env
$EDITOR .env            # set PROXY_SECRET (invent any long random string)

# 2. Run
npm start               # ≡ node server.js
```

You'll see it confirm the token was found automatically:

```
[proxy] listening on http://0.0.0.0:8787
[proxy] forwarding to https://api.anthropic.com
[proxy] shared-secret header: x-proxy-secret
[proxy] OAuth token discovered from file (expires 2026-…)
```

### Generate a strong shared secret

This is the one thing you make up and give to your friend — treat it like a
password.

```bash
openssl rand -hex 32
```

### About the OAuth token (you normally do nothing here)

The proxy reads your token from where Claude Code stores it:

- **Linux / Windows:** `~/.claude/.credentials.json`
- **macOS:** the same file, or the **"Claude Code"** Keychain item (read via
  the `security` tool automatically).

It re-reads on each request and, when the token is within a minute of expiry,
uses the stored refresh token to fetch a new one and saves it back. So you
should never hit an expiry-related 401.

If for some reason discovery doesn't fit your setup, you can override it:

- `ANTHROPIC_OAUTH_TOKEN` — pin a specific token (disables auto-refresh).
- `CLAUDE_CREDENTIALS_PATH` — point at a credentials file in a non-default spot.
- `AUTO_REFRESH=false` — turn off automatic refresh.

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

**Host (you)** — make sure you've run `claude` and logged in first, so the
token exists at `%USERPROFILE%\.claude\.credentials.json`:

```powershell
git clone https://github.com/shanuflash/claude-code-proxy.git
cd claude-code-proxy
Copy-Item .env.example .env

# Generate a strong shared secret (the only thing you must set + share):
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })

notepad .env      # paste that value into PROXY_SECRET, save
npm start         # needs Node 18+ (winget install OpenJS.NodeJS if missing)
```

The token is picked up automatically — you should see
`[proxy] OAuth token discovered from file` in the output.

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

| Variable                  | Required | Default                       | Description                                                            |
| ------------------------- | -------- | ----------------------------- | ---------------------------------------------------------------------- |
| `PROXY_SECRET`            | **yes**  | —                             | Shared secret the client must send.                                    |
| `PORT`                    | no       | `8787`                        | Port to listen on.                                                     |
| `HOST`                    | no       | `0.0.0.0`                     | Bind interface (`127.0.0.1` = localhost only).                         |
| `PROXY_SECRET_HEADER`     | no       | `x-proxy-secret`              | Header name carrying the secret.                                       |
| `ANTHROPIC_OAUTH_TOKEN`   | no       | *(auto-discovered)*           | Pin a specific token manually; disables auto-refresh.                  |
| `CLAUDE_CREDENTIALS_PATH` | no       | `~/.claude/.credentials.json` | Where to read the Claude Code token from.                              |
| `AUTO_REFRESH`            | no       | `true`                        | Auto-refresh the token when it expires (`false` to disable).           |
| `UPSTREAM_HOST`           | no       | `api.anthropic.com`           | Upstream API host.                                                     |

## Security notes

- The real `.env` is git-ignored — and with auto-discovery there's usually no
  token in it to leak anyway.
- Auto-refresh writes the renewed token back to your `~/.claude/.credentials.json`
  (atomic write, other fields preserved) — the same file your own CLI uses.
- Anyone with the shared secret can spend your subscription quota. Treat it
  like a password; rotate it (`PROXY_SECRET`) if it leaks.
- Prefer terminating TLS in front of the proxy (tunnel / reverse proxy) so the
  shared secret isn't sent in clear text over the public internet.
- This is intended for a quick, trusted trial — not a hardened multi-tenant
  gateway.
