import type * as http from 'http';
import { PassThrough, type Readable, type Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { StringDecoder } from 'string_decoder';
import { createBrotliDecompress, createGunzip, createInflate } from 'zlib';
import {
  subagentRouting,
  SubagentRoutingError,
  type SubagentModelResolver,
  type SubagentRoutingContext,
} from './subagentRouting';

export interface NativeSubagentRouting {
  context: SubagentRoutingContext;
  resolve: SubagentModelResolver;
}

/** Outcome of a native generation forward. Errors are written to the client but never thrown. */
export interface NativeForwardResult {
  /** True only when a 2xx native generation was fully delivered without error or disconnect. */
  ok: boolean;
}

/** Gate telemetry/account-success bookkeeping on a real successful generation. */
export function wasForwardedSuccessfully(result: NativeForwardResult | undefined): boolean {
  return result?.ok === true;
}

const JSON_LIMIT = 16 * 1024 * 1024;
const EVENT_LIMIT = 4 * 1024 * 1024;
const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
]);
const BODY_HEADERS = new Set([
  'content-length',
  'content-encoding',
  'content-md5',
  'digest',
  'content-digest',
  'repr-digest',
  'etag',
  'accept-ranges',
  'content-range',
]);

function headers(upstream: http.IncomingMessage, transformed: boolean): http.OutgoingHttpHeaders {
  const blocked = new Set(HOP_HEADERS);
  for (const token of (upstream.headers.connection || '').split(',')) blocked.add(token.trim().toLowerCase());
  if (transformed) for (const header of BODY_HEADERS) blocked.add(header);
  return Object.fromEntries(Object.entries(upstream.headers).filter(([name]) => !blocked.has(name.toLowerCase())));
}

function rewritePayload(value: unknown, routing: NativeSubagentRouting, depth = 0): unknown {
  if (depth > 16) throw new Error('Native response envelope nesting exceeds the supported limit.');
  if (Array.isArray(value)) return value.map((entry) => rewritePayload(entry, routing, depth + 1));
  if (!value || typeof value !== 'object') return value;
  let record = value as Record<string, unknown>;
  if (Array.isArray(record.candidates)) {
    record = subagentRouting.rewriteResponse(record, routing.context, routing.resolve);
  }
  if (record.response && typeof record.response === 'object') {
    record = { ...record, response: rewritePayload(record.response, routing, depth + 1) };
  }
  return record;
}

/** Keep framing/control fields verbatim, replacing only the data of a valid JSON event. */
function rewriteEvent(event: string, routing: NativeSubagentRouting): string {
  const lines = [...event.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/g)].filter((match) => match[0].length);
  const data = lines
    .filter((line) => line[1] === 'data' || line[1].startsWith('data:'))
    .map((line) => (line[1] === 'data' ? '' : line[1].slice(5).replace(/^ /, '')));
  if (!data.length || data.join('\n').trim() === '[DONE]') return event;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.join('\n'));
  } catch {
    // Non-JSON events are part of the upstream protocol, not tool calls we can rewrite.
    return event;
  }
  const rewritten = JSON.stringify(rewritePayload(parsed, routing));
  if (rewritten === JSON.stringify(parsed)) return event;
  let emitted = false;
  return lines
    .map((line) => {
      if (line[1] !== 'data' && !line[1].startsWith('data:')) return line[0];
      if (emitted) return '';
      emitted = true;
      return `data: ${rewritten}${line[2]}`;
    })
    .join('');
}

/** CR, LF and CRLF are line delimiters; a CRLF split across chunks is still one delimiter. */
class EventFramer {
  private pending = '';
  private event = '';
  private bytes = 0;

  *push(text: string, final = false): Generator<string> {
    this.pending += text;
    let start = 0;
    for (let index = 0; index < this.pending.length; index++) {
      const char = this.pending[index];
      if (char !== '\r' && char !== '\n') continue;
      if (char === '\r' && index + 1 === this.pending.length && !final) break;
      const end = index + (char === '\r' && this.pending[index + 1] === '\n' ? 2 : 1);
      const line = this.pending.slice(start, end);
      const blank = index === start;
      this.bytes += Buffer.byteLength(line);
      if (this.bytes > EVENT_LIMIT) throw new Error('Native stream event exceeds the buffer limit.');
      this.event += line;
      start = end;
      index = end - 1;
      if (blank) {
        const complete = this.event;
        this.event = '';
        this.bytes = 0;
        yield complete;
      }
    }
    this.pending = this.pending.slice(start);
    if (this.bytes + Buffer.byteLength(this.pending) > EVENT_LIMIT)
      throw new Error('Native stream event exceeds the buffer limit.');
    if (final && (this.event || this.pending)) {
      const remaining = this.event + this.pending;
      this.event = this.pending = '';
      this.bytes = 0;
      yield remaining;
    }
  }
}

