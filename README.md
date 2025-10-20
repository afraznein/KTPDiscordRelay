`KTP Discord Relay server.js` – **Lightweight HTTP Relay Server**

The `server.js` file implements a lightweight Node.js / Express HTTP relay for the **KTP Score Parser** project.
Its primary role is to forward HTTP requests from the project’s **Google Apps Script** environment to the **Discord API V10**, acting as a simple proxy.
This design helps circumvent Cloudflare challenges and **CORS (Cross-Origin Resource Sharing)** restrictions that would otherwise block direct requests from Google Apps Script to Discord.

**🔧 Purpose**

Enables Google Apps Script (the score parser) to communicate with Discord by forwarding requests — effectively bypassing Cloudflare and CORS issues on direct calls.
The relay simply passes along API calls (e.g. fetching channel messages, posting replies, or adding reactions) to Discord and returns the results.

**🧠 Core Behavior**

**No caching:** The relay does not cache or persist data. Every request is passed directly to Discord in real time.

**Minimal authentication:** The server performs a lightweight token check via an X-Relay-Auth header but does not handle logins, OAuth, or complex permission systems.

**Stateless operation:** Each request is independent / asynchronous; no sessions or background processes are maintained.

**Transparent forwarding:** Request bodies and responses are forwarded between Google Apps Script and Discord with minimal transformation.

**🪶 Design Philosophy**

This relay is intentionally minimal.
All business logic — including message parsing, score updates, alias resolution, and logging — lives inside the Google Apps Script codebase.
The relay’s only purpose is to transmit requests and responses between Google Apps Script and the Discord API reliably and securely, without altering data.

An example of how to deploy to gcloud (how I currently run this):

**Deploying `server.js` to Google Cloud Run (via `gcloud`)**

**Prereqs:**
- Node/Express relay in this repo (your `server.js` + `package.json`, optional `Dockerfile`)
- Google Cloud SDK installed (gcloud)
- A Google Cloud project selected and billing enabled

**One-time project setup**
```bash
# Authenticate and pick your project
gcloud auth login
gcloud config set project YOUR_PROJECT_ID

# Enable required services
gcloud services enable run.googleapis.com cloudbuild.googleapis.com
```
**Choose one of the deployment methods**
**Option A) Deploy from source (uses Cloud Buildpacks or your Dockerfile automatically)**

This is the simplest—no manual image build step.
```bash
# From the repo root (where server.js/package.json live)
gcloud run deploy ktp-relay \
  --source . \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars "RELAY_AUTH=changeme,DISCORD_BOT_TOKEN=your-token-here" \
  --memory 256Mi \
  --concurrency 80 \
  --timeout 30s
```

**Replace:**

- RELAY_AUTH with the shared secret your Apps Script sends in X-Relay-Auth.
- DISCORD_BOT_TOKEN with your bot token (don’t commit it to git).
- Consider removing --allow-unauthenticated and using an HTTPS proxy or IAP if you want stricter access.

Cloud Run will print the public HTTPS URL on success.

**Option B) Build a container, then deploy**

If you prefer an explicit image step (uses your `Dockerfile`):

```bash
# Build & push the image (Artifact Registry)
gcloud artifacts repositories create relay-repo \
  --repository-format=docker --location=us --description="Relay images" || true

gcloud auth configure-docker us-docker.pkg.dev

gcloud builds submit --tag us-docker.pkg.dev/YOUR_PROJECT_ID/relay-repo/ktp-relay:latest .

# Deploy
gcloud run deploy ktp-relay \
  --image us-docker.pkg.dev/YOUR_PROJECT_ID/relay-repo/ktp-relay:latest \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars "RELAY_AUTH=changeme,DISCORD_BOT_TOKEN=your-token-here" \
  --memory 256Mi \
  --concurrency 80 \
  --timeout 30s
```
**Environment variables (examples):**

- RELAY_AUTH — shared secret checked on incoming requests (your Apps Script should send X-Relay-Auth: <value>).
- DISCORD_BOT_TOKEN — bot token used to call the Discord API.
- Any optional config you use (e.g., CORS allowlist): CORS_ORIGIN=https://script.google.com
> Never commit secrets. Prefer storing them as env vars (above) or via Cloud Run > Revisions > Variables & Secrets in the console.

**Quick test**
```bash
# Health check (if you exposed one like GET /health)
curl -s https://YOUR_RUN_URL/health

# Example relay endpoint (adjust to match your server.js routes)
curl -X POST https://YOUR_RUN_URL/reply \
  -H "X-Relay-Auth: changeme" \
  -H "Content-Type: application/json" \
  -d '{"channelId":"123456789012345678","content":"Hello from Cloud Run!"}'
```
**Locking down access (recommended)**

Instead of `--allow-unauthenticated`, you can:

Require Google-signed identity (Cloud Run IAM) and call with an ID token from Apps Script’s `UrlFetchApp.fetch` (advanced).

Keep unauthenticated but enforce your `X-Relay-Auth` header and optionally restrict IPs via a proxy (e.g., Cloud Armor).

**Operations tips:**

- Scale to zero by default; set min instances if you want instant cold-start performance:
```bash
gcloud run services update ktp-relay --region us-central1 --min-instances 1
```
- Logs: view with gcloud logs tail --project YOUR_PROJECT_ID --service ktp-relay.
- Update later: re-run the same gcloud run deploy command after code changes.
