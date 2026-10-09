const { lifecycle } = require('./lifecycle');
const https = require('https');
const crypto = require('crypto');
const { getGeminiTokenSync, refreshGeminiToken } = require('../auth/geminiToken');
const { debugDump } = require('../utils');

function handleGeminiNativeRequest(bodyStr, req, res, config, reqNum, ts) {
  const life = lifecycle(req, res, config);
  const urlMatch = req.url.match(/\/models\/(gemini[^/:]*):(stream)?[gG]enerateContent/);
  if (!urlMatch) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid Gemini native path', code: 400 } }));
    return;
  }

  const model = urlMatch[1];
  const isStreaming = !!urlMatch[2];

  console.log(`[${ts}] #${reqNum} GEMINI_NATIVE ${model} (${bodyStr.length}b, stream=${isStreaming})`);

  let parsed;
  try {
    parsed = JSON.parse(bodyStr);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid JSON: ' + e.message, code: 400 } }));
    return;
  }

  let tokenInfo;
  try {
    tokenInfo = getGeminiTokenSync(config.geminiCredentialsPath);
  } catch (e) {
    config.onUpstreamResponse?.(401, {});
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: e.message, code: 500 } }));
    return;
  }

  const doRequest = (accessToken) => {
    if (life.stopped) return;
    const cloudCodeBody = {
      project: config.GEMINI_PROJECT,
      model,
      user_prompt_id: crypto.randomUUID(),
      request: parsed
    };

    const bodyBuf = Buffer.from(JSON.stringify(cloudCodeBody), 'utf8');

    debugDump(`gemini-native-${reqNum}-in.json`, JSON.stringify(parsed, null, 2));
    debugDump(`gemini-native-${reqNum}-envelope.json`, JSON.stringify(cloudCodeBody, null, 2));

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
      'Content-Length': bodyBuf.length,
      'User-Agent': `GeminiCLI/0.40.0/${model} (linux; x64; terminal) google-api-nodejs-client/9.14.2`,
      'x-goog-api-client': `gl-node/${process.versions.node}`,
      'Accept': '*/*'
    };

    const upstream = https.request({
      hostname: config.GEMINI_HOST,
      port: 443,
      path: config.GEMINI_PATH,
      method: 'POST',
      headers
    }, (upRes) => {
      life.response(upRes);
      if (life.stopped) return;
      const status = upRes.statusCode;
      console.log(`[${ts}] #${reqNum} GEMINI_NATIVE > ${status}`);

      if (status !== 200) {
        const errChunks = [];
        upRes.on('data', c => errChunks.push(c));
        upRes.on('end', () => {
          const errBody = Buffer.concat(errChunks).toString();
          debugDump(`gemini-native-${reqNum}-err-${status}.json`, errBody);
          console.error(`[${ts}] #${reqNum} GEMINI_NATIVE ERR: ${errBody.substring(0, 500)}`);
          res.writeHead(status >= 400 ? status : 500, {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(errBody)
          });
          res.end(errBody);
        });
        return;
      }

      if (isStreaming) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });

        let buffer = '';
        upRes.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const raw = line.slice(6);
              try {
                const parsed = JSON.parse(raw);
                const inner = parsed.response || parsed;
                res.write(`data: ${JSON.stringify(inner)}\n\n`);
              } catch {
                res.write(line + '\n');
              }
            } else if (line.trim()) {
              res.write(line + '\n');
            }
          }
        });
        upRes.on('end', () => {
          if (buffer.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(buffer.slice(6));
              const inner = parsed.response || parsed;
              res.write(`data: ${JSON.stringify(inner)}\n\n`);
            } catch {
              res.write(buffer + '\n');
            }
          }
          res.end();
        });
      } else {
        let buffer = '';
        let lastEvent = null;
        upRes.on('data', c => { buffer += c.toString(); });
        upRes.on('end', () => {
          for (const line of buffer.split('\n')) {
            if (line.startsWith('data: ')) {
              try {
                const p = JSON.parse(line.slice(6));
                lastEvent = p.response || p;
              } catch {}
            }
          }
          const respBody = JSON.stringify(lastEvent || {});
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(respBody)
          });
          res.end(respBody);
        });
      }
    });

    life.request(upstream);
    upstream.on('error', e => {
      console.error(`[${ts}] #${reqNum} GEMINI_NATIVE ERR: ${e.message}`);
      if (!life.stopped && !res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Upstream error: ' + e.message, code: 502 } }));
      }
    });
    upstream.write(bodyBuf);
    upstream.end();
  };

  if (tokenInfo.needsRefresh) {
    console.log(`[${ts}] #${reqNum} GEMINI_NATIVE token expired, refreshing...`);
    refreshGeminiToken(tokenInfo.creds, tokenInfo.credsPath, config)
      .then(newToken => doRequest(newToken))
      .catch(e => {
        if (life.stopped) return;
        config.onUpstreamResponse?.(401, {});
        console.error(`[${ts}] #${reqNum} GEMINI_NATIVE refresh failed: ${e.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Token refresh failed: ' + e.message, code: 500 } }));
      });
  } else {
    doRequest(tokenInfo.token);
  }
}

module.exports = { handleGeminiNativeRequest };
