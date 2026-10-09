const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { load, config } = require('./helpers');

async function fixture(t, handler, overrides = {}) {
  const origin = http.createServer(handler);
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  const state = { requests: 0, refreshes: [], errors: [] };
  const auth = { getValidToken: async () => ({ accessToken: 'fixture-old' }),
    refreshToken: async (file, options) => {
      state.refreshes.push(options.rejectedToken);
      return { accessToken: 'fixture-new' };
    }, ...overrides.auth };
  const transport = load('src/proxy/anthropic.js', {
    https: { request(options, callback) {
      state.requests++;
      return http.request({ ...options, hostname: '127.0.0.1', port: origin.address().port }, callback);
    } }, '../auth/anthropicToken': auth,
  }, '', { console: { log() {}, error(message) { state.errors.push(message); } } });
  const cfg = { ...config(), reverseMap: [['secrets.env', 'hermes-secrets.env'], ['Plan mode', 'Plan mode for Hermes']],
    UPSTREAM_HOST: 'unused.invalid', credsPath: '/fixture', ...overrides.config };
  const proxy = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => transport.handleAnthropicRequest(Buffer.concat(chunks).toString(), req, res, cfg, 1, 'test'));
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(async () => {
    for (const server of [proxy, origin]) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
  const open = callback => {
    const req = http.request({ hostname: '127.0.0.1', port: proxy.address().port, method: 'POST', path: '/v1/messages' }, callback);
    req.end(JSON.stringify({ model: 'claude-opus-5', max_tokens: 128, messages: [{ role: 'user', content: 'fixture' }], ...overrides.body }));
    return req;
  };
  const read = () => new Promise((resolve, reject) => {
    open(res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    }).on('error', reject);
  });
  return { open, read, state };
}

test('fragmented SSE preserves exact bytes, UTF-8, thinking, signatures and tool JSON', async t => {
  const wire = Buffer.from('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"Plan mode è secrets.env"}}\n\ndata: {"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"secrets.env\\"}"}}\n\ndata: {"delta":{"type":"signature_delta","signature":"opaque-code_tools"}}\n\n');
  const f = await fixture(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let i = 0;
    const next = () => { if (i === wire.length) res.end(); else { res.write(wire.subarray(i, ++i)); setImmediate(next); } };
    next();
  });
  assert.deepEqual((await f.read()).body, wire);
});

test('non-stream JSON and error bodies remain byte-identical with correct length', async t => {
  const wire = Buffer.from('{"error":{"message":"Plan mode secrets.env è"}}');
  const f = await fixture(t, (req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'content-length': wire.length,
      'connection': 'x-private-hop', 'x-private-hop': 'do-not-forward', 'retry-after': '10' });
    res.end(wire);
  });
  const result = await f.read();
  assert.equal(result.status, 429);
  assert.deepEqual(result.body, wire);
  assert.equal(Number(result.headers['content-length']), wire.length);
  assert.equal(result.headers['retry-after'], '10');
  assert.equal(result.headers['x-private-hop'], undefined);
});

test('downstream cancellation closes active upstream generation', { timeout: 3000 }, async t => {
  let closed;
  const upstreamClosed = new Promise(resolve => { closed = resolve; });
  const f = await fixture(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"ping"}\n\n');
    res.once('close', () => closed(res.writableFinished));
  });
  f.open(res => { res.once('data', () => res.destroy()); res.on('error', () => {}); }).on('error', () => {});
  assert.equal(await upstreamClosed, false);
});

test('truncated upstream stream is an error, never a successful EOF', { timeout: 3000 }, async t => {
  const f = await fixture(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"ping"}\n\n');
    setTimeout(() => res.destroy(), 20);
  });
  await assert.rejects(f.read());
});

test('401 refresh is forced with rejected token and retries exactly once', async t => {
  const headers = [];
  const f = await fixture(t, (req, res) => {
    headers.push(req.headers.authorization);
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"fixture rejected"}}');
  });
  assert.equal((await f.read()).status, 401);
  assert.deepEqual(headers, ['Bearer fixture-old', 'Bearer fixture-new']);
  assert.deepEqual(f.state.refreshes, ['fixture-old']);
});

