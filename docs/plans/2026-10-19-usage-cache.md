# Proxy serves one cached /api/oauth/usage answer to all clients

**Executor:** `/peer-planning:exec`. A subagent implements each task and Codex reviews the diff
before the task closes; a task marked `**Discuss:** yes` has its approach agreed with Codex first.

## Stories
- As the owner of the shared subscription, I want ClaudeBar and Claude Code status lines on several
  Macs to see quota usage without the proxy hitting Anthropic on every poll, so that the usage
  endpoint stops returning 429 to everyone.
- As a client, when Anthropic rate-limits the usage endpoint, I still get the last good answer
  (if it is recent enough) instead of an error.

## Overview
- All clients poll `GET /api/oauth/usage` through this proxy with one shared OAuth token, so they
  share one upstream rate limit and Anthropic answers 429 regularly.
- The proxy caches the 200 answer per path+query for a TTL, coalesces concurrent refreshes into one
  upstream request, serves a stale answer on 429/5xx/network errors, and pauses upstream calls after
  a 429 with escalating backoff.
- Every other path (`/v1/messages`, SSE streaming) keeps its current behavior.

## Decisions
- **Scope:** only `GET` with pathname `/api/oauth/usage`; cache key is `req.url` (path + query).
  Owner ruling (ТЗ п.1).
- **Placement:** the usage branch runs after the secret check and the access window (so no cache
  data leaks without the secret, and the trial window still applies), after the per-client stats
  are recorded (so the dashboard still counts these clients), and before `getToken()` (a hit needs
  no token). Evidence: request order in `server.js` `http.createServer` handler.
- **TTL default 60 s.** Owner ruling: cache 30-60 s, then the next request refreshes it.
- **Only 200 is cached.** Body and `content-type` only. Owner ruling (ТЗ п.2).
- **Upstream request asks for `accept-encoding: identity`** on this path, so the cached bytes are
  plain and replayable to any client without a `content-encoding` header. Planner decision.
- **Single-flight per key:** one in-flight promise per key; waiters share its result. Same pattern
  as `refreshToken()` / `refreshPromise` in `server.js`.
- **Stale-on-error:** on upstream 429, 5xx or network error, serve the last 200 as 200 with
  `x-proxy-cache: stale` if its age is under `USAGE_CACHE_MAX_STALE`; otherwise pass the original
  error through (network error → existing 502 JSON shape). Owner ruling (ТЗ п.4).
- **Pause after 429 is global, not per key** — the community data says the limit is per access
  token, and all keys share one token. Pause length: `Retry-After` (seconds or HTTP date) when it
  lies in the future, else the escalation step: base 5 min, doubling per consecutive 429, capped at
  30 min. The escalation counter advances on every 429 either way; only a 200 resets it. During the
  pause: serve stale if allowed, else 429 with `Retry-After` = seconds left. Owner ruling (ТЗ п.5);
  the "counter advances even when Retry-After is used" detail is a planner decision.
- **User-Agent:** on this path the proxy sets `user-agent` to `USAGE_USER_AGENT`, default
  `claude-code/2.1.0`. The env holds the full UA string, not just the version (superset of ТЗ п.6).
- **Diagnostic headers** on every usage response the proxy produces: `x-proxy-cache: hit|miss|stale`
  and `age` in whole seconds. Owner ruling (ТЗ п.7).
- **Env (seconds, fractional allowed so tests run fast):** `USAGE_CACHE` (default `true`; `false`
  restores the old pass-through path exactly), `USAGE_CACHE_TTL=60`, `USAGE_CACHE_MAX_STALE=900`,
  `USAGE_BACKOFF_BASE=300`, `USAGE_BACKOFF_MAX=1800`, `USAGE_USER_AGENT`. Invalid values fail at
  startup through the existing `fail()` with a `[config]` message.
- **Testability seam:** new env `UPSTREAM_PORT` (default 443) and `UPSTREAM_PROTOCOL`
  (`https` default, `http` for tests), plus a small `upstreamRequest()` helper used by both the
  main path and the usage path. Startup log prints the actually bound port (so tests can use
  `PORT=0`). Rejected: exporting internals / `require.main` refactor — bigger diff, worse for an
  upstream PR.
- **Tests** spawn `server.js` as a child process against an in-process fake upstream (`node:http`),
  with every policy env set explicitly (empty) so a developer's `.env` cannot leak in. `node --test`,
  no dependencies.
- **Logs** `[usage] ...`, only for non-200 upstream outcomes, pauses and stale serves; never the
  token or secret.
