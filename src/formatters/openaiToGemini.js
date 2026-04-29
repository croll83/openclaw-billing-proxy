const crypto = require('crypto');

function sanitizeSchemaForGemini(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeSchemaForGemini);

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

  for (const key of ['anyOf', 'oneOf']) {
    if (Array.isArray(schema[key]) && schema[key].length > 0) {
      const options = schema[key].filter(o => o.type !== 'null');
      if (options.length > 0) {
        const first = options[0];
        delete schema[key];
        Object.assign(schema, sanitizeSchemaForGemini(first));
      } else {
        delete schema[key];
        schema.type = 'string';
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

  if (schema.properties) {
    for (const key of Object.keys(schema.properties)) {
      schema.properties[key] = sanitizeSchemaForGemini(schema.properties[key]);
    }
  }
  if (schema.items) {
    schema.items = sanitizeSchemaForGemini(schema.items);
  }

  return schema;
}

function openaiToGeminiRequest(parsed, config) {
  const contents = [];
  const systemParts = [];

  for (const msg of (parsed.messages || [])) {
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

  const generationConfig = {
    temperature: parsed.temperature !== undefined ? parsed.temperature : 1,
    topP: parsed.top_p !== undefined ? parsed.top_p : 0.95,
    topK: 64,
    thinkingConfig: { includeThoughts: true }
  };
  if (parsed.stop) {
    generationConfig.stopSequences = Array.isArray(parsed.stop) ? parsed.stop : [parsed.stop];
  }

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
      parameters = sanitizeSchemaForGemini(JSON.parse(JSON.stringify(parameters)));
      functionDeclarations.push({ name, description, parameters });
    }
    if (functionDeclarations.length > 0) {
      tools = [{ functionDeclarations }];
    }
  }

  let model = parsed.model || 'gemini-2.5-pro';
  model = model.replace(/^(gemini-)(\d+)-(\d+)/, '$1$2.$3');

  const geminiReq = {
    project: config.GEMINI_PROJECT,
    model,
    user_prompt_id: crypto.randomUUID(),
    request: {
      contents,
      generationConfig
    }
  };

  if (systemInstruction) geminiReq.request.systemInstruction = systemInstruction;
  if (tools) geminiReq.request.tools = tools;

  return geminiReq;
}

function isAnthropicFormat(parsed) {
  if (Array.isArray(parsed.system)) return true;
  if (typeof parsed.system === 'string' && parsed.messages &&
      !parsed.messages.some(m => m.role === 'system')) return true;
  return false;
}

function geminiSseParse(sseData) {
  let parsed;
  try {
    parsed = JSON.parse(sseData);
  } catch (e) {
    return null;
  }

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

module.exports = {
  openaiToGeminiRequest,
  isAnthropicFormat,
  geminiSseParse,
  sanitizeSchemaForGemini
};