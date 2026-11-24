export declare const STATIC_TAGS: readonly ["identity", "guidelines", "communication_style", "artifacts", "messaging", "conversation_transcript"];
export type StaticTag = (typeof STATIC_TAGS)[number];
export declare const DEFAULT_PROMPT_SECTIONS: Record<StaticTag, string>;
export interface PromptSectionsConfig {
    overrides: Record<string, string>;
    enabled: Record<string, boolean>;
}
export declare const DYNAMIC_SYSTEM_TAGS: Set<string>;
export declare function promptSectionsFile(): string;
export declare function observedPromptSectionsFile(): string;
export declare function loadPromptSectionsConfig(): PromptSectionsConfig;
export declare function savePromptSectionsConfig(config: PromptSectionsConfig): void;
export declare function loadObservedPromptSections(): Record<string, string>;
export declare function saveObservedPromptSections(data: Record<string, string>): void;
/**
 * Capture live default sections dynamically from incoming prompts (as Google updates them).
 */
export declare function recordLivePromptSections(promptText: string): void;
/**
 * Returns effective default prompt sections, combining hardcoded fallbacks
 * with any live sections observed dynamically from Antigravity/Google updates.
 */
export declare function getEffectivePromptDefaults(): Record<string, string>;
/**
 * Returns all customizable tags: static baseline tags plus any newly observed tags from Google.
 */
export declare function getAvailableTags(): string[];
/**
 * Replace targeted static XML-like tags in the prompt text while preserving all
 * dynamic sections (<skills>, <slash_commands>, <mcp_servers>, <user_information>, etc.).
 * Also records observed live prompt sections so defaults track Google updates in real time.
 */
export declare function rewritePromptSections(promptText: string): string;
//# sourceMappingURL=promptSections.d.ts.map