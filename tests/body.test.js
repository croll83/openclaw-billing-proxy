const test = require('node:test');
const assert = require('node:assert/strict');
const { processBody } = require('../src/proxy/anthropic');
const { config } = require('./helpers');

const transform = (body, overrides = {}) => JSON.parse(processBody(JSON.stringify(body), { ...config(), ...overrides }));

test('without compatibility stubs, system/cache, identifiers, tools and history survive unchanged', () => {
  const body = { model: 'claude-opus-5', max_tokens: 256,
    system: [
      { type: 'text', text: '# SOUL.md\nHermes Telegram HERMES_HOME ~/.hermes/\n' + 'stable '.repeat(500), cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: 'suffix '.repeat(400), cache_control: { type: 'ephemeral', ttl: '1h' } },
    ], tools: [{ name: 'read_file', description: 'Read secrets.env for Hermes', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
    messages: [{ role: 'user', content: 'Plan mode è' }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'Plan mode', signature: 'opaque' }] }] };
  const actual = transform(body);
  assert.deepEqual(actual.system.slice(1), body.system);
  assert.deepEqual(actual.tools, body.tools);
  assert.deepEqual(actual.messages, body.messages);
  assert.equal(actual.system[0].text, JSON.parse(config().BILLING_BLOCK).text);
});

test('explicit compatibility relocation retains each block and its cache metadata', () => {
  const blocks = [{ type: 'text', text: 'static '.repeat(400), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'suffix '.repeat(400), cache_control: { type: 'ephemeral' } }];
  const actual = transform({ system: blocks, messages: [{ role: 'user', content: 'question' }] }, { stripSystemConfig: true });
  assert.deepEqual(actual.messages[0].content.slice(1), blocks);
  assert.equal(actual.messages[2].content, 'question');
});

test('disabled or absent thinking is never enabled; unrelated edits and sampling survive', () => {
  for (const thinking of [undefined, { type: 'disabled' }]) {
    const other = { type: 'clear_tool_uses_20250919', keep: { type: 'tool_uses', value: 3 } };
    const input = { max_tokens: 128, thinking, temperature: 0.1, top_p: 0.9,
      context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }, other] } };
    const actual = transform(input);
    assert.deepEqual(actual.thinking, thinking);
    assert.deepEqual(actual.context_management.edits, [other]);
    assert.equal(actual.temperature, 0.1);
    assert.equal(actual.top_p, 0.9);
    assert.equal(actual.max_tokens, 128);
  }
});

test('adaptive and manual thinking settings remain client-owned', () => {
  for (const thinking of [{ type: 'adaptive', display: 'summarized' }, { type: 'enabled', budget_tokens: 2048 }]) {
    const input = { max_tokens: 8192, thinking, output_config: { effort: 'low' },
      context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] } };
    const actual = transform(input);
    assert.deepEqual(actual.thinking, thinking);
    assert.deepEqual(actual.context_management, input.context_management);
    assert.deepEqual(actual.output_config, input.output_config);
  }
});

test('compatibility stubs cannot duplicate or replace a real caller tool', () => {
  const own = { name: 'Bash', description: 'Real caller tool', input_schema: { type: 'object', properties: {} } };
  const actual = transform({ tools: [own] }, { injectCCStubs: true });
  assert.equal(new Set(actual.tools.map(t => t.name)).size, actual.tools.length);
  assert.deepEqual(actual.tools.find(t => t.name === 'Bash'), own);
});

test('disabling stubs leaves tool-less requests tool-less', () => {
  const actual = transform({ messages: [{ role: 'user', content: 'hello' }] }, { injectCCStubs: false });
  assert.equal(actual.tools, undefined);
});

test('compatibility mode does not invent tools for a tool-less caller', () => {
  for (const tools of [undefined, []]) {
    const actual = transform({ tools, messages: [{ role: 'user', content: 'hello' }] }, { injectCCStubs: true });
    assert.deepEqual(actual.tools, tools);
  }
});
