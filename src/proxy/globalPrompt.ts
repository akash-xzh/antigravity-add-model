import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import log from 'electron-log';
import { appendModelSystemPrompt, type GeminiBody } from './requestOptions';
import { rewritePromptSections } from './promptSections';

/**
 * Generous cap: a full replacement prompt is about 28k characters, and the
 * per-model `systemPrompt` field's 20k limit does not apply to this file.
 */
const LIMIT = 100_000;

function read(file: string): { mtimeMs: number; size: number; text: string } | undefined {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > LIMIT * 4) return undefined;
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (raw.length > LIMIT) {
      log.warn(`[Proxy] ${file} exceeds ${LIMIT} characters; using the first ${LIMIT}.`);
      return { mtimeMs: stat.mtimeMs, size: stat.size, text: raw.slice(0, LIMIT) };
    }
    return { mtimeMs: stat.mtimeMs, size: stat.size, text: raw };
  } catch {
    return undefined;
  }
}

/**
 * Where the operator's global instruction lives. Default `append` keeps
 * Antigravity's instruction first; `replace` (ANTIGRAVITY_GLOBAL_PROMPT_MODE)
 * discards it entirely, including its tool and agent rules.
 */
export function globalSystemPromptFile(): string {
  return (
    process.env.ANTIGRAVITY_GLOBAL_PROMPT ||
    path.join(os.homedir(), '.gemini', 'antigravity', 'global-system-prompt.txt')
  );
}

export function globalSystemPromptReplaces(): boolean {
  return (process.env.ANTIGRAVITY_GLOBAL_PROMPT_MODE || '').trim().toLowerCase() === 'replace';
}

let cached: { file: string; mtimeMs: number; size: number; text: string } | undefined;

/**
 * The file actually read for injection. An explicit env path always wins; a
 * test run must not pick up the operator's real file from the home directory,
 * which would make unrelated payload assertions depend on the machine.
 */
function activeFile(): string | undefined {
  if (process.env.ANTIGRAVITY_GLOBAL_PROMPT) return process.env.ANTIGRAVITY_GLOBAL_PROMPT;
  if (process.env.VITEST) return undefined;
  return globalSystemPromptFile();
}

/** Cached by mtime so editing the file applies on the next request without a restart. */
export function globalSystemPrompt(): string {
  const file = activeFile();
  if (!file) {
    cached = undefined;
    return '';
  }
  const current = read(file);
  if (!current) {
    cached = undefined;
    return '';
  }
  if (cached?.file === file && cached.mtimeMs === current.mtimeMs && cached.size === current.size) return cached.text;
  cached = { file, ...current };
  return current.text;
}

export function withGlobalSystemPrompt<T extends GeminiBody>(body: T): T {
  // First apply targeted section rewrites to the existing system instruction (if present)
  let workingBody: T = body;
  const rawInstruction = (body.systemInstruction ?? {}) as { parts?: unknown[]; [key: string]: unknown };
  if (Array.isArray(rawInstruction.parts) && rawInstruction.parts.length > 0) {
    const updatedParts = rawInstruction.parts.map((p) => {
      const partObj = p as { text?: unknown; [key: string]: unknown };
      if (typeof partObj?.text === 'string') {
        const rewritten = rewritePromptSections(partObj.text);
        if (rewritten !== partObj.text) {
          return { ...partObj, text: rewritten };
        }
      }
      return p;
    });
    workingBody = { ...body, systemInstruction: { ...rawInstruction, parts: updatedParts } };
  }

  const text = globalSystemPrompt();
  if (!text) return workingBody;
  if (!globalSystemPromptReplaces()) return appendModelSystemPrompt(workingBody, text) as T;
  // replace mode: the operator's file becomes the whole instruction.
  const instruction = (workingBody.systemInstruction ?? {}) as { parts?: unknown[]; [key: string]: unknown };
  return { ...workingBody, systemInstruction: { ...instruction, parts: [{ text }] } } as T;
}

/**
 * Opt-in diagnostic. Antigravity sends most of its own instruction only on the
 * first turn of a conversation, so the whole body is captured once and never
 * replaced. Enable with `ANTIGRAVITY_CAPTURE_SYSTEM_PROMPT=<file>`.
 */
export function captureSystemPrompt(body: GeminiBody): void {
  const setting = process.env.ANTIGRAVITY_CAPTURE_SYSTEM_PROMPT;
  const target =
    setting === '1'
      ? path.join(path.dirname(globalSystemPromptFile()), 'captured-request.json')
      : setting || '';
  if (!target) return;
  try {
    const json = JSON.stringify(body, null, 2) + '\n';
    // flag 'wx' makes this one capture per file: never replace a real record.
    fs.writeFileSync(target, json, { flag: 'wx', mode: 0o600 });
    log.info(`[Proxy] Captured the Antigravity request body at ${target}`);
  } catch {
    /* Already captured, or the path is unusable. */
  }
}

/**
 * Inject into a Gemini-format JSON body, including the Cloud Code `request`
 * envelope. Returns the input buffer untouched when nothing was added or the
 * body is not Gemini JSON (for example the opaque fallback proxy).
 */
export function injectGlobalSystemPrompt(raw: Buffer): Buffer {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  } catch {
    return raw;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return raw;
  const envelope = parsed.request;
  const isEnvelope = !!envelope && typeof envelope === 'object' && !Array.isArray(envelope);
  const target = (isEnvelope ? envelope : parsed) as GeminiBody;
  captureSystemPrompt(target);
  if (!globalSystemPrompt()) return raw;
  // In replace mode the captured body is left alone only if it already matches.
  const updated = withGlobalSystemPrompt(target);
  if (updated === target) return raw;
  return Buffer.from(JSON.stringify(isEnvelope ? { ...parsed, request: updated } : updated));
}
