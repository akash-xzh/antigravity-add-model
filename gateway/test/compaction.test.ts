import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSummarizationPrompt,
  chunkMessagesForSummary,
  compactIfNeeded,
  getCompactionConfig,
} from '../src/compaction.js';
import { clearContextWindows, setContextWindow } from '../src/context-windows.js';
import { config } from '../src/config.js';
import { modelResolver } from '../src/models.js';
import { estimateMessageTokens, estimateSystemTokens, estimateToolTokens } from '../src/token-estimator.js';
import { ANTIGRAVITY_CONTEXT } from '../src/antigravity-context.js';
import type { MappedRequest, OpenAIMessage } from '../src/mapper.js';
import type { Router } from '../src/router.js';

interface RecordedCall {
  providerIds: string[];
  model: string;
  messages: OpenAIMessage[];
  options: Record<string, unknown>;
}

function createMockRouter(
  handler?: (call: RecordedCall, index: number) => string | Error,
): { router: Router; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const router = {
    async *execute(
      providerIds: string[],
      model: string,
      messages: OpenAIMessage[],
      _tools?: unknown,
      options: Record<string, unknown> = {},
    ) {
      const call: RecordedCall = { providerIds: [...providerIds], model, messages, options };
      const idx = calls.push(call) - 1;
      const outcome = handler ? handler(call, idx) : `## Objective\n- Summary chunk ${idx + 1}`;
      if (outcome instanceof Error) {
        yield { type: 'error', content: outcome.message };
        return;
      }
      yield { type: 'text', content: outcome };
    },
  } as unknown as Router;
  return { router, calls };
}

