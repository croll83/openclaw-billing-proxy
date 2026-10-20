const https = require('node:https');
const { randomUUID } = require('node:crypto');
const { Transform, pipeline } = require('node:stream');
const { StringDecoder } = require('node:string_decoder');
const auth = require('../auth/antigravity');
const { lifecycle } = require('./lifecycle');

class UnwrapSSE extends Transform {
  constructor() { super(); this.decoder = new StringDecoder('utf8'); this.buffer = ''; }
  event(frame) {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    const parsed = JSON.parse(data);
    this.push(`data: ${JSON.stringify(parsed.response || parsed)}\n\n`);
  }
  parse() {
    let end;
    while ((end = this.buffer.indexOf('\n\n')) >= 0) {
      const frame = this.buffer.slice(0, end);
      if (Buffer.byteLength(frame) > 2 * 1024 * 1024) throw new Error('SSE event too large');
      this.buffer = this.buffer.slice(end + 2);
      this.event(frame);
    }
    if (Buffer.byteLength(this.buffer) > 2 * 1024 * 1024) throw new Error('SSE event too large');
  }
  _transform(chunk, _, callback) {
    try {
      this.buffer += this.decoder.write(chunk);
      // Strip CR only when LF has arrived, including across chunk boundaries.
      this.buffer = this.buffer.replace(/\r\n/g, '\n');
      this.parse(); callback();
    } catch { callback(new Error('Invalid upstream event stream')); }
  }
  _flush(callback) {
    try { this.buffer += this.decoder.end(); this.parse(); if (this.buffer.trim()) this.event(this.buffer); callback(); }
    catch { callback(new Error('Incomplete upstream event stream')); }
  }
}

async function handleAntigravityRequest(bodyStr, req, res, config) {
  const life = lifecycle(req, res, config);
  const fail = (status, message) => {
    if (life.stopped) return;
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: status, message } }));
  };
  let parsed, match;
  try {
    match = req.url.split('?')[0].match(/\/models\/(gemini[^/:]+):(streamGenerateContent|generateContent)$/);
    parsed = JSON.parse(bodyStr);
    if (!match || !parsed || !Array.isArray(parsed.contents)) throw new Error();
  } catch { fail(400, 'Expected a Gemini-native generateContent request with contents'); return; }
  let session;
  try { session = await auth.session(config); }
  catch (error) {
    if (life.stopped) return;
    config.onUpstreamResponse?.(error.upstreamStatus || (error.code === 'LOGIN_REQUIRED' ? 401 : 502),
      error.retryAfter ? { 'retry-after': error.retryAfter } : {});
    fail(error.status || 502, error.message); return;
  }
  if (life.stopped) return;
  const streaming = match[2] === 'streamGenerateContent';
  const payload = Buffer.from(JSON.stringify({ project: session.project, model: match[1],
    request: parsed, userAgent: 'antigravity', requestId: randomUUID() }));
  const upstream = https.request({
    hostname: session.host, port: 443,
    path: `/v1internal:${streaming ? 'streamGenerateContent?alt=sse' : 'generateContent'}`,
    method: 'POST', headers: {
      authorization: `Bearer ${session.accessToken}`, 'user-agent': session.userAgent,
      'content-type': 'application/json', 'content-length': payload.length,
      accept: streaming ? 'text/event-stream' : 'application/json',
    },
  }, response => {
    life.response(response);
    if (life.stopped) return;
    if (response.statusCode !== 200) {
      // No automatic replay of inference, raw provider bodies, or credential dumps.
      const status = response.statusCode >= 400 && response.statusCode < 600 ? response.statusCode : 502;
      if (response.headers['retry-after']) res.setHeader('retry-after', response.headers['retry-after']);
      fail(status, `Antigravity upstream HTTP ${status}`);
      response.destroy();
      return;
    }
    if (streaming) {
      if (!String(response.headers['content-type']).includes('text/event-stream')) {
        fail(502, 'Antigravity returned an unexpected stream format'); response.destroy(); return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache',
        'x-accel-buffering': 'no' });
      res.flushHeaders();
      pipeline(response, new UnwrapSSE(), res, () => {});
    } else {
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) { fail(502, 'Antigravity response exceeds 32 MiB'); response.destroy(); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (life.stopped) return;
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(data.response || data));
        } catch { fail(502, 'Antigravity returned invalid JSON'); }
      });
    }
  });
  life.request(upstream);
  upstream.end(payload);
}
module.exports = { handleAntigravityRequest, UnwrapSSE };
