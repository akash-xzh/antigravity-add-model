import { describe, expect, it } from 'vitest';
import {
  getGoogleApiUrl,
  mapGeminiToGoogle,
  mapGoogleChunkToGemini,
  mapGoogleToGemini,
} from '../proxy/translators/google';

describe('Google AI Studio translator', () => {
  it('strips Cloud Code metadata fields including labels without mutating the input', () => {
    const input = {
      model: 'gemini-2.5-pro',
      modelId: 'models/gemini-2.5-pro',
      model_id: 'gemini-2.5-pro',
      stream: true,
      sessionId: 'sess-1',
      conversationId: 'conv-1',
      labels: { cascade_id: 'abc-123', ide: 'antigravity' },
      systemInstruction: { parts: [{ text: 'Be concise.' }] },
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
    };
    const snapshot = structuredClone(input);

    const mapped = mapGeminiToGoogle(input as never, 'gemini-2.5-pro') as Record<string, unknown>;

    expect(mapped.labels).toBeUndefined();
    expect(mapped.model).toBeUndefined();
    expect(mapped.modelId).toBeUndefined();
    expect(mapped.model_id).toBeUndefined();
    expect(mapped.stream).toBeUndefined();
    expect(mapped.sessionId).toBeUndefined();
    expect(mapped.conversationId).toBeUndefined();
    expect(mapped.systemInstruction).toEqual(input.systemInstruction);
    expect(mapped.contents).toEqual(input.contents);
    expect(mapped.generationConfig).toEqual(input.generationConfig);
    expect(input).toEqual(snapshot);
  });

  it('passes through responses and translates streaming chunks cleanly', () => {
    const res = { candidates: [{ content: { parts: [{ text: 'Hi' }], role: 'model' }, finishReason: 'STOP' }] };
    expect(mapGoogleToGemini(res, 'gemini-2.5-pro')).toBe(res);
    expect(mapGoogleChunkToGemini(res, 'gemini-2.5-pro')).toEqual({
      content: { parts: [{ text: 'Hi' }], role: 'model' },
      finishReason: 'STOP',
      index: 0,
      safetyRatings: undefined,
    });
    expect(mapGoogleChunkToGemini({ candidates: [{ finishReason: 'STOP', index: 0 }] }, 'gemini-2.5-pro')).toEqual({
      content: { parts: [], role: 'model' },
      finishReason: 'STOP',
      index: 0,
    });
  });

  it('builds Google AI Studio streaming and non-streaming URLs', () => {
    expect(getGoogleApiUrl('https://generativelanguage.googleapis.com/v1beta', 'models/gemini-2.5-pro', true)).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
    );
    expect(getGoogleApiUrl('https://generativelanguage.googleapis.com/v1beta', 'gemini-2.5-pro', false)).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
    );
  });
});