- **No new dependencies.** Small, self-contained change in `server.js` style, upstream-PR-friendly.

## Context
- `server.js`: `buildUpstreamHeaders`, `https.request` call in the `http.createServer` handler,
  `refreshToken` (single-flight pattern), `snapshot` + `DASHBOARD_HTML` (dashboard), `stats`,
  `getClient`, `fail`, startup `server.listen` logs.
- `README.md` "Configuration reference" section; `.env.example` sections per feature.
- `package.json` has only `start`.

## Execution
- **Implementer:** the `implementer` agent definition (Opus at medium).
- **Validation:** `npm test` (= `node --test test/`), plus `node --check server.js`. Formatting
  follows the repo's prettier style (single quotes, trailing commas, 2 spaces); run
  `npx prettier --check server.js test` only if prettier is already available, never install it.
- **Commits:** one per task, `type(scope): subject`, after Codex's review.

## Tasks

### Task 1: Upstream target is configurable and a test harness exists
**Goal:** `UPSTREAM_PORT` / `UPSTREAM_PROTOCOL` let the proxy talk to a plain-HTTP fake upstream;
`npm test` runs a harness that spawns the proxy against a fake upstream; existing pass-through
behavior is pinned by tests.
**Starting points:** `server.js` (configuration block, `https.request` in the request handler,
`server.listen` callback), `package.json`.
**Constraints:** defaults keep today's behavior (https, 443). See Decisions: Testability seam, Tests.
**Done when:**
- [x] `npm test` runs `node --test` and passes
- [x] tests pin: no secret → 401; `POST /v1/messages` reaches the fake upstream with
      `authorization: Bearer <token>`, the OAuth beta flag, no secret header, and the body intact
- [x] the startup log reports the bound port, so `PORT=0` works

### Task 2: Usage responses are cached with single-flight, stale-on-error and 429 pause
**Discuss:** yes
**Goal:** `GET /api/oauth/usage` is served per the Decisions: TTL hits, one upstream request for
concurrent misses, stale on 429/5xx/network error, global escalating pause after 429, injected
User-Agent, `x-proxy-cache` / `age` headers; `USAGE_CACHE=false` restores pass-through.
**Starting points:** `server.js` request handler (between client stats and `getToken()`),
`refreshToken` for the single-flight pattern, `buildUpstreamHeaders`.
**Constraints:** every Decision above; other paths and SSE untouched; never log token or secret.
**Done when:**
- [ ] tests pin: hit within TTL (one upstream call, `x-proxy-cache: hit`, `age` set); concurrent
      requests → one upstream call; 429 serves stale cache as 200; pause blocks upstream and
      doubles on the next 429; no cache → upstream 429 reaches the client as is; non-200 is not
      cached; no secret → 401 and no cached body leaks; User-Agent is injected
- [ ] tests pin: future `Retry-After` sets the pause length; stale older than
      `USAGE_CACHE_MAX_STALE` is not served; `USAGE_CACHE=false` forwards every request
- [ ] Task 1 tests still pass

### Task 3: Dashboard shows usage-cache counters and the pause
**Goal:** `/dashboard/data` `snapshot()` includes usage-cache counters (hit, miss, stale,
upstream 429s, upstream fetches) and the pause end time; the dashboard page shows them.
**Starting points:** `server.js` (`snapshot`, `DASHBOARD_HTML`).
**Constraints:** dashboard stays self-contained (no external assets); field names stable for tests.
**Done when:**
- [ ] a test reads `/dashboard/data` and sees the counters change after hit/miss/429
- [ ] the page renders the counters and the pause end (or nothing when not paused)

### Task 4: Verify acceptance criteria
- [ ] every story and every Done-when above holds
- [ ] `npm test` green
- [ ] manual check: local proxy against the fake or real upstream, `curl` twice →
      `x-proxy-cache: miss`, then `hit`

### Task 5: Update documentation
- [ ] `README.md` describes the usage cache, its behavior and every new env variable
      (`USAGE_*`, `UPSTREAM_PORT`, `UPSTREAM_PROTOCOL`), and `npm test`
- [ ] `.env.example` lists the new variables with defaults
- [ ] the dashboard note no longer claims nothing about limits is visible if that became wrong

## Post-Completion
- Owner: how the proxy is deployed on `claude.sdfpro.ru` (systemd, docker, manual) — needed before
  any deploy; the agent does not deploy.
- Owner: whether to open a PR to `shanuflash/claude-code-proxy` or keep it fork-only.
- TTL 60 s is the owner's ruling ("30-60 seconds"); max stale 15 min and the backoff values are planner defaults, not Anthropic data.
