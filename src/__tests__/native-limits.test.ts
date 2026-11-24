import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const roots: string[] = [];
const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const directory = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-limits-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  vi.resetModules();
  for (const root of roots.splice(0)) {
    expect(path.basename(root)).toMatch(/^agy-limits-/);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('native model limits', () => {
  it('captures catalog limits, resolves the picker effort suffix and persists them', async () => {
    const root = directory();
    const { configureNativeLimits, findNativeLimit, nativeLimitsPath, recordNativeLimits, resetNativeLimits } = await import(
      '../proxy/nativeLimits'
    );
    resetNativeLimits();
    const filename = nativeLimitsPath(root);
    configureNativeLimits(filename);
    recordNativeLimits({
      models: {
        'models/gemini-4-hydrogen': { displayName: 'Gemini 4 Hydrogen', maxTokens: 1_000_000, maxOutputTokens: 65_536 },
        'claude-4-sonnet': { maxTokens: 200_000 },
        'broken-model': { maxTokens: 'unlimited' },
      },
    });
    expect(findNativeLimit('Gemini 4 Hydrogen (Medium)')).toBe(1_000_000);
    expect(findNativeLimit('gemini-4-hydrogen')).toBe(1_000_000);
    expect(findNativeLimit('Claude 4 Sonnet (High)')).toBe(200_000);
    expect(findNativeLimit('Gemini 4 Carbon (Low)')).toBeUndefined();
    expect(findNativeLimit('broken-model')).toBeUndefined();
    expect(findNativeLimit(undefined as unknown as string)).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(filename, 'utf8'))).toEqual({
      gemini4hydrogen: 1_000_000,
      claude4sonnet: 200_000,
    });
  });

  it('keeps the previous session limits when the catalog cannot be read', async () => {
    const root = directory();
    const { configureNativeLimits, findNativeLimit, nativeLimitsPath, resetNativeLimits } = await import('../proxy/nativeLimits');
    resetNativeLimits();
    fs.writeFileSync(nativeLimitsPath(root), JSON.stringify({ gemini4argon: 500_000, invalid: -1 }));
    configureNativeLimits(nativeLimitsPath(root));
    expect(findNativeLimit('Gemini 4 Argon (Low)')).toBe(500_000);
    expect(findNativeLimit('invalid')).toBeUndefined();
  });
});

describe('recorded stream timing', () => {
  it('derives speed only from honest samples', async () => {
    const { tokensPerSecond } = await import('../proxy/conversationUsage');
    expect(tokensPerSecond(400, 8000)).toBeCloseTo(50);
    expect(tokensPerSecond(1, 8000)).toBeUndefined();
    expect(tokensPerSecond(400, 20)).toBeUndefined();
    expect(tokensPerSecond(undefined, 8000)).toBeUndefined();
  });

  it('records the measured window of a native generation without inventing tokens', async () => {
    const { getConversationUsage, recordConversationTiming } = await import('../proxy/conversationUsage');
    recordConversationTiming(uuid, { ttftMs: 1200, decodeMs: 8000 });
    expect(getConversationUsage(uuid)).toMatchObject({ inputTokens: 0, outputTokens: 0, ttftMs: 1200, decodeMs: 8000 });
    recordConversationTiming('not-a-conversation', { decodeMs: 8000 });
    expect(getConversationUsage('not-a-conversation')).toBeUndefined();
  });
});
