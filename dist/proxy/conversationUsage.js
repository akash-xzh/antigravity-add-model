"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tokensPerSecond = tokensPerSecond;
exports.recordConversationUsage = recordConversationUsage;
exports.recordConversationTiming = recordConversationTiming;
exports.getConversationUsage = getConversationUsage;
exports.clearConversationUsage = clearConversationUsage;
const MAX_CONVERSATIONS = 200;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
// A sub-50ms decode or a single-token jitter has no meaningful decode interval to divide by.
const MIN_DECODE_MS = 50;
const MIN_OUTPUT_TOKENS = 2;
const usage = new Map();
/** Provider generation speed, or undefined when the sample is too short to report honestly. */
function tokensPerSecond(outputTokens, decodeMs) {
    if (typeof outputTokens !== 'number' || typeof decodeMs !== 'number')
        return undefined;
    if (!Number.isFinite(outputTokens) || !Number.isFinite(decodeMs))
        return undefined;
    if (outputTokens < MIN_OUTPUT_TOKENS || decodeMs < MIN_DECODE_MS)
        return undefined;
    return (outputTokens * 1000) / decodeMs;
}
const timing = (value) => ({
    ...(typeof value.ttftMs === 'number' && Number.isFinite(value.ttftMs) && value.ttftMs > 0
        ? { ttftMs: value.ttftMs }
        : {}),
    ...(typeof value.decodeMs === 'number' && Number.isFinite(value.decodeMs) && value.decodeMs >= MIN_DECODE_MS
        ? { decodeMs: value.decodeMs }
        : {}),
});
function store(conversationId, entry) {
    usage.delete(conversationId);
    usage.set(conversationId, entry);
    while (usage.size > MAX_CONVERSATIONS)
        usage.delete(usage.keys().next().value);
}
/** Token usage and stream timing of a request the proxy generated itself (custom models). */
function recordConversationUsage(conversationId, value) {
    if (typeof conversationId !== 'string' || !UUID.test(conversationId))
        return;
    if (value.inputTokens === undefined && value.outputTokens === undefined)
        return;
    store(conversationId, {
        inputTokens: Math.max(0, value.inputTokens ?? 0),
        cachedTokens: Math.max(0, value.cachedTokens ?? 0),
        outputTokens: Math.max(0, value.outputTokens ?? 0),
        hasTokens: true,
        ...timing(value),
        updatedAt: Date.now(),
    });
}
/**
 * Stream timing of a native (official) generation. Its tokens come from the transcript, which the
 * language server annotates, so only the measured window is recorded here and any prior custom
 * model token counts are cleared so switching custom -> native never leaks stale counts.
 */
function recordConversationTiming(conversationId, value) {
    if (typeof conversationId !== 'string' || !UUID.test(conversationId))
        return;
    const measured = timing(value);
    if (measured.ttftMs === undefined && measured.decodeMs === undefined)
        return;
    store(conversationId, {
        inputTokens: 0,
        cachedTokens: 0,
        outputTokens: 0,
        hasTokens: false,
        ...measured,
        updatedAt: Date.now(),
    });
}
function getConversationUsage(conversationId) {
    if (typeof conversationId !== 'string')
        return undefined;
    return usage.get(conversationId);
}
/** Clear cached per-conversation usage/timing (e.g. when Undo truncates transcript.jsonl). */
function clearConversationUsage(conversationId) {
    if (typeof conversationId !== 'string')
        return;
    usage.delete(conversationId);
}
//# sourceMappingURL=conversationUsage.js.map