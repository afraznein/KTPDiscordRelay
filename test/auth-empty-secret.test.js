'use strict';
// Regression: an empty secret in RELAY_KEYS_JSON must not authenticate anyone.
//
// WHY THIS IS A SEPARATE FILE. Env is read once at module load, so the poisoned
// RELAY_KEYS_JSON below cannot coexist with auth.test.js's clean one in the same
// process. It is also why the original suite could be 11/11 green while the
// bypass was live: its "no auth header -> 401" fixture configures only non-empty
// secrets, so the failing case never arises there. A green run was not evidence.
//
// THE BUG. `typeof "" === 'string'`, so an entry with secret:"" passed the
// load-time type filter. A request with no X-Relay-Auth header reads as '' via
// `req.header(...) || ''`, and secretsMatch('','') hashes two empty strings and
// compares equal -- so one typo'd entry authenticated every anonymous caller,
// against a service that holds the Discord bot token.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DISCORD_BOT_TOKEN = 'test-token';
process.env.RELAY_SHARED_SECRET = 'wildcard-secret-for-tests';
delete process.env.RELAY_LEGACY_SECRET;
process.env.RELAY_KEYS_JSON = JSON.stringify([
  { id: 'typo-entry', secret: '', mentions: ['1111111111'] },
  { id: 'good-entry', secret: 'scoped-secret-1', mentions: ['1111111111'] },
]);

const { app, mentionsAllowed } = require('../server.js');

function startServer() {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

test('an empty secret in RELAY_KEYS_JSON authenticates nobody', async (t) => {
  const server = await startServer();
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const originalFetch = global.fetch;
  let discordCalls = [];
  global.fetch = async () => {
    discordCalls.push(1);
    return new Response(JSON.stringify({ id: 'fake-message-id' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  t.after(async () => {
    global.fetch = originalFetch;
    await new Promise((r) => server.close(r));
  });

  await t.test('no auth header -> 401, and never reaches Discord', async () => {
    discordCalls = [];
    const r = await originalFetch(`${base}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channelId: '999', content: 'hi' }),
    });
    assert.equal(r.status, 401);
    assert.equal(discordCalls.length, 0);
  });

  await t.test('explicitly empty auth header -> 401', async () => {
    discordCalls = [];
    const r = await originalFetch(`${base}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Relay-Auth': '' },
      body: JSON.stringify({ channelId: '999', content: 'hi' }),
    });
    assert.equal(r.status, 401);
    assert.equal(discordCalls.length, 0);
  });

  // Control. Without this, the two assertions above would also pass on a server
  // that rejects everything -- including one broken by the fix itself.
  await t.test('CONTROL: the valid key alongside it still authenticates', async () => {
    discordCalls = [];
    const r = await originalFetch(`${base}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Relay-Auth': 'scoped-secret-1' },
      body: JSON.stringify({ channelId: '999', content: 'hi', allowed_mentions: { roles: ['1111111111'] } }),
    });
    assert.equal(r.status, 200);
    assert.equal(discordCalls.length, 1);
  });

  // The wildcard secret must be unaffected by a poisoned entry sitting beside it.
  await t.test('CONTROL: RELAY_SHARED_SECRET still authenticates', async () => {
    discordCalls = [];
    const r = await originalFetch(`${base}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Relay-Auth': 'wildcard-secret-for-tests' },
      body: JSON.stringify({ channelId: '999', content: 'hi' }),
    });
    assert.equal(r.status, 200);
    assert.equal(discordCalls.length, 1);
  });
});

test('mentionsAllowed fails closed on an unknown caller', () => {
  // Reachable only if a route forgets requireAuth. Returning true there would
  // make that mistake silent, which is the same shape as the bug above.
  assert.equal(mentionsAllowed(undefined, { roles: ['1'] }), false);
  assert.equal(mentionsAllowed(null, { roles: ['1'] }), false);
  // A wildcard caller stays unrestricted -- the grandfather clause.
  assert.equal(mentionsAllowed({ id: 'w', mentions: null }, { parse: ['everyone'] }), true);
});

test('replied_user cannot be used to ping outside a scoped allowlist', () => {
  const scoped = { id: 'scoped', mentions: ['1111111111'] };
  // The referenced message's author is never on the caller's role/user list, so
  // checking roles/users/parse alone left a ping every scoped caller could reach.
  assert.equal(mentionsAllowed(scoped, { replied_user: true }), false);
  assert.equal(mentionsAllowed(scoped, { roles: ['1111111111'], replied_user: true }), false);
  // Unset or false is unaffected.
  assert.equal(mentionsAllowed(scoped, { roles: ['1111111111'] }), true);
  assert.equal(mentionsAllowed(scoped, { roles: ['1111111111'], replied_user: false }), true);
  // A wildcard caller keeps it.
  assert.equal(mentionsAllowed({ id: 'w', mentions: null }, { replied_user: true }), true);
});
