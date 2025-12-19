# Changelog

All notable changes to KTP Discord Relay will be documented in this file.

## [1.0.0] - 2024-12-18

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
