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
/** Never let an earlier prefix match shadow an exact model or effort variant. */
export declare function findContextModel(name: string | undefined, models: ContextModel[]): ContextModel | undefined;
/** A title is usable only when it identifies one conversation, including archived rows. */
export declare function findConversationIdByTitle(title: unknown, dataDirectory: string): string | undefined;
export declare function getChatContextUsage(conversationId: unknown, dataDirectory: string): Promise<ChatContextUsage>;
/** Exact catalog identifiers only; conflicting provider limits remain unknown. */
export declare function discoverContextLimit(modelName: string, provider?: string): Promise<number | undefined>;
export declare function getContextInformation(payload: unknown, dataDirectory: string, models: ContextModel[]): Promise<ChatContextUsage>;
//# sourceMappingURL=chatContext.d.ts.map