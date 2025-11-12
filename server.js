// server.js — CommonJS, Cloud Run friendly
// ---------- App ----------
const express = require('express');
const app = express();

app.use(express.json());

// ---------- Constants / ENV ----------
const DISCORD_API = 'https://discord.com/api/v10';

const DISCORD_BOT_TOKEN   = process.env.DISCORD_BOT_TOKEN || '';
const RELAY_SHARED_SECRET = process.env.RELAY_SHARED_SECRET || '';
const PORT = process.env.PORT || 8080;

const crypto = require('crypto');
const jwt = require('jsonwebtoken');        // add to package.json
const qs = require('querystring');

function signState(payload) {
  return jwt.sign(payload, process.env.OAUTH_JWT_SECRET, { expiresIn: '10m' });
}
function verifyState(token) {
  return jwt.verify(token, process.env.OAUTH_JWT_SECRET);
}


// ---------- Utilities ----------
function ts() { return new Date().toISOString(); }
function nowIso() { return ts(); } // keep compatibility

function discordStyleUA() {
  return 'DiscordBot (https://github.com/discord/discord-api-docs, v10) Relay/1.0';
}

// Shared headers for Discord API
const BASE_HEADERS = {
  Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
  'User-Agent': discordStyleUA(),
  'X-Track': 'discord-relay',
  'Content-Type': 'application/json',
};

