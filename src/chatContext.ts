/** Read-only context information. Native transcripts omit system prompts and usage metadata. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { getConversationUsage, tokensPerSecond } from './proxy/conversationUsage';
import { findNativeLimit } from './proxy/nativeLimits';
import {
  DEFAULT_COMPACTION_THRESHOLD_PERCENT,
  nativeCheckpointConfig,
  type CustomModelConfig,
} from './proxy/modelUtils';

export interface ContextModel {
  name?: string;
  displayName?: string;
  externalModelName?: string;
  provider?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsVision?: boolean;
  supportsThinking?: boolean;
  compactionReasoningEffort?: string;
  compactionThresholdPercent?: number;
}
export interface ChatContextRequest {
  conversationId?: string;
  title?: string;
  modelName?: string;
  discoverLimit?: boolean;
}
export interface ChatContextUsage {
  conversationId: string;
  source: 'actual' | 'estimated' | 'unavailable';
  /** Real provider prompt tokens (uncached input + cache read) when Antigravity recorded them. */
  actualTokens?: number;
  /** Real tokens spent on what the transcript cannot show: system prompt, tool definitions, images. */
  overheadTokens?: number;
  /** Visible transcript only: excludes hidden prompts, tool definitions and images. */
  currentTokens?: number;
  visibleInputTokens?: number;
  visibleOutputTokens?: number;
  actualInputTokens?: number;
  actualCachedTokens?: number;
  actualOutputTokens?: number;
  sessionInputTokens?: number;
  sessionCachedTokens?: number;
  sessionOutputTokens?: number;
  turns?: number;
  compactions?: number;
  tokensPerTurn?: number;
  turnsUntilCompaction?: number;
  maxTokens?: number;
  limitSource?: 'configured' | 'native-catalog' | 'public-catalog';
  /** Measured provider generation speed of the last turn. */
  tokensPerSecond?: number;
  /** Measured time to first token of the last turn. */
  ttftMs?: number;
  compactionThresholdPercent?: number;
  compactionAtTokens?: number;
  tokensUntilCompaction?: number;
  /**
   * Which policy the IDE checkpoints with: `custom` and `default` are the proxy's per-model
   * override (the default is 80% of a declared context window), `ide` is the IDE's own new-token
   * default that a window percentage cannot describe.
   */
  compactionSource?: 'custom' | 'default' | 'ide';
}
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
interface TranscriptSnapshot {
  result: ChatContextUsage;
  mtimeMs: number;
  lastCheckpointAt?: number;
  lastUsageAt?: number;
}
const transcriptCache = new Map<string, { stamp: string; snapshot: TranscriptSnapshot }>();
const pendingTranscripts = new Map<string, Promise<TranscriptSnapshot>>();
const validLimit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const validPercent = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 10 && value <= 90 ? value : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const entryTimestamp = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
};
const label = (value?: string) =>
  typeof value === 'string' ? value.trim().replace(/[▾▲▼◂▸◀▶]/g, '').replace(/\s+/g, ' ').trim().toLowerCase() : '';
