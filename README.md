# KTP Discord Relay

**Version 1.0.1** | HTTP relay service for KTP competitive infrastructure to Discord API

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
| `GET /whoami` | Yes | Bot identity |
| `GET /whoami-public` | No | Bot identity (public) |
| `GET /httpcheck` | No | Discord gateway connectivity test |

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

### OAuth (Optional)

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /oauth/discord/login` | No | Initiate Discord OAuth (Twitch linking) |
| `GET /oauth/discord/callback` | No | OAuth callback handler |

---

## Configuration

### Required Environment Variables

| Variable | Description |
|----------|-------------|
| `DISCORD_BOT_TOKEN` | Discord bot token |
| `RELAY_SHARED_SECRET` | Shared secret for `X-Relay-Auth` header |

### Optional (OAuth flow only)

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 8080, Cloud Run sets this) |
| `OAUTH_JWT_SECRET` | JWT signing secret for OAuth state |
| `DISCORD_CLIENT_ID` | Discord OAuth2 client ID |
| `DISCORD_CLIENT_SECRET` | Discord OAuth2 client secret |
| `DISCORD_REDIRECT_URI` | OAuth2 callback URL |
| `WM_WEBAPP_SHARED_SECRET` | Apps Script integration secret |

### Client Configuration

**KTP plugins** (`discord.ini`):
```ini
discord_relay_url=https://your-relay-xxxxx.run.app/reply
discord_channel_id=1234567890123456789
discord_auth_secret=your-secret-here
```

---

## Deployment (Google Cloud Run)

```bash
gcloud run deploy ktp-relay \
  --source . \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars "RELAY_SHARED_SECRET=xxx,DISCORD_BOT_TOKEN=xxx" \
  --memory 256Mi \
  --concurrency 80 \
  --timeout 30s
```

### Update

```bash
gcloud run deploy ktp-relay --source . --region us-central1
```

### Logs

```bash
gcloud logs tail --project YOUR_PROJECT_ID --service ktp-relay
```

---

## Key Design Decisions

- **Stateless** - Each request is independent, scales to zero
- **Retry with backoff** - Honors Discord `Retry-After` headers, exponential backoff, capped at 60s
- **No accidental pings** - `allowed_mentions: { parse: [] }` on all outgoing messages
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