function decoders(encoding: string | undefined): Transform[] {
  const values = (encoding || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .reverse();
  if (values.length > 4) throw new Error('Too many native response content encodings.');
  return values.flatMap((entry) => {
    if (entry === 'identity') return [];
    if (entry === 'gzip' || entry === 'x-gzip') return [createGunzip()];
    if (entry === 'deflate') return [createInflate()];
    if (entry === 'br') return [createBrotliDecompress()];
    throw new Error('Unsupported native response content encoding.');
  });
}

/**
 * Rewrite native-model subagent calls at the same Gemini boundary as custom models.
 * Successful bodies are decoded before inspection; upstream HTTP errors remain opaque.
 */
export async function forwardNativeGeneration(
  upstream: http.IncomingMessage,
  downstream: http.ServerResponse,
  routing: NativeSubagentRouting,
  streamHint: boolean,
): Promise<NativeForwardResult> {
  const successful = (upstream.statusCode || 200) >= 200 && (upstream.statusCode || 200) < 300;
  let succeeded = successful;
  const contentType = upstream.headers['content-type'];
  const streaming = contentType ? contentType.split(';')[0].trim().toLowerCase() === 'text/event-stream' : streamHint;
  let source: Readable = upstream;
  let completion: Promise<void> | undefined;
  let transportError: unknown;
  let disconnected = downstream.destroyed;
  const onClose = () => {
    disconnected = true;
    upstream.destroy();
    if (source !== upstream) source.destroy();
  };
  // ServerResponse errors may otherwise escape while waiting for upstream data.
  const onDownstreamError = () => onClose();
  downstream.on('close', onClose);
  downstream.on('error', onDownstreamError);

  const begin = () => {
    if (disconnected || downstream.destroyed) throw new Error('Native response client disconnected.');
    if (downstream.headersSent) return;
    const outgoing = headers(upstream, successful);
    if (successful && !contentType) outgoing['content-type'] = streaming ? 'text/event-stream' : 'application/json';
    downstream.writeHead(upstream.statusCode || 200, outgoing);
  };
  const write = async (chunk: string | Buffer) => {
    begin();
    if (downstream.write(chunk)) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        downstream.off('drain', drain);
        downstream.off('close', closed);
        downstream.off('error', failed);
      };
      const drain = () => {
        cleanup();
        resolve();
      };
      const closed = () => {
        cleanup();
        reject(new Error('Native response client disconnected.'));
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      downstream.once('drain', drain);
      downstream.once('close', closed);
      downstream.once('error', failed);
      if (downstream.destroyed) closed();
    });
  };

  try {
    if (disconnected) {
      onClose();
      return { ok: false };
    }
    if (successful) {
      const transforms = decoders(upstream.headers['content-encoding']);
      if (transforms.length) {
        const decoded = new PassThrough();
        source = decoded;
        // Catch immediately: the consumer handles the pipeline error through its iterator.
        completion = pipeline(upstream, ...transforms, decoded).catch((error) => {
          transportError = error;
        });
      }
    }
    if (!successful) {
      begin();
      for await (const chunk of source) await write(chunk as Buffer);
    } else if (streaming) {
      const decoder = new StringDecoder('utf8');
      const framer = new EventFramer();
      let firstText = true;
      for await (const chunk of source) {
        const text = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        // SSE ignores one initial BOM, including when its UTF8 bytes arrive separately.
        const framed = firstText ? text.replace(/^\uFEFF/, '') : text;
        if (text.length) firstText = false;
        for (const event of framer.push(framed)) await write(rewriteEvent(event, routing));
      }
      for (const event of framer.push(decoder.end(), true)) await write(rewriteEvent(event, routing));
    } else {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of source) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > JSON_LIMIT) throw new Error('Native JSON response exceeds the buffer limit.');
        chunks.push(bytes);
      }
      const body = Buffer.concat(chunks);
      // 204/205 are valid successful responses without a JSON entity.
      if (body.length || ![204, 205].includes(upstream.statusCode)) {
        let parsed: unknown;
        let validJson = true;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          validJson = false;
        }
        if (validJson) {
          const rewritten = JSON.stringify(rewritePayload(parsed, routing));
          await write(rewritten === JSON.stringify(parsed) ? body : rewritten);
        } else {
          // Keep opaque native payloads transparent; only parse failures are ignored.
          await write(body);
        }
      }
    }
    await completion;
    if (transportError) throw transportError;
    begin();
    downstream.end();
  } catch (error) {
    succeeded = false;
    upstream.destroy();
    if (source !== upstream) source.destroy();
    if (!disconnected && !downstream.destroyed) {
      const status = error instanceof SubagentRoutingError ? error.status : 502;
      const payload = JSON.stringify({
        error: {
          code: status,
          message:
            error instanceof SubagentRoutingError ? error.message : 'Native upstream response could not be processed.',
          status: status === 400 ? 'INVALID_ARGUMENT' : status === 409 ? 'FAILED_PRECONDITION' : 'UNAVAILABLE',
        },
      });
      if (!downstream.headersSent) {
        downstream.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        downstream.end(payload);
      } else if (successful && streaming) {
        downstream.end(`\n\nevent: error\ndata: ${payload}\n\n`);
      } else {
        // An opaque HTTP error or completed JSON entity cannot contain an extra error envelope.
        downstream.destroy();
      }
    }
  } finally {
    await completion;
    downstream.off('close', onClose);
    downstream.off('error', onDownstreamError);
  }
  return { ok: succeeded };
}
