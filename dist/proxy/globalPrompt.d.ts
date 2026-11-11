import { type GeminiBody } from './requestOptions';
/**
 * Where the operator's global instruction lives. Default `append` keeps
 * Antigravity's instruction first; `replace` (ANTIGRAVITY_GLOBAL_PROMPT_MODE)
 * discards it entirely, including its tool and agent rules.
 */
export declare function globalSystemPromptFile(): string;
export declare function globalSystemPromptReplaces(): boolean;
/** Cached by mtime so editing the file applies on the next request without a restart. */
export declare function globalSystemPrompt(): string;
export declare function withGlobalSystemPrompt<T extends GeminiBody>(body: T): T;
/**
 * Opt-in diagnostic. Antigravity sends most of its own instruction only on the
 * first turn of a conversation, so the whole body is captured once and never
 * replaced. Enable with `ANTIGRAVITY_CAPTURE_SYSTEM_PROMPT=<file>`.
 */
export declare function captureSystemPrompt(body: GeminiBody): void;
/**
 * Inject into a Gemini-format JSON body, including the Cloud Code `request`
 * envelope. Returns the input buffer untouched when nothing was added or the
 * body is not Gemini JSON (for example the opaque fallback proxy).
 */
export declare function injectGlobalSystemPrompt(raw: Buffer): Buffer;
//# sourceMappingURL=globalPrompt.d.ts.map