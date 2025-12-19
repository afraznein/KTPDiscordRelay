# KTP Discord Relay

**Lightweight HTTP Relay Server for KTP Competitive Infrastructure**

A Node.js/Express HTTP relay that forwards requests from various KTP services to the Discord API V10, acting as a simple, stateless proxy. This design helps circumvent Cloudflare challenges and CORS restrictions while providing a secure bridge between game servers and Discord.

---

## 🎯 Purpose

The KTP Discord Relay enables multiple KTP services to communicate with Discord:

1. **KTP Match Handler** (AMX ModX plugin) - Real-time match notifications
   - Pause/unpause events
   - Match start/end notifications
   - Player disconnect alerts
   - Technical pause warnings

2. **KTP Score Parser** (Google Apps Script) - Post-match statistics
   - Score updates
   - Player statistics
   - Match results

3. **KTPScoreBot-WeeklyMatches** (Google Apps Script) - Weekly match tracking
   - Match scheduling
   - Weekly recaps
   - Leaderboard updates
   - Historical statistics

The relay acts as a proxy, forwarding API calls (fetching channel messages, posting replies, adding reactions) to Discord and returning the results.

---

## 🧠 Core Behavior

**✅ Stateless Operation**
- Each request is independent/asynchronous
- No sessions or background processes
- Scales to zero automatically

**✅ No Caching**
- Every request is passed directly to Discord in real-time
- No data persistence or storage

**✅ Minimal Authentication**
- Simple shared-secret auth via `X-Relay-Auth` header
- No complex OAuth or permission systems

**✅ Transparent Forwarding**
- Request bodies and responses forwarded between clients and Discord
- Minimal transformation of data

**✅ Automatic Retries**
- Built-in retry logic with exponential backoff
- Honors Discord's `Retry-After` headers
- Handles rate limiting gracefully

---

## 🪶 Design Philosophy

This relay is **intentionally minimal**.

All business logic lives in the client applications:
- **KTP Match Handler**: Match state tracking, pause logic, event formatting
- **KTP Score Parser**: Message parsing, score updates, alias resolution, logging
- **KTPScoreBot-WeeklyMatches**: Match scheduling, weekly recaps, leaderboards

The relay's **only purpose** is to reliably and securely transmit requests and responses between clients and the Discord API **without altering data**.

---

## 🚀 Deployment (Google Cloud Run)

### Prerequisites
- Node.js relay code (`server.js` + `package.json`)
- Google Cloud SDK installed (`gcloud`)
- Google Cloud project with billing enabled
- Discord bot token

### One-Time Project Setup

```bash
# Authenticate and select your project
gcloud auth login
gcloud config set project YOUR_PROJECT_ID

# Enable required services
gcloud services enable run.googleapis.com cloudbuild.googleapis.com
```

### Deployment Options

#### **Option A: Deploy from Source (Recommended)**

Simplest method—Cloud Run auto-detects your runtime and builds automatically.

```bash
# From the repository root
gcloud run deploy ktp-relay \
  --source . \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars "RELAY_SHARED_SECRET=your-secret-here,DISCORD_BOT_TOKEN=your-bot-token" \
  --memory 256Mi \
  --concurrency 80 \
  --timeout 30s
```

**Environment Variables:**
- `RELAY_SHARED_SECRET` - Shared secret for authenticating relay requests
- `DISCORD_BOT_TOKEN` - Your Discord bot token
- `OAUTH_JWT_SECRET` - (Optional) Secret for OAuth state signing

> ⚠️ **Security**: Never commit secrets to git. Use environment variables or Cloud Run's Secrets Manager.

#### **Option B: Build Container, Then Deploy**

For explicit control over the Docker image:

```bash
# Create Artifact Registry repository
gcloud artifacts repositories create relay-repo \
  --repository-format=docker \
  --location=us \
  --description="KTP Relay images"

# Configure Docker authentication
gcloud auth configure-docker us-docker.pkg.dev

# Build and push image
gcloud builds submit --tag us-docker.pkg.dev/YOUR_PROJECT_ID/relay-repo/ktp-relay:latest .

# Deploy
gcloud run deploy ktp-relay \
  --image us-docker.pkg.dev/YOUR_PROJECT_ID/relay-repo/ktp-relay:latest \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars "RELAY_SHARED_SECRET=your-secret-here,DISCORD_BOT_TOKEN=your-bot-token" \
  --memory 256Mi \
  --concurrency 80 \
  --timeout 30s
```

Cloud Run will print the public HTTPS URL on success (e.g., `https://ktp-relay-xxxxx-uc.a.run.app`).

---

