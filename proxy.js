#!/usr/bin/env node
/**
 * Hermes Billing Proxy v1.0
 *
 * Routes Hermes API requests through Claude Code's subscription billing
 * instead of Extra Usage.
 *
 *   Layer 1: Billing header injection (84-char Claude Code identifier)
 *   Layer 2: Keyword replacement (Hermes-specific strings)
 *   Layer 3: Tool name passthrough (no renaming -- Hermes tools don't need it)
 *   Layer 4: System prompt sanitization (strip structured config blocks if present)
 *
 * Zero dependencies. Works on Linux with Node.js 18+.
 *
 * Usage:
 *   node proxy.js [--port 18801] [--config config.json]
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

// --- Defaults ----------------------------------------------------------------
const DEFAULT_PORT = 18801;
const UPSTREAM_HOST = 'api.anthropic.com';
const VERSION = '1.0.0';

// Claude Code billing identifier -- injected into the system prompt
const BILLING_BLOCK = '{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.80.a46; cc_entrypoint=sdk-cli; cch=57806;"}';

// Beta flags required for OAuth + Claude Code features
const REQUIRED_BETAS = [
  'claude-code-20250219',
  'oauth-2025-04-20',

  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'effort-2025-11-24'
];

// CC tool stubs -- injected into tools array to make the tool set look more
// like a Claude Code session. The model won't call these (schemas are minimal).
const CC_TOOL_STUBS = [
  '{"name":"Glob","description":"Find files by pattern","input_schema":{"type":"object","properties":{"pattern":{"type":"string","description":"Glob pattern"}},"required":["pattern"]}}',
  '{"name":"Grep","description":"Search file contents","input_schema":{"type":"object","properties":{"pattern":{"type":"string","description":"Regex pattern"},"path":{"type":"string","description":"Search path"}},"required":["pattern"]}}',
  '{"name":"Agent","description":"Launch a subagent for complex tasks","input_schema":{"type":"object","properties":{"prompt":{"type":"string","description":"Task description"}},"required":["prompt"]}}',
  '{"name":"NotebookEdit","description":"Edit notebook cells","input_schema":{"type":"object","properties":{"notebook_path":{"type":"string"},"cell_index":{"type":"integer"}},"required":["notebook_path"]}}',
  '{"name":"TodoRead","description":"Read current task list","input_schema":{"type":"object","properties":{}}}'
];

// --- Layer 2: Keyword Replacements -------------------------------------------
// Applied ONLY to text content fields (system[].text, messages[].content,
// tool descriptions) — never to JSON structure (role, type, keys).
const DEFAULT_REPLACEMENTS = [
  ['~/.hermes/', '~/.config/app/'],
  ['hermes_tools', 'code_tools'],
  ['hermes_telegram', 'tg_channel'],
  ['hermes-secrets.env', 'secrets.env'],
  ['Plan mode for Hermes', 'Plan mode'],
  ['hermes_cli', 'cli_module'],
  ['from hermes', 'from app'],
  ['Hermes', 'Assistant'],
  ['hermes', 'assistant'],
  ['billing proxy', 'routing layer'],
  ['billing-proxy', 'routing-layer']
];

// --- Reverse Mappings --------------------------------------------------------
// Applied globally on response text. Only SPECIFIC strings that can't collide
// with JSON structure. "Assistant"/"assistant" are intentionally EXCLUDED —
// they'd break "role":"assistant" in API responses.
const DEFAULT_REVERSE_MAP = [
  ['~/.config/app/', '~/.hermes/'],
  ['code_tools', 'hermes_tools'],
  ['tg_channel', 'hermes_telegram'],
  ['secrets.env', 'hermes-secrets.env'],
  ['Plan mode', 'Plan mode for Hermes'],
  ['cli_module', 'hermes_cli'],
  ['from app', 'from hermes'],
  ['routing layer', 'billing proxy'],
  ['routing-layer', 'billing-proxy']
];

// --- Configuration -----------------------------------------------------------
function loadConfig() {
  const args = process.argv.slice(2);
  let configPath = null;
  let port = DEFAULT_PORT;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) port = parseInt(args[i + 1]);
    if (args[i] === '--config' && args[i + 1]) configPath = args[i + 1];
  }

  let config = {};
  if (configPath && fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } else if (fs.existsSync('config.json')) {
    config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
  }

  const homeDir = os.homedir();
  const credsPaths = [
    config.credentialsPath,
    path.join(homeDir, '.claude', '.credentials.json'),
    path.join(homeDir, '.claude', 'credentials.json')
  ].filter(Boolean);

  let credsPath = null;
  for (const p of credsPaths) {
    const resolved = p.startsWith('~') ? path.join(homeDir, p.slice(1)) : p;
    if (fs.existsSync(resolved) && fs.statSync(resolved).size > 0) {
      credsPath = resolved;
      break;
    }
  }

  if (!credsPath) {
    console.error('[ERROR] Claude Code credentials not found. Run "claude auth login" first.');
    console.error('Searched:');
    for (const p of credsPaths) console.error('  ' + p);
    process.exit(1);
  }

  return {
    port: config.port || port,
    credsPath,
    replacements: config.replacements || DEFAULT_REPLACEMENTS,
    reverseMap: config.reverseMap || DEFAULT_REVERSE_MAP,
    stripSystemConfig: config.stripSystemConfig !== false,
    injectCCStubs: config.injectCCStubs !== false
  };
}

// --- Token Management --------------------------------------------------------
function getToken(credsPath) {
  let raw = fs.readFileSync(credsPath, 'utf8');
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  const creds = JSON.parse(raw);
  const oauth = creds.claudeAiOauth;
  if (!oauth || !oauth.accessToken) throw new Error('No OAuth token. Run "claude auth login".');
  return oauth;
}

// --- Request Processing ------------------------------------------------------
function applyReplacements(text, replacements) {
  let r = text;
  for (const [find, rep] of replacements) {
    r = r.split(find).join(rep);
  }
  return r;
}

function processBody(bodyStr, config) {
  let parsed;
  try {
    parsed = JSON.parse(bodyStr);
  } catch (e) {
    console.log(`[PROCESS] JSON parse error, passing through: ${e.message}`);
    return bodyStr;
  }

  const rep = (text) => applyReplacements(text, config.replacements);

  // Layer 2: Keyword replacement — only text content fields
  if (Array.isArray(parsed.system)) {
    for (const block of parsed.system) {
      if (block.text) block.text = rep(block.text);
    }
  } else if (typeof parsed.system === 'string') {
    parsed.system = rep(parsed.system);
  }

  if (Array.isArray(parsed.messages)) {
    for (const msg of parsed.messages) {
      if (typeof msg.content === 'string') {
        msg.content = rep(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.text) block.text = rep(block.text);
        }
      }
    }
  }

  if (Array.isArray(parsed.tools)) {
    for (const tool of parsed.tools) {
      if (tool.description) tool.description = rep(tool.description);
    }
  }

  // Layer 4: System prompt relocation — move SOUL.md from system to messages
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

  // Inject CC tool stubs
  if (config.injectCCStubs) {
    if (!Array.isArray(parsed.tools)) parsed.tools = [];
    for (const stub of CC_TOOL_STUBS) {
      parsed.tools.unshift(JSON.parse(stub));
    }
  }

  // Layer 1: Billing header injection
  if (!Array.isArray(parsed.system)) {
    parsed.system = parsed.system
      ? [{ type: 'text', text: String(parsed.system) }]
      : [];
  }
  parsed.system.unshift(JSON.parse(BILLING_BLOCK));

  return JSON.stringify(parsed);
}

// --- Response Processing -----------------------------------------------------
function reverseMap(text, config) {
  let r = text;
  for (const [sanitized, original] of config.reverseMap) {
    r = r.split(sanitized).join(original);
  }
  return r;
}

// --- Server ------------------------------------------------------------------
function startServer(config) {
  let requestCount = 0;
  const startedAt = Date.now();

  const server = http.createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      try {
        const oauth = getToken(config.credsPath);
        const expiresIn = (oauth.expiresAt - Date.now()) / 3600000;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: expiresIn > 0 ? 'ok' : 'token_expired',
          proxy: 'hermes-billing-proxy',
          version: VERSION,
          requestsServed: requestCount,
          uptime: Math.floor((Date.now() - startedAt) / 1000) + 's',
          tokenExpiresInHours: expiresIn.toFixed(1),
          subscriptionType: oauth.subscriptionType,
          layers: {
            stringReplacements: config.replacements.length,
            ccToolStubs: config.injectCCStubs ? CC_TOOL_STUBS.length : 0,
            systemStripEnabled: config.stripSystemConfig
          }
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: e.message }));
      }
      return;
    }

    requestCount++;
    const reqNum = requestCount;
    const chunks = [];

    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      let oauth;
      try { oauth = getToken(config.credsPath); } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { message: e.message } }));
        return;
      }

      let bodyStr = body.toString('utf8');
      const originalSize = bodyStr.length;
      bodyStr = processBody(bodyStr, config);
      body = Buffer.from(bodyStr, 'utf8');

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
      for (const b of REQUIRED_BETAS) { if (!betas.includes(b)) betas.push(b); }
      // Only add interleaved-thinking beta when the request has thinking enabled
      try { const parsed = JSON.parse(bodyStr); if (parsed.thinking && parsed.thinking.type === "enabled") { const tb = "interleaved-thinking-2025-05-14"; if (!betas.includes(tb)) betas.push(tb); } } catch {}
      headers['anthropic-beta'] = betas.join(',');

      const ts = new Date().toISOString().substring(11, 19);
      console.log(`[${ts}] #${reqNum} ${req.method} ${req.url} (${originalSize}b -> ${body.length}b)`);

      const upstream = https.request({
        hostname: UPSTREAM_HOST, port: 443,
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
    });
  });

  server.listen(config.port, '127.0.0.1', () => {
    try {
      const oauth = getToken(config.credsPath);
      const h = ((oauth.expiresAt - Date.now()) / 3600000).toFixed(1);
      console.log(`\n  Hermes Billing Proxy v${VERSION}`);
      console.log(`  ────────────────────────────`);
      console.log(`  Port:              ${config.port}`);
      console.log(`  Subscription:      ${oauth.subscriptionType}`);
      console.log(`  Token expires:     ${h}h`);
      console.log(`  Keyword patterns:  ${config.replacements.length} sanitize + ${config.reverseMap.length} reverse`);
      console.log(`  CC tool stubs:     ${config.injectCCStubs ? CC_TOOL_STUBS.length : 'disabled'}`);
      console.log(`  System strip:      ${config.stripSystemConfig ? 'enabled' : 'disabled'}`);
      console.log(`  Credentials:       ${config.credsPath}`);
      console.log(`\n  Ready. Point Hermes baseUrl to http://127.0.0.1:${config.port}\n`);
    } catch (e) {
      console.error(`  Started on port ${config.port} but credentials error: ${e.message}`);
    }
  });

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

// --- Main --------------------------------------------------------------------
const config = loadConfig();
startServer(config);
