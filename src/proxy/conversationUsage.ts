/**
 * Process-local last provider usage and stream timing per conversation. This is only a fallback
 * for the context pill: `inputTokens` stores total prompt tokens (already including cached prompt
 * tokens for OpenAI, Anthropic, and Google), while `cachedTokens` tracks the cached subset.
 * No prompts or credentials are stored.
 */
export interface RecordedConversationUsage {
  /** Total prompt tokens (already includes cachedTokens). */
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  /** False for timing-only native stream entries whose token counts come from transcript.jsonl. */
  hasTokens?: boolean;
  /** Time from the upstream request to the first content chunk. */
  ttftMs?: number;
  /** Decode window only: first content chunk to last, excluding time to first token. */
  decodeMs?: number;
  updatedAt: number;
}

const MAX_CONVERSATIONS = 200;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
// A sub-50ms decode or a single-token jitter has no meaningful decode interval to divide by.
const MIN_DECODE_MS = 50;
const MIN_OUTPUT_TOKENS = 2;
const usage = new Map<string, RecordedConversationUsage>();

/** Provider generation speed, or undefined when the sample is too short to report honestly. */
export function tokensPerSecond(outputTokens?: number, decodeMs?: number): number | undefined {
  if (typeof outputTokens !== 'number' || typeof decodeMs !== 'number') return undefined;
  if (!Number.isFinite(outputTokens) || !Number.isFinite(decodeMs)) return undefined;
  if (outputTokens < MIN_OUTPUT_TOKENS || decodeMs < MIN_DECODE_MS) return undefined;
  return (outputTokens * 1000) / decodeMs;
}

const timing = (value: { ttftMs?: number; decodeMs?: number }) => ({
  ...(typeof value.ttftMs === 'number' && Number.isFinite(value.ttftMs) && value.ttftMs > 0
    ? { ttftMs: value.ttftMs }
    : {}),
  ...(typeof value.decodeMs === 'number' && Number.isFinite(value.decodeMs) && value.decodeMs >= MIN_DECODE_MS
    ? { decodeMs: value.decodeMs }
    : {}),
});

function store(conversationId: string, entry: RecordedConversationUsage): void {
  usage.delete(conversationId);
  usage.set(conversationId, entry);
  while (usage.size > MAX_CONVERSATIONS) usage.delete(usage.keys().next().value!);
}

/** Token usage and stream timing of a request the proxy generated itself (custom models). */
export function recordConversationUsage(
  conversationId: unknown,
  value: { inputTokens?: number; cachedTokens?: number; outputTokens?: number; ttftMs?: number; decodeMs?: number },
): void {
  if (typeof conversationId !== 'string' || !UUID.test(conversationId)) return;
  if (value.inputTokens === undefined && value.outputTokens === undefined) return;
  store(conversationId, {
    inputTokens: Math.max(0, value.inputTokens ?? 0),
    cachedTokens: Math.max(0, value.cachedTokens ?? 0),
    outputTokens: Math.max(0, value.outputTokens ?? 0),
    hasTokens: true,
    ...timing(value),
    updatedAt: Date.now(),
  });
}

/**
 * Stream timing of a native (official) generation. Its tokens come from the transcript, which the
 * language server annotates, so only the measured window is recorded here and any prior custom
 * model token counts are cleared so switching custom -> native never leaks stale counts.
 */
export function recordConversationTiming(
  conversationId: unknown,
  value: { ttftMs?: number; decodeMs?: number },
): void {
  if (typeof conversationId !== 'string' || !UUID.test(conversationId)) return;
  const measured = timing(value);
  if (measured.ttftMs === undefined && measured.decodeMs === undefined) return;
  store(conversationId, {
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    hasTokens: false,
    ...measured,
    updatedAt: Date.now(),
  });
}

export function getConversationUsage(conversationId: unknown): RecordedConversationUsage | undefined {
  if (typeof conversationId !== 'string') return undefined;
  return usage.get(conversationId);
}

/** Clear cached per-conversation usage/timing (e.g. when Undo truncates transcript.jsonl). */
export function clearConversationUsage(conversationId: unknown): void {
  if (typeof conversationId !== 'string') return;
  usage.delete(conversationId);
}
