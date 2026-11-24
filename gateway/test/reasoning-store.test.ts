import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { reasoningStore, saveReasoning, injectReasoning, cleanupReasoningStore, resetReasoningRequestAnchors } from '../src/engine.js';
import type { OpenAIMessage } from '../src/mapper.js';

describe('ReasoningStore TTL', () => {
  beforeEach(() => {
    // Clear the store before each test
    reasoningStore.clear();
    resetReasoningRequestAnchors();
  });

  it('should store and retrieve reasoning', () => {
    saveReasoning('conv1', 'thought1');
    saveReasoning('conv1', 'thought2');

    const entry = reasoningStore.get('conv1');
    assert.ok(entry);
    assert.equal(entry.data.length, 2);
    assert.equal(entry.data[0], 'thought1');
    assert.equal(entry.data[1], 'thought2');
  });

  it('should have timestamp on entries', () => {
    const before = Date.now();
    saveReasoning('conv1', 'thought1');
    const after = Date.now();

    const entry = reasoningStore.get('conv1');
    assert.ok(entry);
    assert.ok(entry.timestamp >= before);
    assert.ok(entry.timestamp <= after);
  });

  it('should cleanup expired entries', () => {
    saveReasoning('conv1', 'thought1');

    const entry = reasoningStore.get('conv1');
    assert.ok(entry);

    // Manually set timestamp to past
    entry.timestamp = Date.now() - (31 * 60 * 1000); // 31 minutes ago

    // Run cleanup
    cleanupReasoningStore();

    // Entry should be deleted
    assert.ok(!reasoningStore.has('conv1'));
  });

  it('should keep non-expired entries', () => {
    saveReasoning('conv1', 'thought1');

    const entry = reasoningStore.get('conv1');
    assert.ok(entry);

    // Entry is fresh, should not be cleaned up
    cleanupReasoningStore();

    assert.ok(reasoningStore.has('conv1'));
  });

  it('should enforce max size by deleting oldest entries', () => {
    // Add entries with varying timestamps
    for (let i = 0; i < 10; i++) {
      saveReasoning(`conv${i}`, `thought${i}`);
    }

    // Manually set some entries to be older
    const entry0 = reasoningStore.get('conv0');
    const entry1 = reasoningStore.get('conv1');
    if (entry0) entry0.timestamp = Date.now() - 1000;
    if (entry1) entry1.timestamp = Date.now() - 2000;

    // Run cleanup - should delete oldest entries
    cleanupReasoningStore();

    // Should still have entries (not all expired yet)
    assert.ok(reasoningStore.size > 0);
  });
});

