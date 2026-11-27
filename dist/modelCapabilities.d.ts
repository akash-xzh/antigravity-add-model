export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type VariantEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export interface DetectedModelCapabilities {
    contextWindow?: number;
    maxOutputTokens?: number;
    supportsVision?: boolean;
    supportsThinking?: boolean;
    reasoningEffort?: ReasoningEffort;
    supportedEfforts?: VariantEffort[];
}
export declare function candidateModelSlugs(modelId: string): string[];
interface MrRule {
    pattern?: string;
    context?: {
        max_context?: number;
        max_input?: number;
        max_output?: number;
    };
    capabilities?: {
        vision?: boolean;
        thinking?: boolean;
    };
    default_effort?: string;
    efforts?: string[];
}
interface CatalogBundle {
    loadedAt: number;
    mrRules: Array<{
        regex: RegExp;
        rule: MrRule;
    }>;
    bestIndex: Map<string, Record<string, unknown>>;
    devIndex: Map<string, Record<string, unknown>>;
}
export declare function resolveFromBundle(modelId: string, bundle: CatalogBundle): DetectedModelCapabilities;
export declare function detectModelCapabilitiesBatch(modelIds: string[], dataDirectory: string): Promise<Record<string, DetectedModelCapabilities>>;
export {};
//# sourceMappingURL=modelCapabilities.d.ts.map