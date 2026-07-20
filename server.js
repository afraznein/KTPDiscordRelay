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

// ---------- Utilities ----------
function ts() { return new Date().toISOString(); }
function nowIso() { return ts(); } // keep compatibility

function discordStyleUA() {
  return 'DiscordBot (https://github.com/discord/discord-api-docs, v10) Relay/1.1.1';
}

// Shared headers for Discord API
const BASE_HEADERS = {
  Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
  'User-Agent': discordStyleUA(),
  'X-Track': 'discord-relay',
  'Content-Type': 'application/json',
};

// Timing-safe string compare: hash both sides so buffer lengths always
// match (timingSafeEqual throws on length mismatch, and length leaks).
function secretsMatch(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Simple shared-secret auth; fails closed when the secret is unset.
function requireAuth(req, res, next) {
  const hdr = req.header('X-Relay-Auth') || '';
  if (!RELAY_SHARED_SECRET || !secretsMatch(hdr, RELAY_SHARED_SECRET)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// Per-request ceiling so a hung Discord response can't hold a Cloud Run request
// slot for the full 300s platform deadline. Above the Pawn callers' 5s curl
// timeout so a caller that already gave up doesn't leave a long-lived attempt.
const FETCH_TIMEOUT_MS = 10_000;

async function fetchWithRetries(url, options = {}, { retries = 2, backoffMs = 600 } = {}) {
  let attempt = 0;
  let lastErr = null;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // A 5xx or transport error on a non-idempotent write (POST/PATCH) may have
  // landed AFTER Discord already committed the message — resending would post a
  // duplicate. So writes never auto-retry those; only 429 (which Discord rejects
  // before processing the write) and idempotent methods retry.
  const method = (options.method || 'GET').toUpperCase();
  const isWrite = method === 'POST' || method === 'PATCH';

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
      const resp = await fetch(url, {
        ...options,
        signal: options.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (resp.status === 429 || resp.status >= 500) {
        const body = await resp.text().catch(() => '');
        lastErr = new Error(`HTTP ${resp.status} ${url} body=${body.slice(0,200)}`);

        const retryable = resp.status === 429 || !isWrite;
        if (!retryable || attempt === retries) throw lastErr;

        // honor Retry-After when present (cap at 60s to be safe on Cloud Run)
        const retryAfter = parseRetryAfter(resp.headers.get('retry-after'));
        const waitMs = retryAfter ?? backoffMs * Math.pow(2, attempt);
        await sleep(waitMs);
        attempt++;
        continue;
      }

      return resp;
    } catch (e) {
      lastErr = e;
      // Don't resend a write on a transport error/timeout — it may have committed.
      if (isWrite || attempt === retries) break;
      await sleep(backoffMs * Math.pow(2, attempt));
      attempt++;
    }
  }
  throw lastErr || new Error('fetchWithRetries failed');
}


// Truncate to `max` chars without splitting a surrogate pair — a 4-byte emoji
// straddling the cut would otherwise become a lone surrogate and render as "�"
// once the body is UTF-8 encoded on the way to Discord.
function truncateSafe(s, max) {
  const str = String(s);
  if (str.length <= max) return str;
  const code = str.charCodeAt(max - 1);
  const end = (code >= 0xD800 && code <= 0xDBFF) ? max - 1 : max;
  return str.slice(0, end);
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

    let query;
    if (around) query = `?around=${encodeURIComponent(around)}${limit ? `&limit=${encodeURIComponent(limit)}` : ''}`;
    else if (after) query = `?limit=${encodeURIComponent(limit || 100)}&after=${encodeURIComponent(after)}`;
    else query = `?limit=${encodeURIComponent(limit || 50)}`;

    const url = `${DISCORD_API}/channels/${encodeURIComponent(channelId)}/messages${query}`;
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

// Send a message (reply/plain)
// POST /reply
// Body: { channelId, content, embeds?, referenceMessageId?, allowed_mentions?, components? }
//
// allowed_mentions: optional override. Default behavior strips ALL mentions
// (parse: []) to prevent accidental pings. Pass an explicit
// allowed_mentions object (e.g. { roles: ["1002394466700767332"] }) to
// permit a specific subset — used by KTPAntiCheat verdict embeds for
// admin-role notifications on multi-flag sessions.
//
// components: optional Discord interactive-component payload (action rows
// containing buttons / select menus). Used by KTPAntiCheat verdict embeds
// for the Acknowledge button. The KTPAdminBot listens on its gateway for
// the resulting button-click interactions — the relay only delivers the
// button to the channel; it doesn't process clicks itself.
app.post('/reply', requireAuth, async (req, res) => {
  try {
    const { channelId, content, embeds, referenceMessageId, allowed_mentions, components } = req.body || {};
    if (!channelId) return res.status(400).json({ error: 'channelId required' });

    const url = `${DISCORD_API}/channels/${encodeURIComponent(channelId)}/messages`;

    // Discord allows empty content if embeds exist.
    const body = {
      content: typeof content === 'string' ? truncateSafe(content, 1900) : '',
      ...(Array.isArray(embeds) && embeds.length ? { embeds } : {}),
      ...(Array.isArray(components) && components.length ? { components } : {}),
      ...(referenceMessageId
        ? { message_reference: { message_id: referenceMessageId, fail_if_not_exists: false } }
        : {}),
      // Default safe (strip mentions); allow explicit override from caller.
      allowed_mentions: (allowed_mentions && typeof allowed_mentions === 'object')
        ? allowed_mentions
        : { parse: [] },
    };

    const r = await fetchWithRetries(
      url,
      { method: 'POST', headers: BASE_HEADERS, body: JSON.stringify(body) },
      { retries: 2, backoffMs: 600 }
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
      console.error(`${ts()} POST /react error`, { status: r.status, channelId, messageId, emoji, body: text?.slice(0, 500) });
      return res.status(r.status).type('application/json').send(text || '{}');
    }
    res.status(204).send();
  } catch (e) {
    console.error(`${ts()} POST /react relay error:`, e);
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
      { retries: 2, backoffMs: 600 }
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
      { method: 'POST', headers: BASE_HEADERS, body: JSON.stringify({ content: truncateSafe(content, 1900) }) },
      { retries: 2, backoffMs: 600 }
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
      ...(typeof content === 'string' ? { content: truncateSafe(content, 1900) } : {}),
      ...(Array.isArray(embeds) && embeds.length ? { embeds } : {}),
      allowed_mentions: { parse: [] },
    };

    const r = await fetchWithRetries(
      url,
      { method: 'PATCH', headers: BASE_HEADERS, body: JSON.stringify(body) },
      { retries: 2, backoffMs: 600 }
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