const modelKey = (value?: string) => label(value).replace(/^models\//, '').replace(/[^a-z0-9]/g, '');

/** Never let an earlier prefix match shadow an exact model or effort variant. */
export function findContextModel(name: string | undefined, models: ContextModel[]): ContextModel | undefined {
  const nameLabel = label(name);
  if (!nameLabel) return undefined;
  for (const field of ['displayName', 'name', 'externalModelName'] as const) {
    const matches = models.filter((model) => label(model[field]) === nameLabel);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return undefined;
  }
  const key = modelKey(name);
  const matches = models.filter((model) =>
    [model.displayName, model.name, model.externalModelName].some((value) => value && modelKey(value) === key));
  return matches.length === 1 ? matches[0] : undefined;
}

/** A title is usable only when it identifies one conversation, including archived rows. */
export function findConversationIdByTitle(title: unknown, dataDirectory: string): string | undefined {
  if (typeof title !== 'string' || !title.trim() || title.length > 512) return undefined;
  const filename = path.join(dataDirectory, 'conversation_summaries.db');
  if (!fs.existsSync(filename)) return undefined;
  try {
    // Electron versions without node:sqlite simply leave identity unavailable.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
      const rows = db.prepare('SELECT conversation_id FROM conversation_summaries WHERE title = ? LIMIT 2')
        .all(title.trim()) as { conversation_id: string }[];
      return rows.length === 1 && UUID.test(rows[0].conversation_id) ? rows[0].conversation_id : undefined;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

async function readChatContextSnapshot(
  conversationId: unknown,
  dataDirectory: string,
): Promise<TranscriptSnapshot> {
  const id = typeof conversationId === 'string' && UUID.test(conversationId) ? conversationId : '';
  const unavailable: TranscriptSnapshot = { result: { conversationId: id, source: 'unavailable' }, mtimeMs: 0 };
  if (!id) return unavailable;
  const filename = path.join(dataDirectory, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
  try {
    const stat = await fs.promises.stat(filename);
    // Do not show a truncated tail as the whole context. Large/unsupported files are explicitly unavailable.
    if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES) return unavailable;
    const stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    const cached = transcriptCache.get(filename);
    if (cached?.stamp === stamp) return { ...cached.snapshot, result: { ...cached.snapshot.result } };
    const pending = pendingTranscripts.get(filename);
    if (pending) {
      const resolved = await pending;
      return { ...resolved, result: { ...resolved.result } };
    }
    const read = async (): Promise<TranscriptSnapshot> => {
      let characters = 0;
      let inputChars = 0;
      let outputChars = 0;
      let entries = 0;
      let malformed = false;
      let compactions = 0;
      let turns = 0;
      let lastPrompt = 0;
      let lastInput = 0;
      let lastCached = 0;
      let lastOutput = 0;
      let sessionInput = 0;
      let sessionCached = 0;
      let sessionOutput = 0;
      let lastCheckpointAt: number | undefined;
      let lastUsageAt: number | undefined;
      const input = fs.createReadStream(filename, { encoding: 'utf8' });
      const lines = readline.createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if (!entry || typeof entry !== 'object' || typeof entry.type !== 'string' ||
                typeof entry.source !== 'string') {
              malformed = true;
              continue;
            }
            const ts = entryTimestamp(entry.created_at);
            // The native structured CHECKPOINT starts a new visible context while preserving
            // cumulative session burn totals across compactions.
            // Quoted "resuming" text in user messages is never a checkpoint.
            if (entry.type === 'CHECKPOINT' && entry.source === 'SYSTEM') {
              characters = 0;
              inputChars = 0;
              outputChars = 0;
              compactions += 1;
              turns = 0;
              lastPrompt = 0;
              lastInput = 0;
              lastCached = 0;
              lastOutput = 0;
              lastUsageAt = undefined;
              if (ts !== undefined) lastCheckpointAt = ts;
            }
            let entryChars = 0;
            if (typeof entry.content === 'string') entryChars += entry.content.length;
            if (typeof entry.thinking === 'string') entryChars += entry.thinking.length;
            if (Array.isArray(entry.tool_calls)) entryChars += JSON.stringify(entry.tool_calls).length;
            characters += entryChars;
            if (entry.source === 'MODEL' || entry.type === 'PLANNER_RESPONSE') outputChars += entryChars;
            else inputChars += entryChars;
            // Native per-step usage: immediate input excludes cached prompt tokens, so the real
            // prompt size is both together and includes the hidden system prompt, tools and images.
            const rawInput = count(entry.input_tokens);
            const cached = count(entry.cache_read_tokens);
            const output = count(entry.output_tokens);
            if (rawInput !== undefined || output !== undefined) {
              turns += 1;
              lastInput = rawInput ?? 0;
              lastCached = cached ?? 0;
              lastOutput = output ?? 0;
              lastPrompt = lastInput + lastCached;
              sessionInput += lastInput;
              sessionCached += lastCached;
              sessionOutput += lastOutput;
              if (ts !== undefined) lastUsageAt = ts;
            }
            entries++;
          } catch {
            malformed = true;
          }
        }
      } finally {
        lines.close();
        input.destroy();
      }
      const after = await fs.promises.stat(filename);
      // A concurrent append or partial JSON line must not cache a falsely small count.
      if (malformed || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || !entries) return unavailable;
      const result: ChatContextUsage = {
        conversationId: id,
        source: 'estimated',
        currentTokens: Math.ceil(characters / 4),
        visibleInputTokens: Math.ceil(inputChars / 4),
        visibleOutputTokens: Math.ceil(outputChars / 4),
        compactions,
      };
      if (turns) {
        result.source = 'actual';
        result.actualTokens = lastPrompt;
        result.actualInputTokens = lastInput;
        result.actualCachedTokens = lastCached;
        result.actualOutputTokens = lastOutput;
        result.sessionInputTokens = sessionInput;
        result.sessionCachedTokens = sessionCached;
        result.sessionOutputTokens = sessionOutput;
        result.turns = turns;
        result.overheadTokens = Math.max(0, lastPrompt - result.currentTokens!);
        result.tokensPerTurn = Math.max(1, Math.round((sessionInput + sessionCached) / turns));
      } else if (sessionInput || sessionCached || sessionOutput) {
        result.sessionInputTokens = sessionInput;
        result.sessionCachedTokens = sessionCached;
        result.sessionOutputTokens = sessionOutput;
      }
      const snapshot: TranscriptSnapshot = { result, mtimeMs: stat.mtimeMs, lastCheckpointAt, lastUsageAt };
      if (transcriptCache.size >= 100) transcriptCache.delete(transcriptCache.keys().next().value!);
      transcriptCache.set(filename, { stamp, snapshot });
      return { ...snapshot, result: { ...result } };
    };
    const promise = read();
    pendingTranscripts.set(filename, promise);
    try {
      return await promise;
    } finally {
      pendingTranscripts.delete(filename);
    }
  } catch {
    return unavailable;
  }
}

