const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers');

test('debug transport dumps redact credentials and fail closed on non-JSON', () => {
  const previous = process.env.DEBUG_DUMP;
  process.env.DEBUG_DUMP = '1';
  try {
    const writes = [];
    const utils = load('src/utils.js', { fs: { mkdirSync() {}, writeFileSync(file, content) { writes.push(content); } } });
    utils.debugDumpProxy('fixture.json', JSON.stringify({ headers: {
      Authorization: 'Bearer fixture-secret', 'x-api-key': 'fixture-secret', Cookie: 'fixture-secret',
      'set-cookie': ['fixture-secret'], 'anthropic-version': '2023-06-01',
    } }));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].includes('fixture-secret'), false);
    assert.equal(JSON.parse(writes[0]).headers['anthropic-version'], '2023-06-01');
    utils.debugDumpProxy('bad.json', 'Bearer fixture-secret');
    assert.equal(writes.length, 1);
  } finally {
    if (previous === undefined) delete process.env.DEBUG_DUMP;
    else process.env.DEBUG_DUMP = previous;
  }
});
