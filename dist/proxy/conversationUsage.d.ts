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
/** Provider generation speed, or undefined when the sample is too short to report honestly. */
export declare function tokensPerSecond(outputTokens?: number, decodeMs?: number): number | undefined;
/** Token usage and stream timing of a request the proxy generated itself (custom models). */
export declare function recordConversationUsage(conversationId: unknown, value: {
    inputTokens?: number;
    cachedTokens?: number;
    outputTokens?: number;
    ttftMs?: number;
    decodeMs?: number;
}): void;
/**
 * Stream timing of a native (official) generation. Its tokens come from the transcript, which the
 * language server annotates, so only the measured window is recorded here and any prior custom
 * model token counts are cleared so switching custom -> native never leaks stale counts.
 */
export declare function recordConversationTiming(conversationId: unknown, value: {
    ttftMs?: number;
    decodeMs?: number;
}): void;
export declare function getConversationUsage(conversationId: unknown): RecordedConversationUsage | undefined;
//# sourceMappingURL=conversationUsage.d.ts.map