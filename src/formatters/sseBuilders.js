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

function openaiStreamChunk(model, delta, finishReason) {
  return `data: ${JSON.stringify({
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason || null }]
  })}\n\n`;
}

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

module.exports = {
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
};