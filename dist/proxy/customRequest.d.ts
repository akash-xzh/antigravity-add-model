import * as http from 'http';
import type { CustomModel } from '../proxy';
import { GeminiBody } from './requestOptions';
import { subagentRouting } from './subagentRouting';
export interface CompactionEvent {
    conversationId?: string;
    modelName: string;
    isCustom: boolean;
    at: number;
}
export declare function setCompactionNotifier(fn?: (event: CompactionEvent) => void): void;
export declare function notifyCompactionIfNeeded(body: unknown, modelName: string, isCustom: boolean, conversationId?: string): boolean;
export declare function getProxyMetrics(): {
    circuits: {
        tracked: number;
        open: number;
        probing: number;
    };
    requests: number;
    active: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    upstreamAttempts: number;
    retries: number;
    fallbacks: number;
    circuitSkips: number;
    accountSwitches: number;
};
export declare function stopCustomRequests(): void;
export declare function buildFallbackChain(primary: CustomModel, allModels: CustomModel[]): CustomModel[];
/** The sole retry/fallback owner; nothing is retried after any model output was received. */
export declare function runCustomModelRequest(res: http.ServerResponse, primary: CustomModel, originalBody: GeminiBody, isStream: boolean, allModels: CustomModel[], cloudEnvelope?: boolean, kind?: 'request' | 'generation-test', prePrepared?: ReturnType<typeof subagentRouting.prepareRequest>): Promise<void>;
//# sourceMappingURL=customRequest.d.ts.map