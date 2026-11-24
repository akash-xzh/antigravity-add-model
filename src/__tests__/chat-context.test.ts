import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const directories: string[] = [];
const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
function directory() {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-context-'));
  directories.push(result);
  return result;
}
function transcript(root: string, entries: unknown[]) {
  const filename = path.join(root, 'brain', id, '.system_generated/logs/transcript.jsonl');
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  return filename;
}
const message = (content: string) => ({ type: 'PLANNER_RESPONSE', source: 'MODEL', content });
beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of directories.splice(0)) {
    expect(path.dirname(root)).toBe(os.tmpdir());
    expect(path.basename(root)).toMatch(/^agy-context-/);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('context transcript estimates', () => {
  it('reads the native transcript format and labels it as a partial estimate', async () => {
    const root = directory();
    transcript(root, [
      { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'a'.repeat(40) },
      message('b'.repeat(80)),
    ]);
    const { getChatContextUsage } = await import('../chatContext');
    expect(await getChatContextUsage(id, root)).toEqual({
      conversationId: id,
      source: 'estimated',
      currentTokens: 30,
      visibleInputTokens: 10,
      visibleOutputTokens: 20,
      compactions: 0,
    });
  });

  it('keeps all post-checkpoint text across the old 2 MiB boundary', async () => {
    const root = directory();
    const entries = Array.from({ length: 1000 }, () => message('x'.repeat(2000)));
    const filename = transcript(root, entries);
    const { getChatContextUsage } = await import('../chatContext');
    const before = await getChatContextUsage(id, root);
    fs.appendFileSync(filename, Array.from({ length: 100 }, () => JSON.stringify(message('y'.repeat(2000))) + '\n').join(''));
    const after = await getChatContextUsage(id, root);
    expect(before.currentTokens).toBe(500000);
    expect(after.currentTokens).toBe(550000);
  });

  it('resets only on a structured native system checkpoint', async () => {
    const root = directory();
    transcript(root, [
      message('x'.repeat(200)),
      { source: 'SYSTEM', type: 'CHECKPOINT', content: 's'.repeat(40) },
      { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'Resuming from a compaction' },
      message('y'.repeat(40)),
    ]);
    const { getChatContextUsage } = await import('../chatContext');
    expect((await getChatContextUsage(id, root)).currentTokens).toBe(Math.ceil((80 + 'Resuming from a compaction'.length) / 4));
  });

  it('does not substitute a different chat, truncated JSON, or a huge file', async () => {
    const root = directory();
    const filename = transcript(root, [message('existing')]);
    const { getChatContextUsage } = await import('../chatContext');
    expect(await getChatContextUsage(undefined, root)).toEqual({ conversationId: '', source: 'unavailable' });
    expect(await getChatContextUsage('../outside', root)).toEqual({ conversationId: '', source: 'unavailable' });
    fs.appendFileSync(filename, '{"source":');
    expect((await getChatContextUsage(id, root)).source).toBe('unavailable');
    fs.truncateSync(filename, 64 * 1024 * 1024 + 1);
    expect((await getChatContextUsage(id, root)).source).toBe('unavailable');
  });

  it('does not guess between conversations with the same title', async () => {
    const root = directory();
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(root, 'conversation_summaries.db'));
    db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT, title TEXT)');
    db.prepare('INSERT INTO conversation_summaries VALUES (?, ?)').run(id, 'Same title');
    const { findConversationIdByTitle } = await import('../chatContext');
    expect(findConversationIdByTitle('Same title', root)).toBe(id);
    db.prepare('INSERT INTO conversation_summaries VALUES (?, ?)').run('bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee', 'Same title');
    expect(findConversationIdByTitle('Same title', root)).toBeUndefined();
    db.close();
  });
});

