# Changelog

All notable changes to KTP Discord Relay will be documented in this file.

## [1.1.0] - 2026-07-06

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
