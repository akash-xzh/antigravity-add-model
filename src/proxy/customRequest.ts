import * as http from 'http';
import * as https from 'https';
import { createHash, randomUUID } from 'crypto';
import { StringDecoder } from 'string_decoder';
import type { CustomModel } from '../proxy';
import { describeOpencodeAccessError, isOpencodeEndpoint, resolveApiFormat } from '../providers';
import {
  acquireGoogleAccount,
  googleAccountEndpoint,
  GoogleAccountError,
  GoogleAccountLease,
  GOOGLE_CLOUD_CODE_USER_AGENT,
} from '../googleAccounts';
import { classifyGoogleRateLimit, type GoogleRateLimitDecision } from '../googlePoolPolicy';
import { describeGoogleAccessError } from '../googleAccessErrors';
import { beginDiagnosticRequest } from '../diagnostics';
import * as registry from './registry';
import { CircuitBreaker } from './circuitBreaker';
import {
  appendModelSystemPrompt,
  applyRequestOptions,
  GeminiBody,
  isAntigravityCompactionRequest,
  parseRetryAfter,
  trimContext,
} from './requestOptions';
import { activeStreamContexts, modelReasoningContent, modelToolCallIds, stateTimestamps } from './shared';
import { collectToolSchemas } from './translators/utils';
import { collectArtifactContext } from './artifactMetadata';
import { captureSystemPrompt, withGlobalSystemPrompt } from './globalPrompt';
import { recordModelSuccess, recordModelFailure } from './modelHealth';
import { omitUnsupportedToolImages } from './translators/images';
import { detectModelCapabilities } from './modelUtils';
import { subagentRouting, SubagentRoutingError } from './subagentRouting';
import { resolveConfiguredSubagentModel } from './subagentModels';
import { isGoogleQuotaFailure } from './googlePoolFailover';
import { reasoningReplayCache } from './reasoningReplay';
import { clearConversationUsage, recordConversationUsage } from './conversationUsage';

const circuits = new CircuitBreaker();
export interface CompactionEvent {
  conversationId?: string;
  modelName: string;
  isCustom: boolean;
  at: number;
}
let compactionNotifier: ((event: CompactionEvent) => void) | undefined;
const lastCompactionNotifyAt = new Map<string, number>();

export function setCompactionNotifier(fn?: (event: CompactionEvent) => void): void {
  compactionNotifier = fn;
}

export function notifyCompactionIfNeeded(
  body: unknown,
  modelName: string,
  isCustom: boolean,
  conversationId?: string,
): boolean {
  if (!isAntigravityCompactionRequest(body as GeminiBody)) return false;
  const now = Date.now();
  const key = conversationId || modelName || 'default';
  const prev = lastCompactionNotifyAt.get(key) || 0;
  if (now - prev >= 15_000) {
    lastCompactionNotifyAt.set(key, now);
    if (lastCompactionNotifyAt.size > 200) {
      const oldest = lastCompactionNotifyAt.keys().next().value;
      if (oldest) lastCompactionNotifyAt.delete(oldest);
    }
    try {
      compactionNotifier?.({ conversationId, modelName, isCustom, at: now });
    } catch {
      /* Notification hook must never disrupt generation. */
    }
  }
  return true;
}
/**
 * Endpoints that rejected stream_options.include_usage. Scoped by model + endpoint + format and
 * time-limited: one old error must not silently disable usage telemetry for the process lifetime.
 */
const usageOptOut = new Map<string, number>();
const USAGE_OPT_OUT_TTL_MS = 5 * 60_000;
const usageOptOutKey = (model: { name: string; apiUrl: string }, format: string) =>
  `${model.name}\n${model.apiUrl}\n${format}`;
function hasUsageOptOut(key: string): boolean {
  const at = usageOptOut.get(key);
  if (at === undefined) return false;
  if (Date.now() - at > USAGE_OPT_OUT_TTL_MS) {
    usageOptOut.delete(key);
    return false;
  }
  return true;
}
const controllers = new Set<AbortController>();
const counts = {
  requests: 0,
  active: 0,
  succeeded: 0,
  failed: 0,
  cancelled: 0,
  upstreamAttempts: 0,
  retries: 0,
  fallbacks: 0,
  circuitSkips: 0,
  accountSwitches: 0,
};
export function getProxyMetrics() {
  return { ...counts, circuits: circuits.snapshot() };
}
export function stopCustomRequests(): void {
  for (const controller of controllers) controller.abort();
  reasoningReplayCache.clear();
}