describe('context limits and profile isolation', () => {
  it('selects exact variants independently of ordering and rejects ambiguous aliases', async () => {
    const { findContextModel } = await import('../chatContext');
    const models = [
      { name: 'models/gpt-5', displayName: 'GPT-5', contextWindow: 400000 },
      { name: 'models/gpt-5-mini', displayName: 'GPT-5 Mini', contextWindow: 128000 },
    ];
    expect(findContextModel('GPT-5 Mini', models)?.contextWindow).toBe(128000);
    expect(findContextModel('GPT-5 Mini', [...models].reverse())?.contextWindow).toBe(128000);
    expect(findContextModel('GPT-5 Mini extended', models)).toBeUndefined();
    expect(findContextModel('Duplicate', models.map((model) => ({ ...model, displayName: 'Duplicate' })))).toBeUndefined();
  });

  it('discovers an exact public limit only after opt-in and never mutates either profile', async () => {
    const root = directory();
    const other = directory();
    const model = { name: 'models/alias', displayName: 'My model', externalModelName: 'exact-id', provider: 'acme' };
    for (const location of [root, other]) fs.writeFileSync(path.join(location, 'custom_models.json'), JSON.stringify({ models: [model] }));
    const before = [root, other].map((location) => fs.readFileSync(path.join(location, 'custom_models.json'), 'utf8'));
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      acme: { models: { 'exact-id-mini': { limit: { context: 32000 } }, 'exact-id': { limit: { context: 96000 } } } },
    })));
    vi.stubGlobal('fetch', fetch);
    const { getContextInformation } = await import('../chatContext');
    expect((await getContextInformation({ modelName: 'My model' }, root, [model])).maxTokens).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(await getContextInformation({ modelName: 'My model', discoverLimit: true }, root, [model]))
      .toMatchObject({ maxTokens: 96000, limitSource: 'public-catalog' });
    await getContextInformation({ modelName: 'My model', discoverLimit: true }, root, [model]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('https://models.dev/api.json');
    expect([root, other].map((location) => fs.readFileSync(path.join(location, 'custom_models.json'), 'utf8'))).toEqual(before);
  });

  it('uses the manager profile and explicit context without public network access', async () => {
    const root = directory();
    transcript(root, [message('x'.repeat(40))]);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { createModelActions } = await import('../modelActions');
    const actions = createModelActions({
      store: { filename: path.join(root, 'custom_models.json'), list: () => [{ name: 'models/exact', contextWindow: 42000 }] },
    } as any);
    expect(await actions['storage:get-chat-context-usage']({ conversationId: id, modelName: 'models/exact', discoverLimit: true }))
      .toMatchObject({ currentTokens: 10, maxTokens: 42000, limitSource: 'configured' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('leaves conflicting public catalog aliases unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      one: { models: { 'model-id': { limit: { context: 32000 } } } },
      two: { models: { 'model-id': { limit: { context: 64000 } } } },
    }))));
    const { discoverContextLimit } = await import('../chatContext');
    expect(await discoverContextLimit('model-id')).toBeUndefined();
    expect(await discoverContextLimit('model-id', 'two')).toBe(64000);
  });

  it('clears an explicit preferred account while keeping repeated selection idempotent', async () => {
    const { createModelManager } = await import('../modelManagement');
    const root = directory();
    const manager = createModelManager(root, { encryptString: (value) => value, decryptString: (value) => value }, async () => {});
    manager.saveModel({ name: 'models/cloud', provider: 'google-cloudcode', apiUrl: 'https://cloudcode-pa.googleapis.com',
      externalModelName: 'gemini', apiKey: '', googleAccounts: [{ id: 'one', accessToken: 'test' }],
      googlePool: { strategy: 'round-robin', maxConcurrency: 2 } });
    manager.googleSelectAccount({ modelName: 'models/cloud', accountId: 'one' });
    manager.googleSelectAccount({ modelName: 'models/cloud', accountId: 'one' });
    expect(manager.store.read()[0].googlePool).toMatchObject({ preferredAccountId: 'one' });
    manager.googleSelectAccount({ modelName: 'models/cloud' });
    expect(manager.store.read()[0].googlePool).toEqual({ strategy: 'round-robin', maxConcurrency: 2 });
  });

  it('reports the real provider prompt size, overhead and cache from per-step usage', async () => {
    const root = directory();
    transcript(root, [
      { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'a'.repeat(400) },
      {
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        content: 'b'.repeat(800),
        input_tokens: 2049,
        cache_read_tokens: 69055,
        output_tokens: 200,
      },
    ]);
    const { getChatContextUsage } = await import('../chatContext');
    expect(await getChatContextUsage(id, root)).toEqual({
      conversationId: id,
      source: 'actual',
      currentTokens: 300,
      visibleInputTokens: 100,
      visibleOutputTokens: 200,
      actualTokens: 71104,
      overheadTokens: 70804,
      actualInputTokens: 2049,
      actualCachedTokens: 69055,
      actualOutputTokens: 200,
      sessionInputTokens: 2049,
      sessionCachedTokens: 69055,
      sessionOutputTokens: 200,
      turns: 1,
      compactions: 0,
      tokensPerTurn: 71104,
    });
  });

  it('computes the default checkpoint policy and tokens remaining before chat compact', async () => {
    const root = directory();
    transcript(root, [
      { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'a'.repeat(400) },
      message('b'.repeat(800)),
    ]);
    const { getContextInformation } = await import('../chatContext');
    const info = await getContextInformation(
      { conversationId: id, modelName: 'my-model' },
      root,
      [{ name: 'my-model', contextWindow: 100000, maxOutputTokens: 8192 }],
    );
    expect(info).toMatchObject({
      conversationId: id,
      source: 'estimated',
      currentTokens: 300,
      visibleInputTokens: 100,
      visibleOutputTokens: 200,
      maxTokens: 100000,
      compactionSource: 'default',
      compactionThresholdPercent: 80,
      compactionAtTokens: 80000,
      tokensUntilCompaction: 79700,
    });
  });

  it('honours a configured checkpoint percentage and claims nothing without a declared window', async () => {
    const root = directory();
    transcript(root, [
      { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'a'.repeat(400) },
      message('b'.repeat(800)),
    ]);
    const { getContextInformation } = await import('../chatContext');
    const configured = await getContextInformation(
      { conversationId: id, modelName: 'my-model' },
      root,
      [{ name: 'my-model', contextWindow: 100000, maxOutputTokens: 8192, compactionThresholdPercent: 50 }],
    );
    expect(configured).toMatchObject({ compactionSource: 'custom', compactionAtTokens: 50000 });
    // No declared window: the IDE keeps its own new-token default, so no percentage is claimed.
    const guessed = await getContextInformation(
      { conversationId: id, modelName: 'my-model' },
      root,
      [{ name: 'my-model', maxOutputTokens: 8192 }],
    );
    expect(guessed.compactionSource).toBeUndefined();
    expect(guessed.compactionAtTokens).toBeUndefined();
    expect(guessed.tokensUntilCompaction).toBeUndefined();
  });

  it('reads an official-model limit from the language server catalog and its measured speed', async () => {
    const root = directory();
    transcript(root, [
      { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'a'.repeat(400) },
      {
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        content: 'b'.repeat(800),
        input_tokens: 2049,
        cache_read_tokens: 69055,
        output_tokens: 200,
      },
    ]);
    const { recordNativeLimits } = await import('../proxy/nativeLimits');
    const { recordConversationTiming } = await import('../proxy/conversationUsage');
    const { getContextInformation } = await import('../chatContext');
    recordNativeLimits({
      models: { 'models/gemini-4-hydrogen': { displayName: 'Gemini 4 Hydrogen', maxTokens: 1_000_000 } },
    });
    recordConversationTiming(id, { ttftMs: 1500, decodeMs: 4000 });
    const info = await getContextInformation(
      { conversationId: id, modelName: 'Gemini 4 Hydrogen (Medium)' },
      root,
      [],
    );
    expect(info).toMatchObject({
      source: 'actual',
      actualTokens: 71104,
      actualOutputTokens: 200,
      maxTokens: 1_000_000,
      limitSource: 'native-catalog',
      tokensPerSecond: 50,
      ttftMs: 1500,
      compactionSource: 'ide',
    });
    // Official models keep the IDE's own checkpoint policy, so no window percentage is claimed.
    expect(info.compactionAtTokens).toBeUndefined();
    expect(info.tokensUntilCompaction).toBeUndefined();
  });

  it('reports the effective capped compaction percentage when maxOutputTokens caps tokenThreshold below 80%', async () => {
    const root = directory();
    transcript(root, [
      { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'a'.repeat(400) },
      message('b'.repeat(800)),
    ]);
    const { getContextInformation } = await import('../chatContext');
    const info = await getContextInformation(
      { conversationId: id, modelName: 'haiku-128k-out' },
      root,
      [{ name: 'haiku-128k-out', contextWindow: 200_000, maxOutputTokens: 128_000 }],
    );
    expect(info).toMatchObject({
      maxTokens: 200_000,
      compactionSource: 'default',
      compactionAtTokens: 70_976,
      compactionThresholdPercent: 35,
    });
  });

  it('does not double-count cached tokens for custom models recorded in process', async () => {
    const root = directory();
    transcript(root, [{ source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'hello' }]);
    const { recordConversationUsage } = await import('../proxy/conversationUsage');
    const { getContextInformation } = await import('../chatContext');
    // diagnostics.ts stores total prompt tokens (already including cachedTokens) in inputTokens.
    recordConversationUsage(id, {
      inputTokens: 100_000,
      cachedTokens: 90_000,
      outputTokens: 500,
      ttftMs: 400,
      decodeMs: 5_000,
    });
    const info = await getContextInformation(
      { conversationId: id, modelName: 'my-model' },
      root,
      [{ name: 'my-model', contextWindow: 200_000 }],
    );
    expect(info).toMatchObject({
      source: 'actual',
      actualTokens: 100_000,
      actualInputTokens: 10_000,
      actualCachedTokens: 90_000,
      actualOutputTokens: 500,
      tokensPerSecond: 100,
      ttftMs: 400,
    });
  });

  it('clears stale custom tokens when switching to a native model and ignores pre-checkpoint ghost usage', async () => {
    const root = directory();
    const { recordConversationUsage, recordConversationTiming } = await import('../proxy/conversationUsage');
    const { getContextInformation } = await import('../chatContext');
    const beforeCheckpoint = Date.now() - 10_000;
    vi.spyOn(Date, 'now').mockReturnValue(beforeCheckpoint);
    recordConversationUsage(id, { inputTokens: 160_000, cachedTokens: 80_000, outputTokens: 400, decodeMs: 4_000 });
    vi.restoreAllMocks();

    // Right after a CHECKPOINT resets turns=0, pre-compaction recorded usage must not leak as ghost tokens.
    transcript(root, [
      { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'old', input_tokens: 1000, cache_read_tokens: 4000, output_tokens: 200 },
      { source: 'SYSTEM', type: 'CHECKPOINT', content: 'summary', created_at: new Date(beforeCheckpoint + 5_000).toISOString() },
    ]);
    const postCheckpoint = await getContextInformation({ conversationId: id, modelName: 'my-model' }, root, []);
    expect(postCheckpoint.source).toBe('estimated');
    expect(postCheckpoint.actualTokens).toBeUndefined();
    expect(postCheckpoint.tokensPerSecond).toBeUndefined();
    // Cumulative session burn is preserved across checkpoints.
    expect(postCheckpoint.sessionInputTokens).toBe(1000);
    expect(postCheckpoint.sessionCachedTokens).toBe(4000);
    expect(postCheckpoint.sessionOutputTokens).toBe(200);

    // Switching from custom -> native clears stale custom tokens in recordConversationTiming.
    recordConversationUsage(id, { inputTokens: 120_000, cachedTokens: 60_000, outputTokens: 300, decodeMs: 3_000 });
    recordConversationTiming(id, { ttftMs: 500, decodeMs: 2_000 });
    const nativeInfo = await getContextInformation({ conversationId: id, modelName: 'native' }, root, []);
    expect(nativeInfo.actualTokens).toBeUndefined();
    expect(nativeInfo.source).toBe('estimated');
  });

  it('uses newer custom-model recorded tokens and speed instead of mixing Turn 2 timing with Turn 1 transcript tokens', async () => {
    const root = directory();
    const turn1At = Date.now() - 10_000;
    transcript(root, [
      {
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        content: 'turn 1',
        created_at: new Date(turn1At).toISOString(),
        input_tokens: 2_000,
        cache_read_tokens: 8_000,
        output_tokens: 200,
      },
    ]);
    const { recordConversationUsage } = await import('../proxy/conversationUsage');
    const { getContextInformation } = await import('../chatContext');
    recordConversationUsage(id, {
      inputTokens: 25_000,
      cachedTokens: 20_000,
      outputTokens: 500,
      ttftMs: 300,
      decodeMs: 5_000,
    });
    const info = await getContextInformation({ conversationId: id, modelName: 'my-model' }, root, []);
    expect(info).toMatchObject({
      source: 'actual',
      actualTokens: 25_000,
      actualInputTokens: 5_000,
      actualCachedTokens: 20_000,
      actualOutputTokens: 500,
      tokensPerSecond: 100,
      ttftMs: 300,
    });
  });
});