// Simple shared-secret auth
function requireAuth(req, res, next) {
  const hdr = req.header('X-Relay-Auth');
  if (!RELAY_SHARED_SECRET || hdr !== RELAY_SHARED_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// Sleep + retries
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithRetries(url, options = {}, { retries = 2, backoffMs = 600 } = {}) {
  let attempt = 0;
  let lastErr = null;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function parseRetryAfter(h) {
    if (!h) return null;
    // Numeric seconds per RFC
    const asSeconds = Number(h);
    if (Number.isFinite(asSeconds)) return Math.min(asSeconds * 1000, 60_000);
    // Or HTTP-date
    const asDate = Date.parse(h);
    if (Number.isFinite(asDate)) {
      const delta = asDate - Date.now();
      return Math.min(Math.max(delta, 0), 60_000);
    }
    return null;
  }

  while (attempt <= retries) {
    try {
      const resp = await fetch(url, options);

      if (resp.status === 429 || resp.status >= 500) {
        const body = await resp.text().catch(() => '');
        lastErr = new Error(`HTTP ${resp.status} ${url} body=${body.slice(0,200)}`);

        // honor Retry-After when present (cap at 60s to be safe on Cloud Run)
        const retryAfter = parseRetryAfter(resp.headers.get('retry-after'));
        const waitMs = retryAfter ?? backoffMs * Math.pow(2, attempt);
        if (attempt === retries) throw lastErr;
        await sleep(waitMs);
        attempt++;
        continue;
      }

      return resp;
    } catch (e) {
      lastErr = e;
      if (attempt === retries) break;
      await sleep(backoffMs * Math.pow(2, attempt));
      attempt++;
    }
  }
  throw lastErr || new Error('fetchWithRetries failed');
}


function pruneEmpty(obj) {
  // remove undefined keys so we don't send invalid JSON to Discord
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}


// ---------- Emoji helpers ----------
function buildEmojiPathSegment({ name, id }) {
  if (id && name) return `${name}:${id}`;
  if (name && !id) return name; // unicode or fallback
  if (id && !name) return id;   // try with id only
  return name || id || '';
}

// ---------- Discord lookups (channel, emojis, roles) ----------
async function getChannelInfo(channelId) {
  const url = `${DISCORD_API}/channels/${encodeURIComponent(channelId)}`;
  const r = await fetchWithRetries(url, { method: 'GET', headers: BASE_HEADERS }, { retries: 3, backoffMs: 600 });
  if (!r.ok) return null;
  return r.json();
}

// --- tiny in-memory cache for guild emojis (TTL 60s) ---
const emojiCache = new Map(); // key: guildId, value: { data: Map, expires: number }

function getCachedEmojis(guildId) {
  const hit = emojiCache.get(guildId);
  if (hit && hit.expires > Date.now()) return hit.data;
  return null;
}
function setCachedEmojis(guildId, data) {
  emojiCache.set(guildId, { data, expires: Date.now() + 60_000 });
}


async function getGuildEmojiMap(guildId) {
  const cached = getCachedEmojis(guildId);
  if (cached) return cached;

  const url = `${DISCORD_API}/guilds/${encodeURIComponent(guildId)}/emojis`;
  const r = await fetchWithRetries(url, { method: 'GET', headers: BASE_HEADERS }, { retries: 3, backoffMs: 600 });
  if (!r.ok) return {};
  const arr = await r.json();
  const map = {};
  for (const e of arr) { map[e.id] = e.name; }

  setCachedEmojis(guildId, map);
  return map;
}


async function getGuildMemberRoles(guildId, userId) {
  const url = `${DISCORD_API}/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(userId)}`;
  const r = await fetchWithRetries(url, { method: 'GET', headers: BASE_HEADERS }, { retries: 2, backoffMs: 600 });
  if (!r.ok) return [];
  const j = await r.json();
  return Array.isArray(j.roles) ? j.roles : [];
}

// ---------- Routes ----------

// Health
app.get('/health', (_req, res) => {
  if (!DISCORD_BOT_TOKEN)   return res.status(500).json({ ok: false, error: 'Missing DISCORD_BOT_TOKEN' });
  if (!RELAY_SHARED_SECRET) return res.status(500).json({ ok: false, error: 'Missing RELAY_SHARED_SECRET' });
  res.json({ ok: true, time: ts() });
});

app.get('/whoami-public', async (req, res) => {
  try {
    const r = await fetch('https://discord.com/api/v10/users/@me', {
      headers: {
        'Authorization': `Bot ${process.env.DISCORD_BOT_TOKEN}`,
        'User-Agent': 'DiscordBot (relay; whoami/1.0)'
      }
    });
    const txt = await r.text();
    return res.status(r.status).send(txt);
  } catch (e) {
    console.error('[whoami] fetch failed', e);
    return res.status(500).json({ error: 'fetch_failed', detail: String(e) });
  }
});

app.get('/httpcheck', async (req, res) => {
  try {
    const r = await fetch('https://discord.com/api/v10/gateway');
    const txt = await r.text();
    return res.status(r.status).send(txt.slice(0, 400));
  } catch (e) {
    console.error('[httpcheck] fetch failed', e);
    return res.status(500).json({ error: 'fetch_failed', detail: String(e) });
  }
});

// Who am I
app.get('/whoami', requireAuth, async (_req, res) => {
  try {
    const url = `${DISCORD_API}/users/@me`;
    const r = await fetchWithRetries(url, { method: 'GET', headers: BASE_HEADERS }, { retries: 2, backoffMs: 600 });
    const text = await r.text();
    res.status(r.status).type('application/json').send(text);
  } catch (e) {
    console.error(`${ts()} GET /whoami error:`, e);
    res.status(500).json({ error: 'relay_error', detail: String(e) });
  }
});

// List messages
app.get('/messages', requireAuth, async (req, res) => {
  try {
    const { channelId, after, around, limit } = req.query;
    if (!channelId) return res.status(400).json({ error: 'channelId required' });

    let qs;
    if (around) qs = `?around=${encodeURIComponent(around)}${limit ? `&limit=${encodeURIComponent(limit)}` : ''}`;
    else if (after) qs = `?limit=${encodeURIComponent(limit || 100)}&after=${encodeURIComponent(after)}`;
    else qs = `?limit=${encodeURIComponent(limit || 50)}`;

    const url = `${DISCORD_API}/channels/${encodeURIComponent(channelId)}/messages${qs}`;
    const r = await fetchWithRetries(url, { method: 'GET', headers: BASE_HEADERS }, { retries: 2, backoffMs: 600 });
    const text = await r.text();
    if (r.status !== 200) {
      console.error(`${ts()} GET /messages error`, { status: r.status, channelId, after, around, limit, body: text?.slice(0, 500) });
    }
    res.status(r.status).type('application/json').send(text);
  } catch (e) {
    console.error(`${ts()} GET /messages relay error:`, e);
    res.status(500).json({ error: 'relay_error', detail: String(e) });
  }
});

// Exact message
app.get('/message/:channelId/:messageId', requireAuth, async (req, res) => {
  try {
    const { channelId, messageId } = req.params;
    if (!channelId || !messageId) return res.status(400).json({ error: 'channelId and messageId required' });

    const url = `${DISCORD_API}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`;
    const r = await fetchWithRetries(url, { method: 'GET', headers: BASE_HEADERS }, { retries: 2, backoffMs: 600 });
    const text = await r.text();
    if (r.status !== 200) {
      console.error(`${ts()} GET /message error`, { status: r.status, channelId, messageId, body: text?.slice(0, 500) });
    }
    res.status(r.status).type('application/json').send(text);
  } catch (e) {
    console.error(`${ts()} GET /message relay error:`, e);
    res.status(500).json({ error: 'relay_error', detail: String(e) });
  }
});

// Channel info
app.get('/channel/:channelId', requireAuth, async (req, res) => {
  try {
    const { channelId } = req.params;
    if (!channelId) return res.status(400).json({ error: 'channelId required' });

    const url = `${DISCORD_API}/channels/${encodeURIComponent(channelId)}`;
    const r = await fetchWithRetries(url, { method: 'GET', headers: BASE_HEADERS }, { retries: 2, backoffMs: 600 });
    const text = await r.text();
    if (r.status !== 200) {
      console.error(`${ts()} GET /channel error`, { status: r.status, channelId, body: text?.slice(0, 500) });
    }
    res.status(r.status).type('application/json').send(text);
  } catch (e) {
    console.error(`${ts()} GET /channel relay error:`, e);
    res.status(500).json({ error: 'relay_error', detail: String(e) });
  }
});

// List reactors (with role enrichment)
app.get('/reactions', requireAuth, async (req, res) => {
  try {
    const { channelId, messageId, emoji } = req.query;
    if (!channelId || !messageId || !emoji) {
      return res.status(400).json({ error: 'missing channelId/messageId/emoji' });
    }

    // 1) Determine guild (if any)
    const chInfo = await getChannelInfo(channelId).catch(() => null);
    const guildId = chInfo && chInfo.guild_id ? chInfo.guild_id : null;

    // 2) Build emoji segment
    let emojiName = null;
    let emojiId = null;
    const m = String(emoji).match(/^([^:]+):(\d+)$/);
    if (m) {
      emojiName = m[1];
      emojiId = m[2];
    } else if (/^\d+$/.test(String(emoji))) {
      emojiId = String(emoji);
      if (guildId) {
        const emap = await getGuildEmojiMap(guildId).catch(() => ({}));
        emojiName = emap[emojiId] || null;
      }
    } else {
      emojiName = String(emoji); // unicode or name
    }
    const emojiSeg = encodeURIComponent(buildEmojiPathSegment({ name: emojiName, id: emojiId }));

    // 3) Discord: list users who reacted
    const url = `${DISCORD_API}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions/${emojiSeg}?limit=100`;
    const r = await fetchWithRetries(url, { method: 'GET', headers: BASE_HEADERS }, { retries: 3, backoffMs: 600 });

    if (!r.ok) {
      const body = await r.text();
      return res.status(r.status).send(body);
    }
    const users = await r.json();

    // 4) Enrich with roles
    const out = [];
    for (const u of users) {
      let roles = [];
      if (guildId) {
        roles = await getGuildMemberRoles(guildId, u.id).catch(() => []);
      }
      out.push({
        id: u.id,
        username: u.username,
        displayName: u.global_name || u.username,
        roles,
      });
    }
    return res.json(out);
  } catch (e) {
    console.error(`${ts()} GET /reactions relay error:`, e);
    res.status(500).json({ error: 'relay_error', detail: String(e) });
  }
});

// 1) Kickoff: send user to Discord OAuth consent page
app.get('/oauth/discord/login', async (req, res) => {
  try {
    const userId = String(req.query.userId || ''); // Discord user to attribute shoutcaster to
    if (!/^\d{5,30}$/.test(userId)) {
      return res.status(400).send('Missing/invalid userId');
    }
    const state = signState({ userId, ts: Date.now() });
    const authUrl = 'https://discord.com/api/oauth2/authorize?' + qs.stringify({
      client_id: process.env.DISCORD_CLIENT_ID,
      redirect_uri: process.env.DISCORD_REDIRECT_URI,
      response_type: 'code',
      scope: 'identify connections',
      state
    });
    res.redirect(authUrl);
  } catch (e) {
    console.error('[oauth login] error', e);
    res.status(500).send('OAuth error');
  }
});

// 2) Callback: exchange code → token; read /users/@me and /users/@me/connections
app.get('/oauth/discord/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('Missing code/state');

    let decoded;
    try { decoded = verifyState(state); } catch { return res.status(400).send('Invalid/expired state'); }
    const userId = decoded.userId;

    // Exchange code for token
    const tokenResp = await fetchWithRetries('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: qs.stringify({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.DISCORD_REDIRECT_URI
      })
    }, { retries: 2, backoffMs: 600 });

    const tokenText = await tokenResp.text();
    if (!tokenResp.ok) return res.status(tokenResp.status).send(tokenText);
    const token = JSON.parse(tokenText);
    const accessToken = token.access_token;

    // Fetch user (optional, for display)
    const meResp = await fetchWithRetries('https://discord.com/api/v10/users/@me', {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` }
    }, { retries: 2, backoffMs: 600 });
    const me = await meResp.json();

    // Fetch connections
    const connResp = await fetchWithRetries('https://discord.com/api/v10/users/@me/connections', {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` }
    }, { retries: 2, backoffMs: 600 });
    const connections = await connResp.json();

    // Find Twitch
    let twitchUrl = '';
    if (Array.isArray(connections)) {
      const tw = connections.find(c => c.type === 'twitch' && c.name);
      if (tw && tw.name) twitchUrl = `https://twitch.tv/${tw.name}`;
    }

    // If Twitch was found, push to Apps Script to store (reuse your web app secret)
    if (twitchUrl) {
      // Call your Apps Script webapp endpoint that saves twitch for a user
      // You'll implement this server_* function in Apps Script (see below).
      const scriptUrl = 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec';
      const saveResp = await fetchWithRetries(`${scriptUrl}?op=saveTwitch&key=${encodeURIComponent(process.env.WM_WEBAPP_SHARED_SECRET)}&userId=${encodeURIComponent(userId)}&twitch=${encodeURIComponent(twitchUrl)}`, {
        method: 'GET'
      }, { retries: 2, backoffMs: 600 });
      // Ignore result content; show a nice page:
      return res.status(200).send(`
        <html><body style="font-family:system-ui">
          <h2>Thanks, ${me.username || 'shoutcaster'}!</h2>
          <p>We linked your Twitch: <a href="${twitchUrl}" target="_blank">${twitchUrl}</a>.</p>
          <p>You can close this tab.</p>
        </body></html>`);
    } else {
      return res.status(200).send(`
        <html><body style="font-family:system-ui">
          <h2>Thanks, ${me.username || 'shoutcaster'}!</h2>
          <p>We couldn't find a Twitch connection on your Discord account.</p>
          <p>Please connect Twitch in Discord (User Settings → Connections), then retry, or reply "twitch yourname" to the bot.</p>
        </body></html>`);
    }

  } catch (e) {
    console.error('[oauth callback] error', e);
    res.status(500).send('OAuth error');
  }
});