export async function getChatContextUsage(
  conversationId: unknown,
  dataDirectory: string,
): Promise<ChatContextUsage> {
  return (await readChatContextSnapshot(conversationId, dataDirectory)).result;
}

type Catalog = Record<string, { models?: Record<string, { name?: string; limit?: { context?: number } }> }>;
let catalog: Catalog | undefined;
let catalogExpires = 0;
let catalogPending: Promise<Catalog | undefined> | undefined;

async function publicCatalog(): Promise<Catalog | undefined> {
  if (Date.now() < catalogExpires) return catalog;
  if (catalogPending) return catalogPending;
  catalogPending = (async () => {
    catalogExpires = Date.now() + 60_000;
    try {
      // A fixed public catalog URL receives no conversation, model name or credentials.
      const response = await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(5000) });
      if (!response.ok || !response.body) return undefined;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 32 * 1024 * 1024) return undefined;
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
      catalog = parsed;
      catalogExpires = Date.now() + 300_000;
      return catalog;
    } catch {
      return undefined;
    }
  })();
  try {
    return await catalogPending;
  } finally {
    catalogPending = undefined;
  }
}

/** Exact catalog identifiers only; conflicting provider limits remain unknown. */
export async function discoverContextLimit(modelName: string, provider?: string): Promise<number | undefined> {
  const key = modelKey(modelName);
  if (!key) return undefined;
  const data = await publicCatalog();
  if (!data) return undefined;
  const preferred = provider && data[provider]?.models ? [[provider, data[provider]]] as const : Object.entries(data);
  const limits = new Set<number>();
  for (const [, entry] of preferred) {
    if (!entry || typeof entry !== 'object' || !entry.models || typeof entry.models !== 'object') continue;
    for (const [id, model] of Object.entries(entry.models)) {
      if (!model || typeof model !== 'object' || !validLimit(model.limit?.context)) continue;
      if (modelKey(id) === key || modelKey(model.name) === key) limits.add(model.limit!.context!);
    }
  }
  return limits.size === 1 ? [...limits][0] : undefined;
}

