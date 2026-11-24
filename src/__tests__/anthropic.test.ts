import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as shared from '../proxy/shared';
import {
  mapGeminiToAnthropic,
  mapAnthropicToGemini,
  mapAnthropicChunkToGemini,
  clearAnthropicThinkingCache,
} from '../proxy/translators/anthropic';

const toolArgumentCases: Array<{
  name: string;
  args: Record<string, unknown>;
  schemas?: ReadonlyMap<string, unknown>;
}> = [
  {
    name: 'write_to_file',
    args: {
      TargetFile: '/workspace/example.txt',
      CodeContent: 'Hello.\nKeep /literal/path unchanged.',
      Overwrite: false,
    },
  },
  {
    name: 'mcp__files__write',
    args: { path: '/workspace/example.txt', content: 'Hello.', metadata: { file: 'notes.md' } },
  },
  { name: 'send_note', args: { message: 'This is a sentence.', priority: 'normal' } },
  {
    name: 'write_file',
    args: { path: '/workspace/example.txt', content: 'A declared lowercase path must stay lowercase.' },
    schemas: new Map([
      [
        'write_file',
        {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
          additionalProperties: false,
        },
      ],
    ]),
  },
];

// Mock detectModelCapabilitiesByName to avoid importing the full module chain
vi.mock('../proxy/modelUtils', () => ({
  detectModelCapabilitiesByName: vi.fn((name: string) => ({
    isThinkingModel: name.includes('opus') || name.includes('thinking'),
    supportsToolCalls: true,
    supportsReasoning: name.includes('opus') || name.includes('thinking') || name.includes('deepseek'),
  })),
}));

// Reset shared state before each test
beforeEach(() => {
  shared.modelToolCallIds.clear();
  shared.modelReasoningContent.clear();
  shared.activeStreamContexts.clear();
  shared.translatedToolCalls.clear();
  shared.stateTimestamps.toolCallIds.clear();
  shared.stateTimestamps.reasoning.clear();
  shared.stateTimestamps.streamCtx.clear();
  shared.stateTimestamps.translatedCalls.clear();
  clearAnthropicThinkingCache();
});

// ─── mapGeminiToAnthropic ──────────────────────────────────────────────────

