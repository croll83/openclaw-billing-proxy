#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const { loadConfig } = require('./src/config');
const { handleAnthropicRequest } = require('./src/proxy/anthropic');
const { handleGeminiRequest, getGeminiStats } = require('./src/proxy/gemini');
const { getToken } = require('./src/auth/anthropicToken');
const { getGeminiTokenSync, getGeminiCredsPath } = require('./src/auth/geminiToken');
const { debugDumpProxy } = require('./src/utils');

function startServer(config) {
  let requestCount = 0;
  const startedAt = Date.now();

  const server = http.createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      try {
        const oauth = getToken(config.credsPath);
        const expiresIn = (oauth.expiresAt - Date.now()) / 3600000;
        const health = {
          status: expiresIn > 0 ? 'ok' : 'token_expired',
          proxy: 'hermes-billing-proxy',
          version: config.VERSION,
          requestsServed: requestCount,
          uptime: Math.floor((Date.now() - startedAt) / 1000) + 's',
          anthropic: {
            tokenExpiresInHours: expiresIn.toFixed(1),
            subscriptionType: oauth.subscriptionType
          },
          layers: {
            stringReplacements: config.replacements.length,
            ccToolStubs: config.injectCCStubs ? config.CC_TOOL_STUBS.length : 0,
            systemStripEnabled: config.stripSystemConfig
          }
        };
        try {
          const gi = getGeminiTokenSync();
          const gCredsPath = getGeminiCredsPath();
          const gCreds = JSON.parse(fs.readFileSync(gCredsPath, 'utf8'));
          const gExpiry = gCreds.expiry_date ? ((gCreds.expiry_date - Date.now()) / 3600000).toFixed(1) : 'unknown';
          health.gemini = {
            available: true,
            tokenExpiresInHours: gExpiry,
            needsRefresh: gi.needsRefresh
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

      let isGemini = false;
      try {
        const peek = JSON.parse(bodyStr);
        if (peek.model && peek.model.startsWith('gemini-')) {
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

  server.listen(config.port, '127.0.0.1', () => {
    try {
      const oauth = getToken(config.credsPath);
      const h = ((oauth.expiresAt - Date.now()) / 3600000).toFixed(1);
      console.log(`\n  Hermes Billing Proxy v${config.VERSION}`);
      console.log(`  ────────────────────────────────────`);
      console.log(`  Port:              ${config.port}`);
      console.log(`  Anthropic:         ${oauth.subscriptionType} (token expires ${h}h)`);
      try {
        const gPath = getGeminiCredsPath();
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
      console.log(`\n  Ready. Point Hermes baseUrl to http://127.0.0.1:${config.port}`);
      console.log(`  Gemini models (gemini-*) auto-routed to Cloud Code API\n`);
    } catch (e) {
      console.error(`  Started on port ${config.port} but credentials error: ${e.message}`);
    }
  });

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

const config = loadConfig();
startServer(config);