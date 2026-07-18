# KTP Discord Relay

**Version 1.1.1** | HTTP relay service for KTP competitive infrastructure to Discord API

A Node.js/Express HTTP relay that forwards requests from KTP services to the Discord API V10. Stateless proxy deployed on Google Cloud Run that handles authentication, retry logic, and rate limiting.

Part of the [KTP Competitive Infrastructure](https://github.com/afraznein).

---

## Purpose

Enables KTP game server plugins and backend services to communicate with Discord:

- **KTPMatchHandler** - Match start/end, pause events, player disconnect alerts
- **KTPCvarChecker** - Cvar violation alerts
- **KTPFileChecker** - File consistency alerts
- **KTPAdminAudit** - Admin action logging
- **KTPHLTVRecorder** - HLTV restart notices
- **KTP Score Parser** (Apps Script) - Match statistics
- **KTPScoreBot-WeeklyMatches** (Apps Script) - Weekly recaps and leaderboards

The relay handles Discord API authentication, rate limiting, and retries. All business logic lives in the client applications.

---

## Architecture

```
KTP Game Servers / Apps Script
         | HTTPS + X-Relay-Auth
         v
KTP Discord Relay (Cloud Run)
  - Auth validation
  - Request forwarding
  - Retry with backoff
  - Rate limit handling
         | Bot Token
         v
Discord API V10
```

---

## API Endpoints

All authenticated endpoints require `X-Relay-Auth` header.

### Health & Diagnostics

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /health` | No | Health check + env validation |
| `GET /` | No | Root liveness |
| `GET /whoami` | Yes | Bot identity |

### Messages

| Endpoint | Auth | Description |
|----------|------|-------------|
| `POST /reply` | Yes | Send message to channel (supports embeds, replies) |
| `GET /messages` | Yes | List channel messages (paginated) |
| `GET /message/:channelId/:messageId` | Yes | Get specific message |
| `POST /edit` | Yes | Edit existing message |
| `DELETE /delete/:channelId/:messageId` | Yes | Delete message |
| `POST /dm` | Yes | Send direct message to user |

### Reactions & Channels

| Endpoint | Auth | Description |
|----------|------|-------------|
| `POST /react` | Yes | Add reaction to message |
| `GET /reactions` | Yes | List reactors with role enrichment |
| `GET /channel/:channelId` | Yes | Get channel info |

---

## Configuration

### Required Environment Variables

| Variable | Description |
|----------|-------------|
| `DISCORD_BOT_TOKEN` | Discord bot token |
| `RELAY_SHARED_SECRET` | Shared secret for `X-Relay-Auth` header |

### Optional

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 8080, Cloud Run sets this) |

### Client Configuration

**KTP plugins** (`discord.ini`):
```ini
discord_relay_url=https://your-relay-xxxxx.run.app/reply
discord_channel_id=1234567890123456789
discord_auth_secret=your-secret-here
```

---

## Deployment (Google Cloud Run)

The production service is named `discord-relay` (project `ktp-score-bot`),
running 512Mi / concurrency 80 / timeout 300s.

```bash
gcloud run deploy discord-relay \
  --source . \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars "RELAY_SHARED_SECRET=xxx,DISCORD_BOT_TOKEN=xxx" \
  --memory 512Mi \
  --concurrency 80 \
  --timeout 300
```

### Update

Env vars carry over between revisions — no need to re-set them:

```bash
gcloud run deploy discord-relay --source . --region us-central1 --project ktp-score-bot
```

### Logs

```bash
gcloud beta run services logs tail discord-relay --region us-central1 --project ktp-score-bot
```

---

## Key Design Decisions

- **Stateless** - Each request is independent, scales to zero
- **Retry with backoff** - Honors Discord `Retry-After` headers, exponential backoff, capped at 60s
- **Mentions stripped by default** - outgoing messages default to `allowed_mentions: { parse: [] }`; callers may pass an explicit `allowed_mentions` to opt in (used by the crash reporter, perf rollup, fleet health, and admin-bot verdict embeds)
- **Content truncation** - Messages capped at 1900 chars (Discord limit is 2000)
- **Emoji cache** - In-memory 60s TTL for guild emoji lookups

---

## Related Projects

**KTP Stack:**
- [KTPMatchHandler](https://github.com/afraznein/KTPMatchHandler) - Primary consumer (match events)
- [KTPCvarChecker](https://github.com/afraznein/KTPCvarChecker) - Cvar violation alerts
- [KTPAdminAudit](https://github.com/afraznein/KTPAdminAudit) - Admin action logging

**External:**
- [Discord API Documentation](https://discord.com/developers/docs/intro)
- [Google Cloud Run Documentation](https://cloud.google.com/run/docs)

See [CHANGELOG.md](CHANGELOG.md) for version history.

---

## License

MIT License - See [LICENSE](LICENSE) for full text.
