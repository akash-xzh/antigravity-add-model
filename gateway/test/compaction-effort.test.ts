import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dataFile } from '../src/data-paths.js';
import { ModelResolver, modelResolver, validateModels } from '../src/models.js';
import { getCompactionConfig } from '../src/compaction.js';
import { OpenAICompatAdapter } from '../src/adapters/openai.js';
import { AnthropicAdapter } from '../src/adapters/anthropic.js';
import { GatewayMessagesAdapter } from '../src/adapters/gateway-messages.js';
import { GoogleAdapter } from '../src/adapters/google.js';
import { buildResponsesRequest } from '../src/adapters/gateway-responses.js';
import { mapGenerationConfig } from '../src/mapper.js';

const filename = dataFile('models.json');
const original = fs.readFileSync(filename, 'utf8');
const originalEffort = process.env.COMPACTION_REASONING_EFFORT;
afterEach(() => {
  fs.writeFileSync(filename, original);
  modelResolver.reload();
  if (originalEffort === undefined) delete process.env.COMPACTION_REASONING_EFFORT;
  else process.env.COMPACTION_REASONING_EFFORT = originalEffort;
});
const messages = [{ role: 'user' as const, content: 'Summarize fixture history' }];
const options = (effort: string) => ({
  maxTokens: 2048,
  compactionEffort: effort,
  providerOptions: { openai: { reasoningEffort: effort } },
});

