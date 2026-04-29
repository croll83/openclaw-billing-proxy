const https = require('https');
const { getGeminiTokenSync, refreshGeminiToken } = require('../auth/geminiToken');
const { openaiToGeminiRequest, isAnthropicFormat, geminiSseParse } = require('../formatters/openaiToGemini');
const {
  anthropicStreamStart,
  anthropicContentBlockStart,
  anthropicTextDelta,
  anthropicToolInputDelta,
  anthropicContentBlockStop,
  anthropicMessageDelta,
  anthropicMessageStop,
  openaiStreamChunk,
  buildAnthropicResponse,
  buildOpenaiResponse
} = require('../formatters/sseBuilders');
const { debugDump } = require('../utils');

const geminiStats = {
  requests: 0,
  successes: 0,
  rateLimits: 0,
  errors: 0,
  inputTokens: 0,
  outputTokens: 0,
  byModel: {},
  recentRequests: [],
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

function handleGeminiRequest(bodyStr, req, res, config, reqNum, ts) {
  let parsed;
  try {
    parsed = JSON.parse(bodyStr);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { message: 'Invalid JSON: ' + e.message } }));
    return;
  }

  const model = (parsed.model || 'gemini-2.5-pro').replace(/^google\//, '');
  const isStreaming = parsed.stream !== false;
  const useAnthropicFmt = isAnthropicFormat(parsed);
  const reqStartTime = Date.now();
  console.log(`[${ts}] #${reqNum} GEMINI ${model} (${bodyStr.length}b, stream=${isStreaming}, fmt=${useAnthropicFmt ? 'anthropic' : 'openai'})`);

  let tokenInfo;
  try {
    tokenInfo = getGeminiTokenSync();
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { message: e.message } }));
    return;
  }

  const doRequest = (accessToken) => {
    const geminiReq = openaiToGeminiRequest(parsed, config);
    const geminiBody = JSON.stringify(geminiReq);

    debugDump(`gemini-${reqNum}-raw-in.json`, JSON.stringify(parsed, null, 2));
    debugDump(`gemini-${reqNum}-converted.json`, JSON.stringify(geminiReq, null, 2));

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
      'Content-Length': Buffer.byteLength(geminiBody),
      'User-Agent': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
      'X-Goog-Api-Client': 'gl-node/22.17.0',
      'Accept-Encoding': 'identity'
    };

    debugDump(`gemini-${reqNum}-out.json`, JSON.stringify({
      method: 'POST',
      url: `https://${config.GEMINI_HOST}${config.GEMINI_PATH}`,
      headers,
      body: geminiReq
    }, null, 2));

    const upstream = https.request({
      hostname: config.GEMINI_HOST, port: 443,
      path: config.GEMINI_PATH, method: 'POST', headers
    }, (upRes) => {
      const status = upRes.statusCode;
      console.log(`[${ts}] #${reqNum} GEMINI > ${status}`);

      if (status !== 200) {
        const errChunks = [];
        upRes.on('data', c => errChunks.push(c));
        upRes.on('end', () => {
          const errBody = Buffer.concat(errChunks).toString();
          debugDump(`gemini-${reqNum}-err-${status}.json`, errBody);
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
          let result;
          try {
            result = geminiSseParse(data);
          } catch (e) {
            console.error(`[${ts}] #${reqNum} GEMINI SSE Parse Error:`, e.message);
            return;
          }
          if (!result) return;

          if (useAnthropicFmt) {
            if (!sentStart) {
              res.write(anthropicStreamStart(model, result.usage?.input_tokens || 0));
              sentStart = true;
            }
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
            if (!sentOpenaiRole) {
              res.write(openaiStreamChunk(model, { role: 'assistant', content: '' }, null));
              sentOpenaiRole = true;
            }
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
            if (textBlockOpen) {
              res.write(anthropicContentBlockStop(blockIndex));
              textBlockOpen = false;
            }
            res.write(anthropicMessageDelta('end_turn', totalOutputTokens));
            res.write(anthropicMessageStop());
          } else {
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
    refreshGeminiToken(tokenInfo.creds, tokenInfo.credsPath, config)
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

module.exports = { handleGeminiRequest, getGeminiStats: () => geminiStats };