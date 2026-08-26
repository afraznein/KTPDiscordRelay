'use strict';
// DR5/DR4 — per-caller identity + ping-scoping.
// Run: node --test test/auth.test.js
//
// Env is set BEFORE requiring server.js, since RELAY_KEYS / RELAY_SHARED_SECRET
// / RELAY_LEGACY_SECRET are read once at module load. global.fetch is stubbed
// so no test makes a real call to Discord; a scoped-mention rejection must
// never even reach that stub -- asserted below via discordCalls.length.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DISCORD_BOT_TOKEN = 'test-token';
process.env.RELAY_SHARED_SECRET = 'wildcard-secret-for-tests';
process.env.RELAY_LEGACY_SECRET = 'legacy-secret-for-tests';
process.env.RELAY_KEYS_JSON = JSON.stringify([
  { id: 'crashreporter-test', secret: 'scoped-secret-1', mentions: ['1111111111'] },
]);

const { app } = require('../server.js');

function startServer() {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

test('DR5/DR4 per-caller identity + ping scoping', async (t) => {
  const server = await startServer();
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const originalFetch = global.fetch;
  let discordCalls = [];
  global.fetch = async (_url, _opts) => {
    discordCalls.push(1);
    return new Response(JSON.stringify({ id: 'fake-message-id' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  t.after(() => {
    global.fetch = originalFetch;
    server.close();
  });

  await t.test('no auth header -> 401 (auth still enforced)', async () => {
    const r = await originalFetch(`${base}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channelId: '999', content: 'hi' }),
    });
    assert.equal(r.status, 401);
  });

  await t.test('wrong secret -> 401', async () => {
    const r = await originalFetch(`${base}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Relay-Auth': 'not-a-real-secret' },
      body: JSON.stringify({ channelId: '999', content: 'hi' }),
    });
    assert.equal(r.status, 401);
  });

  await t.test('scoped caller, allowed role -> 200, request reaches Discord', async () => {
    discordCalls = [];
    const r = await originalFetch(`${base}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Relay-Auth': 'scoped-secret-1' },
      body: JSON.stringify({ channelId: '999', content: 'hi', allowed_mentions: { roles: ['1111111111'] } }),
    });
    assert.equal(r.status, 200);
    assert.equal(discordCalls.length, 1);
  });

  // Negative control: with the pre-fix relay (one shared secret, no per-caller
  // scoping) this same request would have been a plain 200 -- ANY holder of a
  // valid secret could request ANY role/user mention. Proven against the
  // unmodified pre-fix server.js in a sibling run (see report).
  await t.test('scoped caller, role NOT on its allowlist -> 403, never reaches Discord', async () => {
    discordCalls = [];
    const r = await originalFetch(`${base}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Relay-Auth': 'scoped-secret-1' },
      body: JSON.stringify({ channelId: '999', content: 'hi', allowed_mentions: { roles: ['2222222222'] } }),
    });
    assert.equal(r.status, 403);
    assert.equal(discordCalls.length, 0);
  });

  await t.test('scoped caller cannot bypass via parse:["everyone"] -> 403', async () => {
    discordCalls = [];
    const r = await originalFetch(`${base}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Relay-Auth': 'scoped-secret-1' },
      body: JSON.stringify({ channelId: '999', content: 'hi', allowed_mentions: { parse: ['everyone'] } }),
    });
    assert.equal(r.status, 403);
    assert.equal(discordCalls.length, 0);
  });

  await t.test('scoped caller with no allowed_mentions at all -> 200 (default strip, unaffected)', async () => {
    discordCalls = [];
    const r = await originalFetch(`${base}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Relay-Auth': 'scoped-secret-1' },
      body: JSON.stringify({ channelId: '999', content: 'hi' }),
    });
    assert.equal(r.status, 200);
    assert.equal(discordCalls.length, 1);
  });

  await t.test('grandfathered wildcard caller (RELAY_SHARED_SECRET) keeps unrestricted @everyone passthrough', async () => {
    discordCalls = [];
    const r = await originalFetch(`${base}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Relay-Auth': 'wildcard-secret-for-tests' },
      body: JSON.stringify({ channelId: '999', content: 'hi', allowed_mentions: { parse: ['everyone'] } }),
    });
    assert.equal(r.status, 200);
    assert.equal(discordCalls.length, 1);
  });

  await t.test('grandfathered legacy-rotation caller (RELAY_LEGACY_SECRET) also unrestricted', async () => {
    discordCalls = [];
    const r = await originalFetch(`${base}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Relay-Auth': 'legacy-secret-for-tests' },
      body: JSON.stringify({ channelId: '999', content: 'hi', allowed_mentions: { parse: ['everyone'] } }),
    });
    assert.equal(r.status, 200);
    assert.equal(discordCalls.length, 1);
  });

  await t.test('/edit: scoped caller, role not on allowlist -> 403, never reaches Discord', async () => {
    discordCalls = [];
    const r = await originalFetch(`${base}/edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Relay-Auth': 'scoped-secret-1' },
      body: JSON.stringify({ channelId: '999', messageId: '888', content: 'hi', allowed_mentions: { roles: ['9999999999'] } }),
    });
    assert.equal(r.status, 403);
    assert.equal(discordCalls.length, 0);
  });

  await t.test('/edit: no allowed_mentions -> 200, default strip unchanged', async () => {
    discordCalls = [];
    const r = await originalFetch(`${base}/edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Relay-Auth': 'wildcard-secret-for-tests' },
      body: JSON.stringify({ channelId: '999', messageId: '888', content: 'hi' }),
    });
    assert.equal(r.status, 200);
    assert.equal(discordCalls.length, 1);
  });
});
