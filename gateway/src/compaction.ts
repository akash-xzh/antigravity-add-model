import { logger } from './logger.js';
import { estimateMessageTokens, estimateSystemTokens, estimateTokens, estimateToolTokens } from './token-estimator.js';
import type { OpenAIMessage, MappedRequest, OpenAIContentPart } from './mapper.js';
import type { Router } from './router.js';
import { config } from './config.js';
import { getContextWindow } from './context-windows.js';
import { modelResolver } from './models.js';
import { validateCompactionEffort, type CompactionEffort } from './compaction-options.js';

const DEFAULT_THRESHOLD = 0.8;
const MIN_THRESHOLD = 0.05;
const MAX_THRESHOLD = 0.99;
const DEFAULT_TAIL_TURNS = 2;
const MIN_TAIL_TURNS = 1;
const MAX_TAIL_TURNS = 100;
const MAX_SUMMARY_CHUNKS = 12;
const TRUNCATION_MARKER = '\n...[truncated to fit context window]...\n';

const SUMMARIZATION_TEMPLATE = `You are a conversation summarizer. Summarize the following conversation history into a structured format. Preserve all important context, decisions, and current state.

Output format:
## Objective
- [what the user is trying to accomplish]

## Important Details
- [constraints, decisions, facts, assumptions]

## Work State
- Completed: [finished work, verified facts]
- Active: [current work, partial changes]
- Blocked: [blockers, failing commands]

## Next Move
1. [immediate concrete action]
2. [next action if known]

Conversation to summarize:
`;

export function needsCompaction(
  system: string,
  messages: OpenAIMessage[],
  tools?: Record<string, unknown>,
  contextWindow?: number,
  threshold: number = DEFAULT_THRESHOLD,
): boolean {
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) return false;
  const window = contextWindow && Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 128000;
  const maxTokens = Math.floor(window * threshold);
  const systemTokens = estimateSystemTokens(system);
  const messageTokens = estimateMessageTokens(messages);
  const toolTokens = estimateToolTokens(tools);
  const totalTokens = systemTokens + messageTokens + toolTokens;
  return totalTokens > maxTokens;
}

export function selectMessagesToCompact(
  messages: OpenAIMessage[],
  tailTurns: number = DEFAULT_TAIL_TURNS,
): { toCompact: OpenAIMessage[]; toPreserve: OpenAIMessage[] } {
  const safeTailTurns = Number.isFinite(tailTurns) && tailTurns >= MIN_TAIL_TURNS
    ? Math.floor(tailTurns)
    : DEFAULT_TAIL_TURNS;
  // Each turn is a user + assistant pair (2 messages)
  const preserveCount = safeTailTurns * 2;
  if (messages.length <= preserveCount) {
    return { toCompact: [], toPreserve: messages };
  }
  let boundary = messages.length - preserveCount;
  // Keep a tool-call assistant message together with every corresponding result.
  while (boundary > 0 && messages[boundary]?.role === 'tool') boundary--;
  const toPreserve = messages.slice(boundary);
  const toCompact = messages.slice(0, boundary);
  return { toCompact, toPreserve };
}

function formatMessageForSummary(msg: OpenAIMessage): string {
  const role = msg.role === 'user'
    ? '[User]'
    : msg.role === 'tool'
      ? '[Tool]'
      : msg.role === 'system'
        ? '[System]'
        : '[Assistant]';
  const content = typeof msg.content === 'string'
    ? msg.content
    : msg.content == null
      ? ''
      : JSON.stringify(msg.content);
  return `${role}: ${content}${msg.tool_calls ? '\nTool calls: ' + JSON.stringify(msg.tool_calls) : ''}`;
}

export function buildSummarizationPrompt(messages: OpenAIMessage[], existingSummary?: string): string {
  const serialized = messages.map(formatMessageForSummary).join('\n\n');
  return buildSummarizationPromptFromChunk(serialized, existingSummary);
}

function buildSummarizationPromptFromChunk(serializedChunk: string, existingSummary?: string): string {
  if (existingSummary) {
    return `${SUMMARIZATION_TEMPLATE}Previous summary of earlier conversation:\n${existingSummary}\n\nAdditional conversation to merge into the updated summary:\n${serializedChunk}`;
  }
  return SUMMARIZATION_TEMPLATE + serializedChunk;
}

function truncateStringToChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 0) return '';
  if (maxChars <= TRUNCATION_MARKER.length + 16) {
    return text.slice(0, maxChars);
  }
  const available = maxChars - TRUNCATION_MARKER.length;
  const headChars = Math.ceil(available * 0.6);
  const tailChars = Math.floor(available * 0.4);
  return text.slice(0, headChars) + TRUNCATION_MARKER + (tailChars > 0 ? text.slice(text.length - tailChars) : '');
}

function truncateMessageToTokenBudget(msg: OpenAIMessage, maxTokens: number): OpenAIMessage {
  const currentTokens = estimateMessageTokens([msg]);
  if (currentTokens <= maxTokens) return msg;

  let working: OpenAIMessage = { ...msg };
  if (working.reasoning_content) {
    const withoutReasoning: OpenAIMessage = { ...working, reasoning_content: undefined };
    delete withoutReasoning.reasoning_content;
    if (estimateMessageTokens([withoutReasoning]) <= maxTokens) {
      return withoutReasoning;
    }
    working = withoutReasoning;
  }

  const overheadTokens = estimateMessageTokens([{ ...working, content: '' }]);
  const contentTokenBudget = Math.max(0, maxTokens - overheadTokens);
  const maxChars = contentTokenBudget * 4;

  if (typeof working.content === 'string') {
    return { ...working, content: truncateStringToChars(working.content, maxChars) };
  }
  if (Array.isArray(working.content)) {
    let remainingChars = maxChars;
    const truncatedParts: OpenAIContentPart[] = [];
    for (const part of working.content) {
      if (remainingChars <= 0) break;
      if (part && part.type === 'text') {
        const text = truncateStringToChars(part.text, remainingChars);
        remainingChars = Math.max(0, remainingChars - text.length);
        truncatedParts.push({ ...part, text });
        continue;
      }
      // Non-text parts (large base64 image/audio URLs, embedded tool payloads,
      // and future part types) are charged in full by estimateMessageTokens
      // via JSON.stringify. Keep one only if it fits; otherwise replace it with
      // a short marker so a single data URL cannot silently overflow the budget.
      const partChars = JSON.stringify(part).length;
      if (partChars <= remainingChars) {
        truncatedParts.push(part);
        remainingChars -= partChars;
      } else {
        const marker = '[non-text content omitted to fit context window]';
        const text = truncateStringToChars(marker, remainingChars);
        if (text) truncatedParts.push({ type: 'text', text });
        remainingChars = 0;
      }
    }
    return { ...working, content: truncatedParts };
  }
  return working;
}

function groupAtomicMessages(messages: OpenAIMessage[]): OpenAIMessage[][] {
  const groups: OpenAIMessage[][] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const group: OpenAIMessage[] = [msg];
      i++;
      while (i < messages.length && messages[i].role === 'tool') {
        group.push(messages[i]);
        i++;
      }
      groups.push(group);
    } else {
      groups.push([msg]);
      i++;
    }
  }
  return groups;
}

function mergeTextIntoUserMessage(prefix: string, msg: OpenAIMessage): OpenAIMessage {
  if (typeof msg.content === 'string') {
    const content = msg.content ? `${prefix}\n\n${msg.content}` : prefix;
    return { ...msg, content };
  }
  if (Array.isArray(msg.content)) {
    return {
      ...msg,
      content: [{ type: 'text', text: `${prefix}\n\n` }, ...msg.content],
    };
  }
  return { ...msg, content: prefix };
}

function combineSummaryAndPreserved(
  summaryText: string | null,
  preserved: OpenAIMessage[],
): OpenAIMessage[] {
  let start = 0;
  while (start < preserved.length && preserved[start].role === 'tool') {
    start++;
  }
  const clean = start > 0 ? preserved.slice(start) : [...preserved];

  if (!summaryText) return clean;
  if (clean.length === 0) return [{ role: 'user', content: summaryText }];
  if (clean[0].role === 'user') {
    return [mergeTextIntoUserMessage(summaryText, clean[0]), ...clean.slice(1)];
  }
  return [{ role: 'user', content: summaryText }, ...clean];
}

