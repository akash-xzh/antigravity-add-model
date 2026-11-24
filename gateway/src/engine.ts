import { getEffortForModel } from './reasoning-effort.js';

import { config } from './config.js';
import { providerRegistry } from './provider-registry.js';
import { logger } from './logger.js';
import { Router } from './router.js';
import { modelResolver } from './models.js';
import { reload as reloadReasoningEffort } from './reasoning-effort.js';
import { ANTIGRAVITY_CONTEXT } from './antigravity-context.js';
import { registerBuiltinPlugins } from './plugins/builtin-plugins.js';
import { toolCapabilityRegistry, ToolCapabilityRegistry } from './tool-capabilities.js';
import { normalizeToolCall } from './tool-normalizer.js';
import type { MappedRequest } from './mapper.js';
import type { OpenAIMessage } from './mapper.js';

// Ensure built-in plugins are registered at module load time
registerBuiltinPlugins();

export function extractConvId(requestId: string): string {
  const parts = requestId?.split('/') || [];
  return parts.length >= 2 ? parts.slice(0, 2).join('/') : requestId;
}

interface ReasoningTurnRecord {
  thought: string;
  asstIndex?: number;
  fingerprint?: string;
}

interface ReasoningEntry {
  data: string[];
  turns: ReasoningTurnRecord[];
  lastSeenAsstCount?: number;
  timestamp: number;
}

const REASONING_TTL_MS = 30 * 60 * 1000; // 30 minutes
const REASONING_MAX_SIZE = 1000;

/**
 * Anchor observations must survive the gap between injectReasoning() and
 * saveReasoning(): server.ts calls both synchronously but awaits a stream in
 * between, so a shared lastSeenAsstCount alone is rewritten by any concurrent
 * request on the same conversation. Snapshot the count observed by inject into
 * a pending per-conversation anchor and consume it in saveReasoning.
 *
 * A request id from server.ts scopes each anchor to one in-flight request, so
 * concurrent requests on the same conversation cannot consume each other's
 * anchor. Callers without a request id keep the legacy conversation-scoped
 * behaviour for compatibility.
 */
interface PendingAnchor {
  count: number;
  at: number;
}
const pendingAnchors = new Map<string, PendingAnchor>();

function anchorKey(convId: string, requestId?: string): string {
  return requestId ? `${convId}\0${requestId}` : convId;
}
function recordAnchor(key: string, count: number): void {
  const now = Date.now();
  // Drop anchors of aborted requests so the map cannot grow without bound.
  for (const [id, entry] of pendingAnchors) if (now - entry.at > 30_000) pendingAnchors.delete(id);
  const pending = pendingAnchors.get(key);
  if (!pending || pending.count < count || now - pending.at > 30_000) {
    pendingAnchors.set(key, { count, at: now });
  }
}
function peekAnchor(key: string): number | undefined {
  return pendingAnchors.get(key)?.count;
}
function consumeAnchor(key: string): number | undefined {
  const pending = pendingAnchors.get(key);
  if (!pending) return undefined;
  pendingAnchors.delete(key);
  return pending.count;
}

/** Test-only: drop state recorded between cases. */
export function resetReasoningRequestAnchors(): void {
  pendingAnchors.clear();
}

// Marks reasoning_content written by applyFallbackReasoning (answer text used as
// a placeholder). A real stored thought must be allowed to overwrite it.
const FALLBACK_REASONING = Symbol.for('antigravity.gateway.fallbackReasoning');
type MessageWithFallback = OpenAIMessage & { [FALLBACK_REASONING]?: boolean };

function isFallbackReasoning(msg: OpenAIMessage): boolean {
  if ((msg as MessageWithFallback)[FALLBACK_REASONING] === true) return true;
  // Clients echo reasoning_content through JSON, which drops symbol props.
  // Fallback values are literally the assistant's answer text, so compare too.
  const current = msg.reasoning_content;
  return typeof current === 'string' && current.length > 0 && current === fallbackReasoning(msg);
}

export const reasoningStore = new Map<string, ReasoningEntry>();

function fingerprintAssistantMessage(msg: OpenAIMessage): string {
  const contentPart = typeof msg.content === 'string'
    ? msg.content
    : msg.content == null
      ? ''
      : JSON.stringify(msg.content);
  const toolsPart = msg.tool_calls ? JSON.stringify(msg.tool_calls) : '';
  return `${contentPart}\0${toolsPart}`;
}

