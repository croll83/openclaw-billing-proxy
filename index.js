#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const { loadConfig } = require('./src/config');
const { handleAnthropicRequest } = require('./src/proxy/anthropic');
const { handleGeminiRequest, getGeminiStats } = require('./src/proxy/gemini');
const { handleGeminiNativeRequest } = require('./src/proxy/geminiNative');
const { getToken } = require('./src/auth/anthropicToken');
const { getGeminiTokenSync, getGeminiCredsPath } = require('./src/auth/geminiToken');
const { debugDumpProxy } = require('./src/utils');

function startServer(config) {
  let requestCount = 0;
  const startedAt = Date.now();

  const server = http.createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      try {
        const oauth = config.credsPath ? getToken(config.credsPath) : null;
        const expiresIn = oauth ? (oauth.expiresAt - Date.now()) / 3600000 : Infinity;
        const health = {
          status: expiresIn > 0 ? 'ok' : 'token_expired',
          proxy: 'hermes-billing-proxy',
          version: config.VERSION,
          requestsServed: requestCount,
          uptime: Math.floor((Date.now() - startedAt) / 1000) + 's',
          anthropic: oauth ? {
            tokenExpiresInHours: expiresIn.toFixed(1),
            subscriptionType: oauth.subscriptionType
          } : { available: false },
          layers: {
            stringReplacements: config.replacements.length,
            ccToolStubs: config.injectCCStubs ? config.CC_TOOL_STUBS.length : 0,
            systemStripEnabled: config.stripSystemConfig
          }
        };
        try {
          const agy = config.geminiBackend === 'antigravity';
          const gi = agy ? require('./src/auth/antigravity').readCredentials(config) : getGeminiTokenSync(config.geminiCredentialsPath);
          const expiry = agy ? gi.expiresAt : gi.creds.expiry_date;
          const gExpiry = expiry ? ((expiry - Date.now()) / 3600000).toFixed(1) : 'unknown';
          health.gemini = {
            available: true,
            backend: config.geminiBackend || 'cloudcode',
            tokenExpiresInHours: gExpiry,
            needsRefresh: agy ? expiry <= Date.now()+60000 : gi.needsRefresh
          };
        } catch (e) {
          health.gemini = { available: false, error: e.message };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(health));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: e.message }));
      }
      return;
    }

    if (req.url === '/stats' && req.method === 'GET') {
      const geminiStats = getGeminiStats();
      const stats = {
        ...geminiStats,
        uptime: Math.floor((Date.now() - startedAt) / 1000) + 's',
        successRate: geminiStats.requests
          ? ((geminiStats.successes / geminiStats.requests) * 100).toFixed(1) + '%'
          : 'N/A',
        rateLimitRate: geminiStats.requests
          ? ((geminiStats.rateLimits / geminiStats.requests) * 100).toFixed(1) + '%'
          : 'N/A',
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats, null, 2));
      return;
    }

    requestCount++;
    const reqNum = requestCount;
    const chunks = [];

    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      let bodyStr = body.toString('utf8');
      const ts = new Date().toISOString().substring(11, 19);

      debugDumpProxy(`${reqNum}-in.json`, JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: bodyStr }, null, 2));

      if (req.url.match(/\/models\/gemini[^/:]*:(stream)?[gG]enerateContent/)) {
        handleGeminiNativeRequest(bodyStr, req, res, config, reqNum, ts);
        return;
      }

      let isGemini = false;
      try {
        const peek = JSON.parse(bodyStr);
        if (peek.model && (peek.model.startsWith('gemini-') || peek.model.startsWith('google/gemini-'))) {
          isGemini = true;
        }
      } catch {}

      if (isGemini) {
        handleGeminiRequest(bodyStr, req, res, config, reqNum, ts);
      } else {
        handleAnthropicRequest(bodyStr, req, res, config, reqNum, ts);
      }
    });
  });

  const bindAddr = config.bindAddress || '0.0.0.0';
  server.listen(config.port, bindAddr, () => {
    try {
      const oauth = config.credsPath ? getToken(config.credsPath) : null;
      const h = oauth ? ((oauth.expiresAt - Date.now()) / 3600000).toFixed(1) : '?';
      console.log(`\n  AI Engine Proxy v${config.VERSION}`);
      console.log(`  ────────────────────────────────────`);
      console.log(`  Port:              ${config.port}`);
      console.log(`  Anthropic:         ${oauth ? `${oauth.subscriptionType} (token expires ${h}h)` : 'not configured'}`);
      try {
        const gPath = config.geminiBackend === 'antigravity' ? null : getGeminiCredsPath(config.geminiCredentialsPath);
        if (config.geminiBackend === 'antigravity') {
          require('./src/auth/antigravity').readCredentials(config);
          console.log('  Gemini:            enabled (subscription backend)');
        } else
        if (gPath) {
          const gCreds = JSON.parse(fs.readFileSync(gPath, 'utf8'));
          const gh = gCreds.expiry_date ? ((gCreds.expiry_date - Date.now()) / 3600000).toFixed(1) : '?';
          console.log(`  Gemini:            enabled (token expires ${gh}h)`);
        } else {
          console.log(`  Gemini:            disabled (no credentials)`);
        }
      } catch (e) {
        console.log(`  Gemini:            error (${e.message})`);
      }
      console.log(`  Keyword patterns:  ${config.replacements.length} sanitize + ${config.reverseMap.length} reverse`);
      console.log(`  CC tool stubs:     ${config.injectCCStubs ? config.CC_TOOL_STUBS.length : 'disabled'}`);
      console.log(`  System strip:      ${config.stripSystemConfig ? 'enabled' : 'disabled'}`);
      console.log(`  Credentials:       ${config.credsPath}`);
      console.log(`  Bind address:      ${bindAddr}`);
      console.log(`\n  Ready. Endpoint: http://${bindAddr}:${config.port}`);
      console.log(`  Gemini models (gemini-*) auto-routed to Cloud Code API\n`);
    } catch (e) {
      console.error(`  Started on port ${config.port} but credentials error: ${e.message}`);
    }
  });

  const shutdown = () => {
    console.log('\n  Shutting down...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const config = loadConfig();
if (config.management?.enabled) {
  const { createManagedServers } = require('./src/management/server');
  const managed = createManagedServers(config);
  managed.start().then(() => {
    console.log('Managed proxy listening:', managed.inference.address());
    console.log('Management console listening:', managed.admin.address());
  }).catch(error => { console.error('Managed proxy startup failed:', error.message); process.exit(1); });
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Draining active requests before shutdown');
    managed.close().then(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} else startServer(config);
