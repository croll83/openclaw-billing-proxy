const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { load } = require('./helpers');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-auth-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'credentials.json');
  const initial = { claudeAiOauth: { accessToken: 'fixture-old', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3600000 }, unrelated: 1 };
  fs.writeFileSync(filename, JSON.stringify(initial), { mode: 0o600 });
  const state = { count: 0, status: 200, beforeResponse: () => {} };
  const https = { request(options, callback) {
    state.count++;
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.destroy = () => {};
    req.write = () => {};
    req.end = () => setImmediate(() => {
      state.beforeResponse();
      const res = new EventEmitter();
      res.statusCode = state.status;
      callback(res);
      res.emit('data', Buffer.from(JSON.stringify(state.status === 200 ? {
        access_token: 'fixture-new', refresh_token: 'fixture-rotated', expires_in: 3600,
      } : { error: 'invalid_grant' })));
      res.emit('end');
    });
    return req;
  } };
  return { auth: load('src/auth/anthropicToken.js', { https }), filename, initial, state, dir };
}

test('401 forces refresh before expiry, concurrent requests share one refresh, file is atomic/private', async t => {
  const { auth, filename, state, dir } = fixture(t);
  const a = auth.refreshToken(filename, { rejectedToken: 'fixture-old' });
  const b = auth.refreshToken(filename, { rejectedToken: 'fixture-old' });
  assert.equal(a, b);
  const [result] = await Promise.all([a, b]);
  assert.equal(result.accessToken, 'fixture-new');
  assert.equal(state.count, 1);
  assert.equal(JSON.parse(fs.readFileSync(filename)).unrelated, 1);
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ['credentials.json']);
});

test('skipped refresh does not poison future refreshes', async t => {
  const { auth, filename, initial, state } = fixture(t);
  await auth.refreshToken(filename);
  assert.equal(state.count, 0);
  initial.claudeAiOauth.expiresAt = 1;
  fs.writeFileSync(filename, JSON.stringify(initial));
  assert.equal((await auth.getValidToken(filename)).accessToken, 'fixture-new');
  assert.equal(state.count, 1);
});

test('failed refresh clears single-flight; next attempt can recover', async t => {
  const { auth, filename, state } = fixture(t);
  state.status = 400;
  await assert.rejects(auth.refreshToken(filename, { rejectedToken: 'fixture-old' }), /invalid_grant/);
  state.status = 200;
  await auth.refreshToken(filename, { rejectedToken: 'fixture-old' });
  assert.equal(state.count, 2);
});

test('a token changed by another owner is reused, not refreshed again', async t => {
  const { auth, filename, state } = fixture(t);
  assert.equal((await auth.refreshToken(filename, { rejectedToken: 'different-old-token' })).accessToken, 'fixture-old');
  assert.equal(state.count, 0);
});

test('CLI login during refresh is not overwritten', async t => {
  const { auth, filename, initial, state } = fixture(t);
  state.beforeResponse = () => {
    initial.claudeAiOauth.accessToken = 'fixture-cli-login';
    initial.claudeAiOauth.refreshToken = 'fixture-cli-refresh';
    fs.writeFileSync(filename, JSON.stringify(initial));
  };
  assert.equal((await auth.refreshToken(filename, { rejectedToken: 'fixture-old' })).accessToken, 'fixture-cli-login');
  assert.equal(JSON.parse(fs.readFileSync(filename)).claudeAiOauth.accessToken, 'fixture-cli-login');
});

test('synchronous read failure does not stick in single-flight', async t => {
  const { auth, filename, initial, state } = fixture(t);
  fs.writeFileSync(filename, '{');
  await assert.rejects(auth.refreshToken(filename));
  initial.claudeAiOauth.expiresAt = 1;
  fs.writeFileSync(filename, JSON.stringify(initial));
  await auth.refreshToken(filename);
  assert.equal(state.count, 1);
});