export async function getContextInformation(
  payload: unknown,
  dataDirectory: string,
  models: ContextModel[],
): Promise<ChatContextUsage> {
  const request: ChatContextRequest = payload && typeof payload === 'object' ? payload : {};
  const id = request.conversationId || findConversationIdByTitle(request.title, dataDirectory);
  const snapshot = await readChatContextSnapshot(id, dataDirectory);
  const result = snapshot.result;
  // The proxy records the provider's real usage and stream timing in-process. Usage covers custom
  // models whose steps the language server has not annotated yet, and is lost when the app restarts.
  // Timing also covers native models, whose tokens the transcript already carries.
  let recorded = getConversationUsage(id);
  // Right after a CHECKPOINT resets post-compaction turns to 0, do not re-inject pre-compaction
  // recorded usage as ghost tokens.
  if (recorded && (result.compactions ?? 0) > 0 && !result.turns && snapshot.lastCheckpointAt !== undefined) {
    // Only a parsed CHECKPOINT timestamp is a reliable boundary. mtimeMs is after
    // the checkpoint and would erase genuine post-compaction usage.
    if (recorded.updatedAt <= snapshot.lastCheckpointAt) recorded = undefined;
  }
  if (recorded) {
    const recordedHasTokens =
      recorded.hasTokens === true || (recorded.hasTokens === undefined && (recorded.inputTokens > 0 || recorded.outputTokens > 0));
    const transcriptUsageAt = snapshot.lastUsageAt ?? snapshot.mtimeMs;
    if (recordedHasTokens) {
      const recordedIsNewer = !result.actualTokens || recorded.updatedAt > transcriptUsageAt;
      if (recordedIsNewer) {
        // diagnostics.ts stores total prompt tokens (already including cached tokens) in inputTokens.
        result.source = 'actual';
        result.actualTokens = recorded.inputTokens;
        result.actualInputTokens = Math.max(0, recorded.inputTokens - recorded.cachedTokens);
        result.actualCachedTokens = recorded.cachedTokens;
        result.actualOutputTokens = recorded.outputTokens;
        result.overheadTokens = Math.max(0, result.actualTokens - (result.currentTokens ?? 0));
      }
      // Only attribute speed/TTFT when recorded belongs to the active turn (never mix turns).
      if (recordedIsNewer || result.actualOutputTokens === recorded.outputTokens) {
        const speed = tokensPerSecond(recorded.outputTokens, recorded.decodeMs);
        if (speed !== undefined) result.tokensPerSecond = speed;
        if (recorded.ttftMs !== undefined) result.ttftMs = recorded.ttftMs;
      }
    } else if (result.actualTokens) {
      // Timing-only native entry: ensure we do not divide Turn 2's decodeMs into Turn 1's outputTokens
      // when transcript.jsonl has not yet flushed Turn 2.
      // A timing record newer than the transcript's last usage belongs to a turn
      // that has not been annotated yet: its decodeMs must not be divided by the
      // previous turn's output tokens. No arbitrary time tolerance.
      const staleForTranscriptTurn =
        snapshot.lastUsageAt !== undefined && recorded.updatedAt > snapshot.lastUsageAt;
      if (!staleForTranscriptTurn) {
        const speed = tokensPerSecond(result.actualOutputTokens, recorded.decodeMs);
        if (speed !== undefined) result.tokensPerSecond = speed;
        if (recorded.ttftMs !== undefined) result.ttftMs = recorded.ttftMs;
      }
    }
  }
  const name = typeof request.modelName === 'string' && request.modelName.length <= 512 ? request.modelName : '';
  const configured = findContextModel(name, models);
  if (validLimit(configured?.contextWindow)) {
    result.maxTokens = configured.contextWindow;
    result.limitSource = 'configured';
  } else {
    // Official models are absent from the user's configuration; their limit is the one the
    // language server's own catalog declares. A saved custom model keeps its own endpoint limit.
    const native = !configured && name ? findNativeLimit(name) : undefined;
    if (validLimit(native)) {
      result.maxTokens = native;
      result.limitSource = 'native-catalog';
    } else if (request.discoverLimit === true && name) {
      const limit = await discoverContextLimit(configured?.externalModelName || name, configured?.provider);
      if (limit) {
        result.maxTokens = limit;
        result.limitSource = 'public-catalog';
      }
    }
  }
  if (validLimit(result.maxTokens)) {
    // Mirror the IDE's real trigger instead of guessing a share of the window. The proxy only
    // installs a checkpoint override for a saved model that declares its real context window;
    // every other model (including official ones) keeps the IDE's own new-token default.
    const checkpoint = configured
      ? nativeCheckpointConfig(configured as CustomModelConfig)
      : undefined;
    const configuredPercent = validPercent(configured?.compactionThresholdPercent);
    if (checkpoint?.tokenThreshold !== undefined) {
      // Reflect the effective capped share when maxOutputTokens + reserve cap tokenThreshold below 80%.
      result.compactionThresholdPercent = Math.round((checkpoint.tokenThreshold / result.maxTokens) * 100)
        || (configuredPercent ?? DEFAULT_COMPACTION_THRESHOLD_PERCENT);
      result.compactionSource = configuredPercent === undefined ? 'default' : 'custom';
      result.compactionAtTokens = checkpoint.tokenThreshold;
      const inUse = result.actualTokens ?? result.currentTokens;
      if (typeof inUse === 'number' && Number.isFinite(inUse)) {
        result.tokensUntilCompaction = Math.max(0, checkpoint.tokenThreshold - inUse);
        if (result.tokensPerTurn) {
          result.turnsUntilCompaction = Math.ceil(result.tokensUntilCompaction / result.tokensPerTurn);
        }
      }
    } else {
      result.compactionSource = 'ide';
    }
  }
  return result;
}