function fallbackReasoning(msg: OpenAIMessage): string | undefined {
  const c = msg.content;
  if (typeof c === 'string') {
    if (c.trim().length > 0) return c;
    return msg.tool_calls && msg.tool_calls.length > 0 ? ' ' : undefined;
  }
  if (Array.isArray(c)) {
    const text = c
      .map(part => (part && part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim();
    if (text.length > 0) return text;
    return ' ';
  }
  return msg.tool_calls && msg.tool_calls.length > 0 ? ' ' : undefined;
}

function applyFallbackReasoning(msg: OpenAIMessage): void {
  const existing = msg.reasoning_content;
  if (existing && existing.length > 0 && !isFallbackReasoning(msg)) return;
  const fallback = fallbackReasoning(msg);
  if (fallback !== undefined) {
    msg.reasoning_content = fallback;
    (msg as MessageWithFallback)[FALLBACK_REASONING] = true;
  } else if (msg.reasoning_content === '') {
    delete msg.reasoning_content;
    delete (msg as MessageWithFallback)[FALLBACK_REASONING];
  }
}

/** A matched stored thought always replaces a fallback answer-text placeholder. */
function applyStoredReasoning(msg: OpenAIMessage, thought: string): void {
  if (msg.reasoning_content && msg.reasoning_content.length > 0 && !isFallbackReasoning(msg)) return;
  msg.reasoning_content = thought;
  delete (msg as MessageWithFallback)[FALLBACK_REASONING];
}

export function cleanupReasoningStore(): void {
  const now = Date.now();
  for (const [key, entry] of reasoningStore) {
    if (now - entry.timestamp > REASONING_TTL_MS) {
      reasoningStore.delete(key);
    }
  }

  // Enforce max size (delete oldest)
  if (reasoningStore.size > REASONING_MAX_SIZE) {
    const entries = Array.from(reasoningStore.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toDelete = entries.slice(0, entries.length - REASONING_MAX_SIZE);
    for (const [key] of toDelete) {
      reasoningStore.delete(key);
    }
  }
}

export function saveReasoning(convId: string, thoughtText: string, requestId?: string): void {
  cleanupReasoningStore();
  // Consume this request's own anchor snapshot, never a value another
  // concurrent request may have written to the shared store in the meantime.
  const key = anchorKey(convId, requestId);
  const asstIndex = consumeAnchor(key) ?? reasoningStore.get(convId)?.lastSeenAsstCount;
  const existing = reasoningStore.get(convId);
  if (existing) {
    existing.data.push(thoughtText);
    existing.turns.push({ thought: thoughtText, asstIndex });
    existing.timestamp = Date.now();
  } else {
    reasoningStore.set(convId, {
      data: [thoughtText],
      turns: [{ thought: thoughtText }],
      timestamp: Date.now(),
    });
  }
}

export function injectReasoning(messages: OpenAIMessage[], convId: string, requestId?: string): void {
  const key = anchorKey(convId, requestId);
  const asstIdxs: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'assistant') asstIdxs.push(i);
  }

  const entry = reasoningStore.get(convId);
  if (!entry || entry.turns.length === 0) {
    for (const idx of asstIdxs) {
      applyFallbackReasoning(messages[idx]);
    }
    if (entry) {
      entry.lastSeenAsstCount = asstIdxs.length;
      recordAnchor(key, asstIdxs.length);
      entry.timestamp = Date.now();
    } else {
      cleanupReasoningStore();
      reasoningStore.set(convId, {
        data: [],
        turns: [],
        lastSeenAsstCount: asstIdxs.length,
        timestamp: Date.now(),
      });
      recordAnchor(key, asstIdxs.length);
    }
    return;
  }

  const fingerprints = asstIdxs.map(idx => fingerprintAssistantMessage(messages[idx]));
  const assigned = new Set<number>(); // indices into asstIdxs (0..asstIdxs.length-1)
  const matchedTurns = new Set<ReasoningTurnRecord>();

  // 1. First align turns that already have a known fingerprint (survives compaction/trimming)
  let searchFrom = 0;
  let inferredShift: number | undefined;
  for (const turn of entry.turns) {
    if (!turn.fingerprint) continue;
    for (let pos = searchFrom; pos < asstIdxs.length; pos++) {
      if (!assigned.has(pos) && fingerprints[pos] === turn.fingerprint) {
        if (turn.asstIndex !== undefined) {
          inferredShift = turn.asstIndex - pos;
        }
        const msg = messages[asstIdxs[pos]];
        applyStoredReasoning(msg, turn.thought);
        turn.asstIndex = pos;
        assigned.add(pos);
        matchedTurns.add(turn);
        searchFrom = pos + 1;
        break;
      }
    }
  }

  // 2. Align anchored turns by their recorded assistant index (adjusted for any compaction shift)
  const anchoredUnmatched = entry.turns.filter(t => !matchedTurns.has(t) && t.asstIndex !== undefined);
  if (anchoredUnmatched.length > 0) {
    let shift = inferredShift ?? 0;
    if (inferredShift === undefined) {
      const prevTotal = peekAnchor(key) ?? entry.lastSeenAsstCount;
      const priorCount = prevTotal !== undefined
        ? prevTotal + 1
        : Math.max(...anchoredUnmatched.map(t => t.asstIndex!)) + 1;
      if (asstIdxs.length < priorCount) {
        shift = priorCount - asstIdxs.length;
      }
    }
    for (const turn of anchoredUnmatched) {
      const pos = turn.asstIndex! - shift;
      if (pos >= 0 && pos < asstIdxs.length && !assigned.has(pos)) {
        if (turn.fingerprint && turn.fingerprint !== fingerprints[pos]) continue;
        const msg = messages[asstIdxs[pos]];
        applyStoredReasoning(msg, turn.thought);
        turn.asstIndex = pos;
        turn.fingerprint = fingerprints[pos];
        assigned.add(pos);
        matchedTurns.add(turn);
      }
    }
  }

  // 3. Align unanchored turns (e.g. saveReasoning called before any injectReasoning)
  //    to the trailing unmatched assistant messages in chronological order.
  const unanchored = entry.turns.filter(t => !matchedTurns.has(t) && t.asstIndex === undefined);
  if (unanchored.length > 0) {
    const freePositions: number[] = [];
    for (let pos = 0; pos < asstIdxs.length; pos++) {
      if (!assigned.has(pos)) freePositions.push(pos);
    }
    const injectCount = Math.min(unanchored.length, freePositions.length);
    const posOffset = freePositions.length - injectCount;
    const turnOffset = unanchored.length - injectCount;
    for (let i = 0; i < injectCount; i++) {
      const pos = freePositions[posOffset + i];
      const turn = unanchored[turnOffset + i];
      const msg = messages[asstIdxs[pos]];
      applyStoredReasoning(msg, turn.thought);
      turn.asstIndex = pos;
      turn.fingerprint = fingerprints[pos];
      assigned.add(pos);
      matchedTurns.add(turn);
    }
  }

  // 4. Fill non-empty fallback reasoning on unmatched assistant turns (never leaving "")
  for (let pos = 0; pos < asstIdxs.length; pos++) {
    if (!assigned.has(pos)) {
      applyFallbackReasoning(messages[asstIdxs[pos]]);
    }
  }

  recordAnchor(key, asstIdxs.length);
  entry.lastSeenAsstCount = asstIdxs.length;
  entry.timestamp = Date.now();
}

let router: Router;

export function getRouter(): Router {
  if (!router) {
    router = new Router(config.providers, modelResolver, { retries: config.retries, backoffMs: config.backoffMs });
  }
  return router;
}

export function reloadRouter(): void {
  config.reload();
  providerRegistry.clearAdapterCache();
  if (router) {
    router.updateProviders(config.providers, { retries: config.retries, backoffMs: config.backoffMs });
  }
  modelResolver.reload();
  reloadReasoningEffort();
  logger.info('[engine] Router, config, and model maps reloaded');
}

/**
 * Normalize a tool call from an external LLM.
 * Uses the ToolNormalizer to fix names, params, types, and defaults.
 * Falls back to simple internal-param stripping if normalizer doesn't apply.
 */
const ANTIGRAVITY_INTERNAL_ONLY = new Set([
  'toolAction', 'toolSummary', 'ToolAction', 'ToolSummary',
]);

function normalizeToolArgs(args: Record<string, unknown>, toolName: string): Record<string, unknown> {
  // First: strip Antigravity internal params (these are injected by the runtime)
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!ANTIGRAVITY_INTERNAL_ONLY.has(key)) cleaned[key] = value;
  }
  if (Object.keys(cleaned).length === 0) return args;

  // Second: run through the tool normalizer for schema-aware fixes
  const result = normalizeToolCall(toolName, cleaned);
  if (result.warnings) {
    logger.info(`[normalizer] ${result.warnings.join('; ')}`);
  }
  return result.args;
}

