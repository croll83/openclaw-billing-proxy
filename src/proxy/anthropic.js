const https = require('https');
const { getToken } = require('../auth/anthropicToken');
const { applyReplacements, reverseMap, debugDump, debugDumpProxy } = require('../utils');

function processBody(bodyStr, config) {
  let parsed;
  try {
    parsed = JSON.parse(bodyStr);
  } catch (e) {
    console.log(`[PROCESS] JSON parse error, passing through: ${e.message}`);
    return bodyStr;
  }

  const rep = (text) => applyReplacements(text, config.replacements);

  if (Array.isArray(parsed.system)) {
    for (const block of parsed.system) {
      if (block.text) block.text = rep(block.text);
    }
  } else if (typeof parsed.system === 'string') {
    parsed.system = rep(parsed.system);
  }

  if (Array.isArray(parsed.tools)) {
    for (const tool of parsed.tools) {
      if (tool.description) tool.description = rep(tool.description);
      const props = tool.input_schema && tool.input_schema.properties;
      if (props && typeof props === "object") {
        for (const k of Object.keys(props)) {
          const p = props[k];
          if (p && typeof p === "object" && typeof p.description === "string") {
            p.description = rep(p.description);
          }
        }
      }
    }
  }

  if (config.stripSystemConfig && Array.isArray(parsed.system)) {
    const keepBlocks = [];
    const moveBlocks = [];
    for (const block of parsed.system) {
      const text = block.text || '';
      if (text.includes('# SOUL.md') || text.length > 2000) {
        moveBlocks.push(text);
      } else {
        keepBlocks.push(block);
      }
    }
    if (moveBlocks.length > 0) {
      const movedText = moveBlocks.join('\n\n');
      parsed.system = keepBlocks;
      if (!Array.isArray(parsed.messages)) parsed.messages = [];
      parsed.messages.unshift(
        { role: 'user', content: '[CONTEXT]\n' + movedText },
        { role: 'assistant', content: 'Understood.' }
      );
      console.log(`[RELOCATE] Moved ${movedText.length} chars from system to messages`);
    }
  }

  if (config.injectCCStubs) {
    if (!Array.isArray(parsed.tools)) parsed.tools = [];
    const existingNames = new Set(parsed.tools.map(t => t.name));
    const hasNativeCC = existingNames.has('Glob') || existingNames.has('Read') || existingNames.has('Edit');
    if (!hasNativeCC) {
      for (const stub of config.CC_TOOL_STUBS) {
        parsed.tools.unshift(JSON.parse(stub));
      }
    }
  }

  if (parsed.context_management && Array.isArray(parsed.context_management.edits)) {
    const needsThinking = parsed.context_management.edits.some(
      e => e && typeof e.type === "string" && e.type.startsWith("clear_thinking")
    );
    if (needsThinking && (!parsed.thinking || (parsed.thinking.type !== "enabled" && parsed.thinking.type !== "adaptive"))) {
      const mt = typeof parsed.max_tokens === "number" ? parsed.max_tokens : 8192;
      const budget = Math.max(1024, Math.min(mt - 4096, 32000));
      parsed.thinking = { type: "enabled", budget_tokens: budget };
    }
  }

  if (!Array.isArray(parsed.system)) {
    parsed.system = parsed.system
      ? [{ type: 'text', text: String(parsed.system) }]
      : [];
  }
  parsed.system.unshift(JSON.parse(config.BILLING_BLOCK));

  return JSON.stringify(parsed);
}

async function handleAnthropicRequest(bodyStr, req, res, config, reqNum, ts) {
  let oauth;
  try { oauth = getToken(config.credsPath); } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { message: e.message } }));
    return;
  }

  const originalSize = bodyStr.length;
  const _rawCopy = bodyStr;
  bodyStr = processBody(bodyStr, config);

  // Async dumping
  debugDump(`dbg-raw-${reqNum}.json`, _rawCopy);
  debugDump(`dbg-proc-${reqNum}.json`, bodyStr);

  let body = Buffer.from(bodyStr, 'utf8');

  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lk = key.toLowerCase();
    if (lk === 'host' || lk === 'connection' || lk === 'authorization' ||
        lk === 'x-api-key' || lk === 'content-length') continue;
    headers[key] = value;
  }
  headers['authorization'] = `Bearer ${oauth.accessToken}`;
  headers['content-length'] = body.length;
  headers['accept-encoding'] = 'identity';

  const existingBeta = headers['anthropic-beta'] || '';
  const betas = existingBeta ? existingBeta.split(',').map(b => b.trim()) : [];
  for (const b of config.requiredBetas) { if (!betas.includes(b)) betas.push(b); }
  headers['anthropic-beta'] = betas.join(',');

  console.log(`[${ts}] #${reqNum} ANTHROPIC ${req.method} ${req.url} (${originalSize}b -> ${body.length}b)`);

  debugDumpProxy(`${reqNum}-out.json`, JSON.stringify({
    method: req.method,
    url: `https://${config.UPSTREAM_HOST}${req.url}`,
    headers,
    body: bodyStr
  }, null, 2));

  const upstream = https.request({
    hostname: config.UPSTREAM_HOST, port: 443,
    path: req.url, method: req.method, headers
  }, (upRes) => {
    const status = upRes.statusCode;
    console.log(`[${ts}] #${reqNum} > ${status}`);
    if (status !== 200 && status !== 201) {
      const errChunks = [];
      upRes.on('data', c => errChunks.push(c));
      upRes.on('end', () => {
        let errBody = Buffer.concat(errChunks).toString();
        if (errBody.includes('extra usage')) {
          console.error(`[${ts}] #${reqNum} DETECTION! Body: ${body.length}b`);
        }
        errBody = reverseMap(errBody, config);
        const nh = { ...upRes.headers };
        delete nh['transfer-encoding'];
        delete nh['Transfer-Encoding'];
        nh['content-length'] = Buffer.byteLength(errBody);
        res.writeHead(status, nh);
        res.end(errBody);
      });
      return;
    }
    if (upRes.headers['content-type'] && upRes.headers['content-type'].includes('text/event-stream')) {
      res.writeHead(status, upRes.headers);
      upRes.on('data', chunk => res.write(reverseMap(chunk.toString(), config)));
      upRes.on('end', () => res.end());
    } else {
      const respChunks = [];
      upRes.on('data', c => respChunks.push(c));
      upRes.on('end', () => {
        let respBody = Buffer.concat(respChunks).toString();
        respBody = reverseMap(respBody, config);
        const nh = { ...upRes.headers };
        delete nh['transfer-encoding'];
        delete nh['Transfer-Encoding'];
        nh['content-length'] = Buffer.byteLength(respBody);
        res.writeHead(status, nh);
        res.end(respBody);
      });
    }
  });
  upstream.on('error', e => {
    console.error(`[${ts}] #${reqNum} ERR: ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { message: e.message } }));
    }
  });
  upstream.write(body);
  upstream.end();
}

module.exports = { handleAnthropicRequest };