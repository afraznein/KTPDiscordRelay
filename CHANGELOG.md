# Changelog

All notable changes to KTP Discord Relay will be documented in this file.

## [Unreleased]

### Documentation
- README `/reply` row and Key Design Decisions now cover both load-bearing
  passthroughs: `allowed_mentions` (scoped — only `POST /reply` honors a caller
  override; `/edit` always strips, `/dm` sends none) and `components` (the
  KTPAdminBot Acknowledge button). Documenting only one of the two invited the
  next refactor to strip the other.
- README retry bullet brought up to 1.1.1: `429` retries on every method, a 5xx
  or transport error on a write is terminal, and each outbound request carries a
  10s timeout.
- Outbound User-Agent version stamp bumped to match `package.json` (was `1.1.0`).
- `engines.node` floor raised to `>=22` to match the Dockerfile, which moved off
  Node 20 in 1.1.0 because it reached end-of-life 2026-04-30.
- `relay-dev` skill: unauthenticated-endpoint rule corrected to `/health` **and**
  `/` — the README was already right.

## [1.1.1] - 2026-07-18 (staged, not deployed)

`fetchWithRetries` hardening. No endpoint, auth, or response-shape changes — the
`allowed_mentions` and `components` passthroughs are untouched.

### Fixed
- **Duplicate messages on a 5xx-after-commit (DR-01).** `fetchWithRetries` retried
  any `429 || status >= 500` regardless of HTTP method, so a POST/PATCH that
  Discord committed but then answered with a 502/503 (a known behavior for write
  APIs behind an edge proxy under load) was resent with an identical body —
  posting a duplicate embed or DM. Retries on a 5xx are now gated to idempotent
  methods; a 5xx on a non-idempotent write (`POST`/`PATCH`) is terminal and
  surfaced, never resent. `429` stays retryable for every method (Discord rejects
  it before processing the write, so there is nothing to duplicate). The same
  duplicate-avoidance now covers the transport-error/timeout path: a write is not
  resent on a `fetch` rejection either, since it may have committed.

### Added
- **Per-request timeout (DR-02).** Every outbound `fetch` now carries a 10s
  `AbortSignal.timeout` (was unbounded up to Cloud Run's 300s request deadline),
  so a hung Discord response can't tie up a request slot during match-time
  traffic bursts. Above the Pawn callers' 5s curl timeout; a caller-supplied
  `signal` is respected if present. A timeout falls into the existing retry/catch
  path (and, per DR-01, is not resent for writes).

### Fixed (continued)
- **Surrogate-safe content truncation (DR-03, cosmetic).** The 1900-char content cap on
  `/reply`, `/dm`, and `/edit` used a plain UTF-16 `.slice()`, which could split a
  4-byte emoji straddling the boundary into a lone surrogate that renders as "�".
  A shared `truncateSafe()` helper now drops a dangling high surrogate at the cut.

## [1.1.0] - 2026-07-06 (Cloud Run revision `discord-relay-00034-r54`)

### Retroactive documentation (shipped earlier without a version bump)

Two behavior changes went live on `main` after 1.0.1 with no version bump or
changelog entry; they are documented here for the record:

- **`allowed_mentions` passthrough on `POST /reply`** (commit 850b178) - Callers
  may pass an explicit `allowed_mentions` object to permit specific mentions;
  the default is still `{ parse: [] }` (strip everything). Used by the
  KTPAntiCheat verdict embeds, crashreporter (`parse: ["everyone"]`),
  perf-rollup (role pings), and fleet-health (user pings).
- **`components` passthrough on `POST /reply`** (commit 562c721) - Callers may
  pass Discord interactive components (action rows with buttons/selects). Used
  by the KTPAntiCheat verdict embeds for the Acknowledge button; KTPAdminBot
  handles the resulting interactions on its gateway.

### Changed
- **Node 22 base image** - `node:20-alpine` → `node:22-alpine` (Node 20 reached
  end-of-life 2026-04-30)
- **Timing-safe auth comparison** - the `X-Relay-Auth` check now uses
  `crypto.timingSafeEqual` over SHA-256 digests instead of `!==`; still fails
  closed when `RELAY_SHARED_SECRET` is unset
- **`POST /dm` content cap** - DM content is now truncated to 1900 chars,
  matching `/reply` and `/edit`

### Removed
- **Dead OAuth Twitch-link flow** - `GET /oauth/discord/login` and
  `GET /oauth/discord/callback` deleted. The callback posted to a literal
  placeholder Apps Script URL, rendered a false success page, and leaked a
  shared secret in a query string; nothing consumed it. The `jsonwebtoken`
  dependency (OAuth state signing) is dropped with it, along with the
  `OAUTH_JWT_SECRET` / `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` /
  `DISCORD_REDIRECT_URI` / `WM_WEBAPP_SHARED_SECRET` env vars.
- **Unauthenticated debug endpoints** - `GET /whoami-public` and
  `GET /httpcheck` removed. `GET /health` and `GET /` remain.

### Fixed
- `/react` error logs were labeled `PUT /react`; the route is a POST
- Renamed a local `qs` variable in `GET /messages` that shadowed the
  (now removed) `querystring` import

---

## [1.0.1] - 2025-12-21

### Fixed
- **Critical: fetchWithRetries() calls** - Fixed incorrect argument format causing 500 errors
  - Changed from `fetchWithRetries(url, options, 2, 'postMessage')`
  - To `fetchWithRetries(url, options, { retries: 2, backoffMs: 600 })`
  - Affected endpoints: `/reply`, `/dm` (2 calls), `/edit`
  - Root cause: Function signature mismatch caused retry logic to fail

### Changed
- **POST /dm response** - Now includes `channelId` in the response JSON for DM channel tracking

---

## [1.0.0] - 2025-10-14

### Added
- Initial release
- Express.js HTTP relay server for Discord API V10
- Shared secret authentication via `X-Relay-Auth` header
- Automatic retry logic with exponential backoff
- Discord rate limit handling with `Retry-After` support
- In-memory emoji cache (60-second TTL)

### Endpoints

**Health & Diagnostics:**
- `GET /health` - Health check with environment validation
- `GET /whoami` - Bot identity (authenticated)
- `GET /whoami-public` - Bot identity (public)
- `GET /httpcheck` - Discord gateway connectivity test

**Messages:**
- `GET /messages` - List channel messages (with pagination)
- `GET /message/:channelId/:messageId` - Get specific message
- `POST /reply` - Send message to channel (supports embeds, replies)
- `POST /edit` - Edit existing message
- `DELETE /delete/:channelId/:messageId` - Delete message

**Channels:**
- `GET /channel/:channelId` - Get channel information

**Reactions:**
- `GET /reactions` - List users who reacted (with role enrichment)
- `POST /react` - Add reaction to message

**Direct Messages:**
- `POST /dm` - Send direct message to user

**OAuth (Optional):**
- `GET /oauth/discord/login` - Initiate Discord OAuth flow
- `GET /oauth/discord/callback` - OAuth callback handler

### Infrastructure
- Docker support via Dockerfile
- Google Cloud Run deployment ready
- Node.js 20+ required
- Stateless, scales-to-zero design

### Security
- Simple shared-secret authentication
- No data persistence or caching (except emoji cache)
- Transparent request forwarding
- Allowed mentions disabled by default (prevents accidental pings)