export type StreamResponseChunk =
  | { type: 'text'; content: string; provider?: string; resolvedModel?: string; sessionId?: string }
  | { type: 'thought'; content: string; provider?: string; resolvedModel?: string; sessionId?: string }
  | { type: 'tool-call'; name: string; args: Record<string, unknown>; provider?: string; resolvedModel?: string }
  | { type: 'attempt'; provider: string; resolvedModel: string; attempt: number; status: string; fallback?: boolean };

export async function* streamResponse(
  mapped: MappedRequest,
  modelId?: string,
  abortSignal?: AbortSignal,
): AsyncGenerator<StreamResponseChunk> {
  const model = modelId || 'default';
  const r = getRouter();
  const providerIds = config.providers.filter(p => p.enabled).sort((a,b) => a.priority - b.priority).map(p => p.id);

    logger.info(`Intercept: ${model}`, {
      messageCount: mapped.messages.length,
      hasTools: !!mapped.tools && Object.keys(mapped.tools).length > 0,
      hasSystem: !!mapped.system,
      contextStripMode: config.contextStripMode,
    });

  try {
    // Sync per-request tools into the capability registry for normalization
    const requestTools = new ToolCapabilityRegistry();
    requestTools.setDynamicTools(mapped.tools);

    const gen = r.execute(providerIds, model, mapped.messages, mapped.tools as any, {
      maxTokens: mapped.maxTokens,
      compactionEffort: mapped.compactionEffort,
      requestTimeoutMs: config.requestTimeoutMs,
      temperature: mapped.temperature,
      topP: mapped.topP,
      stopSequences: mapped.stopSequences,
      providerOptions: { ...mapped.providerOptions, openai: { ...mapped.providerOptions?.openai, reasoningEffort: mapped.providerOptions?.openai?.reasoningEffort || (getEffortForModel(model) === 'default' ? undefined : getEffortForModel(model)) } },
    }, abortSignal, mapped.system);

    for await (const chunk of gen) {
      const prov = (chunk as any).provider;
      const rmodel = (chunk as any).resolvedModel;
      const sid = (chunk as any).sessionId as string | undefined;
      if (chunk.type === 'text') {
        yield { type: 'text', content: chunk.content || '', provider: prov, resolvedModel: rmodel, sessionId: sid };
      } else if (chunk.type === 'thought') {
        yield { type: 'thought', content: chunk.content || '', provider: prov, resolvedModel: rmodel, sessionId: sid };
      } else if (chunk.type === 'tool-call') {
        const toolName = chunk.name || 'unknown';
        const cleaned = Object.fromEntries(Object.entries(chunk.args || {}).filter(([key]) => !ANTIGRAVITY_INTERNAL_ONLY.has(key)));
        const normalized = normalizeToolCall(toolName, cleaned, requestTools);
        yield { type: 'tool-call', name: normalized.name, args: normalized.args, provider: prov, resolvedModel: rmodel };
      } else if (chunk.type === 'attempt') {
        // A4: surface router's attempt events to the dashboard so failover
        // telemetry is visible. The downstream consumer in index.ts already
        // handles 'attempt' chunks — it was just never receiving them.
        yield {
          type: 'attempt',
          provider: prov || '',
          resolvedModel: rmodel || '',
          attempt: (chunk as any).attempt ?? 1,
          status: (chunk as any).status || 'trying',
          fallback: (chunk as any).fallback,
        };
      } else if (chunk.type === 'error') {
        throw new Error(chunk.content || 'router error');
      }
    }
  } catch (err: any) {
    logger.error(`[engine] stream error`, { error: err.message });
    throw err;
  }
}

