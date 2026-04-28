#!/usr/bin/env node
/**
 * Hermes Billing Proxy v2.0
 *
 * Dual-backend proxy: routes Hermes API requests through subscription billing
 * for both Anthropic (Claude Code OAuth) and Google (Gemini CLI OAuth).
 *
 *   Anthropic path (default):
 *     Layer 1: Billing header injection (Claude Code identifier)
 *     Layer 2: Keyword replacement (Hermes-specific strings)
 *     Layer 3: Tool name passthrough
 *     Layer 4: System prompt sanitization
 *
 *   Gemini path (model starts with "gemini-"):
 *     Translates OpenAI chat format → Gemini native Contents/Parts
 *     Routes through Cloud Code Assist API with Gemini CLI OAuth
 *     Translates Gemini SSE response → OpenAI-compatible response
 *
 * Zero dependencies. Works on Linux with Node.js 18+.
 *
 * Usage:
 *   node proxy.js [--port 18801] [--config config.json]
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
try { fs.mkdirSync('/tmp/proxy-dumps', { recursive: true }); } catch {}
const path = require('path');
const os = require('os');

// --- Defaults ----------------------------------------------------------------
const DEFAULT_PORT = 18801;
const UPSTREAM_HOST = 'api.anthropic.com';
const GEMINI_HOST = 'cloudcode-pa.googleapis.com';
const GEMINI_PATH = '/v1internal:streamGenerateContent?alt=sse';
const GEMINI_PROJECT = 'engaged-fuze-66c0n';
// Gemini OAuth credentials loaded from config.json (geminiClientId, geminiClientSecret)
let GEMINI_CLIENT_ID = null;
let GEMINI_CLIENT_SECRET = null;
const VERSION = '2.0.0';

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
  ['HERMES_', 'APP_'],
  ['HERMES', 'APP'],
  ['hermes', 'assistant'],
  ['OpenClaw', 'CLI'],
  ['openclaw', 'cli'],
  ['OPENCLAW', 'CLI'],
  ['Telegram', 'Channel'],
  ['telegram', 'channel'],
  ['Discord', 'Forum'],
  ['discord', 'forum'],
  ['WhatsApp', 'IM'],
  ['whatsapp', 'im'],
  ['Mattermost', 'Workspace'],
  ['mattermost', 'workspace'],
  ['Slack', 'Channel'],
  ['slack', 'channel'],
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

  // Load Gemini credentials from config
  if (config.geminiClientId) GEMINI_CLIENT_ID = config.geminiClientId;
  if (config.geminiClientSecret) GEMINI_CLIENT_SECRET = config.geminiClientSecret;

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

// --- Gemini Token Management -------------------------------------------------
let _geminiTokenCache = null;

function getGeminiCredsPath() {
  const homeDir = os.homedir();
  const p = path.join(homeDir, '.gemini', 'oauth_creds.json');
  if (fs.existsSync(p)) return p;
  return null;
}

function getGeminiToken() {
  const credsPath = getGeminiCredsPath();
  if (!credsPath) throw new Error('Gemini credentials not found at ~/.gemini/oauth_creds.json');
  const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
  if (!creds.access_token) throw new Error('No access_token in Gemini credentials');

  // Check if token is expired (expiry_date is ms timestamp)
  if (creds.expiry_date && Date.now() > creds.expiry_date - 60000) {
    return refreshGeminiToken(creds, credsPath);
  }
  return creds.access_token;
}

function refreshGeminiToken(creds, credsPath) {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      client_id: GEMINI_CLIENT_ID,
      client_secret: GEMINI_CLIENT_SECRET,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token'
    }).toString();

    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      port: 443,
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          if (body.access_token) {
            creds.access_token = body.access_token;
            creds.expiry_date = Date.now() + (body.expires_in * 1000);
            if (body.id_token) creds.id_token = body.id_token;
            fs.writeFileSync(credsPath, JSON.stringify(creds, null, 2));
            console.log('[GEMINI] Token refreshed');
            resolve(body.access_token);
          } else {
            reject(new Error('Gemini token refresh failed: ' + JSON.stringify(body)));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// Synchronous wrapper — tries cached/file token first, triggers async refresh if needed
function getGeminiTokenSync() {
  const credsPath = getGeminiCredsPath();
  if (!credsPath) throw new Error('Gemini credentials not found at ~/.gemini/oauth_creds.json');
  const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
  if (!creds.access_token) throw new Error('No access_token in Gemini credentials');
  // If not expired, return directly
  if (!creds.expiry_date || Date.now() < creds.expiry_date - 60000) {
    return { token: creds.access_token, needsRefresh: false, creds, credsPath };
  }
  return { token: creds.access_token, needsRefresh: true, creds, credsPath };
}

// --- OpenAI ↔ Gemini Format Translation --------------------------------------

// Recursively strip schema fields that Gemini doesn't support
function sanitizeSchemaForGemini(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeSchemaForGemini);

  // Fields Gemini doesn't support in function parameters
  delete schema.additionalProperties;
  delete schema.$ref;
  delete schema.$schema;
  delete schema.$defs;
  delete schema.definitions;
  delete schema.title;
  delete schema.default;
  delete schema.examples;
  delete schema.const;
  delete schema.readOnly;
  delete schema.writeOnly;

  // Handle anyOf/oneOf/allOf — Gemini doesn't support these, flatten to first option
  for (const key of ['anyOf', 'oneOf']) {
    if (Array.isArray(schema[key]) && schema[key].length > 0) {
      // Take first non-null option
      const options = schema[key].filter(o => o.type !== 'null');
      if (options.length > 0) {
        const first = options[0];
        delete schema[key];
        Object.assign(schema, sanitizeSchemaForGemini(first));
      } else {
        delete schema[key];
        schema.type = 'string'; // fallback
      }
      return schema;
    }
  }
  if (Array.isArray(schema.allOf)) {
    const merged = {};
    for (const sub of schema.allOf) {
      Object.assign(merged, sanitizeSchemaForGemini(sub));
    }
    delete schema.allOf;
    Object.assign(schema, merged);
    return schema;
  }

  // Recurse into properties
  if (schema.properties) {
    for (const key of Object.keys(schema.properties)) {
      schema.properties[key] = sanitizeSchemaForGemini(schema.properties[key]);
    }
  }
  // Recurse into items
  if (schema.items) {
    schema.items = sanitizeSchemaForGemini(schema.items);
  }

  return schema;
}

function openaiToGeminiRequest(parsed) {
  // Convert OpenAI/Anthropic messages → Gemini contents
  const contents = [];
  const systemParts = []; // Collect system messages for systemInstruction

  for (const msg of (parsed.messages || [])) {
    // OpenAI system messages → Gemini systemInstruction
    if (msg.role === 'system') {
      const text = typeof msg.content === 'string' ? msg.content
        : Array.isArray(msg.content) ? msg.content.map(b => b.text || '').join('\n') : '';
      if (text) systemParts.push(text);
      continue;
    }

    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts = [];

    if (typeof msg.content === 'string') {
      parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') {
          parts.push({ text: block.text });
        } else if (block.type === 'image_url' && block.image_url) {
          // Pass through image data if present
          parts.push({ text: '[image]' });
        } else if (block.type === 'tool_use') {
          parts.push({
            functionCall: {
              name: block.name,
              args: block.input || {}
            }
          });
        } else if (block.type === 'tool_result') {
          parts.push({
            functionResponse: {
              name: block.tool_use_id || 'tool',
              response: { result: block.content || '' }
            }
          });
        }
      }
    }

    // Handle tool_calls in assistant messages (OpenAI format)
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments); } catch {}
        parts.push({
          functionCall: {
            name: tc.function.name,
            args
          }
        });
      }
    }

    // Handle tool role messages (OpenAI format)
    if (msg.role === 'tool') {
      let resultContent = msg.content;
      if (typeof resultContent !== 'string') {
        try { resultContent = JSON.stringify(resultContent); } catch { resultContent = String(resultContent); }
      }
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: msg.name || msg.tool_call_id || 'tool',
            response: { result: resultContent }
          }
        }]
      });
      continue;
    }

    if (parts.length > 0) {
      contents.push({ role, parts });
    }
  }

  // System instruction — combine Anthropic-style parsed.system + OpenAI-style system messages
  let systemInstruction = undefined;
  const allSystemTexts = [...systemParts];
  if (parsed.system) {
    if (typeof parsed.system === 'string') {
      allSystemTexts.unshift(parsed.system);
    } else if (Array.isArray(parsed.system)) {
      allSystemTexts.unshift(parsed.system.map(b => b.text || '').join('\n'));
    }
  }
  if (allSystemTexts.length > 0) {
    systemInstruction = { parts: [{ text: allSystemTexts.join('\n') }] };
  }

  // Generation config
  const generationConfig = {};
  if (parsed.temperature !== undefined) generationConfig.temperature = parsed.temperature;
  // max_tokens: OpenAI uses max_tokens or max_completion_tokens
  const maxTok = parsed.max_tokens || parsed.max_completion_tokens;
  generationConfig.maxOutputTokens = maxTok ? Math.min(maxTok, 65536) : 8192;
  if (parsed.top_p !== undefined) generationConfig.topP = parsed.top_p;
  if (parsed.stop) {
    generationConfig.stopSequences = Array.isArray(parsed.stop) ? parsed.stop : [parsed.stop];
  }

  // Tools → functionDeclarations
  let tools = undefined;
  if (Array.isArray(parsed.tools) && parsed.tools.length > 0) {
    const functionDeclarations = [];
    for (const tool of parsed.tools) {
      let name, description, parameters;
      if (tool.type === 'function' && tool.function) {
        name = tool.function.name;
        description = tool.function.description || '';
        parameters = tool.function.parameters || { type: 'object', properties: {} };
      } else if (tool.name) {
        name = tool.name;
        description = tool.description || '';
        parameters = tool.input_schema || { type: 'object', properties: {} };
      } else {
        continue;
      }
      // Sanitize schema for Gemini compatibility
      parameters = sanitizeSchemaForGemini(JSON.parse(JSON.stringify(parameters)));
      functionDeclarations.push({ name, description, parameters });
    }
    if (functionDeclarations.length > 0) {
      tools = [{ functionDeclarations }];
    }
  }

  let model = parsed.model || 'gemini-2.5-pro';

  const geminiReq = {
    project: GEMINI_PROJECT,
    model,
    userAgent: 'pi-coding-agent',
    requestId: `pi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    request: {
      contents,
      generationConfig
    }
  };

  if (systemInstruction) geminiReq.request.systemInstruction = systemInstruction;
  if (tools) geminiReq.request.tools = tools;

  return geminiReq;
}

// Detect if incoming request is Anthropic Messages API format
function isAnthropicFormat(parsed) {
  // Anthropic format has system as array of blocks or uses /v1/messages path
  // OpenAI format has system as a message role
  if (Array.isArray(parsed.system)) return true;
  if (typeof parsed.system === 'string' && parsed.messages &&
      !parsed.messages.some(m => m.role === 'system')) return true;
  return false;
}

function geminiSseParse(sseData) {
  // Parse a Gemini SSE data line into normalized parts
  // Cloud Code API wraps response in {"response": {...}, "traceId": ...}
  let parsed;
  try {
    parsed = JSON.parse(sseData);
  } catch {
    return null;
  }

  // Unwrap Cloud Code response envelope
  const inner = parsed.response || parsed;

  const candidates = inner.candidates || [];
  if (candidates.length === 0 && !inner.usageMetadata) return null;

  const candidate = candidates[0] || {};
  const parts = candidate.content?.parts || [];
  const finishReason = candidate.finishReason;

  const result = { textParts: [], toolCalls: [], finishReason: null, usage: null };

  for (const part of parts) {
    if (part.text !== undefined) {
      result.textParts.push(part.text);
    }
    if (part.functionCall) {
      result.toolCalls.push({
        name: part.functionCall.name,
        args: part.functionCall.args || {}
      });
    }
  }

  if (finishReason) {
    result.finishReason = finishReason === 'STOP' ? 'end_turn'
      : finishReason === 'MAX_TOKENS' ? 'max_tokens'
      : finishReason === 'SAFETY' ? 'content_filter'
      : 'end_turn';
  }

  if (inner.usageMetadata) {
    result.usage = {
      input_tokens: inner.usageMetadata.promptTokenCount || 0,
      output_tokens: inner.usageMetadata.candidatesTokenCount || 0
    };
  }

  return result;
}

// --- Anthropic Streaming Response Builder ------------------------------------
// Produces event: / data: pairs matching Anthropic Messages SSE format

function anthropicStreamStart(model, inputTokens) {
  const msgId = `msg_gemini_${Date.now()}`;
  return `event: message_start\ndata: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: msgId, type: 'message', role: 'assistant', content: [],
      model, stop_reason: null, stop_sequence: null,
      usage: { input_tokens: inputTokens || 0, output_tokens: 0 }
    }
  })}\n\n`;
}

function anthropicContentBlockStart(index, blockType, toolName, toolId) {
  if (blockType === 'text') {
    return `event: content_block_start\ndata: ${JSON.stringify({
      type: 'content_block_start', index,
      content_block: { type: 'text', text: '' }
    })}\n\n`;
  }
  // tool_use block
  return `event: content_block_start\ndata: ${JSON.stringify({
    type: 'content_block_start', index,
    content_block: { type: 'tool_use', id: toolId, name: toolName, input: {} }
  })}\n\n`;
}

function anthropicTextDelta(index, text) {
  return `event: content_block_delta\ndata: ${JSON.stringify({
    type: 'content_block_delta', index,
    delta: { type: 'text_delta', text }
  })}\n\n`;
}

function anthropicToolInputDelta(index, partialJson) {
  return `event: content_block_delta\ndata: ${JSON.stringify({
    type: 'content_block_delta', index,
    delta: { type: 'input_json_delta', partial_json: partialJson }
  })}\n\n`;
}

function anthropicContentBlockStop(index) {
  return `event: content_block_stop\ndata: ${JSON.stringify({
    type: 'content_block_stop', index
  })}\n\n`;
}

function anthropicMessageDelta(stopReason, outputTokens) {
  return `event: message_delta\ndata: ${JSON.stringify({
    type: 'message_delta',
    delta: { stop_reason: stopReason || 'end_turn', stop_sequence: null },
    usage: { output_tokens: outputTokens || 0 }
  })}\n\n`;
}

function anthropicMessageStop() {
  return `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;
}

// --- OpenAI Streaming Response Builder ---------------------------------------

function openaiStreamChunk(model, delta, finishReason) {
  return `data: ${JSON.stringify({
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason || null }]
  })}\n\n`;
}

// --- Non-Streaming Response Builders -----------------------------------------

function buildAnthropicResponse(allText, allToolCalls, model, usage) {
  const content = [];
  if (allText) content.push({ type: 'text', text: allText });
  for (const tc of allToolCalls) {
    content.push({
      type: 'tool_use',
      id: `toolu_gemini_${Date.now()}_${content.length}`,
      name: tc.name,
      input: tc.args
    });
  }
  return {
    id: `msg_gemini_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: usage || { input_tokens: 0, output_tokens: 0 }
  };
}

function buildOpenaiResponse(allText, allToolCalls, model, usage) {
  const message = { role: 'assistant', content: allText || null };
  if (allToolCalls.length > 0) {
    message.tool_calls = allToolCalls.map((tc, i) => ({
      id: `call_${Date.now()}_${i}`,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) }
    }));
  }
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: 'stop' }],
    usage: usage ? {
      prompt_tokens: usage.input_tokens || 0,
      completion_tokens: usage.output_tokens || 0,
      total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0)
    } : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
}

// --- Request Processing ------------------------------------------------------
// Anthropic enforces byte-identity on thinking/redacted_thinking content
// blocks across turns.  If our string-replace layers touch them, the next
// request is rejected.  Mask them out, run transforms, restore.
function findThinkingBlockEnd(text, start) {
  // start points at the '{' of the JSON object
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (ch === '\\') { escape = true; }
      else if (ch === '"') { inStr = false; }
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function maskThinkingBlocks(text) {
  const masks = [];
  const patterns = ['{"type":"thinking"', '{"type":"redacted_thinking"'];
  let result = '';
  let cursor = 0;
  while (cursor < text.length) {
    let nextStart = -1;
    for (const pat of patterns) {
      const idx = text.indexOf(pat, cursor);
      if (idx !== -1 && (nextStart === -1 || idx < nextStart)) nextStart = idx;
    }
    if (nextStart === -1) {
      result += text.slice(cursor);
      break;
    }
    const end = findThinkingBlockEnd(text, nextStart);
    if (end === -1) {
      result += text.slice(cursor);
      break;
    }
    result += text.slice(cursor, nextStart);
    const placeholder = `__OBP_THINK_MASK_${masks.length}__`;
    masks.push(text.slice(nextStart, end));
    result += placeholder;
    cursor = end;
  }
  return { masked: result, masks };
}

function unmaskThinkingBlocks(text, masks) {
  let result = text;
  for (let i = 0; i < masks.length; i++) {
    result = result.split(`__OBP_THINK_MASK_${i}__`).join(masks[i]);
  }
  return result;
}

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
          // Never touch thinking / redacted_thinking blocks — Anthropic
          // checks them for byte-identity across turns.
          if (block.type === 'thinking' || block.type === 'redacted_thinking') continue;
          if (block.text) block.text = rep(block.text);
          if (typeof block.content === 'string') {
            block.content = rep(block.content);
          } else if (Array.isArray(block.content)) {
            for (const inner of block.content) {
              if (inner && inner.type === 'thinking') continue;
              if (inner && inner.type === 'redacted_thinking') continue;
              if (inner && inner.text) inner.text = rep(inner.text);
            }
          }
          if (block.input && typeof block.input === 'object') {
            for (const k of Object.keys(block.input)) {
              if (typeof block.input[k] === 'string') {
                block.input[k] = rep(block.input[k]);
              }
            }
          }
        }
      }
    }
  }

  if (Array.isArray(parsed.tools)) {
    for (const tool of parsed.tools) {
      if (tool.description) tool.description = rep(tool.description);
      // Also sanitize input_schema property descriptions (paths/imports leak here)
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

  // Inject CC tool stubs (skip if tools already contain CC-native names, e.g. Claude Code)
  if (config.injectCCStubs) {
    if (!Array.isArray(parsed.tools)) parsed.tools = [];
    const existingNames = new Set(parsed.tools.map(t => t.name));
    const hasNativeCC = existingNames.has('Glob') || existingNames.has('Read') || existingNames.has('Edit');
    if (!hasNativeCC) {
      for (const stub of CC_TOOL_STUBS) {
        parsed.tools.unshift(JSON.parse(stub));
      }
    }
  }

  // Auto-enable thinking when context_management requires it
  if (parsed.context_management && Array.isArray(parsed.context_management.edits)) {
    const needsThinking = parsed.context_management.edits.some(
      e => e && typeof e.type === "string" && e.type.startsWith("clear_thinking")
    );
    if (needsThinking && (!parsed.thinking || (parsed.thinking.type !== "enabled" && parsed.thinking.type !== "adaptive"))) {
      // Budget must be < max_tokens; reserve 4096 for the final response
      const mt = typeof parsed.max_tokens === "number" ? parsed.max_tokens : 8192;
      const budget = Math.max(1024, Math.min(mt - 4096, 32000));
      parsed.thinking = { type: "enabled", budget_tokens: budget };
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
  // Preserve byte-identity of thinking blocks
  const { masked, masks } = maskThinkingBlocks(text);
  let r = masked;
  for (const [sanitized, original] of config.reverseMap) {
    r = r.split(sanitized).join(original);
  }
  return unmaskThinkingBlocks(r, masks);
}

// --- Anthropic Request Handler -----------------------------------------------
function handleAnthropicRequest(bodyStr, req, res, config, reqNum, ts) {
  let oauth;
  try { oauth = getToken(config.credsPath); } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { message: e.message } }));
    return;
  }

  const originalSize = bodyStr.length;
  const _rawCopy = bodyStr;
  bodyStr = processBody(bodyStr, config);
  try { fs.writeFileSync(`/tmp/dbg-raw-${reqNum}.json`, _rawCopy); } catch {}
  try { fs.writeFileSync(`/tmp/dbg-proc-${reqNum}.json`, bodyStr); } catch {}
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
  for (const b of REQUIRED_BETAS) { if (!betas.includes(b)) betas.push(b); }
  headers['anthropic-beta'] = betas.join(',');

  console.log(`[${ts}] #${reqNum} ANTHROPIC ${req.method} ${req.url} (${originalSize}b -> ${body.length}b)`);

  // === OUT dump: request as it leaves toward api.anthropic.com ===
  try {
    fs.writeFileSync(
      `/tmp/proxy-dumps/${reqNum}-out.json`,
      JSON.stringify({
        method: req.method,
        url: `https://${UPSTREAM_HOST}${req.url}`,
        headers,
        body: bodyStr
      }, null, 2)
    );
  } catch {}

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

// --- Gemini Request Handler --------------------------------------------------
function handleGeminiRequest(bodyStr, req, res, config, reqNum, ts) {
  let parsed;
  try {
    parsed = JSON.parse(bodyStr);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { message: 'Invalid JSON: ' + e.message } }));
    return;
  }

  const model = parsed.model || 'gemini-2.5-pro';
  const isStreaming = parsed.stream !== false;
  const useAnthropicFmt = isAnthropicFormat(parsed);
  const reqStartTime = Date.now();
  console.log(`[${ts}] #${reqNum} GEMINI ${model} (${bodyStr.length}b, stream=${isStreaming}, fmt=${useAnthropicFmt ? 'anthropic' : 'openai'})`);

  // Get Google OAuth token
  let tokenInfo;
  try {
    tokenInfo = getGeminiTokenSync();
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { message: e.message } }));
    return;
  }

  const doRequest = (accessToken) => {
    const geminiReq = openaiToGeminiRequest(parsed);
    const geminiBody = JSON.stringify(geminiReq);

    // Debug: dump both input and translated request
    try { fs.writeFileSync(`/tmp/gemini-input-${reqNum}.json`, JSON.stringify(parsed, null, 2)); } catch {}
    try { fs.writeFileSync(`/tmp/gemini-output-${reqNum}.json`, JSON.stringify(geminiReq, null, 2)); } catch {}
    console.log(`[${ts}] #${reqNum} GEMINI dumped input+output to /tmp/gemini-{input,output}-${reqNum}.json`);

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
      'Content-Length': Buffer.byteLength(geminiBody),
      'User-Agent': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
      'X-Goog-Api-Client': 'gl-node/22.17.0',
      'Accept-Encoding': 'identity'
    };

    const upstream = https.request({
      hostname: GEMINI_HOST, port: 443,
      path: GEMINI_PATH, method: 'POST', headers
    }, (upRes) => {
      const status = upRes.statusCode;
      console.log(`[${ts}] #${reqNum} GEMINI > ${status}`);

      if (status !== 200) {
        const errChunks = [];
        upRes.on('data', c => errChunks.push(c));
        upRes.on('end', () => {
          const errBody = Buffer.concat(errChunks).toString();
          console.error(`[${ts}] #${reqNum} GEMINI ERR: ${errBody.substring(0, 500)}`);
          const errResp = useAnthropicFmt
            ? JSON.stringify({ type: 'error', error: { type: 'api_error', message: `Gemini API error (${status}): ${errBody.substring(0, 200)}` } })
            : JSON.stringify({ error: { message: `Gemini API error (${status}): ${errBody.substring(0, 200)}`, type: 'api_error', code: status } });
          trackGemini(model, status, null, Date.now() - reqStartTime);
          res.writeHead(status >= 400 ? status : 500, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(errResp) });
          res.end(errResp);
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
        let blockIndex = 0;
        let sentStart = false;
        let sentOpenaiRole = false;
        let textBlockOpen = false;
        let totalOutputTokens = 0;
        const includeUsage = parsed.stream_options?.include_usage === true;
        let lastUsage = null;

        const processSseData = (data) => {
          const result = geminiSseParse(data);
          if (!result) return;

          // Debug: log parsed SSE event
          console.log(`[${ts}] #${reqNum} GEMINI SSE: text=${result.textParts.length} tools=${result.toolCalls.length} finish=${result.finishReason} usage=${JSON.stringify(result.usage)}`);

          if (useAnthropicFmt) {
            if (!sentStart) {
              res.write(anthropicStreamStart(model, result.usage?.input_tokens || 0));
              sentStart = true;
            }
            // Text deltas
            if (result.textParts.length > 0) {
              if (!textBlockOpen) {
                res.write(anthropicContentBlockStart(blockIndex, 'text'));
                textBlockOpen = true;
              }
              for (const text of result.textParts) {
                const words = text.match(/\S+\s*/g) || [text];
                for (const word of words) {
                  res.write(anthropicTextDelta(blockIndex, word));
                }
              }
            }
            // Tool calls
            for (const tc of result.toolCalls) {
              if (textBlockOpen) {
                res.write(anthropicContentBlockStop(blockIndex));
                blockIndex++;
                textBlockOpen = false;
              }
              const toolId = `toolu_gemini_${Date.now()}_${blockIndex}`;
              res.write(anthropicContentBlockStart(blockIndex, 'tool_use', tc.name, toolId));
              res.write(anthropicToolInputDelta(blockIndex, JSON.stringify(tc.args)));
              res.write(anthropicContentBlockStop(blockIndex));
              blockIndex++;
            }
            if (result.usage) totalOutputTokens = result.usage.output_tokens || 0;
            if (result.finishReason) {
              if (textBlockOpen) {
                res.write(anthropicContentBlockStop(blockIndex));
                textBlockOpen = false;
              }
              res.write(anthropicMessageDelta(result.finishReason, totalOutputTokens));
            }
          } else {
            // OpenAI streaming format
            // Send role chunk first (SDK expects this)
            if (!sentOpenaiRole) {
              res.write(openaiStreamChunk(model, { role: 'assistant', content: '' }, null));
              sentOpenaiRole = true;
            }
            // Split large text parts into word-level chunks for progressive display
            for (const text of result.textParts) {
              const words = text.match(/\S+\s*/g) || [text];
              for (const word of words) {
                res.write(openaiStreamChunk(model, { content: word }, null));
              }
            }
            for (const tc of result.toolCalls) {
              res.write(openaiStreamChunk(model, {
                tool_calls: [{
                  index: 0, id: `call_${Date.now()}`, type: 'function',
                  function: { name: tc.name, arguments: JSON.stringify(tc.args) }
                }]
              }, null));
            }
            if (result.usage) lastUsage = result.usage;
            if (result.finishReason) {
              const mapped = result.finishReason === 'end_turn' ? 'stop'
                : result.finishReason === 'max_tokens' ? 'length' : 'stop';
              res.write(openaiStreamChunk(model, {}, mapped));
            }
          }
        };

        upRes.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            if (line.startsWith('data: ')) processSseData(line.slice(6));
          }
        });
        upRes.on('end', () => {
          if (buffer.startsWith('data: ')) processSseData(buffer.slice(6));
          if (useAnthropicFmt) {
            if (!sentStart) res.write(anthropicStreamStart(model, 0));
            // Close any open content block
            if (textBlockOpen) {
              res.write(anthropicContentBlockStop(blockIndex));
              textBlockOpen = false;
            }
            // Ensure message_delta is sent before message_stop
            res.write(anthropicMessageDelta('end_turn', totalOutputTokens));
            res.write(anthropicMessageStop());
          } else {
            // Send usage chunk if requested (stream_options.include_usage)
            if (includeUsage && lastUsage) {
              res.write(`data: ${JSON.stringify({
                id: `chatcmpl-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [],
                usage: {
                  prompt_tokens: lastUsage.input_tokens || 0,
                  completion_tokens: lastUsage.output_tokens || 0,
                  total_tokens: (lastUsage.input_tokens || 0) + (lastUsage.output_tokens || 0)
                }
              })}\n\n`);
            }
            res.write('data: [DONE]\n\n');
          }
          trackGemini(model, 200, lastUsage, Date.now() - reqStartTime);
          res.end();
        });
      } else {
        // Non-streaming: collect all events
        let allText = '';
        const allToolCalls = [];
        let usage = null;
        let buffer = '';

        upRes.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const result = geminiSseParse(line.slice(6));
              if (result) {
                allText += result.textParts.join('');
                allToolCalls.push(...result.toolCalls);
                if (result.usage) usage = result.usage;
              }
            }
          }
        });
        upRes.on('end', () => {
          if (buffer.startsWith('data: ')) {
            const result = geminiSseParse(buffer.slice(6));
            if (result) {
              allText += result.textParts.join('');
              allToolCalls.push(...result.toolCalls);
              if (result.usage) usage = result.usage;
            }
          }
          const resp = useAnthropicFmt
            ? JSON.stringify(buildAnthropicResponse(allText, allToolCalls, model, usage))
            : JSON.stringify(buildOpenaiResponse(allText, allToolCalls, model, usage));
          trackGemini(model, 200, usage, Date.now() - reqStartTime);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(resp) });
          res.end(resp);
        });
      }
    });

    upstream.on('error', e => {
      console.error(`[${ts}] #${reqNum} GEMINI ERR: ${e.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { message: 'Gemini upstream error: ' + e.message } }));
      }
    });
    upstream.write(geminiBody);
    upstream.end();
  };

  if (tokenInfo.needsRefresh) {
    console.log(`[${ts}] #${reqNum} GEMINI token expired, refreshing...`);
    refreshGeminiToken(tokenInfo.creds, tokenInfo.credsPath)
      .then(newToken => doRequest(newToken))
      .catch(e => {
        console.error(`[${ts}] #${reqNum} GEMINI refresh failed: ${e.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { message: 'Gemini token refresh failed: ' + e.message } }));
      });
  } else {
    doRequest(tokenInfo.token);
  }
}

// --- Usage Tracker -----------------------------------------------------------
const geminiStats = {
  requests: 0,
  successes: 0,
  rateLimits: 0,
  errors: 0,
  inputTokens: 0,
  outputTokens: 0,
  byModel: {},       // model -> { requests, successes, rateLimits, inputTokens, outputTokens }
  recentRequests: [], // last 20 requests: { ts, model, status, inputTokens, outputTokens, durationMs }
};

function trackGemini(model, status, usage, durationMs) {
  geminiStats.requests++;
  if (status === 200) geminiStats.successes++;
  else if (status === 429) geminiStats.rateLimits++;
  else geminiStats.errors++;

  if (usage) {
    geminiStats.inputTokens += usage.input_tokens || 0;
    geminiStats.outputTokens += usage.output_tokens || 0;
  }

  if (!geminiStats.byModel[model]) {
    geminiStats.byModel[model] = { requests: 0, successes: 0, rateLimits: 0, inputTokens: 0, outputTokens: 0 };
  }
  const m = geminiStats.byModel[model];
  m.requests++;
  if (status === 200) m.successes++;
  else if (status === 429) m.rateLimits++;
  if (usage) {
    m.inputTokens += usage.input_tokens || 0;
    m.outputTokens += usage.output_tokens || 0;
  }

  geminiStats.recentRequests.push({
    ts: new Date().toISOString(),
    model, status,
    inputTokens: usage?.input_tokens || 0,
    outputTokens: usage?.output_tokens || 0,
    durationMs
  });
  if (geminiStats.recentRequests.length > 20) geminiStats.recentRequests.shift();
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
        const health = {
          status: expiresIn > 0 ? 'ok' : 'token_expired',
          proxy: 'hermes-billing-proxy',
          version: VERSION,
          requestsServed: requestCount,
          uptime: Math.floor((Date.now() - startedAt) / 1000) + 's',
          anthropic: {
            tokenExpiresInHours: expiresIn.toFixed(1),
            subscriptionType: oauth.subscriptionType
          },
          layers: {
            stringReplacements: config.replacements.length,
            ccToolStubs: config.injectCCStubs ? CC_TOOL_STUBS.length : 0,
            systemStripEnabled: config.stripSystemConfig
          }
        };
        // Add Gemini status
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
      const originalSize = bodyStr.length;
      const ts = new Date().toISOString().substring(11, 19);

      // === IN dump: request as it enters the proxy ===
      try {
        fs.writeFileSync(
          `/tmp/proxy-dumps/${reqNum}-in.json`,
          JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: bodyStr }, null, 2)
        );
      } catch {}

      // Detect if this is a Gemini request by peeking at the model field
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
      console.log(`\n  Hermes Billing Proxy v${VERSION}`);
      console.log(`  ────────────────────────────────────`);
      console.log(`  Port:              ${config.port}`);
      console.log(`  Anthropic:         ${oauth.subscriptionType} (token expires ${h}h)`);
      // Gemini status
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
      console.log(`  CC tool stubs:     ${config.injectCCStubs ? CC_TOOL_STUBS.length : 'disabled'}`);
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

// --- Main --------------------------------------------------------------------
const config = loadConfig();
startServer(config);