describe('mapGeminiToAnthropic', () => {
  it.each(['parameters', 'parametersJsonSchema'] as const)(
    'converts serialized minLength in %s before sending an agent tool to the provider',
    (schemaField) => {
      const schema = {
        type: 'OBJECT',
        properties: { command: { type: 'STRING', minLength: '1' } },
        required: ['command'],
        additionalProperties: false,
      };
      const original = structuredClone(schema);
      const result = mapGeminiToAnthropic(
        { contents: [], tools: [{ functionDeclarations: [{ name: 'run_command', [schemaField]: schema }] }] },
        'claude-agent-model',
      );
      expect(result.tools![0].input_schema).toEqual({
        ...schema,
        type: 'object',
        properties: { command: { type: 'string', minLength: 1 } },
      });
      expect(schema).toEqual(original);
    },
  );

  it('preserves parametersJsonSchema properties, references, and additional-property constraints', () => {
    const parametersJsonSchema = {
      type: 'object',
      $defs: { filePath: { type: 'string', minLength: 1 } },
      properties: {
        TargetFile: { $ref: '#/$defs/filePath' },
        CodeContent: { type: 'string' },
        Overwrite: { type: 'boolean' },
      },
      required: ['TargetFile', 'CodeContent', 'Overwrite'],
      additionalProperties: false,
    };
    const original = structuredClone(parametersJsonSchema);
    const result = mapGeminiToAnthropic(
      {
        contents: [],
        tools: [{ functionDeclarations: [{ name: 'write_to_file', parametersJsonSchema }] }],
      },
      'external-model',
    );
    expect(result.tools![0].input_schema).toEqual(original);
    expect(result.tools![0].input_schema).not.toBe(parametersJsonSchema);
    expect(parametersJsonSchema).toEqual(original);
  });

  it('should convert systemInstruction to system parameter', () => {
    const body = {
      systemInstruction: { parts: [{ text: 'You are helpful.' }] },
      contents: [],
    };
    const result = mapGeminiToAnthropic(body, 'claude-3-5-sonnet-latest');
    expect(result.system).toBe('You are helpful.');
  });

  it('should convert user messages', () => {
    const body = {
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
    };
    const result = mapGeminiToAnthropic(body, 'claude-3-5-sonnet-latest');
    expect(result.messages[0]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('should convert model role to assistant', () => {
    const body = {
      contents: [{ role: 'model', parts: [{ text: 'Hi!' }] }],
    };
    const result = mapGeminiToAnthropic(body, 'claude-3-5-sonnet-latest');
    expect(result.messages[0].role).toBe('assistant');
    expect(result.messages[0].content).toBe('Hi!');
  });

  it('should convert functionCall to tool_use content blocks', () => {
    const body = {
      contents: [
        {
          role: 'model',
          parts: [{ text: 'Before call' }, { functionCall: { name: 'search', args: { query: 'test' }, id: 'call_1' } }],
        },
      ],
    };
    const result = mapGeminiToAnthropic(body, 'claude-3-5-sonnet-latest');
    expect(result.messages[0].role).toBe('assistant');
    expect(Array.isArray(result.messages[0].content)).toBe(true);
    const blocks = result.messages[0].content as unknown as Array<Record<string, unknown>>;
    expect(blocks.some((b) => b.type === 'tool_use')).toBe(true);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
  });

  it('should convert functionResponse to tool_result content blocks', () => {
    const body = {
      contents: [
        {
          parts: [
            {
              functionResponse: { name: 'search', response: 'data', id: 'call_1' },
            },
          ],
        },
      ],
    };
    const result = mapGeminiToAnthropic(body, 'claude-3-5-sonnet-latest');
    expect(result.messages[0].role).toBe('user');
    expect(Array.isArray(result.messages[0].content)).toBe(true);
    const blocks = result.messages[0].content as unknown as Array<Record<string, unknown>>;
    expect(blocks.some((b) => b.type === 'tool_result')).toBe(true);
  });

  it.each([false, true])('keeps tool failure text after matching tool results (split items: %s)', (splitItems) => {
    const failure = 'WRITE_ERROR: invalid tool call: additional properties AbsolutePath not allowed';
    const body = {
      contents: [
        {
          role: 'model',
          parts: [
            { functionCall: { name: 'write_to_file', id: 'write-1', args: { TargetFile: '/tmp/first.txt' } } },
            { functionCall: { name: 'write_to_file', id: 'write-2', args: { TargetFile: '/tmp/second.txt' } } },
          ],
        },
        {
          role: 'user',
          parts: [
            { text: failure },
            { functionResponse: { name: 'write_to_file', id: 'write-2', response: {} } },
            { text: 'Internal note', thought: true },
            { text: 'Correct the arguments before retrying.' },
            { functionResponse: { name: 'write_to_file', id: 'write-1', response: { error: 'Permission denied' } } },
          ],
        },
      ],
    };
    if (splitItems) {
      const results = body.contents.pop()!;
      body.contents.push(
        { ...results, parts: results.parts.slice(0, 2) },
        { ...results, parts: results.parts.slice(2) },
      );
    }
    const original = structuredClone(body);
    const result = mapGeminiToAnthropic(body, 'external-model');
    expect(result.messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'write-2', content: '{}' },
        { type: 'tool_result', tool_use_id: 'write-1', content: '{"error":"Permission denied"}' },
        { type: 'text', text: failure },
        { type: 'text', text: 'Correct the arguments before retrying.' },
      ],
    });
    expect(result.messages[0].content).toMatchObject([{ id: 'write-1' }, { id: 'write-2' }]);
    expect(body).toEqual(original);
  });

  it('should set max_tokens from generationConfig', () => {
    const body = {
      contents: [],
      generationConfig: { maxOutputTokens: 8000 },
    };
    const result = mapGeminiToAnthropic(body, 'claude-3-5-sonnet-latest');
    expect(result.max_tokens).toBe(8000);
  });

  it('should use default max_tokens when not specified', () => {
    const body = { contents: [] };
    const result = mapGeminiToAnthropic(body, 'claude-3-5-sonnet-latest');
    expect(result.max_tokens).toBe(16000);
  });

  it('should not set temperature for thinking models', () => {
    const body = {
      contents: [],
      generationConfig: { temperature: 0.7 },
    };
    const result = mapGeminiToAnthropic(body, 'claude-3-5-sonnet-latest');
    // Claude 3.5 Sonnet is NOT a thinking model, so temperature should be set
    expect(result.temperature).toBe(0.7);
  });

  it('should convert Gemini tools to Anthropic format', () => {
    const body = {
      contents: [],
      tools: [
        {
          functionDeclarations: [
            {
              name: 'get_weather',
              description: 'Get weather',
              parameters: { type: 'OBJECT', properties: { city: { type: 'STRING' } } },
            },
          ],
        },
      ],
    };
    const result = mapGeminiToAnthropic(body, 'claude-3-5-sonnet-latest');
    expect(result.tools).toHaveLength(1);
    expect(result.tools![0].name).toBe('get_weather');
    expect(result.tools![0].input_schema).toBeDefined();
  });

  it('never leaks unsigned thought parts as visible assistant text (plain or tool-call turns)', () => {
    const body = {
      contents: [
        { role: 'user', parts: [{ text: 'Solve this' }] },
        {
          role: 'model',
          parts: [
            { text: 'Private chain of thought 1', thought: true },
            { functionCall: { name: 'search', id: 'call_1', args: { q: 'test' } } },
          ],
        },
        {
          role: 'user',
          parts: [{ functionResponse: { name: 'search', id: 'call_1', response: { ok: true } } }],
        },
        {
          role: 'model',
          parts: [
            { text: 'Private chain of thought 2', thought: true },
            { text: 'Final visible answer' },
          ],
        },
      ],
    };
    const result = mapGeminiToAnthropic(body, 'claude-3-5-sonnet-latest');
    expect(result.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'test' } }],
    });
    expect(result.messages[3]).toEqual({
      role: 'assistant',
      content: 'Final visible answer',
    });
    expect(JSON.stringify(result.messages)).not.toContain('Private chain of thought');
  });

  it('reconstructs signed thinking and redacted_thinking blocks inline and omits them when thinking is disabled', () => {
    const body = {
      contents: [
        { role: 'user', parts: [{ text: 'Check file' }] },
        {
          role: 'model',
          parts: [
            { text: 'Step 1. ', thought: true },
            { text: 'Step 2.', thought: true },
            { text: '', thought: true, thoughtSignature: 'sig_valid_123' },
            { thought: true, thoughtSignature: 'redacted_blob_456' },
            { text: 'Calling tool' },
            { functionCall: { name: 'read_file', id: 'toolu_1', args: { path: 'a.ts' } } },
          ],
        },
      ],
    };

    const enabled = mapGeminiToAnthropic(body, 'claude-opus-4');
    expect(enabled.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Step 1. Step 2.', signature: 'sig_valid_123' },
        { type: 'redacted_thinking', data: 'redacted_blob_456' },
        { type: 'text', text: 'Calling tool' },
        { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } },
      ],
    });

    const disabled = mapGeminiToAnthropic(
      { ...body, generationConfig: { thinkingConfig: { thinkingBudget: 0 } } },
      'claude-opus-4',
    );
    expect(disabled.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Calling tool' },
        { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } },
      ],
    });
  });

  it('replays signed thinking and redacted_thinking from cache when Turn 2 strips thought parts after tool_use', () => {
    // Turn 1: non-streaming response with thinking + signature + redacted_thinking + tool_use
    const turn1 = mapAnthropicToGemini(
      {
        content: [
          { type: 'thinking', thinking: 'Checking disk...', signature: 'sig_turn1' },
          { type: 'redacted_thinking', data: 'redacted_turn1' },
          { type: 'tool_use', id: 'toolu_turn1', name: 'search', input: { query: 'a.ts' } },
        ],
        stop_reason: 'tool_use',
      },
      'claude-opus-4',
    );
    expect(turn1.candidates[0].content.parts).toEqual([
      { text: 'Checking disk...', thought: true, thoughtSignature: 'sig_turn1' },
      { thought: true, thoughtSignature: 'redacted_turn1' },
      { functionCall: { name: 'search', args: { query: 'a.ts' }, id: 'toolu_turn1' } },
    ]);

    // Turn 2: IDE strips thought parts and replays only functionCall + functionResponse
    const turn2Req = mapGeminiToAnthropic(
      {
        contents: [
          { role: 'user', parts: [{ text: 'Search a.ts' }] },
          {
            role: 'model',
            parts: [{ functionCall: { name: 'search', id: 'toolu_turn1', args: { query: 'a.ts' } } }],
          },
          {
            role: 'user',
            parts: [{ functionResponse: { name: 'search', id: 'toolu_turn1', response: { content: 'ok' } } }],
          },
        ],
      },
      'claude-opus-4',
    );
    expect(turn2Req.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Checking disk...', signature: 'sig_turn1' },
        { type: 'redacted_thinking', data: 'redacted_turn1' },
        { type: 'tool_use', id: 'toolu_turn1', name: 'search', input: { query: 'a.ts' } },
      ],
    });
  });

  it('does not replay another conversation\'s signed thinking blocks', () => {
    mapAnthropicToGemini(
      {
        content: [
          { type: 'thinking', thinking: 'Private thought A', signature: 'sig_scope_a' },
          { type: 'tool_use', id: 'toolu_shared_id', name: 'search', input: { query: 'a.ts' } },
        ],
        stop_reason: 'tool_use',
      },
      'conversation-A',
    );
    const turn2 = {
      contents: [
        { role: 'user', parts: [{ text: 'Search a.ts' }] },
        { role: 'model', parts: [{ functionCall: { name: 'search', id: 'toolu_shared_id', args: { query: 'a.ts' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'search', id: 'toolu_shared_id', response: {} } }] },
      ],
    };
    const sameScope = mapGeminiToAnthropic(turn2, 'claude-opus-4', 'conversation-A');
    expect((sameScope.messages[1].content as unknown as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: 'thinking', signature: 'sig_scope_a',
    });
    const otherScope = mapGeminiToAnthropic(turn2, 'claude-opus-4', 'conversation-B');
    expect((otherScope.messages[1].content as unknown as Array<Record<string, unknown>>).some((b) => b.type === 'thinking')).toBe(false);
  });

  it('merges consecutive same-role messages (including tool_result followed by user turn) and omits empty turns', () => {
    const body = {
      contents: [
        { role: 'user', parts: [{ text: 'First prompt' }] },
        { role: 'user', parts: [{ text: '' }] },
        { role: 'user', parts: [{ text: 'Second prompt' }] },
        {
          role: 'model',
          parts: [{ functionCall: { name: 'search', id: 'call_merge', args: { q: 'x' } } }],
        },
        {
          role: 'user',
          parts: [{ functionResponse: { name: 'search', id: 'call_merge', response: { found: true } } }],
        },
        { role: 'user', parts: [{ text: 'Follow up after tool result' }] },
        { role: 'model', parts: [{ text: 'Only unsigned thought', thought: true }] },
        { role: 'user', parts: [{ text: 'Another user line' }] },
      ],
    };
    const result = mapGeminiToAnthropic(body, 'claude-3-5-sonnet-latest');
    expect(result.messages).toEqual([
      { role: 'user', content: 'First prompt\nSecond prompt' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_merge', name: 'search', input: { q: 'x' } }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_merge', content: '{"found":true}' },
          { type: 'text', text: 'Follow up after tool result' },
          { type: 'text', text: 'Another user line' },
        ],
      },
    ]);
  });

  it('safely defaults malformed string functionCall args to {} instead of throwing', () => {
    const body = {
      contents: [
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'broken_tool',
                id: 'call_bad_json',
                args: '{invalid json' as unknown as Record<string, unknown>,
              },
            },
          ],
        },
      ],
    };
    const result = mapGeminiToAnthropic(body, 'claude-3-5-sonnet-latest');
    expect(result.messages[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_bad_json', name: 'broken_tool', input: {} }],
    });
  });
});