// Send a message (reply/plain)
// POST /reply
// Body: { channelId, content, embeds?, referenceMessageId? }
app.post('/reply', requireAuth, async (req, res) => {
  try {
    const { channelId, content, embeds, referenceMessageId } = req.body || {};
    if (!channelId) return res.status(400).json({ error: 'channelId required' });

    const url = `${DISCORD_API}/channels/${encodeURIComponent(channelId)}/messages`;

    // Discord allows empty content if embeds exist.
    const body = {
      content: typeof content === 'string' ? String(content).slice(0, 1900) : '',
      ...(Array.isArray(embeds) && embeds.length ? { embeds } : {}),
      ...(referenceMessageId
        ? { message_reference: { message_id: referenceMessageId, fail_if_not_exists: false } }
        : {}),
      // avoid accidental pings
      allowed_mentions: { parse: [] },
    };

    const r = await fetchWithRetries(
      url,
      { method: 'POST', headers: BASE_HEADERS, body: JSON.stringify(body) },
      2,
      'postMessage'
    );

    const text = await r.text();
    if (r.status >= 300) {
      console.error(`${ts()} POST /reply error`, {
        status: r.status,
        channelId,
        body: text?.slice(0, 500),
      });
    }
    res.status(r.status).type('application/json').send(text);
  } catch (e) {
    console.error(`${ts()} POST /reply relay error:`, e);
    res.status(500).json({ error: 'relay_error', detail: String(e) });
  }
});