class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly retryable = true,
    readonly retryAfter = 0,
    readonly mayFallback = true,
    readonly googleRateLimit?: GoogleRateLimitDecision,
  ) {
    super(message);
  }
}
function asUpstreamError(error: unknown): UpstreamError {
  if (error instanceof SubagentRoutingError) return new UpstreamError(error.message, error.status, false, 0, false);
  if (error instanceof GoogleAccountError) return new UpstreamError(error.message, error.status, false);
  return error instanceof UpstreamError ? error : new UpstreamError('Upstream connection failed.');
}
function clearRequestState(key: string): void {
  activeStreamContexts.delete(key);
  modelReasoningContent.delete(key);
  modelToolCallIds.delete(key);
  for (const timestamps of Object.values(stateTimestamps)) timestamps.delete(key);
}
function envelope(value: unknown, cloud: boolean): unknown {
  return cloud ? { response: value, traceId: '', metadata: {} } : value;
}
function validateToolArguments(value: unknown): void {
  let parsed: unknown = value;
  try {
    if (typeof value === 'string') parsed = JSON.parse(value || '{}');
  } catch {
    throw new UpstreamError('Upstream returned incomplete tool arguments.', 502, false, 0, false);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new UpstreamError('Upstream returned invalid tool arguments.', 502, false, 0, false);
}

/** Read only a bounded error body for classification; never expose or persist its contents. */
async function boundedErrorBody(upstream: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  const limit = 16 * 1024;
  const timer = setTimeout(() => upstream.destroy(), 1000);
  timer.unref();
  try {
    for await (const chunk of upstream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const bounded = bytes.subarray(0, limit - size);
      chunks.push(bounded);
      size += bounded.length;
      if (size >= limit) break;
    }
  } catch {
    // Diagnostics must not replace the original HTTP status on a broken response.
  } finally {
    clearTimeout(timer);
    upstream.destroy();
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

/** Detect provider context-window overflow responses without echoing provider payloads. */
function isContextLengthExceeded(status: number, body: string): boolean {
  if (status === 413) return true;
  // 422 is the shape several OpenAI-compatible providers use for context overflow.
  if (status !== 400 && status !== 422) return false;
  return /(?:context_length_exceeded|maximum context length|too many tokens|prompt is too long|request too large|exceeds the maximum)/i.test(
    body,
  );
}

/** Classify schema errors without returning provider text, credentials or echoed prompts. */
function toolSchemaErrorHint(body: string): string {
  let message = body;
  if (message.startsWith('{') || message.startsWith('[')) {
    try {
      const data = JSON.parse(message) as {
        message?: unknown;
        error?: { message?: unknown };
        errors?: { message?: unknown }[];
      };
      message = [
        data?.message,
        data?.error?.message,
        ...(Array.isArray(data?.errors) ? data.errors.map((item) => item?.message) : []),
      ]
        .filter((value): value is string => typeof value === 'string')
        .join('\n');
    } catch {
      return '';
    }
  }
  if (!/\b(?:schema|parameters)\b/i.test(message) || !/\b(?:invalid|rejected|not of type|must be)\b/i.test(message))
    return '';
  const bounds = [
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'minProperties',
    'maxProperties',
    'minContains',
    'maxContains',
  ].filter((keyword) => new RegExp(`\\b${keyword}\\b`).test(message));
  return bounds.length
    ? ` Tool schema rejected; check non-negative integer constraints (${bounds.join(', ')}).`
    : ' Tool schema rejected; check the declared parameter types and constraints.';
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Cancelled'));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(new Error('Cancelled'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
function waitForDrain(res: http.ServerResponse): Promise<void> {
  if (!res.writableNeedDrain) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const drain = () => {
      res.removeListener('close', closed);
      resolve();
    };
    const closed = () => {
      res.removeListener('drain', drain);
      reject(new Error('Cancelled'));
    };
    res.once('drain', drain);
    res.once('close', closed);
  });
}

export function buildFallbackChain(primary: CustomModel, allModels: CustomModel[]): CustomModel[] {
  const names = new Set([primary.name]);
  const chain = [primary];
  for (const name of primary.fallbackModels || []) {
    const model = allModels.find((candidate) => candidate.name === name && candidate.enabled !== false);
    if (model && !names.has(name)) {
      names.add(name);
      chain.push(model);
    }
  }
  return chain;
}

/** The sole retry/fallback owner; nothing is retried after any model output was received. */
export async function runCustomModelRequest(
  res: http.ServerResponse,
  primary: CustomModel,
  originalBody: GeminiBody,
  isStream: boolean,
  allModels: CustomModel[],
  cloudEnvelope = true,
  kind: 'request' | 'generation-test' = 'request',
  prePrepared?: ReturnType<typeof subagentRouting.prepareRequest>,
): Promise<void> {
  const resolveSubagent = (selector: string) => resolveConfiguredSubagentModel(allModels, selector)?.name;
  let prepared: ReturnType<typeof subagentRouting.prepareRequest>;
  if (prePrepared) {
    prepared = prePrepared;
    originalBody = prepared.body;
    if (prepared.modelName) primary = resolveConfiguredSubagentModel(allModels, prepared.modelName) ?? primary;
  } else {
    try {
      prepared = subagentRouting.prepareRequest(originalBody, resolveSubagent, primary.name);
      originalBody = prepared.body;
      if (prepared.modelName) primary = resolveConfiguredSubagentModel(allModels, prepared.modelName)!;
    } catch (error) {
      res.writeHead(error instanceof SubagentRoutingError ? error.status : 400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            message: error instanceof SubagentRoutingError ? error.message : 'Invalid subagent routing request.',
          },
        }),
      );
      return;
    }
  }
  // Resolve once before trimming/translating; retries and fallback providers
  // must preserve the primary model's choice for this compaction operation.
  const isCompaction = notifyCompactionIfNeeded(
    originalBody,
    primary.displayName || primary.name,
    true,
    prepared.context.conversationId,
  );
  const compactionEffort = isCompaction ? primary.compactionReasoningEffort : undefined;
  const toolSchemas = collectToolSchemas(originalBody);
  const artifactContext = collectArtifactContext(originalBody, toolSchemas);
  const controller = new AbortController();
  const { signal } = controller;
  const requestId = randomUUID();
  controllers.add(controller);
  counts.requests += 1;
  counts.active += 1;
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.once('close', onClose);
  let completed = false;
  let upstreamOutput = false;
  // Decode speed is measured on the first-to-last content chunk, excluding time to first token.
  let streamStartedAt = 0;
  let firstChunkAt = 0;
  let lastChunkAt = 0;
  const deadline = Date.now() + (primary.retryBudgetMs ?? Math.max(primary.timeout ?? 120_000, 120_000));
  let failure = new UpstreamError('No configured model is currently available.', 503);
  let effectiveModel = primary;
  const diagnostic = beginDiagnosticRequest({
    model: primary.name,
    provider: primary.provider,
    stream: isStream,
    kind,
  });

  const writeCandidate = (candidate: unknown) => {
    if (signal.aborted || res.destroyed) throw new Error('Cancelled');
    prepared.context.modelName = effectiveModel.name;
    const routed = subagentRouting.rewriteCandidate(candidate, prepared.context, resolveSubagent);
    if (!res.headersSent)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      });
    res.write(`data: ${JSON.stringify(envelope({ candidates: [routed] }, cloudEnvelope))}\n\n`);
  };
  /** Real provider usage: Antigravity records it per step only when the response carries it. */
  const writeUsage = () => {
    const measured = diagnostic.usage();
    if (isCompaction) {
      clearConversationUsage(prepared.context.conversationId);
    } else {
      recordConversationUsage(prepared.context.conversationId, {
        ...measured,
        ttftMs: firstChunkAt ? firstChunkAt - streamStartedAt : undefined,
        decodeMs: firstChunkAt && lastChunkAt > firstChunkAt ? lastChunkAt - firstChunkAt : undefined,
      });
    }
    if (measured.inputTokens === undefined && measured.outputTokens === undefined) return;
    if (signal.aborted || res.destroyed) return;
    const usageMetadata = {
      promptTokenCount: measured.inputTokens ?? 0,
      candidatesTokenCount: measured.outputTokens ?? 0,
      totalTokenCount: (measured.inputTokens ?? 0) + (measured.outputTokens ?? 0),
      ...(measured.cachedTokens !== undefined ? { cachedContentTokenCount: measured.cachedTokens } : {}),
    };
    if (!res.headersSent)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      });
    res.write(`data: ${JSON.stringify(envelope({ usageMetadata }, cloudEnvelope))}\n\n`);
  };

  try {
    const chain = buildFallbackChain(primary, allModels);
    modelLoop: for (let modelIndex = 0; modelIndex < chain.length; modelIndex++) {
      const model = chain[modelIndex];
      if (signal.aborted) break;
      if (Date.now() >= deadline) {
        failure = new UpstreamError('Request retry budget exhausted.', 504, false);
        break;
      }
      // Include transport configuration so editing a broken endpoint does not retain its open circuit.
      const circuitKey = JSON.stringify([model.name, model.apiUrl, model.apiFormat || model.provider]);
      if (!circuits.acquire(circuitKey, model.circuitBreaker)) {
        counts.circuitSkips += 1;
        continue;
      }
      let circuitPending = true;
      const settleCircuit = (outcome: 'succeed' | 'fail' | 'cancel') => {
        if (!circuitPending) return;
        circuitPending = false;
        if (outcome === 'succeed') circuits.succeed(circuitKey);
        else if (outcome === 'fail') circuits.fail(circuitKey, model.circuitBreaker);
        else circuits.cancel(circuitKey);
      };
      try {
        if (modelIndex > 0) counts.fallbacks += 1;
        let modelFailed = false;
        const retries = kind === 'generation-test' ? 0 : Math.min(5, Math.max(0, model.maxRetries ?? 3));
        const cloudCode = model.provider === 'google-cloudcode';
        const opencode = !cloudCode && isOpencodeEndpoint(model.apiUrl, model.provider);
        const accountCount =
          cloudCode && kind !== 'generation-test'
            ? (model.googleAccounts || []).filter((account) => account.enabled !== false).length
            : 0;
        const attemptsAllowed = retries + Math.max(0, accountCount - 1);
        let accountSwitchesUsed = 0;
        let retriesUsed = 0;
        for (let attempt = 0; attempt <= attemptsAllowed; attempt++) {
          const stateKey = randomUUID();
          let replayReasoning = '';
          const replayCalls: unknown[] = [];
          let replayOverflow = false;
          const observeCandidate = (candidate: unknown) => {
            const parts = (candidate as { content?: { parts?: Record<string, unknown>[] } })?.content?.parts;
            for (const part of parts || []) {
              if (replayOverflow) break;
              if (part.thought === true && typeof part.text === 'string') replayReasoning += part.text;
              if (part.functionCall) replayCalls.push(part);
              if (replayReasoning.length > 256 * 1024 || replayCalls.length > 128) {
                replayOverflow = true;
                replayReasoning = '';
                replayCalls.length = 0;
              }
            }
          };
          let request: http.ClientRequest | undefined;
          let accountLease: GoogleAccountLease | undefined;
          let totalTimer: ReturnType<typeof setTimeout> | undefined;
          let headerLatencyMs: number | undefined;
          let timeoutFailure: UpstreamError | undefined;
          const abort = () => request?.destroy(new Error('Cancelled'));
          const triggerTimeout = (message: string) => {
            const err = new UpstreamError(message, 504);
            timeoutFailure = err;
            request?.destroy(err);
          };
          try {
            if (signal.aborted) break;
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new UpstreamError('Request retry budget exhausted.', 504, false);
            effectiveModel = model;
            diagnostic.resetUsage();
            const format = resolveApiFormat(model.provider, model.apiFormat);
            const externalName = model.externalModelName || model.name.replace(/^models\//, '');
            if (cloudCode) {
              const identity = originalBody.sessionId || originalBody.conversationId;
              accountLease = await acquireGoogleAccount(
                model.name,
                model.googleAccounts || [],
                model.googlePool,
                typeof identity === 'string' ? identity : undefined,
                externalName.replace(/^models\//, ''),
                model.apiUrl,
              );
              if (signal.aborted) break;
            }
            let payload: Record<string, unknown>;
            let url: URL;
            let headers: registry.ProviderHeaders;
            try {
              const cap = detectModelCapabilities(model);
              let outputBudget =
                model.maxOutputTokens ??
                Number(
                  originalBody.generationConfig?.maxOutputTokens ||
                    (model.contextWindow
                      ? Math.min(cap.maxOutputTokens, Math.max(1, Math.floor(model.contextWindow / 4)))
                      : 0),
                );
              if (!Number.isFinite(outputBudget) || outputBudget < 0) outputBudget = 0;
              if (model.contextWindow && outputBudget >= model.contextWindow) {
                outputBudget = Math.max(1, Math.min(cap.maxOutputTokens, Math.floor(model.contextWindow / 4)));
              }
              // The IDE can omit thought parts when replaying completed tool calls.
              // Recover only this conversation/provider's matching turn before budgeting.
              const history = format === 'openai' ? reasoningReplayCache.restore(originalBody, model) : originalBody;
              // Each attempt uses its own model's prompt, so a fallback never inherits the
              // primary's. The operator's global prompt sits between the IDE instruction
              // and the model's own text, and is added before trimming so it is counted.
              captureSystemPrompt(history);
              const prompted = appendModelSystemPrompt(withGlobalSystemPrompt(history), model.systemPrompt);
              // A text-only provider fails the whole request when it receives an image,
              // so strip tool-result media the model cannot use before trimming and
              // translating. Google's native format already carried nested tool media,
              // so it keeps its bytes to stay identical to the pre-fix behaviour.
              // Replayed thought parts sit on model turns and the guard only rewrites
              // user tool results, so the order here does not affect recovery.
              const guardedBody =
                format === 'google'
                  ? prompted
                  : omitUnsupportedToolImages(prompted, detectModelCapabilities(model).supportsImages);
              let body: GeminiBody;
              try {
                // Without a declared window, use the detected capability so a 500k
                // chat is still trimmed before reaching a smaller provider limit.
                const effectiveContextWindow = model.contextWindow ||
                  (Number.isSafeInteger(cap.maxTokens) ? cap.maxTokens : undefined);
                body = trimContext(guardedBody, effectiveContextWindow, outputBudget, { marker: true });
              } catch (trimError) {
                // Allow a configured larger-context fallback model to take over.
                throw new UpstreamError(
                  `Context exceeds the configured contextWindow: ${(trimError as Error).message}`,
                  400,
                  false,
                  0,
                  true,
                );
              }
              const effectiveModel = outputBudget ? { ...model, maxOutputTokens: outputBudget } : model;
              payload = applyRequestOptions(
                registry.translateRequest(model.provider, body, externalName, format, stateKey) as Record<
                  string,
                  unknown
                >,
                effectiveModel,
                format,
                isStream,
                compactionEffort,
              );
              // OpenAI-compatible endpoints report tokens only when asked; retried without it
              // if the provider rejects the field.
              if (format === 'openai' && isStream && !hasUsageOptOut(usageOptOutKey(model, format)) && payload.stream_options === undefined)
                payload.stream_options = { include_usage: true };
              const target =
                cloudCode || model.rawUrl
                  ? model.apiUrl
                  : registry.getProviderUrl(
                      model.apiUrl,
                      externalName,
                      isStream,
                      registry.getTranslator(model.provider, format),
                    );
              url = new URL(target);
              if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported endpoint protocol');
              headers = registry.getProviderHeaders(model.provider, cloudCode ? '' : model.apiKey, format, model.apiUrl);
              if (accountLease) {
                url = new URL(googleAccountEndpoint(accountLease.account, model.apiUrl));
                if (accountLease.account.authMode === 'antigravity' && !accountLease.account.project)
                  throw new Error('Prepare this Antigravity account in the model manager before generating a response');
                url.pathname = `/v1internal:${isStream ? 'streamGenerateContent' : 'generateContent'}`;
                url.search = isStream ? '?alt=sse' : '';
                headers.Authorization = `Bearer ${accountLease.account.accessToken}`;
                headers['User-Agent'] = GOOGLE_CLOUD_CODE_USER_AGENT;
                const project = accountLease.account.project || model.googleProject;
                payload = { model: externalName, ...(project ? { project } : {}), request: payload };
              }
              if (opencode) {
                const identity = originalBody.sessionId || originalBody.conversationId;
                // Preserve conversation affinity without putting arbitrary Unicode or control characters in a header.
                headers['x-opencode-session'] =
                  typeof identity === 'string' && identity.trim()
                    ? createHash('sha256').update(identity).digest('hex')
                    : requestId;
              }
              if (model.gateway) {
                const identity = originalBody.conversationId || originalBody.sessionId;
                if (typeof identity === 'string' && identity.trim()) {
                  // Stable across turns and safe as a header, even when callers use Unicode/control characters.
                  headers['x-antigravity-conversation-id'] = createHash('sha256').update(identity).digest('hex');
                }
              }
              for (const [key, value] of Object.entries(model.customHeaders || {})) {
                if (/^(host|content-length|connection|transfer-encoding)$/i.test(key))
                  throw new Error('Reserved HTTP header');
                if (cloudCode && /^authorization$/i.test(key))
                  throw new Error('Google pool authorization comes from the selected account');
                http.validateHeaderName(key);
                http.validateHeaderValue(key, value);
                headers[key] = value;
              }
            } catch (error) {
              if (error instanceof UpstreamError) throw error;
              throw new UpstreamError(`Invalid model configuration: ${(error as Error).message}`, 400, false, 0, false);
            }
            counts.upstreamAttempts += 1;
            const upstreamStartedAt = Date.now();
            streamStartedAt = upstreamStartedAt;
            const upstream = await new Promise<http.IncomingMessage>((resolve, reject) => {
              request = (url.protocol === 'https:' ? https : http).request(
                url,
                { method: 'POST', headers, rejectUnauthorized: !model.allowUnauthorized },
                resolve,
              );
              request.once('error', reject);
              request.setTimeout(model.idleTimeout ?? 30_000, () => triggerTimeout('Upstream idle timeout.'));
              totalTimer = setTimeout(
                () => triggerTimeout('Upstream request timeout.'),
                Math.min(model.timeout ?? 120_000, remaining),
              );
              signal.addEventListener('abort', abort, { once: true });
              request.end(JSON.stringify(payload));
            });
            // Keep an error listener attached post-headers so timeout/abort destroy() never emits unhandled error.
            request!.on('error', () => {});
            headerLatencyMs = Date.now() - upstreamStartedAt;
            const status = upstream.statusCode || 502;
            if (status < 200 || status >= 300) {
              const errorBody =
                kind === 'generation-test' ||
                status === 400 ||
                status === 413 ||
                status === 422 ||
                (cloudCode && [403, 429].includes(status)) ||
                (opencode && [401, 403].includes(status))
                  ? await boundedErrorBody(upstream)
                  : '';
              if (
                (status === 400 || status === 422) &&
                !hasUsageOptOut(usageOptOutKey(model, format)) &&
                /stream_options|include_usage/i.test(errorBody)
              ) {
                // Retry this same attempt once without stream_options; decrementing avoids exiting on the final attempt.
                usageOptOut.set(usageOptOutKey(model, format), Date.now());
                upstream.destroy();
                attempt -= 1;
                continue;
              }
              const decision =
                cloudCode && isGoogleQuotaFailure(status, errorBody)
                  ? classifyGoogleRateLimit(errorBody, upstream.headers['retry-after'])
                  : undefined;
              const retryAfter = decision?.retryAfterMs ?? parseRetryAfter(upstream.headers['retry-after']);
              const contextOverflow = isContextLengthExceeded(status, errorBody);
              const hint = status === 400 || status === 422 ? toolSchemaErrorHint(errorBody) : '';
              const overflowHint = contextOverflow
                ? ' Context length exceeded the model limit; compact the conversation or switch to a larger-context model.'
                : '';
              const probeDetail = (() => {
                if (kind !== 'generation-test' || !errorBody.trim()) return '';
                let candidate = '';
                try {
                  const parsed = JSON.parse(errorBody) as Record<string, unknown>;
                  const err = parsed?.error as Record<string, unknown> | string | undefined;
                  if (typeof err === 'string' && err.trim()) candidate = err.trim();
                  else if (err && typeof err === 'object') {
                    if (typeof err.message === 'string' && err.message.trim()) candidate = err.message.trim();
                    else if (typeof err.detail === 'string' && err.detail.trim()) candidate = err.detail.trim();
                    else if (typeof err.code === 'string' && err.code.trim()) candidate = err.code.trim();
                  }
                  if (!candidate && typeof parsed?.message === 'string' && parsed.message.trim()) candidate = parsed.message.trim();
                  else if (!candidate && typeof parsed?.detail === 'string' && parsed.detail.trim()) candidate = parsed.detail.trim();
                  else if (!candidate && typeof parsed?.msg === 'string' && parsed.msg.trim()) candidate = parsed.msg.trim();
                } catch {
                  if (!/^<(?:!doctype|html|head|body)\b/i.test(errorBody.trim())) candidate = errorBody.trim();
                }
                if (!candidate) return '';
                let cleaned = candidate
                  .replace(/\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/gi, 'Bearer [redacted]')
                  .replace(/\b(?:sk|nvapi|gsk|xai|AIza)[A-Za-z0-9._\-]{8,}/g, '[redacted]')
                  .replace(/\s+/g, ' ')
                  .trim();
                if (model.apiKey && model.apiKey !== 'none' && model.apiKey.length >= 4) {
                  cleaned = cleaned.split(model.apiKey).join('[redacted]');
                }
                return cleaned.length > 260 ? `${cleaned.slice(0, 257)}…` : cleaned;
              })();
              upstream.destroy();
              throw new UpstreamError(
                `${
                  cloudCode
                    ? decision && status === 403
                      ? 'Google Cloud Code reported a rate or quota limit (HTTP 403). Respect the provider retry/reset delay; signing in again does not increase quota.'
                      : describeGoogleAccessError(status).message
                    : opencode && [401, 403].includes(status)
                      ? describeOpencodeAccessError(status, errorBody)
                      : probeDetail || `Upstream returned HTTP ${status}.`
                }${hint}${overflowHint}`,
                status,
                !!decision || status === 408 || status === 429 || status >= 500,
                retryAfter,
                contextOverflow || (status !== 400 && status !== 422),
                decision,
              );
            }

          if (isStream && String(upstream.headers['content-type']).includes('text/event-stream')) {
            const decoder = new StringDecoder('utf8');
            let buffer = '';
            let dataLines: string[] = [];
            let emitted = false;
            let finalReason = false;
            let terminal = false;
            const event = () => {
              const data = dataLines.join('\n');
              dataLines = [];
              if (!data) return;
              let chunk: Record<string, any>;
              if (data.trim() === '[DONE]') {
                terminal = true;
                // Some compatible endpoints omit finish_reason. Flush remaining
                // text/tools through validation, but never replay a finalized context.
                if (format !== 'openai' || !activeStreamContexts.has(stateKey)) return;
                chunk = { choices: [{ delta: {}, finish_reason: 'stop' }] };
              } else {
                try {
                  chunk = JSON.parse(data);
                } catch {
                  throw new UpstreamError('Upstream sent malformed SSE JSON.');
                }
              }
              if (chunk.error || chunk.type === 'error') throw new UpstreamError('Upstream reported a stream error.');
              if (cloudCode && chunk.response) chunk = chunk.response;
              diagnostic.observe(chunk, format);
              const delta = chunk.choices?.[0]?.delta;
              if (
                delta?.content ||
                delta?.reasoning_content ||
                delta?.reasoning ||
                delta?.tool_calls?.length ||
                chunk.content_block?.type === 'tool_use' ||
                chunk.delta?.text ||
                chunk.delta?.thinking ||
                chunk.delta?.partial_json ||
                chunk.candidates?.[0]?.content?.parts?.length
              ) {
                upstreamOutput = true;
                const now = Date.now();
                if (!firstChunkAt) firstChunkAt = now;
                lastChunkAt = now;
              }
              if (
                chunk.type === 'message_stop' ||
                chunk.choices?.[0]?.finish_reason ||
                chunk.candidates?.[0]?.finishReason
              )
                terminal = true;
              if (
                (chunk.type === 'message_delta' && chunk.delta?.stop_reason === 'tool_use') ||
                chunk.choices?.[0]?.finish_reason
              ) {
                const pending = activeStreamContexts.get(stateKey)?.toolCalls || {};
                // Validate a copy including this event before the translator appends
                // its fragments and consumes the state. Never append to live state twice.
                const completed = new Map(Object.entries(pending).map(([index, tool]) => [index, tool.arguments]));
                if (format === 'openai' && Array.isArray(delta?.tool_calls)) {
                  for (const tool of delta.tool_calls) {
                    const index = String(tool.index ?? 0);
                    completed.set(index, (completed.get(index) || '') + (tool.function?.arguments || ''));
                  }
                }
                for (const args of completed.values()) validateToolArguments(args);
              }
              const mapped = registry.translateStreamChunk(
                model.provider,
                chunk,
                stateKey,
                format,
                stateKey,
                toolSchemas,
                artifactContext,
              ) as {
                content?: { parts?: unknown[] };
                finishReason?: string;
              } | null;
              if (mapped) {
                if (format === 'openai') observeCandidate(mapped);
                if (mapped.content?.parts?.length) emitted = true;
                if (mapped.finishReason && mapped.finishReason !== 'OTHER') finalReason = true;
                // A role-only or empty completion must not commit headers and prevent fallback.
                if (emitted) writeCandidate(mapped);
              }
            };
            const drain = () => {
              let index: number;
              while ((index = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, index).replace(/\r$/, '');
                buffer = buffer.slice(index + 1);
                if (!line) event();
                else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
              }
            };
            for await (const bytes of upstream) {
              if (signal.aborted) throw new Error('Cancelled');
              buffer += decoder.write(bytes as Buffer);
              if (buffer.length + dataLines.join('').length > 2 * 1024 * 1024)
                throw new UpstreamError('Upstream SSE event is too large.', 502, false);
              drain();
              await waitForDrain(res);
            }
            buffer += decoder.end();
            if (buffer) buffer += '\n';
            drain();
            event();
            if (!emitted) throw new UpstreamError('Upstream returned an empty stream.');
            if (!terminal) throw new UpstreamError('Upstream stream ended before completion.', 502, false);
            writeUsage();
            if (!finalReason) writeCandidate({ content: { parts: [], role: 'model' }, finishReason: 'STOP', index: 0 });
          } else {
            let size = 0;
            const chunks: Buffer[] = [];
            for await (const bytes of upstream) {
              size += bytes.length;
              if (size > 20 * 1024 * 1024) throw new UpstreamError('Upstream response exceeds 20 MB.', 502, false);
              chunks.push(bytes as Buffer);
            }
            let parsed: Record<string, any>;
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              throw new UpstreamError('Upstream returned invalid JSON.');
            }
            if (parsed.error) throw new UpstreamError('Upstream returned an error response.');
            if (cloudCode && parsed.response) parsed = parsed.response;
            diagnostic.observe(parsed, format);
            if (
              (format === 'openai' && !parsed.choices?.[0]?.message) ||
              (format === 'anthropic' && !Array.isArray(parsed.content))
            )
              throw new UpstreamError('Upstream returned an invalid completion.');
            if (parsed.choices?.[0]?.message?.tool_calls?.length) {
              upstreamOutput = true;
              for (const tool of parsed.choices[0].message.tool_calls) validateToolArguments(tool.function?.arguments);
            }
            // Some compatible endpoints return a complete JSON response even when stream=true.
            const mapped = registry.translateResponse(
              model.provider,
              parsed,
              stateKey,
              format,
              toolSchemas,
              artifactContext,
            ) as {
              candidates?: unknown[];
            };
            if (!mapped?.candidates?.length) throw new UpstreamError('Upstream returned no candidates.');
            if (format === 'openai') for (const candidate of mapped.candidates) observeCandidate(candidate);
            if (
              kind === 'generation-test' &&
              !mapped.candidates.some((candidate) => {
                const content = (candidate as { content?: { parts?: { text?: unknown; thought?: boolean }[] } })
                  ?.content;
                return (
                  Array.isArray(content?.parts) &&
                  content.parts.some(
                    (part) => part?.thought !== true && typeof part?.text === 'string' && part.text.trim(),
                  )
                );
              })
            ) {
              // The short test can exhaust its output budget despite a healthy account.
              // Record the accepted upstream response before the logical test failure.
              accountLease?.release({ status, latencyMs: headerLatencyMs });
              throw new UpstreamError(
                'The provider did not return generated text. Check the model and test output budget.',
                502,
                false,
                0,
                false,
              );
            }
            if (isStream) {
              for (const candidate of mapped.candidates) writeCandidate(candidate);
              writeUsage();
            } else {
              if (isCompaction) {
                clearConversationUsage(prepared.context.conversationId);
              } else {
                recordConversationUsage(prepared.context.conversationId, diagnostic.usage());
              }
              prepared.context.modelName = effectiveModel.name;
              const routed = subagentRouting.rewriteResponse(mapped, prepared.context, resolveSubagent);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(envelope(routed, cloudEnvelope)));
            }
          }
          // Do not retain partial, failed, cancelled, or retried output. This cache
          // outlives the per-attempt translator state, but never the proxy service.
          if (format === 'openai' && !replayOverflow && !signal.aborted)
            reasoningReplayCache.record(originalBody, model, [
              { text: replayReasoning, thought: true },
              ...replayCalls,
            ]);
          settleCircuit('succeed');
          // A successful stream proves this endpoint accepts usage fields again.
          usageOptOut.delete(usageOptOutKey(model, format));
          recordModelSuccess(model.name, headerLatencyMs);
          completed = true;
          accountLease?.release({ status, latencyMs: headerLatencyMs });
          counts.succeeded += 1;
          res.end();
          return;
        } catch (error) {
          failure = timeoutFailure ?? asUpstreamError(error);
          accountLease?.release({
            status: failure.status,
            retryAfterMs: failure.googleRateLimit
              ? failure.googleRateLimit.retryAfterMs
              : failure.retryAfter || undefined,
            cooldownReason: failure.googleRateLimit?.reason,
            cancelled: signal.aborted,
          });
          if (signal.aborted) {
            settleCircuit('cancel');
            break modelLoop;
          }
          if (res.headersSent || upstreamOutput) {
            settleCircuit('fail');
            recordModelFailure(model.name, failure.message);
            break modelLoop;
          }
          if (
            accountLease &&
            accountSwitchesUsed < accountCount - 1 &&
            [401, 403, 408, 429, 500, 502, 503, 504].includes(failure.status)
          ) {
            accountSwitchesUsed += 1;
            counts.accountSwitches += 1;
            continue;
          }
          if (failure.retryable && retriesUsed < retries && Date.now() < deadline) {
            const backoffAttempt = retriesUsed;
            retriesUsed += 1;
            counts.retries += 1;
            // Tear down the old attempt before waiting; timeout and error cannot each schedule a retry.
            request?.destroy();
            if (totalTimer) clearTimeout(totalTimer);
            signal.removeEventListener('abort', abort);
            await delay(
              Math.min(failure.retryAfter || 500 * 2 ** backoffAttempt, Math.max(1, deadline - Date.now())),
              signal,
            );
          } else {
            modelFailed = true;
            break;
          }
        } finally {
          if (totalTimer) clearTimeout(totalTimer);
          signal.removeEventListener('abort', abort);
          request?.destroy();
          accountLease?.release();
          clearRequestState(stateKey);
        }
      }
      if (modelFailed) {
        settleCircuit('fail');
        recordModelFailure(model.name, failure.message);
      } else settleCircuit('cancel');
      if (!failure.mayFallback) break;
      } finally {
        settleCircuit('cancel');
      }
    }
    if (!signal.aborted && !res.writableEnded && !res.destroyed) {
      if (res.headersSent)
        res.write(
          `event: error\ndata: ${JSON.stringify({ error: { message: failure.message, code: failure.status } })}\n\n`,
        );
      else {
        res.writeHead(failure.status, { 'Content-Type': 'application/json' });
        res.write(JSON.stringify({ error: { message: failure.message } }));
      }
      res.end();
    }
  } catch {
    if (!signal.aborted && !res.writableEnded && !res.destroyed) {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Model request failed.' } }));
    }
  } finally {
    res.removeListener('close', onClose);
    controllers.delete(controller);
    counts.active -= 1;
    diagnostic.finish({
      outcome: signal.aborted ? 'cancelled' : completed ? 'succeeded' : 'failed',
      status: signal.aborted ? undefined : completed ? 200 : failure.status,
      model: effectiveModel.name,
      provider: effectiveModel.provider,
    });
    if (!completed) {
      if (signal.aborted) counts.cancelled += 1;
      else counts.failed += 1;
    }
  }
}
