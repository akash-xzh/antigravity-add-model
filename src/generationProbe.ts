import { Writable } from 'node:stream';
import type { ServerResponse } from 'node:http';
import type { CustomModel } from './proxy';
import { runCustomModelRequest } from './proxy/customRequest';

/**
 * Output budget for "Test generation". Reasoning models (for example Qwen3 or
 * DeepSeek-R1 behind llama.cpp) spend tokens on reasoning before the answer, so a
 * tiny budget fails them even though they work in chat (issue #42). Other models
 * still stop after replying "OK", so the larger limit does not raise their cost.
 */
export const GENERATION_PROBE_OUTPUT_TOKENS = 1024;

/** A bounded response sink exercises the real request path without opening another listening port. */
class ProbeResponse extends Writable {
  statusCode = 200;
  headersSent = false;
  bytes = 0;
  private capturedChunks: Buffer[] = [];
  private capturedBytes = 0;
  private static readonly MAX_CAPTURE_BYTES = 16 * 1024;
  writeHead(status: number) {
    this.statusCode = status;
    this.headersSent = true;
    return this;
  }
  _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    this.bytes += chunk.length;
    if (this.bytes > 256 * 1024) return done(new Error('Generation test response exceeds limit'));
    if (this.capturedBytes < ProbeResponse.MAX_CAPTURE_BYTES) {
      const remaining = ProbeResponse.MAX_CAPTURE_BYTES - this.capturedBytes;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      this.capturedChunks.push(Buffer.from(slice));
      this.capturedBytes += slice.length;
    }
    done();
  }
  bodyText(): string {
    return Buffer.concat(this.capturedChunks).toString('utf8');
  }
}

/** Extracts a concise, human-readable error message from an upstream API error body. */
export function extractApiErrorMessage(rawBody: string): string {
  const text = (rawBody || '').trim();
  if (!text) return '';
  let candidate = '';
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object') {
      const errObj = parsed.error as Record<string, unknown> | string | undefined;
      if (typeof errObj === 'string' && errObj.trim()) {
        candidate = errObj.trim();
      } else if (errObj && typeof errObj === 'object') {
        if (typeof errObj.message === 'string' && errObj.message.trim()) {
          candidate = errObj.message.trim();
        } else if (typeof errObj.detail === 'string' && errObj.detail.trim()) {
          candidate = errObj.detail.trim();
        } else if (typeof errObj.code === 'string' && errObj.code.trim()) {
          candidate = errObj.code.trim();
        }
      }
      if (!candidate && typeof parsed.message === 'string' && parsed.message.trim()) {
        candidate = parsed.message.trim();
      } else if (!candidate && typeof parsed.detail === 'string' && parsed.detail.trim()) {
        candidate = parsed.detail.trim();
      } else if (!candidate && typeof parsed.msg === 'string' && parsed.msg.trim()) {
        candidate = parsed.msg.trim();
      }
    }
  } catch {
    // Plain text or non-JSON body — skip raw HTML error pages
    if (!/^<(?:!doctype|html|head|body)\b/i.test(text)) {
      candidate = text;
    }
  }
  if (!candidate) return '';
  const sanitized = candidate
    .replace(/\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|nvapi|gsk|xai|AIza)[A-Za-z0-9._\-]{8,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return sanitized.length > 260 ? `${sanitized.slice(0, 257)}…` : sanitized;
}

/** Explicitly invoked only. One short generation; no retries, tools, user prompt or fallback models. */
export async function runGenerationProbe(input: CustomModel) {
  const startedAt = Date.now();
  const response = new ProbeResponse();
  response.on('error', () => {});
  const model = {
    ...input,
    enabled: true,
    maxRetries: 0,
    fallbackModels: [],
    timeout: 30000,
    retryBudgetMs: 30000,
    maxOutputTokens: GENERATION_PROBE_OUTPUT_TOKENS,
    extraBody: undefined,
    thinkingBudget: undefined,
    circuitBreaker: { enabled: false },
  } as CustomModel;
  await runCustomModelRequest(
    response as unknown as ServerResponse,
    model,
    {
      contents: [{ role: 'user', parts: [{ text: 'Reply with OK.' }] }],
      generationConfig: { maxOutputTokens: GENERATION_PROBE_OUTPUT_TOKENS },
    },
    false,
    [model],
    false,
    'generation-test',
  );
  if (response.statusCode < 200 || response.statusCode >= 300 || response.errored) {
    let apiError = extractApiErrorMessage(response.bodyText());
    if (apiError && input.apiKey && input.apiKey !== 'none' && input.apiKey.length >= 4) {
      apiError = apiError.split(input.apiKey).join('[redacted]');
    }
    const isGenericUpstream = /^Upstream returned HTTP \d+\.?$/i.test(apiError);
    const isEmptyGeneration = /did not return generated text|no generated text|without generated text|no text|empty response|returned no candidates/i.test(apiError);
    const showSpecific = Boolean(apiError) && !isGenericUpstream && !(response.statusCode === 502 && isEmptyGeneration);
    return {
      success: false,
      status: response.statusCode,
      error: showSpecific
        ? `Generation failed (HTTP ${response.statusCode}): ${apiError}`
        : `Generation failed (HTTP ${response.statusCode}). Check model access, provider quota, configuration and the ${GENERATION_PROBE_OUTPUT_TOKENS}-token test output limit.`,
    };
  }
  return {
    success: true,
    status: response.statusCode,
    message: `Generation succeeded (HTTP ${response.statusCode}, ${Date.now() - startedAt} ms).`,
  };
}
