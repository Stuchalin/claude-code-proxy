# claude-code-proxy

A tiny, **zero-dependency** self-hosted gateway that lets you use **your own**
Claude subscription from your other devices — a headless server, a remote dev
box, a second laptop — **without copying your credential files around**.

Point a Claude Code CLI's `ANTHROPIC_BASE_URL` at the proxy and give it a shared
secret. The proxy authenticates the request, injects the OAuth token it reads
from *your* local Claude Code login, and forwards everything to
`api.anthropic.com`. Streamed responses (SSE) pass straight through in
real-time. Your token stays on the one machine that hosts the proxy.

```
┌──────────────────┐   x-proxy-secret    ┌───────────┐  Bearer <your token>  ┌───────────────────┐
│ your other device│ ──────────────────▶ │  proxy    │ ────────────────────▶ │ api.anthropic.com │
│ ANTHROPIC_BASE_  │ ◀────────────────── │ (this app)│ ◀──────────────────── │                   │
│ URL=your-proxy   │    streamed SSE     └───────────┘     streamed SSE       └───────────────────┘
└──────────────────┘
```

## Who this is for

The intended use is **your own account, on machines you control**:

- Run Claude Code on a **headless / remote server** without dropping your
  `~/.claude` credentials onto it.
- Reach one logged-in machine from your **other devices on the same network**.
- Keep the OAuth token on a **single trusted host** instead of syncing
  credential files between computers.