test('model settings validate summary effort and reload restores inheritance when the override is removed', () => {
  for (const effort of ['inherit', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
    assert.doesNotThrow(() => validateModels({ _compaction_reasoning_effort: effort }));
  }
  for (const value of ['turbo', 'default', '', null, {}, 0]) {
    assert.throws(() => validateModels({ _compaction_reasoning_effort: value }), /compaction reasoning effort/);
  }
  fs.writeFileSync(filename, JSON.stringify({ _compaction_reasoning_effort: 'low' }));
  const resolver = new ModelResolver();
  assert.equal(resolver.compactionReasoningEffort, 'low');
  fs.writeFileSync(filename, '{}');
  resolver.reload();
  assert.equal(resolver.compactionReasoningEffort, 'inherit');
});

test('environment summary effort takes precedence over the model file and falls back to inherit on unknown values', () => {
  fs.writeFileSync(filename, JSON.stringify({ _compaction_reasoning_effort: 'low' }));
  modelResolver.reload();
  delete process.env.COMPACTION_REASONING_EFFORT;
  assert.equal(getCompactionConfig().effort, 'low');
  process.env.COMPACTION_REASONING_EFFORT = 'none';
  assert.equal(getCompactionConfig().effort, 'none');
  process.env.COMPACTION_REASONING_EFFORT = 'inherit';
  assert.equal(getCompactionConfig().effort, 'inherit');
  process.env.COMPACTION_REASONING_EFFORT = 'turbo';
  assert.equal(getCompactionConfig().effort, 'inherit');
});

test('OpenAI chat and Responses preserve explicit compaction effort including none', () => {
  const adapter = new OpenAICompatAdapter('openai', 'https://example.invalid/v1', 'fixture-key');
  for (const effort of ['none', 'minimal', 'low', 'xhigh']) {
    const config = options(effort);
    const before = JSON.stringify(config);
    const chat = (adapter as any).buildRequest('fixture-model', messages, undefined, config);
    const responses = buildResponsesRequest('fixture-model', messages, undefined, config) as any;
    assert.equal(chat.reasoning_effort, effort);
    assert.deepEqual(responses.reasoning, { effort });
    assert.equal(chat.compactionEffort, undefined, 'internal request purpose is not sent to the provider');
    assert.equal(responses.compactionEffort, undefined);
    assert.equal(JSON.stringify(config), before, 'request options remain reusable');
  }
  const normal = (adapter as any).buildRequest('fixture-model', messages, undefined, { providerOptions: { openai: { reasoningEffort: 'high' } } });
  assert.equal(normal.reasoning_effort, 'high');
});

test('native compaction metadata overrides inherited thinking only for the marked request', () => {
  const original = { temperature: 0.8, topP: 0.9, topK: 40, maxOutputTokens: 2048, thinkingConfig: { includeThoughts: true } };
  const marked = mapGenerationConfig({ ...original, compactionReasoningEffort: 'none' });
  assert.equal(marked.compactionEffort, 'none');
  assert.deepEqual(marked.providerOptions, { openai: { reasoningEffort: 'none' } });
  assert.equal(marked.temperature, undefined);
  assert.equal(marked.topP, undefined);
  assert.equal(marked.topK, undefined);
  assert.equal(marked.maxTokens, 2048);
  const normal = mapGenerationConfig(original);
  assert.equal(normal.compactionEffort, undefined);
  assert.equal(normal.temperature, 0.8);
  assert.deepEqual(normal.providerOptions, { openai: { reasoningEffort: 'medium' } });
  assert.deepEqual(mapGenerationConfig({ ...original, compactionReasoningEffort: 'inherit' }), normal);
  assert.throws(() => mapGenerationConfig({ compactionReasoningEffort: 'turbo' }), (error: any) => error.status === 400);
});

test('OpenRouter compaction uses native reasoning controls without altering ordinary chat payloads', () => {
  const adapter = new OpenAICompatAdapter('openrouter', 'https://openrouter.ai/api/v1', 'fixture-key');
  const low = (adapter as any).buildRequest('fixture-model', messages, undefined, options('low'));
  assert.deepEqual(low.reasoning, { effort: 'low', enabled: true });
  assert.equal(low.reasoning_effort, undefined);
  const none = (adapter as any).buildRequest('fixture-model', messages, undefined, options('none'));
  assert.deepEqual(none.reasoning, { effort: 'none', enabled: false });
  assert.equal(none.reasoning_effort, undefined);
  const normal = (adapter as any).buildRequest('fixture-model', messages, undefined, { providerOptions: { openai: { reasoningEffort: 'high' } } });
  assert.equal(normal.reasoning_effort, 'high');
  assert.equal(normal.reasoning, undefined);
});

test('Anthropic and gateway Messages disable compaction thinking or use the smallest valid budget', () => {
  const adapters = [
    new AnthropicAdapter('https://example.invalid/v1', 'fixture-key'),
    new GatewayMessagesAdapter('https://example.invalid/v1', 'fixture-key', 'opencode-go'),
  ];
  for (const adapter of adapters) {
    const none = (adapter as any).buildRequest('fixture-model', messages, undefined, options('none'));
    assert.deepEqual(none.thinking, { type: 'disabled' });
    for (const effort of ['minimal', 'low']) {
      const low = (adapter as any).buildRequest('fixture-model', messages, undefined, { ...options(effort), temperature: 0.3, topP: 0.9 });
      assert.deepEqual(low.thinking, { type: 'enabled', budget_tokens: 1024 });
      assert.ok(low.thinking.budget_tokens < low.max_tokens);
      assert.equal(low.temperature, undefined);
      assert.equal(low.top_p, undefined);
    }
    const normal = (adapter as any).buildRequest('fixture-model', messages, undefined, { maxTokens: 20000, providerOptions: { openai: { reasoningEffort: 'high' } } });
    assert.deepEqual(normal.thinking, { type: 'enabled', budget_tokens: 16384 });
  }
});

test('Google compaction maps effort to each Gemini family and leaves ordinary generation unchanged', () => {
  const adapter = new GoogleAdapter('https://example.invalid', 'fixture-key');
  const build = (model: string, effort: string) => (adapter as any).buildRequest(model, messages, undefined, options(effort)).generationConfig.thinkingConfig;
  assert.deepEqual(build('gemini-2.5-flash', 'none'), { thinkingBudget: 0 });
  assert.deepEqual(build('gemini-2.5-pro', 'none'), { thinkingBudget: 128 }, 'Pro cannot disable thinking');
  assert.deepEqual(build('gemini-2.5-flash', 'low'), { thinkingBudget: 1024 });
  assert.deepEqual(build('gemini-3-flash-preview', 'none'), { thinkingLevel: 'MINIMAL' });
  assert.deepEqual(build('models/gemini-3-pro-preview', 'none'), { thinkingLevel: 'LOW' });
  assert.deepEqual(build('gemini-3-pro-preview', 'minimal'), { thinkingLevel: 'LOW' });
  assert.deepEqual(build('gemini-3-pro-preview', 'medium'), { thinkingLevel: 'HIGH' });
  assert.deepEqual(build('gemini-3.1-pro-preview', 'xhigh'), { thinkingLevel: 'HIGH' });
  assert.deepEqual(build('gemini-3.8-flash', 'none'), { thinkingLevel: 'LOW' }, 'do not assume future Flash models support minimal');
  const normal = (adapter as any).buildRequest('gemini-3-pro-preview', messages, undefined, { maxTokens: 20000, providerOptions: { openai: { reasoningEffort: 'high' } } });
  assert.equal(normal.generationConfig.thinkingConfig, undefined);
});