function enforcePostCompactionBudget(
  summaryText: string | null,
  preserved: OpenAIMessage[],
  messageBudget: number,
): OpenAIMessage[] {
  let currentSummary = summaryText;
  let workingPreserve = preserved.map(m => ({ ...m }));
  let combined = combineSummaryAndPreserved(currentSummary, workingPreserve);
  if (estimateMessageTokens(combined) <= messageBudget) {
    return combined;
  }

  // Pass 1: Truncate oversized tool outputs in preserved messages (largest first)
  let excess = estimateMessageTokens(combined) - messageBudget;
  const toolIndices = workingPreserve
    .map((m, idx) => ({ idx, tokens: m.role === 'tool' ? estimateMessageTokens([m]) : 0 }))
    .filter(item => item.tokens > 64)
    .sort((a, b) => b.tokens - a.tokens);

  for (const item of toolIndices) {
    if (excess <= 0) break;
    const minKeep = 64;
    const reducible = Math.max(0, item.tokens - minKeep);
    if (reducible === 0) continue;
    const cut = Math.min(reducible, excess);
    workingPreserve[item.idx] = truncateMessageToTokenBudget(workingPreserve[item.idx], item.tokens - cut);
    combined = combineSummaryAndPreserved(currentSummary, workingPreserve);
    excess = estimateMessageTokens(combined) - messageBudget;
  }
  if (excess <= 0) return combined;

  // Pass 2: Drop oldest atomic groups from preserved history (keeping at least the latest group)
  const groups = groupAtomicMessages(workingPreserve);
  while (groups.length > 1) {
    groups.shift();
    if (!currentSummary) {
      currentSummary = '[Context compacted - earlier conversation truncated]';
    }
    workingPreserve = groups.flat();
    combined = combineSummaryAndPreserved(currentSummary, workingPreserve);
    if (estimateMessageTokens(combined) <= messageBudget) {
      return combined;
    }
  }

  // Pass 3: Cap summary size to at most 35% of the remaining message budget
  if (currentSummary) {
    const maxSummaryChars = Math.max(64, Math.floor(messageBudget * 0.35) * 4);
    if (currentSummary.length > maxSummaryChars) {
      currentSummary = truncateStringToChars(currentSummary, maxSummaryChars);
      combined = combineSummaryAndPreserved(currentSummary, workingPreserve);
      if (estimateMessageTokens(combined) <= messageBudget) {
        return combined;
      }
    }
  }

  // Pass 4: Directly truncate remaining oversized messages so total fits within messageBudget
  excess = estimateMessageTokens(combined) - messageBudget;
  const ranked = combined
    .map((m, idx) => ({ idx, tokens: estimateMessageTokens([m]) }))
    .sort((a, b) => b.tokens - a.tokens);

  for (const item of ranked) {
    if (excess <= 0) break;
    const minKeep = 8;
    const reducible = Math.max(0, item.tokens - minKeep);
    if (reducible === 0) continue;
    const cut = Math.min(reducible, excess);
    combined[item.idx] = truncateMessageToTokenBudget(combined[item.idx], item.tokens - cut);
    excess = estimateMessageTokens(combined) - messageBudget;
  }

  // Pass 5 (final guarantee): a non-text array part (e.g. one huge base64 image)
  // can survive every earlier pass inside the only preserved message. Strip such
  // payloads, then drop oldest messages if needed. This pass must run whenever
  // the budget is still violated — returning an overflowing `combined` here was
  // the original hole.
  if (estimateMessageTokens(combined) > messageBudget) {
    combined = combined.map(msg => {
      const stripped: OpenAIMessage = { ...msg };
      delete stripped.reasoning_content;
      if (Array.isArray(stripped.content)) {
        let firstText = '';
        for (const part of stripped.content) {
          if (part && part.type === 'text' && typeof part.text === 'string') {
            firstText = part.text;
            break;
          }
        }
        stripped.content = [
          { type: 'text', text: truncateStringToChars(firstText || '[non-text content omitted]', 64) },
        ];
      } else if (typeof stripped.content === 'string') {
        stripped.content = truncateStringToChars(stripped.content, 64);
      }
      if (stripped.tool_calls) {
        stripped.tool_calls = stripped.tool_calls.map(tc => ({
          ...tc,
          function: { ...tc.function, arguments: truncateStringToChars(tc.function.arguments || '', 64) },
        }));
      }
      return stripped;
    });
  }
  while (combined.length > 1 && estimateMessageTokens(combined) > messageBudget) {
    combined.shift();
  }
  if (estimateMessageTokens(combined) > messageBudget) {
    // Smallest possible payload: one bare message (4 role-overhead tokens).
    const only = combined[combined.length - 1] || { role: 'user' as const, content: '' };
    combined = [{ role: only.role, content: '' }];
  }
  // Final assertion: every caller relies on this being a hard bound.
  const assertedTokens = estimateMessageTokens(combined);
  if (assertedTokens > messageBudget) {
    logger.warn(`[compaction] Could not enforce message budget: ${assertedTokens} > ${messageBudget}`);
  }
  return combined;
}