export async function generateResponse(
  mapped: MappedRequest,
  modelId?: string,
): Promise<{ text: string; finishReason: string | null }> {
  const model = modelId || 'default';
  const r = getRouter();
  const providerIds = config.providers.filter(p => p.enabled).sort((a,b) => a.priority - b.priority).map(p => p.id);

  try {
    const gen = r.execute(providerIds, model, mapped.messages, mapped.tools as any, {
      maxTokens: mapped.maxTokens,
      compactionEffort: mapped.compactionEffort,
      requestTimeoutMs: config.requestTimeoutMs,
      temperature: mapped.temperature,
      topP: mapped.topP,
      stopSequences: mapped.stopSequences,
      providerOptions: { ...mapped.providerOptions, openai: { ...mapped.providerOptions?.openai, reasoningEffort: mapped.providerOptions?.openai?.reasoningEffort || (getEffortForModel(model) === 'default' ? undefined : getEffortForModel(model)) } },
    }, undefined, mapped.system);

    let text = '';
    for await (const chunk of gen) {
      if (chunk.type === 'text') text += chunk.content || '';
      if (chunk.type === 'error') throw new Error(chunk.content);
    }
    return { text, finishReason: 'STOP' };
  } catch (err: any) {
    logger.error(`[engine] generate error`, { error: err.message });
    return { text: `Error: ${err.message}`, finishReason: 'ERROR' };
  }
}

// Auto-cleanup every 5 minutes
setInterval(cleanupReasoningStore, 5 * 60 * 1000).unref();