## 🔧 Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `RELAY_SHARED_SECRET` | ✅ | Shared secret for authenticating relay requests (sent as `X-Relay-Auth` header) |
| `DISCORD_BOT_TOKEN` | ✅ | Discord bot token for API authentication |
| `OAUTH_JWT_SECRET` | ⚠️ | Secret for OAuth state signing (only if using OAuth flow) |
| `PORT` | ❌ | Server port (default: 8080, Cloud Run sets this automatically) |

### Client Configuration

**KTP Match Handler** (`discord.ini`):
```ini
discord_relay_url=https://your-relay-xxxxx.run.app/reply
discord_channel_id=1234567890123456789
discord_auth_secret=your-secret-here
```

**KTP Score Parser / KTPScoreBot-WeeklyMatches** (Apps Script):
```javascript
const RELAY_URL = 'https://your-relay-xxxxx.run.app/reply';
const RELAY_AUTH = 'your-secret-here';
const CHANNEL_ID = '1234567890123456789';
```

---

## 🧪 Testing

### Health Check
```bash
curl -s https://YOUR_RUN_URL/health
```

### Test Reply Endpoint
```bash
curl -X POST https://YOUR_RUN_URL/reply \
  -H "X-Relay-Auth: your-secret-here" \
  -H "Content-Type: application/json" \
  -d '{
    "channelId": "1234567890123456789",
    "content": "Hello from KTP Discord Relay!"
  }'
```

### From KTP Match Handler
The plugin automatically sends requests when match events occur. Check your Discord channel for notifications.

---

## 🔒 Security Best Practices

### Authentication

**Current Setup (Shared Secret):**
- Simple `X-Relay-Auth` header validation
- Good for trusted internal services
- Protects against casual abuse

**Recommended for Production:**

1. **Keep `--allow-unauthenticated` but enforce strong secrets:**
   - Use a cryptographically random `RELAY_SHARED_SECRET`
   - Rotate secrets periodically
   - Monitor access logs

2. **Use Cloud Run IAM (Advanced):**
   ```bash
   # Remove --allow-unauthenticated
   gcloud run deploy ktp-relay \
     --source . \
     --region us-central1 \
     --no-allow-unauthenticated

   # Grant invoker access to service account
   gcloud run services add-iam-policy-binding ktp-relay \
     --member="serviceAccount:YOUR_SA@PROJECT.iam.gserviceaccount.com" \
     --role="roles/run.invoker"
   ```

3. **Additional Protection:**
   - Cloud Armor for IP allowlisting
   - VPC Service Controls
   - API Gateway with rate limiting

### Secret Management

**Never commit secrets to git:**
- ✅ Use Cloud Run environment variables
- ✅ Use Cloud Run Secrets Manager
- ✅ Use `.env` file (local dev only, add to `.gitignore`)
- ❌ Don't hardcode in `server.js`
- ❌ Don't commit to version control

---

## 📊 Operations

### View Logs
```bash
gcloud logs tail \
  --project YOUR_PROJECT_ID \
  --service ktp-relay
```

### Update Deployment
```bash
# After making code changes, re-run the deploy command
gcloud run deploy ktp-relay --source . --region us-central1
```

### Scale Configuration

**Auto-scale (default):**
- Scales to zero when not in use
- Scales up based on traffic
- Cost-effective for intermittent usage

**Keep warm (optional):**
```bash
gcloud run services update ktp-relay \
  --region us-central1 \
  --min-instances 1
```

### Resource Limits
```bash
gcloud run services update ktp-relay \
  --region us-central1 \
  --memory 512Mi \
  --cpu 1 \
  --concurrency 100 \
  --max-instances 10
```

---

## 🏗️ Architecture

```
┌─────────────────────────┐
│  KTP Match Handler      │
│  (AMX ModX Plugin)      │
│  - Pause events         │
│  - Match notifications  │
└────────┬────────────────┘
         │
         │ HTTPS + X-Relay-Auth
         ↓
┌─────────────────────────┐      ┌─────────────────────────┐
│  KTP Discord Relay      │ ←──→ │  Discord API V10        │
│  (Cloud Run)            │      │  - Channels             │
│  - Auth validation      │      │  - Messages             │
│  - Request forwarding   │      │  - Reactions            │
│  - Retry logic          │      │                         │
└────────┬────────────────┘      └─────────────────────────┘
         │
         │ HTTPS + X-Relay-Auth
         ↓
┌─────────────────────────┐         ┌─────────────────────────┐
│  KTP Score Parser       │         │  KTPScoreBot-           │
│  (Google Apps Script)   │         │  WeeklyMatches          │
│  - Match statistics     │         │  (Google Apps Script)   │
│  - Score updates        │         │  - Weekly recaps        │
└─────────────────────────┘         │  - Leaderboards         │
                                     └─────────────────────────┘
```

---

## 📋 API Endpoints

All authenticated endpoints require the `X-Relay-Auth` header with your shared secret.

### Health & Diagnostics

#### `GET /health`
Health check with environment validation.

