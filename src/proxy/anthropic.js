const https = require('https');
const { pipeline } = require('stream');
const { performance } = require('perf_hooks');
const { getValidToken, refreshToken } = require('../auth/anthropicToken');
const { applyReplacements, debugDump, debugDumpProxy } = require('../utils');

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
        moveBlocks.push(block);
      } else {
        keepBlocks.push(block);
      }
    }
    if (moveBlocks.length > 0) {
      parsed.system = keepBlocks;
      if (!Array.isArray(parsed.messages)) parsed.messages = [];
      parsed.messages.unshift(
        { role: 'user', content: [{ type: 'text', text: '[CONTEXT]' }, ...moveBlocks] },
        { role: 'assistant', content: 'Understood.' }
      );
      console.log(`[RELOCATE] Moved ${moveBlocks.length} system blocks, preserving cache markers`);
    }
  }

  // Never invent tool access for requests whose caller supplied no tools.
  // Tool-bearing requests retain compatibility stubs unless explicitly disabled.
  if (config.injectCCStubs && Array.isArray(parsed.tools) && parsed.tools.length > 0) {
    const existingNames = new Set(parsed.tools.map(t => t.name));
    const hasNativeCC = existingNames.has('Glob') || existingNames.has('Read') || existingNames.has('Edit');
    if (!hasNativeCC) {
      for (const stub of config.CC_TOOL_STUBS) {
        const tool = JSON.parse(stub);
        if (!existingNames.has(tool.name)) {
          parsed.tools.unshift(tool);
          existingNames.add(tool.name);
        }
      }
    }
  }

  if (parsed.context_management && Array.isArray(parsed.context_management.edits)) {
    if (!['enabled', 'adaptive'].includes(parsed.thinking?.type)) {
      // Hermes owns reasoning settings. Remove incompatible housekeeping edits
      // instead of silently enabling potentially expensive/unsupported thinking.
      parsed.context_management.edits = parsed.context_management.edits.filter(
        edit => !(edit && typeof edit.type === 'string' && edit.type.startsWith('clear_thinking'))
      );
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

// Connection-specific headers must not cross either side of the proxy.
function forwardHeaders(source) {
  const excluded = new Set(['host', 'connection', 'keep-alive', 'proxy-authenticate',
    'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
  for (const name of String(source.connection || '').split(',')) excluded.add(name.trim().toLowerCase());
  return Object.fromEntries(Object.entries(source).filter(([key]) => !excluded.has(key.toLowerCase())));
}

async function handleAnthropicRequest(bodyStr, req, res, config, reqNum, ts) {
  const startedAt = performance.now();
  const idleTimeoutMs = config.anthropicTimeoutMs ?? 3600000;
  let upstream;
  let upstreamResponse;
  let stopped = false;
  const cancel = () => {
    stopped = true;
    upstreamResponse?.destroy();
    upstream?.destroy();
  };
  const onClose = () => {
    if (!res.writableFinished && !stopped) {
      console.log(`[${ts}] #${reqNum} CANCEL downstream closed; aborting upstream`);
      cancel();
    }
    cleanup();
  };
  const cleanup = () => {
    req.removeListener('aborted', cancel);
    res.removeListener('close', onClose);
    res.removeListener('finish', cleanup);
  };
  const fail = (status, message, details = {}) => {
    if (stopped || res.destroyed || res.writableEnded) return;
    if (res.headersSent) res.destroy();
    else {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { message, ...details } }));
    }
    cancel();
  };
  req.once('aborted', cancel);
  res.once('close', onClose);
  res.once('finish', cleanup);
  if (req.aborted || res.destroyed) { cancel(); cleanup(); return; }

  let oauth;
  try { oauth = await getValidToken(config.credsPath); }
  catch (error) { config.onUpstreamResponse?.(401, {}); fail(500, error.message); return; }
  if (stopped) return;

  const originalSize = Buffer.byteLength(bodyStr);
  debugDump(`dbg-raw-${reqNum}.json`, bodyStr);
  try { bodyStr = processBody(bodyStr, config); }
  catch (error) { fail(400, error.message); return; }
  debugDump(`dbg-proc-${reqNum}.json`, bodyStr);
  const body = Buffer.from(bodyStr, 'utf8');
  let requestModel = '';
  let streaming = false;
  try {
    const parsed = JSON.parse(bodyStr);
    requestModel = parsed.model || '';
    streaming = parsed.stream === true;
  } catch (_) {}
  const isOpus = requestModel.includes('opus');

  const buildHeaders = (token) => {
    const headers = forwardHeaders(req.headers);
    delete headers.authorization;
    delete headers['x-api-key'];
    headers.authorization = `Bearer ${token}`;
    headers['content-length'] = body.length;
    headers['accept-encoding'] = 'identity';
    const existingBeta = headers['anthropic-beta'] || '';
    const betas = existingBeta ? existingBeta.split(',').map(b => b.trim()) : [];
    for (const beta of config.requiredBetas) {
      if (!isOpus && (config.opusOnlyBetas || []).includes(beta)) continue;
      if (!betas.includes(beta)) betas.push(beta);
    }
    headers['anthropic-beta'] = betas.join(',');
    return headers;
  };

  const sendUpstream = (token, isRetry) => {
    if (stopped || res.destroyed) return;
    let responseStarted = false;
    const headers = buildHeaders(token);
    if (!isRetry) {
      console.log(`[${ts}] #${reqNum} ANTHROPIC ${req.method} ${req.url} (${originalSize}b -> ${body.length}b)`);
      debugDumpProxy(`${reqNum}-out.json`, JSON.stringify({
        method: req.method, url: `https://${config.UPSTREAM_HOST}${req.url}`, headers, body: bodyStr
      }, null, 2));
    }
    upstream = https.request({ hostname: config.UPSTREAM_HOST, port: 443,
      path: req.url, method: req.method, headers }, (upRes) => {
      responseStarted = true;
      upstreamResponse = upRes;
      if (stopped || res.destroyed) { upRes.destroy(); return; }
      const status = upRes.statusCode;
      console.log(`[${ts}] #${reqNum} > ${status}${isRetry ? ' (retry)' : ''}`);
      if (status === 401 && !isRetry) {
        upRes.once('error', () => fail(502, 'Authentication response interrupted'));
        upRes.once('aborted', () => fail(502, 'Authentication response aborted'));
        upRes.once('end', async () => {
          if (stopped) return;
          try {
            const refreshed = await refreshToken(config.credsPath, { rejectedToken: token });
            sendUpstream(refreshed.accessToken, true);
          } catch (error) { config.onUpstreamResponse?.(401, {}); fail(401, 'Token refresh failed: ' + error.message); }
        });
        upRes.resume();
        return;
      }
      config.onUpstreamResponse?.(status, upRes.headers);
      // Forward bytes unchanged, including signed thinking, tool JSON, errors and UTF-8.
      // pipeline supplies backpressure and tears down both streams on truncation/error.
      res.writeHead(status, forwardHeaders(upRes.headers));
      pipeline(upRes, res, error => {
        if (error && !stopped) {
          console.error(`[${ts}] #${reqNum} Stream interrupted: ${error.code || 'stream_error'}`);
          cancel();
        }
        cleanup();
      });
    });
    upstream.once('error', () => fail(502, 'Upstream connection failed'));
    // Node's socket timeout resets on I/O; this is not a total request deadline.
    // Keep pipeline untouched so SSE bytes flow immediately with backpressure.
    upstream.setTimeout(idleTimeoutMs, () => {
      if (stopped || res.destroyed || res.writableEnded) return;
      const elapsedMs = Math.round(performance.now() - startedAt);
      const phase = responseStarted ? 'receiving_response' : 'waiting_for_response';
      const details = { type: 'timeout_error', code: 'upstream_idle_timeout',
        timeout_ms: idleTimeoutMs, elapsed_ms: elapsedMs, phase, streaming };
      const message = `Upstream connection inactive for ${(idleTimeoutMs / 1000).toFixed(3)}s ` +
        `(idle timeout; total elapsed ${(elapsedMs / 1000).toFixed(3)}s; ${phase}).` +
        (streaming ? '' : ' Streaming is disabled: upstream may still be generating without sending data. ' +
          'Enable streaming or increase anthropicTimeoutMs.');
      // Once response headers are sent, HTTP status/body cannot be replaced safely.
      // Always log the diagnosis, including for streams that must be terminated.
      console.error(`[${ts}] #${reqNum} ${message} ${JSON.stringify(details)}`);
      fail(504, message, details);
    });
    upstream.end(body);
  };
  try { sendUpstream(oauth.accessToken, false); }
  catch (error) { fail(502, 'Upstream connection failed'); }
}

module.exports = { handleAnthropicRequest, processBody, forwardHeaders };
