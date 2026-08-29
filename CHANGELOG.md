# Changelog

All notable changes to KTP Discord Relay will be documented in this file.

## [1.2.0] - 2026-08-25

### Added
- **DR5/DR4 — per-caller identity + ping-scoping.** `RELAY_KEYS_JSON` (JSON
  array of `{id, secret, mentions:[...]}`) replaces the single shared secret
  with per-caller keys: `requireAuth` timing-safe-matches against every
  configured key and sets `req.caller`, `POST /reply` and `POST /edit` reject
  an `allowed_mentions` naming a role/user ID outside that caller's list
  (403, before the request reaches Discord) — including an attempt to
  sidestep the list via `parse:["everyone"|"roles"|"users"]`. Every
  authenticated request now logs `caller.id`.
  ⛔ **Dual-mode rollout, nothing migrated yet.** A caller still
  authenticating via `RELAY_SHARED_SECRET` or `RELAY_LEGACY_SECRET` is a
  "wildcard" caller (`mentions: null`) with the prior unrestricted
  passthrough — this grandfathers crashreporter `@everyone`, perf-rollup and
  fleet-health role/user pings, and AdminBot exactly as before. No consumer
  config changed in this release; issuing individual keys and threading them
  through each consumer is follow-up work. Revoking a caller is dropping its
  `RELAY_KEYS_JSON` entry and redeploying.
  ⚠️ `RELAY_LEGACY_SECRET`'s existing `AUTH_LEGACY_SECRET_USED` log line is
  byte-for-byte unchanged — a separate, already-in-flight secret rotation
  (deferred to 2026-08-28) watches that text verbatim.
  `POST /edit` gained an optional `allowed_mentions` field (previously always
  hardcoded to strip); omitting it keeps today's behavior.
- `test/auth.test.js` — `node:test` coverage for the above (11 cases): auth
  still 401s with no/wrong header, a scoped caller's in-scope mention reaches
  Discord, an out-of-scope role/`parse:["everyone"]` 403s and never reaches
  Discord (checked on both `/reply` and `/edit`), and both wildcard callers
  keep unrestricted passthrough. `global.fetch` is stubbed so the suite makes
  no live Discord call. `npm test` runs it; wired into `Tier 1 Build` CI.

## [Unreleased]

> **DEPLOYED 2026-08-19 — Cloud Run revision `discord-relay-00038-scw`, 100% of traffic**
> (re-verified serving 100% as `latestReadyRevision` on 2026-08-29 via
> `gcloud run services describe`). This revision carries the dual-accept rotation
> window below. Rollback is a traffic split back to `discord-relay-00037-6wd` —
> but note that rolling back also rolls back dual-accept: callers still on the
> legacy secret would 401, which is the exact outage the window exists to prevent.

### Added
- **`RELAY_LEGACY_SECRET` — a second accepted secret for the length of a rotation
  window.** When set, `requireAuth` accepts it alongside `RELAY_SHARED_SECRET`
  (both compared timing-safe) and logs `AUTH_LEGACY_SECRET_USED path=…` on every
  legacy hit — that log going quiet is what makes the window closable; without it,
  dropping the old secret is a guess about whether every caller has migrated.
  When unset, behaviour is exactly as before, and with `RELAY_SHARED_SECRET`
  unset every authenticated endpoint still 401s regardless of the legacy value.
  Exists because the 24 fleet instances re-read their relay secret only on the
  nightly restart, so a hard cutover would strand every caller for up to a day.

> **DEPLOYED 2026-08-17 — Cloud Run revision `discord-relay-00037-6wd`, 100% of traffic.**
> Rollback is a traffic split back to `discord-relay-00036-vrl` (seconds, no rebuild):
> `gcloud run services update-traffic discord-relay --to-revisions discord-relay-00036-vrl=100 --region us-central1 --project ktp-score-bot`.
>
> The deploy is lockfile-only: `server.js` hashes to the same blob on both revisions,
> re-derived from each revision's own Cloud Build source zip rather than from a tag.
> `00036-vrl`'s zip carried `package-lock.json` with `path-to-regexp` 0.1.12 / `qs` 6.13.0 /
> `body-parser` 1.20.3 / `express` 4.21.2 and audited 4 production advisories; `00037-6wd`'s
> carries 0.1.13 / 6.15.3 / 1.20.6 / 4.22.2 and audits 0, with and without `--omit=dev`.
>
> `allowed_mentions` re-verified live afterwards by **difference**, gated on Discord's
> returned message object rather than the relay's own 200: the same content sent with
> `parse: []` came back with an empty `mentions` array and with `parse: ["users"]` came back
> with the mention present. A relay that dropped the field would answer identically to both,
> which a single success status cannot distinguish. Both probe messages were deleted.

### Security
- **Dependency refresh — the four production advisories are real, not the
  dev-only tree they were assumed to be.** `npm audit --omit=dev` (Node 24.19.0)
  reported 4 (2 high, 2 moderate) against the *shipping* dependency set, plus 3
  more in the `nodemon` tree that `npm ci --omit=dev` never installs. The
  lockfile pins that were patched at the last review had since been overtaken by
  newly published advisories: `path-to-regexp` 0.1.12 → **0.1.13**
  (GHSA-37ch-88jc-xwx2, ReDoS), `qs` 6.13.0 → **6.15.3** (GHSA-w7fw-mjwx-w883,
  GHSA-6rw7-vpxm-498p, GHSA-q8mj-m7cp-5q26), `body-parser` 1.20.3 → **1.20.6**
  (GHSA-v422-hmwv-36x6, size limit silently disabled on an invalid `limit`), and
  `express` 4.21.2 → **4.22.2**, which carries them. All resolved inside the
  existing `^4.19.2` range, so `package.json` is unchanged and only the lockfile
  moved; `npm audit` now reports 0 with and without `--omit=dev`. Server smoke
  re-run on the new tree: `/` 200, `/health` 200, `/whoami` unauthenticated 401,
  wrong secret 401, `/reactions` missing-params 400, unknown route 404.
  ⚠️ A patched pin is a snapshot, not a state — re-run the audit rather than
  reading the version list here.

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

## [1.1.1] - 2026-07-18 (DEPLOYED 2026-08-09, Cloud Run revision `discord-relay-00036-vrl`)

> ⚠️ **The "staged, not deployed" tag sat here for three weeks and was probably already wrong.**
> Revision **`00035-xlg`** was deployed **2026-07-19**, the day after this code landed (`1b3f9c8`,
> 07-18), so 1.1.1 was most likely already serving — while this changelog and the root
> `CLAUDE.md` row both still pinned `00034-r54`. Redeployed 2026-08-09 to remove the doubt
> rather than reason about it; `00036-vrl` is certain. **Verify a relay deploy by revision id,
> not by a changelog tag.**
>
> Post-deploy checks, all four green: `/health` 200 · no `X-Relay-Auth` → 401 · authenticated
> `/whoami` → 200 "KTP Score Bot" · removed debug endpoint → 404.

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
