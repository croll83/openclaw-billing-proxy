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
  'interleaved-thinking-2025-05-14',
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
// Applied globally via split/join on the entire request body.
// These replace Hermes-specific terms to avoid any fingerprinting.
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
const DEFAULT_REVERSE_MAP = [
  ['~/.config/app/', '~/.hermes/'],
  ['code_tools', 'hermes_tools'],
  ['tg_channel', 'hermes_telegram'],
  ['secrets.env', 'hermes-secrets.env'],
  ['Plan mode', 'Plan mode for Hermes'],
  ['cli_module', 'hermes_cli'],
  ['from app', 'from hermes'],
  ['Assistant', 'Hermes'],
  ['assistant', 'hermes'],
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

// --- Helper ------------------------------------------------------------------
function findMatchingBracket(str, start) {
  let d = 0;
  for (let i = start; i < str.length; i++) {
    if (str[i] === '[') d++;
    else if (str[i] === ']') { d--; if (d === 0) return i; }
  }
  return -1;
}

// --- Request Processing ------------------------------------------------------
function processBody(bodyStr, config) {
  let m = bodyStr;

  // Layer 2: Keyword replacement (global split/join)
  for (const [find, replace] of config.replacements) {
    m = m.split(find).join(replace);
  }

  // Layer 4: System prompt sanitization
  // Strip structured config blocks if present (large ## sections)
  if (config.stripSystemConfig) {
    const IDENTITY_MARKER = 'You are a personal assistant';
    const configStart = m.indexOf(IDENTITY_MARKER);
    if (configStart !== -1) {
      let stripFrom = configStart;
      if (stripFrom >= 2 && m[stripFrom - 2] === '\\' && m[stripFrom - 1] === 'n') {
        stripFrom -= 2;
      }
      const configEnd = m.indexOf('AGENTS.md', configStart);
      if (configEnd !== -1) {
        let boundary = configEnd;
        for (let i = configEnd - 1; i > stripFrom; i--) {
          if (m[i] === '#' && m[i - 1] === '#' && i >= 3 && m[i - 3] === '\\' && m[i - 2] === 'n') {
            boundary = i - 3;
            break;
          }
        }

        const strippedLen = boundary - stripFrom;
        if (strippedLen > 1000) {
          const PARAPHRASE =
            '\\nYou are an AI operations assistant with access to all tools listed in this request ' +
            'for file operations, command execution, web search, browser control, scheduling, ' +
            'messaging, and session management. Tool names are case-sensitive and must be called ' +
            'exactly as listed. Your responses route to the active channel automatically. ' +
            'For cross-session communication, use the task messaging tools. ' +
            'Skills defined in your workspace should be invoked when they match user requests. ' +
            'Consult your workspace reference files for detailed operational configuration.\\n';

          m = m.slice(0, stripFrom) + PARAPHRASE + m.slice(boundary);
          console.log(`[STRIP] Removed ${strippedLen} chars of config template`);
        }
      }
    }
  }

  // Inject CC tool stubs into tools array
  if (config.injectCCStubs) {
    const toolsIdx = m.indexOf('"tools":[');
    if (toolsIdx !== -1) {
      const insertAt = toolsIdx + '"tools":['.length;
      m = m.slice(0, insertAt) + CC_TOOL_STUBS.join(',') + ',' + m.slice(insertAt);
    }
  }

  // Layer 1: Billing header injection
  const sysArrayIdx = m.indexOf('"system":[');
  if (sysArrayIdx !== -1) {
    const insertAt = sysArrayIdx + '"system":['.length;
    m = m.slice(0, insertAt) + BILLING_BLOCK + ',' + m.slice(insertAt);
  } else if (m.includes('"system":"')) {
    const sysStart = m.indexOf('"system":"');
    let i = sysStart + '"system":"'.length;
    while (i < m.length) {
      if (m[i] === '\\') { i += 2; continue; }
      if (m[i] === '"') break;
      i++;
    }
    const sysEnd = i + 1;
    const originalSysStr = m.slice(sysStart + '"system":'.length, sysEnd);
    m = m.slice(0, sysStart)
      + '"system":[' + BILLING_BLOCK + ',{"type":"text","text":' + originalSysStr + '}]'
      + m.slice(sysEnd);
  } else {
    m = '{"system":[' + BILLING_BLOCK + '],' + m.slice(1);
  }

  return m;
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
