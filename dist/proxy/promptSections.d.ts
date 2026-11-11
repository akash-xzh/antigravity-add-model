export declare const STATIC_TAGS: readonly ["identity", "guidelines", "communication_style", "artifacts", "messaging", "conversation_transcript"];
export type StaticTag = (typeof STATIC_TAGS)[number];
export declare const DEFAULT_PROMPT_SECTIONS: Record<StaticTag, string>;
export interface PromptSectionsConfig {
    overrides: Partial<Record<StaticTag, string>>;
    enabled: Partial<Record<StaticTag, boolean>>;
}
export declare function promptSectionsFile(): string;
export declare function loadPromptSectionsConfig(): PromptSectionsConfig;
export declare function savePromptSectionsConfig(config: PromptSectionsConfig): void;
/**
 * Replace targeted static XML-like tags in the prompt text while preserving all
 * dynamic sections (<skills>, <slash_commands>, <mcp_servers>, <user_information>, etc.).
 */
export declare function rewritePromptSections(promptText: string): string;
//# sourceMappingURL=promptSections.d.ts.map