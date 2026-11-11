/**
 * Model Health Checker for Antigravity Proxy.
 * Performs lightweight, paced ping/health checks on custom model endpoints
 * and dynamically manages status signals (🟢 / 🔴) in the IDE and web panel.
 *
 * Designed to prevent rate-limiting ("mash requests") via:
 * 1. Endpoint deduplication (models sharing the same API key and URL share 1 ping).
 * 2. Concurrency limiting and request pacing.
 * 3. Persistent disk caching so health state survives restarts.
 * 4. Live updates during chat (success -> green, error -> red).
 */
import type { CustomModel } from '../proxy';
export type ModelHealthStatus = 'healthy' | 'slow' | 'unhealthy' | 'cooldown';
export interface ModelHealthResult {
    status: ModelHealthStatus;
    statusCode?: number;
    latencyMs?: number;
    error?: string;
    checkedAt: number;
}
export declare function recordRecentModel(modelName: string): void;
export declare function isRecentModel(modelName: string): boolean;
export declare function getRecentModels(): string[];
/**
 * Sorts custom models:
 * 1. Starred / recently used models at the top (most recent first).
 * 2. Healthy models next (fastest latency first).
 * 3. Slow models next.
 * 4. Cooldown models next.
 * 5. Unhealthy / offline models last.
 */
export declare function sortCustomModels<T extends {
    name: string;
}>(models: T[]): T[];
export declare function setDataDirectory(dir: string | undefined): void;
export declare function getHealthCachePath(dataDir?: string): string;
export declare function loadHealthCache(dataDir?: string): Map<string, ModelHealthResult>;
export declare function saveHealthCache(dataDir?: string): void;
export declare function getCachedHealth(modelName: string): ModelHealthResult | undefined;
export declare function getCachedHealthMap(): Map<string, ModelHealthResult>;
export declare function setCachedHealth(modelName: string, result: ModelHealthResult, persist?: boolean): void;
export declare function clearHealthCache(persist?: boolean): void;
/** Record live chat success: immediately marks the model healthy and tracks as recent */
export declare function recordModelSuccess(modelName: string, latencyMs?: number): void;
/** Record live chat failure: immediately marks the model unhealthy/cooldown and tracks as recent */
export declare function recordModelFailure(modelName: string, error?: string): void;
/** Strip any status dots/emojis, stars, brackets, and bullets from display name */
export declare function cleanModelDisplayName(name: string): string;
/**
 * Formats a model's display name with star (⭐ for recent) and status circle (🟢 / 🟡 / 🔴) for the IDE dropdown.
 * Uses cached status so this executes in ~0ms with zero network calls.
 */
export declare function formatHealthDisplayName(baseName: string, health?: ModelHealthResult | null, isRecent?: boolean): string;
/**
 * Pings a single model endpoint with a lightweight HTTP/HTTPS GET, aborting
 * immediately on headers to avoid downloading content or burning usage.
 */
export declare function pingCustomModel(model: CustomModel): Promise<ModelHealthResult>;
/**
 * Smart batch health check:
 * - Deduplicates endpoints so multiple models using 1 API key/host only trigger 1 ping.
 * - Paces requests (concurrency limit = 3, 150ms delay) to prevent burst rate limits.
 * - Reuses fresh cache unless force=true.
 */
export declare function checkAllModelsHealth(models: CustomModel[], force?: boolean): Promise<Map<string, ModelHealthResult>>;
//# sourceMappingURL=modelHealth.d.ts.map