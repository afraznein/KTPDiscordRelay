'use strict';
// POST /thread — create a thread on a channel, or from a message.
// Run: node --test test/thread.test.js
//
// Same shape as auth.test.js: env before requiring server.js, global.fetch
// stubbed so nothing reaches Discord, and the stub records the Discord URL and
// body it was handed — which is the whole contract under test here.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DISCORD_BOT_TOKEN = 'test-token';
process.env.RELAY_SHARED_SECRET = 'wildcard-secret-for-tests';

const { app } = require('../server.js');

function startServer() {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

test('POST /thread', async (t) => {
  const server = await startServer();
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const originalFetch = global.fetch;
  let discordCalls = [];
  global.fetch = async (url, opts) => {
    discordCalls.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null });
    return new Response(JSON.stringify({ id: 'fake-thread-id', name: 'x', type: 11 }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  };

  t.after(() => {
    global.fetch = originalFetch;
    server.close();
  });

  const post = (body, auth = 'wildcard-secret-for-tests') =>
    originalFetch(`${base}/thread`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth ? { 'X-Relay-Auth': auth } : {}),
      },
      body: JSON.stringify(body),
    });

  await t.test('no auth header -> 401, never reaches Discord', async () => {
    discordCalls = [];
    const r = await post({ channelId: '999', name: 'S10 Silver SEC Stunna STEAM_0:1:1' }, null);
    assert.equal(r.status, 401);
    assert.equal(discordCalls.length, 0);
  });

  await t.test('a channel thread goes to /channels/{c}/threads as a public thread', async () => {
    discordCalls = [];
    const r = await post({ channelId: '999', name: 'S10 Silver SEC Stunna STEAM_0:1:1', autoArchiveDuration: 4320 });
    assert.equal(r.status, 201);
    assert.equal(discordCalls.length, 1);
    assert.match(discordCalls[0].url, /\/channels\/999\/threads$/);
    assert.deepEqual(discordCalls[0].body, {
      name: 'S10 Silver SEC Stunna STEAM_0:1:1',
      auto_archive_duration: 4320,
      type: 11,
    });
    // Discord's object comes back untouched, so the caller reads the thread id.
    const json = await r.json();
    assert.equal(json.id, 'fake-thread-id');
  });

  await t.test('a message thread goes to /channels/{c}/messages/{m}/threads and sends no type', async () => {
    discordCalls = [];
    const r = await post({ channelId: '999', messageId: '555', name: 'from a message' });
    assert.equal(r.status, 201);
    assert.match(discordCalls[0].url, /\/channels\/999\/messages\/555\/threads$/);
    assert.deepEqual(discordCalls[0].body, { name: 'from a message' });
  });

  await t.test('missing name or channelId -> 400, never reaches Discord', async () => {
    discordCalls = [];
    assert.equal((await post({ channelId: '999' })).status, 400);
    assert.equal((await post({ name: 'x' })).status, 400);
    assert.equal((await post({ channelId: '999', name: '   ' })).status, 400);
    assert.equal(discordCalls.length, 0);
  });

  await t.test('an autoArchiveDuration Discord would reject is refused here', async () => {
    discordCalls = [];
    const r = await post({ channelId: '999', name: 'x', autoArchiveDuration: 90 });
    assert.equal(r.status, 400);
    assert.equal(discordCalls.length, 0);
  });

  await t.test('the name is cut at 100 characters', async () => {
    discordCalls = [];
    const r = await post({ channelId: '999', name: 'a'.repeat(150) });
    assert.equal(r.status, 201);
    assert.equal(discordCalls[0].body.name.length, 100);
  });
});
