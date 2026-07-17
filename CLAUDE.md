# Discord Relay - Claude Code Context

> **IPs here are placeholders** — this repo is public. Real addresses resolve in
> the private root context (`KTP Git Projects/CLAUDE.md` § IP Addresses),
> which is deliberately not in any git repository.

**REQUIRED: Before modifying or deploying this service, invoke the `relay-dev` skill** (`.claude/skills/relay-dev/SKILL.md`). It carries the load-bearing passthroughs, compatibility contract, and deploy/verify checklist; do not edit server.js without it loaded.

## Overview
Node.js/Express bot-token relay for the Discord API — send/edit/delete/read
messages, add/list reactions, and send DMs on behalf of KTP services that can't
hold a bot token themselves. Authenticated via the `X-Relay-Auth` shared-secret
header. Deployed on Google Cloud Run.

## Project Structure
- `server.js` - Main Express server
- `package.json` - Node.js dependencies
- `Dockerfile` - Container build definition
- `README.md` - Full documentation
- `CHANGELOG.md` - Version history

## Local Development
```bash
# Install dependencies
npm install

# Set environment variables
export DISCORD_BOT_TOKEN="your-token"
export RELAY_SHARED_SECRET="your-secret"

# Run with auto-reload
npm run dev

# Or run directly
npm start
```

## Deployment
Deployed to Google Cloud Run as service `discord-relay` in project
`ktp-score-bot` (512Mi / concurrency 80 / timeout 300s). Env vars carry over
between revisions:
```bash
gcloud run deploy discord-relay --source . --region us-central1 --project ktp-score-bot
```

## Key Endpoints
| Endpoint | Description |
|----------|-------------|
| `POST /reply` | Send message to channel |
| `POST /edit` | Edit existing message |
| `POST /react` | Add reaction to message |
| `POST /dm` | Send direct message |
| `GET /messages` | List channel messages |
| `GET /health` | Health check |

## Environment Variables

**Required:**
| Variable | Description |
|----------|-------------|
| `DISCORD_BOT_TOKEN` | Discord bot token |
| `RELAY_SHARED_SECRET` | Auth header secret |

**Optional:**
| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 8080, Cloud Run sets this) |

## KTP Integration (consumers)
- AMX plugins via `ktp_discord.inc` over KTPAmxxCurl (KTPMatchHandler, KTPCvarChecker, KTPFileChecker, KTPAdminAudit, KTPHLTVRecorder, ...)
- `ktp-scheduled-restart.sh` - nightly restart notifications
- KTPInfrastructure monitoring - crashreporter, perf-rollup, fleet-health, audit-fleet-drift, deploy.py
- KTPScoreBot-ScoreParser + KTPScoreBot-WeeklyMatches (Apps Script)
- KTPAdminBot - verdict embeds (relay delivers the Acknowledge button; the bot handles interactions on its own gateway)

## Authentication
All authenticated endpoints require `X-Relay-Auth` header matching `RELAY_SHARED_SECRET`.

## Version
Current: v1.1.0

## SSH Access (for debugging/logs)

For data server access, use Python/Paramiko:

**Server Credentials:**
| Server | Host | User | Password |
|--------|------|------|----------|
| Data Server | <DATA_SERVER_IP> | root | (SSH key auth) |

See `N:\Nein_\KTP Git Projects\CLAUDE.md` for paramiko SSH documentation.

## Related Projects
- `N:\Nein_\KTP Git Projects\KTPMatchHandler` - Primary consumer
- `N:\Nein_\KTP Git Projects\KTPCvarChecker` - Uses for violation alerts
- `N:\Nein_\KTP Git Projects\KTPFileChecker` - Uses for file alerts