// ─── mapAnthropicToGemini ──────────────────────────────────────────────────

describe('mapAnthropicToGemini', () => {
  it('keeps valid write_to_file arguments within the schema sent to the provider', () => {
    const args = { TargetFile: '/workspace/example.txt', CodeContent: 'Hello.', Overwrite: false };
    const parameters = {
      type: 'OBJECT',
      properties: { TargetFile: { type: 'STRING' }, CodeContent: { type: 'STRING' }, Overwrite: { type: 'BOOLEAN' } },
      required: ['TargetFile', 'CodeContent', 'Overwrite'],
      additionalProperties: false,
    };
    const request = mapGeminiToAnthropic(
      {
        contents: [],
        tools: [{ functionDeclarations: [{ name: 'write_to_file', parameters }] }],
      },
      'claude-test',
    );
    const sentSchema = request.tools![0].input_schema;
    expect(sentSchema).toMatchObject({
      properties: { TargetFile: { type: 'string' }, CodeContent: { type: 'string' }, Overwrite: { type: 'boolean' } },
      required: parameters.required,
      additionalProperties: false,
    });
    const result = mapAnthropicToGemini(
      {
        content: [{ type: 'tool_use', id: 'write-call', name: 'write_to_file', input: args }],
        stop_reason: 'tool_use',
      },
      'claude-test',
    );
    const call = result.candidates[0].content.parts[0].functionCall!;
    expect(call).toEqual({ name: 'write_to_file', args, id: 'write-call' });
    expect(Object.keys(call.args).sort()).toEqual(Object.keys(sentSchema.properties!).sort());
  });

  it.each(toolArgumentCases)(
    'preserves valid $name arguments without guessing path fields',
    ({ name, args, schemas }) => {
      const result = mapAnthropicToGemini(
        {
          content: [{ type: 'tool_use', id: 'preserved-call', name, input: args }],
          stop_reason: 'tool_use',
        },
        'external-model',
        schemas,
      );
      expect(result.candidates[0].content.parts[0].functionCall).toEqual({ name, args, id: 'preserved-call' });
    },
  );

  it('should convert text content blocks', () => {
    const res = {
      content: [{ type: 'text' as const, text: 'Hello!' }],
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: 'end_turn',
    };
    const result = mapAnthropicToGemini(res, 'claude-3-5-sonnet-latest');
    expect(result.candidates[0].content.parts[0]).toEqual({ text: 'Hello!' });
    expect(result.candidates[0].finishReason).toBe('STOP');
  });

  it('should convert thinking content blocks to thought parts', () => {
    const res = {
      content: [
        { type: 'thinking' as const, thinking: 'reasoning...' },
        { type: 'text' as const, text: 'answer' },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: 'end_turn',
    };
    const result = mapAnthropicToGemini(res, 'claude-opus-4');
    const parts = result.candidates[0].content.parts;
    expect(parts.some((p) => p.text === 'reasoning...' && p.thought)).toBe(true);
    expect(parts.some((p) => p.text === 'answer')).toBe(true);
  });

  it('should convert tool_use blocks to functionCalls', () => {
    const res = {
      content: [{ type: 'tool_use' as const, id: 'toolu_1', name: 'search', input: { query: 'test' } }],
      usage: { input_tokens: 5, output_tokens: 10 },
      stop_reason: 'tool_use',
    };
    const result = mapAnthropicToGemini(res, 'claude-3-5-sonnet-latest');
    expect(result.candidates[0].finishReason).toBe('STOP');
    const fcParts = result.candidates[0].content.parts.filter((p) => p.functionCall);
    expect(fcParts).toHaveLength(1);
    expect(fcParts[0].functionCall!.name).toBe('search');
  });

  it('should handle max_tokens stop reason', () => {
    const res = {
      content: [{ type: 'text' as const, text: 'truncated' }],
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: 'max_tokens',
    };
    const result = mapAnthropicToGemini(res, 'claude-3-5-sonnet-latest');
    expect(result.candidates[0].finishReason).toBe('MAX_TOKENS');
  });

  it('should handle unknown stop reason', () => {
    const res = {
      content: [{ type: 'text' as const, text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'refusal',
    };
    const result = mapAnthropicToGemini(res, 'claude-3-5-sonnet-latest');
    expect(result.candidates[0].finishReason).toBe('OTHER');
  });

  it('should handle empty content', () => {
    const res = {
      content: [],
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: 'end_turn',
    };
    const result = mapAnthropicToGemini(res, 'claude-3-5-sonnet-latest');
    expect(result.candidates[0].content.parts).toEqual([]);
    expect(result.candidates[0].finishReason).toBe('STOP');
  });

  it('should track tool call IDs in modelToolCallIds', () => {
    const res = {
      content: [{ type: 'tool_use' as const, id: 'toolu_abc', name: 'search', input: { query: 'x' } }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'tool_use',
    };
    mapAnthropicToGemini(res, 'claude-3-5-sonnet-latest');
    const tcIds = shared.modelToolCallIds.get('claude-3-5-sonnet-latest');
    expect(tcIds).toBeDefined();
    expect(tcIds!['search']).toBe('toolu_abc');
  });
});

// ─── mapAnthropicChunkToGemini (Streaming SSE) ─────────────────────────────

describe('mapAnthropicChunkToGemini', () => {
  it.each(toolArgumentCases)('preserves fragmented $name input_json_delta arguments', ({ name, args, schemas }) => {
    const streamKey = `preserve-${name}`;
    expect(
      mapAnthropicChunkToGemini(
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'fragmented-call', name, input: {} },
        },
        'external-model',
        streamKey,
        schemas,
      ),
    ).toBeNull();
    const serialized = JSON.stringify(args);
    for (const fragment of [serialized.slice(0, 9), serialized.slice(9, 31), serialized.slice(31)]) {
      expect(
        mapAnthropicChunkToGemini(
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: fragment },
          },
          'external-model',
          streamKey,
          schemas,
        ),
      ).toBeNull();
    }
    const result = mapAnthropicChunkToGemini(
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
      },
      'external-model',
      streamKey,
      schemas,
    );
    expect(result?.finishReason).toBe('STOP');
    expect(result?.content.parts).toEqual([{ functionCall: { name, args, id: 'fragmented-call' } }]);
    expect(shared.activeStreamContexts.has(streamKey)).toBe(false);
  });

  it('should handle content_block_start for tool_use', () => {
    const chunk = {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use' as const, id: 'toolu_1', name: 'search', input: {} },
    };
    const result = mapAnthropicChunkToGemini(chunk, 'claude-3-5-sonnet-latest');
    expect(result).toBeNull();
  });

  it('should emit text_delta as text part', () => {
    const chunk = {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello' },
    };
    const result = mapAnthropicChunkToGemini(chunk, 'claude-3-5-sonnet-latest');
    expect(result).not.toBeNull();
    expect(result!.content.parts[0]).toEqual({ text: 'Hello' });
  });

  it('should emit thinking_delta as thought part', () => {
    const chunk = {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'reasoning...' },
    };
    const result = mapAnthropicChunkToGemini(chunk, 'claude-opus-4');
    expect(result).not.toBeNull();
    expect(result!.content.parts[0]).toEqual({ text: 'reasoning...', thought: true });
  });

  it('should accumulate input_delta for tool arguments', () => {
    // Start a tool_use block
    mapAnthropicChunkToGemini(
      {
        message: { id: 'msg_tool' },
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use' as const, id: 'toolu_x', name: 'run_command', input: {} },
      },
      'claude-3-5-sonnet-latest',
    );

    // Send input delta fragments
    mapAnthropicChunkToGemini(
      {
        message: { id: 'msg_tool' },
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_delta', partial_json: '{"CommandLine"' },
      },
      'claude-3-5-sonnet-latest',
    );
    mapAnthropicChunkToGemini(
      {
        message: { id: 'msg_tool' },
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_delta', partial_json: ':"ls"}' },
      },
      'claude-3-5-sonnet-latest',
    );

    // Message delta with stop_reason tool_use should emit the tool call
    const result = mapAnthropicChunkToGemini(
      {
        message: { id: 'msg_tool' },
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
      },
      'claude-3-5-sonnet-latest',
    );
    expect(result).not.toBeNull();
    expect(result!.finishReason).toBe('STOP');
  });

  it('should handle message_stop', () => {
    // Send some text first
    mapAnthropicChunkToGemini(
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Some text' },
      },
      'claude-3-5-sonnet-latest',
    );

    const result = mapAnthropicChunkToGemini(
      {
        type: 'message_stop',
      },
      'claude-3-5-sonnet-latest',
    );
    expect(result).not.toBeNull();
    expect(result!.finishReason).toBe('STOP');
  });

  it('should return null for unknown event types', () => {
    const chunk = { type: 'ping' };
    const result = mapAnthropicChunkToGemini(chunk, 'claude-3-5-sonnet-latest');
    expect(result).toBeNull();
  });

  it('should handle multiple content blocks in same stream', () => {
    const chunk1 = {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Part 1' },
    };
    const chunk2 = {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'Part 2' },
    };
    const r1 = mapAnthropicChunkToGemini(chunk1, 'claude-3-5-sonnet-latest');
    const r2 = mapAnthropicChunkToGemini(chunk2, 'claude-3-5-sonnet-latest');
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
  });

  it('captures streaming thinking + signature_delta + redacted_thinking and replays on Turn 2', () => {
    const streamKey = 'stream-thinking-tool';
    expect(
      mapAnthropicChunkToGemini(
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        'claude-opus-4',
        streamKey,
      ),
    ).toBeNull();
    expect(
      mapAnthropicChunkToGemini(
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Inspecting ' } },
        'claude-opus-4',
        streamKey,
      )?.content.parts,
    ).toEqual([{ text: 'Inspecting ', thought: true }]);
    expect(
      mapAnthropicChunkToGemini(
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'logs.' } },
        'claude-opus-4',
        streamKey,
      )?.content.parts,
    ).toEqual([{ text: 'logs.', thought: true }]);
    expect(
      mapAnthropicChunkToGemini(
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig_stream_' } },
        'claude-opus-4',
        streamKey,
      ),
    ).toBeNull();
    expect(
      mapAnthropicChunkToGemini(
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'final' } },
        'claude-opus-4',
        streamKey,
      ),
    ).toBeNull();
    expect(
      mapAnthropicChunkToGemini({ type: 'content_block_stop', index: 0 }, 'claude-opus-4', streamKey)?.content.parts,
    ).toEqual([{ text: '', thought: true, thoughtSignature: 'sig_stream_final' }]);
    expect(
      mapAnthropicChunkToGemini(
        { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'redacted_s1' } },
        'claude-opus-4',
        streamKey,
      )?.content.parts,
    ).toEqual([{ thought: true, thoughtSignature: 'redacted_s1' }]);
    expect(
      mapAnthropicChunkToGemini(
        {
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'tool_use', id: 'toolu_stream_1', name: 'search', input: {} },
        },
        'claude-opus-4',
        streamKey,
      ),
    ).toBeNull();
    expect(
      mapAnthropicChunkToGemini(
        { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"q":"err"}' } },
        'claude-opus-4',
        streamKey,
      ),
    ).toBeNull();

    const toolDelta = mapAnthropicChunkToGemini(
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      'claude-opus-4',
      streamKey,
    );
    expect(toolDelta?.finishReason).toBe('STOP');
    expect(toolDelta?.content.parts).toEqual([
      { functionCall: { name: 'search', args: { q: 'err' }, id: 'toolu_stream_1' } },
    ]);

    // Subsequent message_stop must NOT emit a duplicate finishReason: 'STOP'
    expect(mapAnthropicChunkToGemini({ type: 'message_stop' }, 'claude-opus-4', streamKey)).toBeNull();
    expect(shared.activeStreamContexts.has(streamKey)).toBe(false);

    // Turn 2 replay works even if IDE dropped thought parts completely
    const turn2 = mapGeminiToAnthropic(
      {
        contents: [
          { role: 'user', parts: [{ text: 'Check logs' }] },
          {
            role: 'model',
            parts: [{ functionCall: { name: 'search', id: 'toolu_stream_1', args: { q: 'err' } } }],
          },
          {
            role: 'user',
            parts: [{ functionResponse: { name: 'search', id: 'toolu_stream_1', response: { lines: 0 } } }],
          },
        ],
      },
      'claude-opus-4',
      streamKey,
    );
    expect(turn2.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Inspecting logs.', signature: 'sig_stream_final' },
        { type: 'redacted_thinking', data: 'redacted_s1' },
        { type: 'tool_use', id: 'toolu_stream_1', name: 'search', input: { q: 'err' } },
      ],
    });
  });

  it('maps streaming message_delta stop_reason max_tokens to MAX_TOKENS on message_stop', () => {
    const streamKey = 'stream-max-tokens';
    expect(
      mapAnthropicChunkToGemini(
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Truncated' } },
        'claude-3-5-sonnet-latest',
        streamKey,
      )?.content.parts,
    ).toEqual([{ text: 'Truncated' }]);
    expect(
      mapAnthropicChunkToGemini(
        { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
        'claude-3-5-sonnet-latest',
        streamKey,
      ),
    ).toBeNull();
    const stop = mapAnthropicChunkToGemini({ type: 'message_stop' }, 'claude-3-5-sonnet-latest', streamKey);
    expect(stop).toEqual({ content: { parts: [], role: 'model' }, finishReason: 'MAX_TOKENS', index: 0 });
    expect(shared.activeStreamContexts.has(streamKey)).toBe(false);
  });
});