describe('injectReasoning', () => {
  beforeEach(() => {
    reasoningStore.clear();
    resetReasoningRequestAnchors();
  });

  it('replaces fallback answer text with a matched stored thought after a JSON round-trip', () => {
    const first: OpenAIMessage[] = [
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'ANSWER_TEXT' },
    ];
    injectReasoning(first, 'conv-provenance');
    assert.equal(first[1].reasoning_content, 'ANSWER_TEXT', 'fallback placeholder was expected');

    // The client echoes reasoning_content as JSON, so the symbol marker is gone.
    const echoed = JSON.parse(JSON.stringify(first)) as typeof first;
    saveReasoning('conv-provenance', 'REAL_THOUGHT');

    const next = [...echoed, { role: 'user' as const, content: 'Q2' }];
    injectReasoning(next, 'conv-provenance');
    assert.equal(next[1].reasoning_content, 'REAL_THOUGHT');
  });

  it('never overwrites genuine client-supplied reasoning_content with a stored thought', () => {
    const first = [
      { role: 'user' as const, content: 'Q1' },
      { role: 'assistant' as const, content: 'ANSWER', reasoning_content: 'CLIENT_THOUGHT' },
    ];
    injectReasoning(first, 'conv-genuine');
    saveReasoning('conv-genuine', 'STORED_THOUGHT');

    const next = [
      ...JSON.parse(JSON.stringify(first)) as typeof first,
      { role: 'user' as const, content: 'Q2' },
    ];
    injectReasoning(next, 'conv-genuine');
    assert.equal(next[1].reasoning_content, 'CLIENT_THOUGHT');
  });

  it('does not lose a pending anchor when a second request observes the same history', async () => {
    const context = new AsyncLocalStorage<number>();
    const runRequest = (assistantCount: number, thought: string) => context.run(assistantCount, async () => {
      const messages = Array.from({ length: assistantCount }, (_, i) => ({
        role: 'assistant' as const,
        content: `answer ${i}`,
      }));
      injectReasoning(messages, 'conv-concurrent');
      await new Promise(resolve => setTimeout(resolve, 1)); // interleave the two requests
      saveReasoning('conv-concurrent', thought);
    });

    await Promise.all([runRequest(2, 'THOUGHT_A'), runRequest(2, 'THOUGHT_B')]);
    const indices = (reasoningStore.get('conv-concurrent')?.turns || []).map(t => t.asstIndex);
    assert.deepEqual(indices, [2, 2], 'both saves must anchor to the observed history');
  });

  it('keeps request-scoped anchors separate for two concurrent requests', async () => {
    const runRequest = async (requestId: string, count: number, thought: string) => {
      const messages = Array.from({ length: count }, (_, i) => ({ role: 'assistant' as const, content: `answer ${i}` }));
      injectReasoning(messages, 'conv-scoped', requestId);
      await new Promise(resolve => setTimeout(resolve, 1));
      saveReasoning('conv-scoped', thought, requestId);
    };
    await Promise.all([runRequest('req-a', 2, 'THOUGHT_A'), runRequest('req-b', 3, 'THOUGHT_B')]);
    const indices = (reasoningStore.get('conv-scoped')?.turns || []).map(t => t.asstIndex).sort();
    assert.deepEqual(indices, [2, 3], 'each request must consume its own anchor');
  });

  it('should inject reasoning into messages', () => {
    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ];

    saveReasoning('conv1', 'thinking about greeting');

    injectReasoning(messages, 'conv1');

    assert.equal(messages[1].reasoning_content, 'thinking about greeting');
  });

  it('should handle no stored reasoning', () => {
    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ];

    injectReasoning(messages, 'conv1');

    // Should set fallback reasoning
    assert.ok(messages[1].reasoning_content);
  });

  it('does not shift earlier thoughts onto an intermediate assistant turn without thoughts', () => {
    // Turn 1: no assistant messages yet
    injectReasoning([{ role: 'user', content: 'Q1' }], 'conv-align');
    saveReasoning('conv-align', 'T1');

    // Turn 2: A1 receives T1; Turn 2 responds without a thought (no saveReasoning)
    const turn2 = [
      { role: 'user' as const, content: 'Q1' },
      { role: 'assistant' as const, content: 'A1' },
      { role: 'user' as const, content: 'Q2' },
    ];
    injectReasoning(turn2, 'conv-align');
    assert.equal(turn2[1].reasoning_content, 'T1');

    // Turn 3: A1 must keep T1, and A2 must NOT receive T1
    const turn3 = [
      { role: 'user' as const, content: 'Q1' },
      { role: 'assistant' as const, content: 'A1' },
      { role: 'user' as const, content: 'Q2' },
      { role: 'assistant' as const, content: 'A2' },
      { role: 'user' as const, content: 'Q3' },
    ];
    injectReasoning(turn3, 'conv-align');
    assert.equal(turn3[1].reasoning_content, 'T1');
    assert.notEqual(turn3[3].reasoning_content, 'T1');
    assert.equal(turn3[3].reasoning_content, 'A2');
    saveReasoning('conv-align', 'T3');

    // Turn 4: A1->T1, A2->fallback, A3->T3
    const turn4 = [
      { role: 'user' as const, content: 'Q1' },
      { role: 'assistant' as const, content: 'A1' },
      { role: 'user' as const, content: 'Q2' },
      { role: 'assistant' as const, content: 'A2' },
      { role: 'user' as const, content: 'Q3' },
      { role: 'assistant' as const, content: 'A3' },
      { role: 'user' as const, content: 'Q4' },
    ];
    injectReasoning(turn4, 'conv-align');
    assert.equal(turn4[1].reasoning_content, 'T1');
    assert.equal(turn4[3].reasoning_content, 'A2');
    assert.equal(turn4[5].reasoning_content, 'T3');
  });

  it('never leaves bogus empty-string reasoning_content on tool-only or empty assistant turns', () => {
    const messages = [
      { role: 'user' as const, content: 'Run tool' },
      {
        role: 'assistant' as const,
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function' as const, function: { name: 'list_dir', arguments: '{}' } }],
      },
      { role: 'tool' as const, tool_call_id: 'call_1', content: '[]' },
      {
        role: 'assistant' as const,
        content: null,
        tool_calls: [{ id: 'call_2', type: 'function' as const, function: { name: 'view_file', arguments: '{}' } }],
      },
      { role: 'tool' as const, tool_call_id: 'call_2', content: 'ok' },
      { role: 'assistant' as const, content: '' },
    ];

    injectReasoning(messages, 'conv-tools');

    // Tool-call turns get a non-empty placeholder for DeepSeek/OpenAI replay, never ""
    assert.equal(messages[1].reasoning_content, ' ');
    assert.equal(messages[3].reasoning_content, ' ');
    // Empty non-tool assistant turn does not get bogus ""
    assert.equal(messages[5].reasoning_content, undefined);
  });

  it('preserves thought alignment after compaction trims earlier turns', () => {
    injectReasoning([{ role: 'user', content: 'Q1' }], 'conv-compact');
    saveReasoning('conv-compact', 'T1');

    injectReasoning([
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'Q2' },
    ], 'conv-compact');
    saveReasoning('conv-compact', 'T2');

    // Observe A2 so it gets fingerprinted, then Turn 3 responds with T3
    injectReasoning([
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'Q2' },
      { role: 'assistant', content: 'A2' },
      { role: 'user', content: 'Q3' },
    ], 'conv-compact');
    saveReasoning('conv-compact', 'T3');

    // Compaction drops Q1/A1, keeping A2 and A3
    const compacted = [
      { role: 'user' as const, content: '[Context compacted]\nSummary' },
      { role: 'assistant' as const, content: 'A2' },
      { role: 'user' as const, content: 'Q3' },
      { role: 'assistant' as const, content: 'A3' },
      { role: 'user' as const, content: 'Q4' },
    ];
    injectReasoning(compacted, 'conv-compact');
    assert.equal(compacted[1].reasoning_content, 'T2');
    assert.equal(compacted[3].reasoning_content, 'T3');
  });
});
