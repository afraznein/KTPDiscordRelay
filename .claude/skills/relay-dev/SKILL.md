---
name: relay-dev
description: Use BEFORE modifying or deploying the Discord Relay — load-bearing passthroughs you must not strip, auth rules for new endpoints, backward-compatibility constraints with fleet consumers, and the gcloud-via-WSL deploy + verify checklist.
---

# Discord Relay Development

Single Express service (`server.js`) relaying Discord API calls for the whole
KTP stack. Small codebase, big blast radius: every plugin alert, crash report,
restart notification, and admin-bot embed flows through it.

## Identity (get this right first)
- Cloud Run service **`discord-relay`** in GCP project **`ktp-score-bot`**,
  region us-central1. NOT "ktp-relay" — that wrong name shipped in an old README
  and has burned a deploy before.
- 512Mi / concurrency 80 / timeout 300s. Env vars carry over between revisions.

## Load-bearing behavior — never remove or "tighten"
- **`allowed_mentions` passthrough**: crashreporter `@everyone`, perf-rollup role
  pings, fleet-health user pings, and AdminBot all depend on it. Stripping or
  defaulting it silently kills paging.
- **`components` passthrough**: delivers AdminBot's Acknowledge button (the bot
  handles interactions on its own gateway; the relay only delivers).
- These were once unversioned drive-by additions — they are now documented in the
  CHANGELOG. Keep them documented.

## Compatibility contract
Consumers you cannot easily update call this service: AMX plugins over
KTPAmxxCurl (`ktp_discord.inc`), `ktp-scheduled-restart.sh` on 5 hosts,
KTPInfrastructure monitors, Apps Script score bots, KTPAdminBot. Therefore:
- Never change an existing endpoint's path, method, auth header, or required
  fields. Additive changes only; new behavior goes on new fields/endpoints.
- Fleet-side callers are plain curl from Pawn — no retries, no content
  negotiation. Responses must stay simple JSON with stable shapes.

## Security rules
- One shared secret (`X-Relay-Auth` vs `RELAY_SHARED_SECRET`) guards everything.
  Every new endpoint MUST require it — use the existing **timing-safe compare**
  helper in server.js, never `===`.
- No unauthenticated endpoints besides `/health` and `/` (root liveness). Debug/introspection endpoints
  without auth were removed in 1.1.0; don't reintroduce them.
- The relay holds the bot token; nothing that echoes config/env may ship.
- `/dm` content is capped (1900 chars). Respect Discord API limits on new
  endpoints rather than letting Discord reject at the edge.

## Change workflow
1. Bump version in `package.json`, add a `CHANGELOG.md` section (this repo's
   changelog was once backfilled from unversioned changes — keep it current),
   update README if endpoints/env change.
2. Base image is version-pinned Node LTS alpine (node:22-alpine as of 1.1.0).
   When touching the Dockerfile, check the pinned major is still in LTS.
3. Local test: `npm start` with `DISCORD_BOT_TOKEN` + `RELAY_SHARED_SECRET`
   exported; exercise the changed endpoint with curl before any deploy.

## Deploy (gcloud is WSL-only on this box)
`gcloud` does not exist in Windows PATH here — run it inside WSL:
```bash
wsl bash -c "cd '/mnt/n/Nein_/KTP Git Projects/Discord Relay' && gcloud run deploy discord-relay --source . --region us-central1 --project ktp-score-bot"
```
If auth is needed, `gcloud auth login` is interactive — have the operator run it
(the `!` prefix in the prompt runs commands in-session), or use the FIFO
technique noted in memory `gcloud-wsl-relay-deploy`.

## Post-deploy verification (all four, every time)
1. `GET /health` → 200.
2. A request with no `X-Relay-Auth` → 401.
3. An authenticated `GET /whoami` → 200 with the bot identity ("KTP Score Bot").
4. Any endpoint you deleted → 404.
Then confirm the new revision is serving (`gcloud run revisions list`) and note
the revision id in the CHANGELOG entry.

## Rollback
Cloud Run keeps prior revisions — roll back by routing traffic to the previous
revision (`gcloud run services update-traffic discord-relay
--to-revisions=<rev>=100`), not by redeploying old source.