// Add reaction
app.post('/react', requireAuth, async (req, res) => {
  try {
    const { channelId, messageId, emoji } = req.body || {};
    if (!channelId || !messageId || !emoji) {
      return res.status(400).json({ error: 'channelId, messageId and emoji are required' });
    }
    const emojiParam = encodeURIComponent(String(emoji)); // unicode or "name:id"
    const url = `${DISCORD_API}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions/${emojiParam}/@me`;
    const r = await fetchWithRetries(url, { method: 'PUT', headers: BASE_HEADERS }, { retries: 2, backoffMs: 600 });
    const text = await r.text();
    if (r.status !== 204) {
      console.error(`${ts()} PUT /react error`, { status: r.status, channelId, messageId, emoji, body: text?.slice(0, 500) });
      return res.status(r.status).type('application/json').send(text || '{}');
    }
    res.status(204).send();
  } catch (e) {
    console.error(`${ts()} PUT /react relay error:`, e);
    res.status(500).json({ error: 'relay_error', detail: String(e) });
  }
});

// Direct message
app.post('/dm', requireAuth, async (req, res) => {
  try {
    const { userId, content } = req.body || {};
    if (!userId || !content) {
      return res.status(400).json({ ok: false, error: 'userId and content required' });
    }

    // 1) Create or reuse DM channel
    const chResp = await fetchWithRetries(
      `${DISCORD_API}/users/@me/channels`,
      { method: 'POST', headers: BASE_HEADERS, body: JSON.stringify({ recipient_id: String(userId) }) },
      2,
      'dmOpen'
    );
    if (!chResp.ok) {
      const t = await chResp.text();
      return res.status(chResp.status).json({ ok: false, step: 'create_dm_channel', body: t });
    }
    const dmChan = await chResp.json();
    if (!dmChan || !dmChan.id) {
      return res.status(502).json({ ok: false, error: 'no dm channel id' });
    }

    // 2) Send the DM
    const msgResp = await fetchWithRetries(
      `${DISCORD_API}/channels/${encodeURIComponent(dmChan.id)}/messages`,
      { method: 'POST', headers: BASE_HEADERS, body: JSON.stringify({ content: String(content) }) },
      2,
      'dmSend'
    );
    const msgText = await msgResp.text();
    if (!msgResp.ok) {
      return res.status(msgResp.status).json({ ok: false, step: 'send_dm', body: msgText });
    }

    let message = {};
    try { message = JSON.parse(msgText); } catch {}
    return res.status(200).json({ ok: true, id: message.id || null, channelId: dmChan.id || null });
  } catch (e) {
    console.error(`${ts()} POST /dm relay error:`, e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// POST /edit
// Body: { channelId, messageId, content?, embeds? }
app.post('/edit', requireAuth, async (req, res) => {
  try {
    const { channelId, messageId, content, embeds } = req.body || {};
    if (!channelId || !messageId) {
      return res.status(400).json({ error: 'channelId and messageId required' });
    }
    if (typeof content !== 'string' && !(Array.isArray(embeds) && embeds.length)) {
      return res.status(400).json({ error: 'nothing to edit (need content or embeds)' });
    }

    const url = `${DISCORD_API}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`;

    // For PATCH, omit fields that aren’t changing.
    const body = {
      ...(typeof content === 'string' ? { content: String(content).slice(0, 1900) } : {}),
      ...(Array.isArray(embeds) && embeds.length ? { embeds } : {}),
      allowed_mentions: { parse: [] },
    };

    const r = await fetchWithRetries(
      url,
      { method: 'PATCH', headers: BASE_HEADERS, body: JSON.stringify(body) },
      2,
      'editMessage'
    );

    const text = await r.text();
    if (r.status >= 300) {
      console.error(`${ts()} POST /edit error`, {
        status: r.status,
        channelId,
        messageId,
        body: text?.slice(0, 500),
      });
    }
    res.status(r.status).type('application/json').send(text);
  } catch (e) {
    console.error(`${ts()} POST /edit relay error:`, e);
    res.status(500).json({ error: 'relay_error', detail: String(e) });
  }
});


// Delete message
app.delete('/delete/:channelId/:messageId', requireAuth, async (req, res) => {
  try {
    const { channelId, messageId } = req.params;
    if (!channelId || !messageId) return res.status(400).json({ error: 'channelId and messageId required' });

    const url = `${DISCORD_API}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`;
    const r = await fetchWithRetries(url, { method: 'DELETE', headers: BASE_HEADERS }, { retries: 2, backoffMs: 600 });
    const text = await r.text();
    // Success is 204
    res.status(r.status).type('application/json').send(text || '{}');
  } catch (e) {
    console.error(`${ts()} DELETE /delete relay error:`, e);
    res.status(500).json({ error: 'relay_error', detail: String(e) });
  }
});

// Root
app.get('/', (_req, res) => res.status(200).send(`relay ok @ ${nowIso()}`));

// Start
app.listen(PORT, () => {
  console.log(`${ts()} relay listening on :${PORT}`);
});