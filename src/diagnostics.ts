/** Process-local, bounded diagnostics. No prompts, response text, URLs or credentials are retained. */
import { randomUUID } from 'node:crypto';

export type DiagnosticOutcome = 'succeeded' | 'failed' | 'cancelled';
export interface DiagnosticRequest {
  id: string;
  timestamp: number;
  model: string;
  provider: string;
  stream: boolean;
  kind: 'request' | 'generation-test';
  outcome: DiagnosticOutcome;
  status?: number;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}

const MAX_REQUESTS = 200;
const requests: DiagnosticRequest[] = [];
let epoch = 0;
let active = 0;
let startedAt = Date.now();
const label = (value: string) =>
  String(value)
    .replace(/[\x00-\x1f\x7f]/g, '')
    .slice(0, 160);
const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export function beginDiagnosticRequest(input: {
  model: string;
  provider: string;
  stream: boolean;
  kind?: 'request' | 'generation-test';
}) {
  const timestamp = Date.now();
  const requestEpoch = epoch;
  const usage: { inputTokens?: number; outputTokens?: number; cachedTokens?: number } = {};
  let finished = false;
  active += 1;
  const update = (key: keyof typeof usage, value: unknown) => {
    const measured = count(value);
    if (measured !== undefined) usage[key] = Math.max(usage[key] ?? 0, measured);
  };
  return {
    /** Usage belongs to the final attempted provider/model, not a sum of retry billing. */
    resetUsage(): void {
      if (finished) return;
      delete usage.inputTokens;
      delete usage.outputTokens;
      delete usage.cachedTokens;
    },
    observe(value: unknown, format: 'openai' | 'anthropic' | 'google'): void {
      if (finished || !value || typeof value !== 'object') return;
      const raw = object(value);
      const data = raw.response && typeof raw.response === 'object' ? object(raw.response) : raw;
      if (format === 'openai') {
        const u = object(data.usage);
        update('inputTokens', u.prompt_tokens);
        update('outputTokens', u.completion_tokens);
        update('cachedTokens', object(u.prompt_tokens_details).cached_tokens);
      } else if (format === 'anthropic') {
        const u = object(data.usage || object(data.message).usage);
        const uncached = count(u.input_tokens);
        if (uncached !== undefined)
          update(
            'inputTokens',
            uncached + (count(u.cache_read_input_tokens) ?? 0) + (count(u.cache_creation_input_tokens) ?? 0),
          );
        update('outputTokens', u.output_tokens);
        update('cachedTokens', u.cache_read_input_tokens);
      } else {
        const u = object(data.usageMetadata);
        update('inputTokens', u.promptTokenCount);
        update('outputTokens', u.candidatesTokenCount);
        update('cachedTokens', u.cachedContentTokenCount);
      }
    },
    finish(result: { outcome: DiagnosticOutcome; status?: number; model?: string; provider?: string }): void {
      if (finished) return;
      finished = true;
      active = Math.max(0, active - 1);
      if (requestEpoch !== epoch) return;
      const status = count(result.status);
      requests.unshift({
        id: randomUUID(),
        timestamp,
        model: label(result.model ?? input.model),
        provider: label(result.provider ?? input.provider),
        stream: input.stream,
        kind: input.kind || 'request',
        outcome: result.outcome,
        ...(status !== undefined && status >= 100 && status <= 599 ? { status } : {}),
        latencyMs: Math.max(0, Date.now() - timestamp),
        ...usage,
      });
      requests.length = Math.min(requests.length, MAX_REQUESTS);
    },
  };
}

export function getDiagnostics() {
  const recentModels = getRecentModelNames();
  const total = (key: 'inputTokens' | 'outputTokens' | 'cachedTokens') =>
    requests.reduce((sum, r) => sum + (r[key] ?? 0), 0);
  return {
    success: true,
    startedAt,
    active,
    capacity: MAX_REQUESTS,
    summary: {
      requests: requests.length,
      succeeded: requests.filter((r) => r.outcome === 'succeeded').length,
      failed: requests.filter((r) => r.outcome === 'failed').length,
      cancelled: requests.filter((r) => r.outcome === 'cancelled').length,
      measuredRequests: requests.filter((r) => r.inputTokens !== undefined || r.outputTokens !== undefined).length,
      measuredInputRequests: requests.filter((r) => r.inputTokens !== undefined).length,
      measuredOutputRequests: requests.filter((r) => r.outputTokens !== undefined).length,
      measuredCachedRequests: requests.filter((r) => r.cachedTokens !== undefined).length,
      inputTokens: total('inputTokens'),
      outputTokens: total('outputTokens'),
      cachedTokens: total('cachedTokens'),
    },
    recentModels,
    requests: requests.map((r) => ({ ...r })),
  };
}

export function getRecentModelNames(): string[] {
  return [
    ...new Set(requests.filter((r) => r.outcome === 'succeeded' && r.kind === 'request').map((r) => r.model)),
  ].slice(0, 3);
}

export function clearDiagnostics() {
  epoch += 1;
  requests.length = 0;
  startedAt = Date.now();
  return { success: true };
}