function splitOversizedFormattedMessage(text: string, maxChunkTokens: number): string[] {
  const maxChars = Math.max(256, maxChunkTokens * 4);
  if (text.length <= maxChars) return [text];

  const colonIdx = text.indexOf(': ');
  const prefix = colonIdx > 0 && colonIdx < 24 ? `${text.slice(0, colonIdx)} (continued): ` : '';
  const slices: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    const slicePrefix = offset === 0 ? '' : prefix;
    const budget = Math.max(64, maxChars - slicePrefix.length);
    slices.push(slicePrefix + text.slice(offset, offset + budget));
    offset += budget;
  }
  return slices;
}

export function chunkMessagesForSummary(
  messages: OpenAIMessage[],
  maxChunkTokens: number,
  maxChunks: number = MAX_SUMMARY_CHUNKS,
): string[] {
  const safeBudget = Math.max(64, Math.floor(maxChunkTokens));
  const units: string[] = [];
  for (const msg of messages) {
    const formatted = formatMessageForSummary(msg);
    if (estimateTokens(formatted) > safeBudget) {
      units.push(...splitOversizedFormattedMessage(formatted, safeBudget));
    } else {
      units.push(formatted);
    }
  }

  const chunks: string[] = [];
  let current = '';
  for (const unit of units) {
    const candidate = current ? `${current}\n\n${unit}` : unit;
    if (current && estimateTokens(candidate) > safeBudget) {
      chunks.push(current);
      current = unit;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  if (chunks.length <= maxChunks) return chunks;

  // Guard explicitly: with maxChunks === 1, slice(-(1 - 1)) === slice(-0) ===
  // slice(0), which duplicated every chunk instead of keeping only the tail.
  const safeMaxChunks = Number.isFinite(maxChunks) && maxChunks > 1 ? Math.floor(maxChunks) : 1;
  if (safeMaxChunks === 1) {
    const omittedCount = chunks.length - 1;
    const marker = `[...${omittedCount} intermediate conversation chunk(s) omitted to fit summarization budget...]\n\n${chunks[chunks.length - 1]}`;
    return [truncateStringToChars(marker, safeBudget * 4)];
  }
  const keptTail = chunks.slice(-(safeMaxChunks - 1));
  const omittedCount = chunks.length - safeMaxChunks;
  return [
    chunks[0],
    `[...${omittedCount} intermediate conversation chunk(s) omitted to fit summarization budget...]\n\n${keptTail[0]}`,
    ...keptTail.slice(1),
  ].map(c => truncateStringToChars(c, safeBudget * 4));
}

function getEnabledProviderIds(): string[] {
  return config.providers
    .filter(p => p.enabled)
    .sort((a, b) => a.priority - b.priority)
    .map(p => p.id);
}

async function runSummaryRequest(
  prompt: string,
  providerIds: string[],
  compactionModel: string,
  router: Router,
  effort: CompactionEffort,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<string> {
  let summary = '';
  const gen = router.execute(
    providerIds,
    compactionModel,
    [{ role: 'user', content: prompt }],
    undefined,
    {
      maxTokens,
      ...(effort === 'inherit' ? { temperature: 0.3 } : {
        providerOptions: { openai: { reasoningEffort: effort } },
        compactionEffort: effort,
      }),
    },
    signal,
  );

  for await (const chunk of gen) {
    if (chunk.type === 'text') summary += chunk.content || '';
    if (chunk.type === 'error') throw new Error(chunk.content || 'compaction LLM error');
  }

  if (!summary.trim()) {
    throw new Error('Empty summary from LLM');
  }
  return summary;
}

/**
 * Attempt LLM-powered compaction. Falls back to truncation on failure.
 * Returns the mapped request with messages compacted if needed.
 */
export async function compactIfNeeded(
  mapped: MappedRequest,
  model: string,
  router: Router,
  signal?: AbortSignal,
): Promise<MappedRequest> {
  if (mapped.compactionEffort) return mapped;
  const cfg = getCompactionConfig();
  if (!cfg.enabled) return mapped;

  const contextWindow = getContextWindow(model);
  const system = mapped.system || '';
  const tools = mapped.tools as Record<string, unknown> | undefined;

  if (!needsCompaction(system, mapped.messages, tools, contextWindow, cfg.threshold)) {
    return mapped;
  }

  logger.info(`[compaction] Compaction needed for model ${model} (window: ${contextWindow})`);

  const systemTokens = estimateSystemTokens(system);
  const toolTokens = estimateToolTokens(tools);
  const fixedTokens = systemTokens + toolTokens;
  const outputReserve = mapped.maxTokens && Number.isFinite(mapped.maxTokens) && mapped.maxTokens > 0
    ? Math.min(mapped.maxTokens, Math.floor(contextWindow * 0.2))
    : Math.min(4096, Math.floor(contextWindow * 0.1));
  const hardInputBudget = Math.max(1, contextWindow - outputReserve);
  const messageBudget = Math.max(16, hardInputBudget - fixedTokens);

  let { toCompact, toPreserve } = selectMessagesToCompact(mapped.messages, cfg.tailTurns);

  // Avoid the short-message bypass when <= tailTurns * 2 messages still overflow the window:
  // move older atomic groups into toCompact so they can be summarized instead of returning uncompacted.
  if (toCompact.length === 0) {
    const groups = groupAtomicMessages(mapped.messages);
    if (groups.length > 1) {
      let splitGroup = 0;
      const targetPreserve = Math.floor(messageBudget * 0.65);
      while (splitGroup < groups.length - 1) {
        splitGroup++;
        const remaining = groups.slice(splitGroup).flat();
        if (estimateMessageTokens(remaining) <= targetPreserve) break;
      }
      toCompact = groups.slice(0, splitGroup).flat();
      toPreserve = groups.slice(splitGroup).flat();
    } else {
      // Single atomic group still exceeds the threshold/budget: enforce budget via truncation.
      const enforced = enforcePostCompactionBudget(null, toPreserve, messageBudget);
      return { ...mapped, messages: enforced };
    }
  }

  // If preserved tail itself is already close to or over budget, shift older tail groups into toCompact
  // so they are summarized rather than dropped after summarization.
  const preserveTarget = Math.floor(messageBudget * 0.75);
  if (estimateMessageTokens(toPreserve) > preserveTarget) {
    const preserveGroups = groupAtomicMessages(toPreserve);
    while (preserveGroups.length > 1 && estimateMessageTokens(preserveGroups.flat()) > preserveTarget) {
      toCompact = [...toCompact, ...preserveGroups.shift()!];
    }
    toPreserve = preserveGroups.flat();
  }

  const compactionModel = cfg.model || model;
  const compactionWindow = getContextWindow(compactionModel);
  const summaryOutputTokens = Math.min(2048, Math.max(64, Math.floor(compactionWindow * 0.2)));
  const templateTokens = estimateTokens(SUMMARIZATION_TEMPLATE) + 32;
  const rollingSummaryReserve = Math.min(summaryOutputTokens, Math.floor(compactionWindow * 0.15));
  const singleShotBudget = Math.max(128, Math.floor(compactionWindow * 0.8) - summaryOutputTokens - templateTokens);
  const serializedFull = toCompact.map(formatMessageForSummary).join('\n\n');
  const chunks = estimateTokens(serializedFull) <= singleShotBudget
    ? [serializedFull]
    : chunkMessagesForSummary(
      toCompact,
      Math.max(128, singleShotBudget - rollingSummaryReserve),
    );

  try {
    const providerIds = getEnabledProviderIds();
    let rollingSummary: string | undefined;

    for (let i = 0; i < chunks.length; i++) {
      const priorSummary = rollingSummary
        ? truncateStringToChars(rollingSummary, Math.max(256, rollingSummaryReserve * 4))
        : undefined;
      const prompt = buildSummarizationPromptFromChunk(chunks[i], priorSummary);
      rollingSummary = await runSummaryRequest(
        prompt,
        providerIds,
        compactionModel,
        router,
        cfg.effort,
        summaryOutputTokens,
        signal,
      );
    }

    const summary = rollingSummary || '';
    if (!summary.trim()) {
      throw new Error('Empty summary from LLM');
    }

    logger.info(`[compaction] LLM summary obtained (${summary.length} chars, ${chunks.length} chunk(s))`);

    const compactedMessages = enforcePostCompactionBudget(
      `[Context compacted]\n${summary}`,
      toPreserve,
      messageBudget,
    );

    return { ...mapped, messages: compactedMessages };
  } catch (err: any) {
    if (signal?.aborted) throw err;
    logger.warn(`[compaction] LLM summarization failed, falling back to truncation: ${err.message}`);
    const fallbackMessages = enforcePostCompactionBudget(
      '[Context compacted - earlier conversation truncated]',
      toPreserve,
      messageBudget,
    );
    return { ...mapped, messages: fallbackMessages };
  }
}

function parseThreshold(raw: string | undefined, fallback: number): number {
  const value = raw !== undefined && raw.trim() !== '' ? Number.parseFloat(raw) : fallback;
  if (!Number.isFinite(value)) {
    logger.warn(`[compaction] Invalid COMPACTION_THRESHOLD '${raw}', falling back to ${DEFAULT_THRESHOLD}`);
    return DEFAULT_THRESHOLD;
  }
  if (value <= 0 || value >= 1) {
    const clamped = Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, value));
    logger.warn(`[compaction] Out-of-range COMPACTION_THRESHOLD ${value}, clamping to ${clamped}`);
    return clamped;
  }
  return value;
}

function parseTailTurns(raw: string | undefined, fallback: number): number {
  const value = raw !== undefined && raw.trim() !== '' ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isFinite(value)) {
    logger.warn(`[compaction] Invalid COMPACTION_TAIL_TURNS '${raw}', falling back to ${DEFAULT_TAIL_TURNS}`);
    return DEFAULT_TAIL_TURNS;
  }
  if (value < MIN_TAIL_TURNS) {
    logger.warn(`[compaction] Out-of-range COMPACTION_TAIL_TURNS ${value}, clamping to ${MIN_TAIL_TURNS}`);
    return MIN_TAIL_TURNS;
  }
  return Math.min(MAX_TAIL_TURNS, Math.floor(value));
}

function parseEffort(raw: string | undefined, fallback: CompactionEffort): CompactionEffort {
  const candidate = raw !== undefined && raw.trim() !== '' ? raw.trim() : fallback;
  try {
    return validateCompactionEffort(candidate);
  } catch {
    logger.warn(`[compaction] Invalid COMPACTION_REASONING_EFFORT '${candidate}', falling back to 'inherit'`);
    return 'inherit';
  }
}

export function getCompactionConfig() {
  return {
    enabled: process.env.COMPACTION_ENABLED !== 'false' && modelResolver.compactionEnabled,
    threshold: parseThreshold(process.env.COMPACTION_THRESHOLD, modelResolver.compactionThreshold),
    tailTurns: parseTailTurns(process.env.COMPACTION_TAIL_TURNS, modelResolver.compactionTailTurns),
    model: process.env.COMPACTION_MODEL || modelResolver.compactionModel,
    effort: parseEffort(process.env.COMPACTION_REASONING_EFFORT, modelResolver.compactionReasoningEffort),
  };
}