```json
{ "ok": true, "time": "2025-01-15T12:34:56.789Z" }
```

#### `GET /whoami`
Get bot identity (authenticated).

#### `GET /whoami-public`
Get bot identity (public, no auth required).

#### `GET /httpcheck`
Test Discord gateway connectivity (public, no auth required).

---

### Messages

#### `POST /reply`
Send a message to a Discord channel.

**Request Body:**
```json
{
  "channelId": "1234567890123456789",
  "content": "Message text",
  "embeds": [],
  "referenceMessageId": "987654321098765432"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `channelId` | Yes | Target channel ID |
| `content` | No | Message text (max 1900 chars) |
| `embeds` | No | Array of Discord embed objects |
| `referenceMessageId` | No | Message ID to reply to |

#### `GET /messages`
List messages in a channel.

**Query Parameters:**
| Parameter | Description |
|-----------|-------------|
| `channelId` | Required. Channel to fetch from |
| `after` | Get messages after this ID |
| `around` | Get messages around this ID |
| `limit` | Max messages (default 50, max 100) |

#### `GET /message/:channelId/:messageId`
Get a specific message by ID.

#### `POST /edit`
Edit an existing message.

**Request Body:**
```json
{
  "channelId": "1234567890123456789",
  "messageId": "987654321098765432",
  "content": "Updated text",
  "embeds": []
}
```

#### `DELETE /delete/:channelId/:messageId`
Delete a message.

---

### Channels

#### `GET /channel/:channelId`
Get channel information.

---

### Reactions

#### `POST /react`
Add a reaction to a message.

**Request Body:**
```json
{
  "channelId": "1234567890123456789",
  "messageId": "987654321098765432",
  "emoji": "👍"
}
```

The `emoji` can be a unicode emoji or custom emoji in `name:id` format.

#### `GET /reactions`
List users who reacted to a message (with role enrichment).

**Query Parameters:**
| Parameter | Description |
|-----------|-------------|
| `channelId` | Required. Channel ID |
| `messageId` | Required. Message ID |
| `emoji` | Required. Emoji (unicode or `name:id`) |

**Response:**
```json
[
  {
    "id": "123456789",
    "username": "player1",
    "displayName": "Player One",
    "roles": ["role_id_1", "role_id_2"]
  }
]
```

---

### Direct Messages

#### `POST /dm`
Send a direct message to a user.

**Request Body:**
```json
{
  "userId": "123456789012345678",
  "content": "Hello!"
}
```

**Response:**
```json
{
  "ok": true,
  "id": "987654321098765432",
  "channelId": "111222333444555666"
}
```

---

### OAuth (Optional)

These endpoints support Discord OAuth for linking external accounts (e.g., Twitch).

#### `GET /oauth/discord/login?userId=<discordUserId>`
Redirect user to Discord OAuth consent page.

#### `GET /oauth/discord/callback`
OAuth callback handler (called by Discord after user authorizes).

---

## 🔗 Related Projects

**KTP Competitive Infrastructure:**
- **[KTP-ReHLDS](https://github.com/afraznein/KTP-ReHLDS)** - Custom ReHLDS fork with pause HUD updates
- **[KTP-ReAPI](https://github.com/afraznein/KTP-ReAPI)** - Custom ReAPI fork with pause hooks
- **[KTP Match Handler](https://github.com/afraznein/KTPMatchHandler)** - Match management plugin
- **[KTP Cvar Checker](https://github.com/afraznein/KTPCvarChecker)** - Anti-cheat system
- **[KTP Score Parser](https://github.com/afraznein/KTPScoreParser)** - Match statistics parser
- **[KTPScoreBot-WeeklyMatches](https://github.com/afraznein/KTPScoreBot-WeeklyMatches)** - Weekly match tracking

---

## 📝 License

MIT License - See [LICENSE](LICENSE) file for details

---

## 👤 Author

**Nein_**
- GitHub: [@afraznein](https://github.com/afraznein)
- Project: KTP Competitive Infrastructure

---

## 🙏 Acknowledgments

- **Discord** - API platform
- **Google Cloud** - Cloud Run hosting
- **Express.js** - Web framework
- **KTP Community** - Testing and feedback

---

## 📚 Additional Resources

**Documentation:**
- [Discord API Documentation](https://discord.com/developers/docs/intro)
- [Google Cloud Run Documentation](https://cloud.google.com/run/docs)
- [KTP Match Handler Discord Guide](https://github.com/afraznein/KTPMatchHandler/blob/main/DISCORD_GUIDE.md)

**Deployment:**
- [Cloud Run Quickstart](https://cloud.google.com/run/docs/quickstarts/build-and-deploy)
- [Cloud Run Authentication](https://cloud.google.com/run/docs/authenticating/overview)
- [Cloud Run Secrets](https://cloud.google.com/run/docs/configuring/secrets)