> **Responsible use — please read.** This tool forwards *your* Anthropic
> credentials, so every request it serves counts as your usage and is your
> responsibility. Before pointing anyone else's device at it, check Anthropic's
> [Terms of Service](https://www.anthropic.com/legal/consumer-terms) and
> [Usage Policy](https://www.anthropic.com/legal/aup) — individual
> subscriptions are generally intended for a single person, and sharing account
> access may not be permitted under your plan. Use it for your own devices, or
> only in ways your agreement with Anthropic allows. Don't expose it to the
> public internet, and don't use it to resell or pool access. You are solely
> responsible for how your credentials are used through this proxy.

## What it does

1. **Listens** for HTTP requests from a Claude Code CLI.
2. **Secures** the endpoint with a configurable shared-secret header
   (constant-time comparison) so only clients you authorize can use it.
3. **Overrides** the incoming auth headers — strips the client's
   `authorization` / `x-api-key`, injects your OAuth token as
   `Authorization: Bearer …`, sets the `Host` to `api.anthropic.com`, and
   ensures the `oauth-2025-04-20` beta flag is present.
4. **Streams** Server-Sent Events back to the client with no buffering
   (`TCP_NODELAY` + immediate header flush + direct pipe).
5. **Auto-discovers** your OAuth token from your local Claude Code credentials
   and **auto-refreshes** it when it expires — writing the new token back so
   your own CLI stays in sync.
6. **Restricts** which models a client may call and caps reasoning effort
   (optional), rejecting others before they reach Anthropic.
7. **Expires** access after an optional time window (`ACCESS_DURATION`).
8. **Caches** the quota-usage endpoint (`GET /api/oauth/usage`) so many
   polling clients share one upstream request instead of hitting Anthropic's
   rate limit (see [Usage cache](#usage-cache)).
9. **Reads** configuration from a `.env` file (only the shared secret is required).

## Requirements

- Node.js 18+ (no `npm install` — it uses only built-ins).
- You've logged into Claude Code at least once on the host machine (`claude`),
  so a token exists for the proxy to read.

## Setup (the host machine)

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
[proxy] forwarding to https://api.anthropic.com:443
[proxy] shared-secret header: x-proxy-secret
[proxy] dashboard: http://localhost:8787/dashboard?secret=YOUR_SECRET
[proxy] max effort: xhigh
[proxy] usage cache: ttl 60 s, max stale 900 s, 429 backoff 300-1800 s, user-agent claude-code/2.1.0
[proxy] OAuth token discovered from file (expires 2026-…)
```

### Generate a strong shared secret

This is the one value you create and give to each client — treat it like a
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

If discovery doesn't fit your setup, you can override it:

- `ANTHROPIC_OAUTH_TOKEN` — pin a specific token (disables auto-refresh).
- `CLAUDE_CREDENTIALS_PATH` — point at a credentials file in a non-default spot.
- `AUTO_REFRESH=false` — turn off automatic refresh.

## Setup (the client device)

Make the proxy reachable from the client (a LAN IP, a tunnel like `cloudflared`,
or a small VPS you own), then run the CLI against it:

```bash
export ANTHROPIC_BASE_URL="http://YOUR_PROXY_HOST:8787"
export ANTHROPIC_API_KEY="sk-ant-dummy"                 # any value; the proxy discards it
export ANTHROPIC_CUSTOM_HEADERS="x-proxy-secret: your-shared-secret"
claude
```

- `ANTHROPIC_BASE_URL` points the CLI at your proxy.
- `ANTHROPIC_API_KEY` (any dummy value) puts the CLI in API-key mode so it
  **doesn't try to run its own OAuth login** — the proxy strips this header and
  injects your real token, so the value is irrelevant.
- `ANTHROPIC_CUSTOM_HEADERS` attaches the shared secret to every request. (If
  you changed `PROXY_SECRET_HEADER`, use that header name instead.)

The client device does **not** need to be logged into Claude Code — that's the
point: credentials live only on the host.

## Windows (PowerShell) quickstart

The proxy is cross-platform; only the shell commands differ. Run these in
**PowerShell**.

**Host** — make sure you've run `claude` and logged in first, so the token
exists at `%USERPROFILE%\.claude\.credentials.json`:

```powershell
git clone https://github.com/shanuflash/claude-code-proxy.git
cd claude-code-proxy
Copy-Item .env.example .env

# Generate a strong shared secret (the one value you must set + share):
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })

notepad .env      # paste that value into PROXY_SECRET, save
npm start         # needs Node 18+ (winget install OpenJS.NodeJS if missing)
```

The token is picked up automatically — you should see
`[proxy] OAuth token discovered from file` in the output.

**Client (also Windows):**

```powershell
$env:ANTHROPIC_BASE_URL       = "http://YOUR_PROXY_HOST:8787"
$env:ANTHROPIC_API_KEY        = "sk-ant-dummy"   # any value; proxy discards it, skips login
$env:ANTHROPIC_CUSTOM_HEADERS = "x-proxy-secret: your-shared-secret"
claude
```

Notes:
- On the **same PC**, use `http://localhost:8787` (set `HOST=127.0.0.1`).
- On the **same network**, use the host's LAN IP (`ipconfig`) and allow the port
  through Windows Firewall.
- Across the internet, use a tunnel (below) rather than opening a port — it
  gives you HTTPS so the shared secret isn't sent in the clear.

## Persistent HTTPS with a Cloudflare named tunnel

If you already run a domain's DNS on Cloudflare, a **named tunnel** gives you a
stable `https://<sub>.yourdomain.com` instead of a random quick-tunnel URL, all
managed from the Zero Trust dashboard. It's free.

When using a tunnel, set `HOST=127.0.0.1` in `.env` — only `cloudflared`
(running on the same machine) needs to reach the proxy, so there's no need to
open any firewall port or bind to `0.0.0.0`.

**Dashboard-managed setup (easiest):**

1. `winget install Cloudflare.cloudflared` (Windows) / `brew install cloudflared` (Mac).
2. Go to **one.dash.cloudflare.com** → **Networks → Tunnels → Create a tunnel**
   → **Cloudflared** → name it (e.g. `claude-proxy`) → **Save**.
3. Pick your OS; copy the install command it shows and run it in an
   **elevated** shell. To just try it without installing a service, run:
   ```powershell
   cloudflared.exe tunnel run --token <TOKEN_FROM_DASHBOARD>
   ```
   The connector should flip to **Connected** in the dashboard.
4. In the tunnel's **Public Hostname** tab → **Add a public hostname**:
   - **Subdomain:** e.g. `ccproxy`  · **Domain:** pick yours  · **Path:** empty
   - **Service → Type:** `HTTP`  · **URL:** `localhost:8787`
   - Save. Cloudflare auto-creates the proxied DNS record.
5. Start the proxy (`npm start`) and hit `https://ccproxy.yourdomain.com/health`.

Then point the client's `ANTHROPIC_BASE_URL` at `https://ccproxy.yourdomain.com`.

Notes:
- Use a **fresh subdomain** — this won't affect your existing site.
- Claude's SSE stream keeps bytes flowing, so Cloudflare's ~100s
  origin-response timeout isn't a problem; leave HTTP settings at defaults
  (don't enable "Disable Chunked Encoding").
- For an extra layer, you can put **Cloudflare Access** in front, but a CLI
  client then needs an Access **service token** (`CF-Access-Client-Id` /
  `CF-Access-Client-Secret` headers).

## Test it locally

```bash
# Health check (no auth):
curl http://localhost:8787/health
# -> {"status":"ok","tokenSource":"file"}

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

## Running tests

```bash
npm test                # ≡ node --test test/*.test.js
```

The suite uses only Node's built-in `node:test` runner — no `npm install`.
The harness relies on `node:test`'s per-test `timeout` option, which needs
Node 18.7 or newer. Each test spawns `server.js` as a child process against a
local plain-HTTP fake upstream (via `UPSTREAM_PROTOCOL=http` and
`UPSTREAM_PORT`), so it never talks to Anthropic and needs no real token.
Every environment variable `server.js` reads is set explicitly for the child,
so neither your shell nor your `.env` leaks into the tests. The shell expands
`test/*.test.js`, so only the top-level `*.test.js` files run; the shared
harness lives in `test/helpers/`.

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
| `BLOCKED_MODELS`          | no       | —                             | Comma-separated substrings; matching models are rejected with `403`.   |
| `ALLOWED_MODELS`          | no       | —                             | If set, only matching models are allowed (everything else `403`).      |
| `MAX_EFFORT`              | no       | —                             | Cap reasoning effort; requests above it get `403`. See below.          |
| `ACCESS_DURATION`         | no       | —                             | Time limit (`1h`, `30m`, `90s`, `2d`). See below.                      |
| `ACCESS_START_MODE`       | no       | `first-use`                   | Start the clock on `first-use` or `server-start`.                      |
| `ACCESS_EXPIRE_ACTION`    | no       | `reject`                      | On expiry: `reject` (403s, stays up) or `shutdown` (exits).            |
| `ACCESS_STATE_FILE`       | no       | `./.access-start`             | Where the start time persists (delete to reset the window).            |
| `USAGE_CACHE`             | no       | `true`                        | Cache `GET /api/oauth/usage` (`false` = pass-through). See below.      |
| `USAGE_CACHE_TTL`         | no       | `60`                          | Seconds a cached usage answer is served as fresh (`hit`).              |
| `USAGE_CACHE_MAX_STALE`   | no       | `900`                         | Max age in seconds of a cached answer served on upstream errors.       |
| `USAGE_BACKOFF_BASE`      | no       | `300`                         | First pause in seconds after an upstream `429` (no `Retry-After`).     |
| `USAGE_BACKOFF_MAX`       | no       | `1800`                        | Cap in seconds for the doubling `429` pause.                           |
| `USAGE_USER_AGENT`        | no       | `claude-code/2.1.0`           | Full `User-Agent` string sent upstream for the usage endpoint.         |
| `UPSTREAM_HOST`           | no       | `api.anthropic.com`           | Upstream API host.                                                     |
| `UPSTREAM_PORT`           | no       | `443`                         | Upstream port (integer 1-65535). Meant for tests.                      |
| `UPSTREAM_PROTOCOL`       | no       | `https`                       | `https` or `http`. `http` exists for tests against a local fake.       |

### Restricting models

The proxy reads the `model` field from each request and can block models before
they reach Anthropic (so no quota is spent). Matching is case-insensitive
substring, so `fable` blocks `claude-fable-5`.

```bash
# Block a specific model (matches any id containing "fable"):
BLOCKED_MODELS=fable

# Or lock the client to a whitelist — everything else is rejected:
ALLOWED_MODELS=sonnet,haiku,opus
```

> Note: Claude Code makes background calls with Haiku (title/summary
> generation), so if you use `ALLOWED_MODELS`, include `haiku` or the CLI's
> background requests will 403.

Blocked requests get an Anthropic-style `403` error, which the client CLI
surfaces as a normal error message.

### Capping reasoning effort

The proxy reads `output_config.effort` and rejects requests above a ceiling.
Levels low→high are `low`, `medium`, `high`, `xhigh`, `max`.

```bash
MAX_EFFORT=xhigh   # allows Claude Code's default (xhigh); blocks only "max"
```

`.env.example` ships with `MAX_EFFORT=xhigh`, which permits Claude Code's
default effort and blocks only the most expensive `max` tier. Set it lower
(e.g. `high`) to save more — but note that if the ceiling is **below** the
client's effort, those requests get a `403` until the client lowers effort.
Remove the line for no cap.

### Time limit

After `ACCESS_DURATION` elapses, every request gets a `403 access window has
expired`. Useful for lending access for a bounded period.

```bash
ACCESS_DURATION=1h        # 1h / 30m / 90s / 2d (bare number = minutes)
```

- **When the clock starts:** `first-use` (default) begins timing on the first
  authenticated request; `server-start` begins when you launch the proxy.
- **Survives restarts:** the start time is persisted to `.access-start`
  (git-ignored). Restarting the proxy does **not** grant a fresh window. To
  reset, delete that file (path configurable via `ACCESS_STATE_FILE`).
- **On expiry:** `ACCESS_EXPIRE_ACTION=reject` (default) keeps the proxy up and
  returns 403s (so `/health` still reports status); `shutdown` exits the process.
- **Check remaining time:** `GET /health` includes `access.expiresAt` and
  `access.expired` when a window is configured.

### Usage cache

Quota tools (ClaudeBar, Claude Code status lines) poll `GET /api/oauth/usage`.
Through the proxy they all use the same OAuth token and poll the same
endpoint, and Anthropic answers `429` when it is polled too often. The proxy
therefore answers this one endpoint from a shared in-memory cache, which cuts
the number of upstream requests. Every other path
(`/v1/messages`, SSE streaming) is forwarded as before.

> `/api/oauth/usage` is an **undocumented** Anthropic endpoint, and its rate
> limit is not published. The TTL, stale and backoff values below are this
> proxy's defaults, not Anthropic-documented numbers — tune them if needed.

```bash
USAGE_CACHE_TTL=60          # seconds; fractional values are allowed
USAGE_CACHE_MAX_STALE=900
USAGE_BACKOFF_BASE=300
USAGE_BACKOFF_MAX=1800
USAGE_USER_AGENT=claude-code/2.1.0
```

- **What is cached:** only `GET` requests whose path is exactly
  `/api/oauth/usage`. The cache key is the full path plus query string, so
  different queries are cached separately. Only a `200` answer is stored
  (body and `content-type`); entries live in memory until the proxy restarts.
- **Still gated:** the shared secret and the access window are checked first,
  so no cached data is returned without the secret, and these requests still
  appear in the dashboard's per-client stats. A cache hit needs no OAuth token.
- **Fresh hit:** an entry younger than `USAGE_CACHE_TTL` is served without
  contacting Anthropic.
- **Refresh:** when the entry is older, the next request fetches a new one.
  Concurrent requests for the same key share a single upstream request. The
  upstream request carries `User-Agent: $USAGE_USER_AGENT` and
  `Accept-Encoding: identity` (so the cached bytes are uncompressed and can be
  replayed to any client). The whole upstream exchange (headers and body) is
  bounded by a fixed 30 s timeout; the token lookup/refresh before it is not.
- **Stale on error:** if the upstream answers `429` or `5xx`, the connection
  fails or times out, or no OAuth token is available, the proxy serves the last
  `200` answer as a `200` — as long as it is younger than
  `USAGE_CACHE_MAX_STALE`. Otherwise the error goes to the client: the upstream
  status, headers and body as is, `502 {"error":"bad gateway",…}` for a
  network error, or the usual `502` "no upstream credentials" body.
- **Other errors are not masked:** `401`, `403`, `404` and any other non-`200`
  answer pass through as is; they are never cached and never replaced by a
  stale answer.
- **Pause after `429`:** one upstream `429` pauses upstream calls for **all**
  usage keys. This global pause is the proxy's own policy, based on community
  reports that the limit is per access token (all keys share one
  token); Anthropic does not document it. The pause lasts as long
  as the upstream `Retry-After` (seconds or an HTTP date) says when that lies
  in the future; otherwise it follows the backoff step: `USAGE_BACKOFF_BASE`,
  doubling on each consecutive `429`, capped at `USAGE_BACKOFF_MAX`. The step
  advances on every `429`, even when `Retry-After` set the pause; only a `200`
  resets it. A later `429` (for example from a concurrent fetch for another
  key) can extend a running pause but never shortens it. During an active
  pause, requests are answered in this order,
  without calling Anthropic: an entry younger than `USAGE_CACHE_TTL` is still
  served as a fresh `hit`; otherwise an entry younger than
  `USAGE_CACHE_MAX_STALE` is served as `stale`; otherwise the proxy answers
  `429` itself with `Retry-After` set to the seconds left and an
  Anthropic-style `rate_limit_error` body.
- **Diagnostic headers:** every usage answer carries `x-proxy-cache`
  (`hit` or `stale` when served from the cache, `miss` for a fresh upstream
  `200`, a passed-through error, or a proxy-made `429`/`502`) and `age` (the
  cached entry's age in whole seconds, `0` for anything not from the cache).

```bash
curl -si http://localhost:8787/api/oauth/usage -H "x-proxy-secret: $PROXY_SECRET" \
  | grep -iE '^(x-proxy-cache|age):'
# first call:  x-proxy-cache: miss / age: 0
# within TTL:  x-proxy-cache: hit  / age: <seconds>
```

The dashboard (`/dashboard?secret=…`) has a **Usage cache** section with the
TTL and max-stale settings, hit / miss / stale counts, upstream fetches,
upstream `429`s and, while a pause is active, when it ends. The same numbers
are in the `usage` object of `/dashboard/data`.

Lines tagged `[usage]` are logged only for upstream `429`s and pauses, `5xx`,
network errors, missing credentials and stale serves; the token and the
shared secret are never logged.

Invalid values stop the proxy at startup with a `[config]` message:
`USAGE_CACHE` must be `true` or `false`, the duration variables must be
positive numbers of seconds, and `USAGE_USER_AGENT` must be a valid header
value. Set `USAGE_CACHE=false` to turn the cache off
entirely: the endpoint is then forwarded like any other request, with the
client's own `User-Agent`.

## Security notes

- The real `.env` is git-ignored — and with auto-discovery there's usually no
  token in it to leak anyway.
- Auto-refresh writes the renewed token back to your `~/.claude/.credentials.json`
  (atomic write, other fields preserved) — the same file your own CLI uses.
- Anyone with the shared secret can spend your subscription quota. Treat it
  like a password; rotate it (`PROXY_SECRET`) if it leaks, and use a unique one
  per device if you can.
- Always terminate TLS in front of the proxy (a tunnel or reverse proxy) before
  it leaves your own machine — otherwise the shared secret travels in clear text.
- This is a lightweight personal gateway, not a hardened multi-tenant service.
  Don't expose it to the open internet.

## License

[MIT](./LICENSE). Provided as-is, with no warranty. You are responsible for
complying with Anthropic's terms when using it.
