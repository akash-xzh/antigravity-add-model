export declare function configureNativeLimits(filename: string): void;
/** Merge `models[slug].maxTokens` from the upstream (official) catalog. */
export declare function recordNativeLimits(catalog: unknown): void;
/** Exact model, name or slug; an effort suffix such as "(Medium)" is ignored. */
export declare function findNativeLimit(name: unknown): number | undefined;
export declare function nativeLimitsPath(dataDirectory: string): string;
/** Test seam: drops every captured catalog limit. */
export declare function resetNativeLimits(): void;
//# sourceMappingURL=nativeLimits.d.ts.map