test('idle upstream times out instead of leaving client hanging', { timeout: 3000 }, async t => {
  const f = await fixture(t, () => {}, { config: { anthropicTimeoutMs: 30 } });
  const result = await f.read();
  assert.equal(result.status, 504);
  const { error } = JSON.parse(result.body);
  assert.equal(error.code, 'upstream_idle_timeout');
  assert.equal(error.type, 'timeout_error');
  assert.equal(error.timeout_ms, 30);
  assert.ok(error.elapsed_ms >= 30);
  assert.equal(error.phase, 'waiting_for_response');
  assert.equal(error.streaming, false);
  assert.match(error.message, /total elapsed [0-9.]+s/);
  assert.match(error.message, /Streaming is disabled/);
  assert.match(f.state.errors[0], /upstream_idle_timeout/);
});

test('disconnect while auth is pending cannot start a generation afterwards', { timeout: 3000 }, async t => {
  let finishAuth, entered;
  const authEntered = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, () => {}, { auth: { getValidToken: () => {
    entered(); return new Promise(resolve => { finishAuth = resolve; });
  } } });
  const req = f.open(() => {});
  req.on('error', () => {});
  await authEntered;
  req.destroy();
  await new Promise(resolve => setTimeout(resolve, 30));
  finishAuth({ accessToken: 'fixture' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.state.requests, 0);
});

for (const contentType of ['text/event-stream', 'application/json']) {
  test(`active ${contentType} response can outlive the idle timeout`, { timeout: 5000 }, async t => {
    const chunks = contentType === 'text/event-stream'
      ? Array(9).fill('event: ping\ndata: {"type":"ping"}\n\n')
      : ['{"text":"', ...Array(7).fill('more text '), '"}'];
    const f = await fixture(t, (req, res) => {
      res.writeHead(200, { 'content-type': contentType });
      let i = 0;
      res.write(chunks[i++]);
      const timer = setInterval(() => {
        res.write(chunks[i++]);
        if (i === chunks.length) { clearInterval(timer); res.end(); }
      }, 40);
      res.once('close', () => clearInterval(timer));
    }, { config: { anthropicTimeoutMs: 200 }, body: { stream: contentType === 'text/event-stream' } });
    const result = await f.read();
    assert.equal(result.status, 200);
    assert.equal(result.body.toString(), chunks.join(''));
    assert.equal(f.state.errors.length, 0);
  });
}

test('SSE first chunk reaches the client before upstream can finish', { timeout: 3000 }, async t => {
  let finish;
  const first = 'event: ping\ndata: {"type":"ping"}\n\n';
  const last = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  const f = await fixture(t, (req, res) => {
    finish = () => res.end(last);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(first);
  });
  await new Promise((resolve, reject) => {
    f.open(res => {
      const chunks = [];
      res.on('data', chunk => {
        chunks.push(chunk);
        if (chunks.length === 1) {
          assert.equal(chunk.toString(), first);
          finish(); // Upstream cannot finish until the client sees the first chunk.
        }
      });
      res.on('error', reject);
      res.on('end', () => {
        assert.equal(Buffer.concat(chunks).toString(), first + last);
        resolve();
      });
    }).on('error', reject);
  });
});

test('idle timeout after SSE starts aborts without appending an error body and logs elapsed time',
  { timeout: 3000 }, async t => {
    const first = 'data: {"type":"ping"}\n\n';
    const f = await fixture(t, (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(first);
    }, { config: { anthropicTimeoutMs: 60 }, body: { stream: true } });
    await new Promise((resolve, reject) => {
      f.open(res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => reject(new Error('Truncated stream must not complete')));
        res.on('error', () => {
          assert.equal(res.statusCode, 200);
          assert.equal(Buffer.concat(chunks).toString(), first);
          resolve();
        });
      }).on('error', reject);
    });
    assert.equal(f.state.errors.length, 1);
    assert.match(f.state.errors[0], /upstream_idle_timeout/);
    assert.match(f.state.errors[0], /receiving_response/);
    assert.match(f.state.errors[0], /"streaming":true/);
    assert.doesNotMatch(f.state.errors[0], /Streaming is disabled/);
    assert.match(f.state.errors[0], /total elapsed/);
  });