describe('Gateway compaction (#1.2, #1.4) & context prompt (#6.5)', () => {
  const savedEnv = {
    COMPACTION_ENABLED: process.env.COMPACTION_ENABLED,
    COMPACTION_THRESHOLD: process.env.COMPACTION_THRESHOLD,
    COMPACTION_TAIL_TURNS: process.env.COMPACTION_TAIL_TURNS,
    COMPACTION_MODEL: process.env.COMPACTION_MODEL,
    COMPACTION_REASONING_EFFORT: process.env.COMPACTION_REASONING_EFFORT,
  };
  const savedProviders = [...config.providers];
  const savedPriority = [...config.providerPriority];
  const savedCompactionEnabled = modelResolver.compactionEnabled;
  const savedCompactionThreshold = modelResolver.compactionThreshold;
  const savedCompactionTailTurns = modelResolver.compactionTailTurns;
  const savedCompactionModel = modelResolver.compactionModel;
  const savedCompactionEffort = modelResolver.compactionReasoningEffort;

  beforeEach(() => {
    clearContextWindows();
    delete process.env.COMPACTION_ENABLED;
    delete process.env.COMPACTION_THRESHOLD;
    delete process.env.COMPACTION_TAIL_TURNS;
    delete process.env.COMPACTION_MODEL;
    delete process.env.COMPACTION_REASONING_EFFORT;
    modelResolver.compactionEnabled = true;
    modelResolver.compactionThreshold = 0.8;
    modelResolver.compactionTailTurns = 2;
    modelResolver.compactionModel = '';
    modelResolver.compactionReasoningEffort = 'inherit';
    config.providers = [
      { id: 'openai', priority: 0, apiKey: 'test-key-123456', enabled: true },
    ];
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    config.providers = [...savedProviders];
    config.providerPriority = [...savedPriority];
    modelResolver.compactionEnabled = savedCompactionEnabled;
    modelResolver.compactionThreshold = savedCompactionThreshold;
    modelResolver.compactionTailTurns = savedCompactionTailTurns;
    modelResolver.compactionModel = savedCompactionModel;
    modelResolver.compactionReasoningEffort = savedCompactionEffort;
    clearContextWindows();
  });

  it('labels tool messages as [Tool] rather than [Assistant] in buildSummarizationPrompt', () => {
    const prompt = buildSummarizationPrompt([
      { role: 'user', content: 'List files' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_dir', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: '["a.ts","b.ts"]' },
    ]);
    assert.match(prompt, /\[User\]: List files/);
    assert.match(prompt, /\[Assistant\]: /);
    assert.match(prompt, /\[Tool\]: \["a\.ts","b\.ts"\]/);
    assert.doesNotMatch(prompt, /\[Assistant\]: \["a\.ts","b\.ts"\]/);
  });

  it('chunks 500k history progressively so every summarization prompt fits inside a 200k target model', async () => {
    setContextWindow('target-200k', 200_000);
    // 10 turns * ~48k tokens each = ~480k tokens
    const messages: OpenAIMessage[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: 'user', content: `Turn ${i} user: ` + 'u'.repeat(96_000) });
      messages.push({ role: 'assistant', content: `Turn ${i} assistant: ` + 'a'.repeat(96_000) });
    }
    messages.push({ role: 'user', content: 'Final question on 200k model' });

    const { router, calls } = createMockRouter((_call, idx) => `Rolling summary step ${idx + 1}`);
    const mapped: MappedRequest = { system: 'System prompt', messages };
    const result = await compactIfNeeded(mapped, 'target-200k', router);

    assert.ok(calls.length >= 2, `expected multi-chunk summarization, got ${calls.length} call(s)`);
    for (const call of calls) {
      const promptTokens = estimateMessageTokens(call.messages);
      assert.ok(
        promptTokens < 200_000,
        `summarization chunk exceeded 200k window: ${promptTokens} tokens`,
      );
    }
    // Second chunk should include rolling summary from first chunk
    assert.match(String(calls[1].messages[0].content), /Rolling summary step 1/);
    // Final compacted request must fit comfortably inside 200k
    const finalTotal = estimateSystemTokens(result.system || '') + estimateMessageTokens(result.messages);
    assert.ok(finalTotal <= 200_000, `compacted request exceeded 200k: ${finalTotal}`);
    assert.ok(String(result.messages[0].content).includes('[Context compacted]'));
  });

  it('does not bypass compaction when messages.length <= tailTurns * 2 overflows contextWindow', async () => {
    setContextWindow('target-200k', 200_000);
    // Case A: 4 messages (<= tailTurns * 2 = 4) totaling ~315k tokens
    const shortToolChat: OpenAIMessage[] = [
      { role: 'user', content: 'Inspect repo ' + 'x'.repeat(40_000) },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'view_file', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'log '.repeat(300_000) },
      { role: 'user', content: 'What failed?' },
    ];
    const { router, calls } = createMockRouter(() => 'Summary of repo inspection');
    const compactedA = await compactIfNeeded({ messages: shortToolChat }, 'target-200k', router);
    assert.ok(calls.length >= 1, 'should summarize earlier atomic groups instead of returning uncompacted');
    assert.ok(estimateMessageTokens(compactedA.messages) <= 200_000);

    // Case B: single oversized user message (500k tokens)
    const singleHuge: OpenAIMessage[] = [
      { role: 'user', content: 'HEAD_MARKER ' + 'z'.repeat(2_000_000) + ' TAIL_MARKER' },
    ];
    const compactedB = await compactIfNeeded({ messages: singleHuge }, 'target-200k', router);
    const tokensB = estimateMessageTokens(compactedB.messages);
    assert.ok(tokensB <= 200_000, `single huge message not compacted: ${tokensB}`);
    assert.ok(String(compactedB.messages[0].content).includes('HEAD_MARKER'));
    assert.ok(String(compactedB.messages[0].content).includes('TAIL_MARKER'));
  });

  it('enforces hard post-compaction token budget including system and tools while preserving tool groups', async () => {
    setContextWindow('small-10k', 10_000);
    const system = 's'.repeat(4_000); // 1000 tokens
    const tools = {
      big_tool: { description: 'd'.repeat(4_000), parameters: { type: 'object' } },
    }; // ~1000 tokens
    const messages: OpenAIMessage[] = [
      { role: 'user', content: 'old prompt ' + 'a'.repeat(16_000) },
      { role: 'assistant', content: 'old reply ' + 'b'.repeat(16_000) },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_keep', type: 'function', function: { name: 'big_tool', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_keep', content: 'TOOL_START ' + 't'.repeat(80_000) + ' TOOL_END' },
    ];

    // Even when LLM summarization fails, fallback must still fit inside 10k!
    const { router } = createMockRouter(() => new Error('upstream unavailable'));
    const result = await compactIfNeeded({ system, tools, messages }, 'small-10k', router);

    const total = estimateSystemTokens(result.system || '')
      + estimateToolTokens(result.tools as Record<string, unknown>)
      + estimateMessageTokens(result.messages);
    assert.ok(total <= 10_000, `post-compaction total ${total} exceeded 10000`);

    // Verify tool call/result pairing is preserved (no orphan tool message)
    const toolIdx = result.messages.findIndex(m => m.role === 'tool');
    if (toolIdx !== -1) {
      assert.ok(toolIdx > 0 && result.messages[toolIdx - 1].role === 'assistant' && result.messages[toolIdx - 1].tool_calls?.length);
    }
  });

  it('merges summary into leading preserved user message to avoid consecutive user roles', async () => {
    setContextWindow('win-4k', 4_000);
    modelResolver.compactionTailTurns = 1;
    // 4 messages: [U0, A0, U1, A1] -> preserveCount=2 -> toPreserve = [U1, A1] (starts with user!)
    const messages: OpenAIMessage[] = [
      { role: 'user', content: 'earlier ' + 'x'.repeat(14_000) },
      { role: 'assistant', content: 'old reply' },
      { role: 'user', content: 'latest user question' },
      { role: 'assistant', content: 'latest assistant reply' },
    ];
    const { router } = createMockRouter(() => 'Concise summary');
    const result = await compactIfNeeded({ messages }, 'win-4k', router);

    // Must never produce two consecutive user messages
    for (let i = 1; i < result.messages.length; i++) {
      assert.notEqual(
        result.messages[i - 1].role === 'user' && result.messages[i].role === 'user',
        true,
        `found consecutive user messages at index ${i - 1} and ${i}`,
      );
    }
    assert.equal(result.messages[0].role, 'user');
    assert.ok(String(result.messages[0].content).includes('[Context compacted]'));
    assert.ok(String(result.messages[0].content).includes('Concise summary'));
    assert.ok(String(result.messages[0].content).includes('latest user question'));
    assert.equal(result.messages[1].role, 'assistant');
  });

  it('uses enabled providers sorted by priority (including local providers and excluding disabled ones)', async () => {
    setContextWindow('win-4k', 4_000);
    modelResolver.compactionTailTurns = 1;
    config.providerPriority = ['disabled-cloud', 'openrouter'];
    config.providers = [
      { id: 'disabled-cloud', priority: 0, enabled: false },
      { id: 'ollama', priority: 2, baseUrl: 'http://127.0.0.1:11434/v1', enabled: true },
      { id: 'openrouter', priority: 1, apiKey: 'test-key-123456', enabled: true },
      { id: 'lmstudio', priority: 3, baseUrl: 'http://127.0.0.1:1234/v1', enabled: true },
    ];

    const messages: OpenAIMessage[] = [
      { role: 'user', content: 'history ' + 'h'.repeat(14_000) },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'next' },
      { role: 'assistant', content: 'ok' },
    ];
    const { router, calls } = createMockRouter(() => 'Local-aware summary');
    await compactIfNeeded({ messages }, 'win-4k', router);

    assert.ok(calls.length >= 1);
    for (const call of calls) {
      assert.deepEqual(call.providerIds, ['openrouter', 'ollama', 'lmstudio']);
    }
  });

  it('validates and clamps invalid compaction env vars instead of crashing or disabling compaction', () => {
    process.env.COMPACTION_THRESHOLD = 'not-a-number';
    process.env.COMPACTION_TAIL_TURNS = 'abc';
    process.env.COMPACTION_REASONING_EFFORT = 'invalid-effort';
    let cfg = getCompactionConfig();
    assert.equal(cfg.threshold, 0.8);
    assert.equal(cfg.tailTurns, 2);
    assert.equal(cfg.effort, 'inherit');

    process.env.COMPACTION_THRESHOLD = '-0.5';
    process.env.COMPACTION_TAIL_TURNS = '-4';
    cfg = getCompactionConfig();
    assert.ok(cfg.threshold > 0 && cfg.threshold < 1);
    assert.equal(cfg.tailTurns, 1);

    process.env.COMPACTION_THRESHOLD = '2.5';
    process.env.COMPACTION_TAIL_TURNS = '0';
    cfg = getCompactionConfig();
    assert.ok(cfg.threshold > 0 && cfg.threshold < 1);
    assert.equal(cfg.tailTurns, 1);
  });

  it('bounds large base64 image parts and never returns an over-budget message list', async () => {
    setContextWindow('media-10k', 10_000);
    modelResolver.compactionTailTurns = 1;
    const hugeBase64 = 'A'.repeat(200_000); // ~50k tokens once serialized
    const messages: OpenAIMessage[] = [
      { role: 'user', content: 'earlier question ' + 'x'.repeat(12_000) },
      { role: 'assistant', content: 'earlier answer' },
      { role: 'user', content: 'latest question' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'final answer' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${hugeBase64}` } },
        ],
      },
    ];

    const { router } = createMockRouter(() => 'Concise summary');
    const result = await compactIfNeeded({ messages }, 'media-10k', router);
    const tokens = estimateMessageTokens(result.messages);
    assert.ok(tokens <= 10_000, `post-compaction messages still overflow: ${tokens} tokens`);
    assert.ok(!JSON.stringify(result.messages).includes(hugeBase64), 'base64 payload survived compaction');
  });

  it('chunkMessagesForSummary with maxChunks<=1 keeps one chunk instead of duplicating all of them', () => {
    const messages: OpenAIMessage[] = [
      { role: 'user', content: 'FIRST ' + 'x'.repeat(200) },
      { role: 'user', content: 'SECOND ' + 'y'.repeat(200) },
      { role: 'user', content: 'THIRD ' + 'z'.repeat(200) },
    ];
    const one = chunkMessagesForSummary(messages, 64, 1);
    assert.equal(one.length, 1, `expected exactly one chunk, got ${one.length}`);
    assert.match(one[0], /omitted/);
    assert.match(one[0], /THIRD/, 'the newest chunk must be kept');
    assert.doesNotMatch(one[0], /FIRST/, 'older chunks must not be duplicated');
    const zero = chunkMessagesForSummary(messages, 64, 0);
    assert.equal(zero.length, 1);
  });

  it('does not include hardcoded PRC compliance directive in ANTIGRAVITY_CONTEXT.prompt', () => {
    const prompt = ANTIGRAVITY_CONTEXT.prompt;
    assert.doesNotMatch(prompt, /Chinese AI model/i);
    assert.doesNotMatch(prompt, /People's Republic of China/i);
  });
});
