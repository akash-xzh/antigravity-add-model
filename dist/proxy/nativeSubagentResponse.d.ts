import type * as http from 'http';
import { type SubagentModelResolver, type SubagentRoutingContext } from './subagentRouting';
export interface NativeSubagentRouting {
    context: SubagentRoutingContext;
    resolve: SubagentModelResolver;
}
/** Outcome of a native generation forward. Errors are written to the client but never thrown. */
export interface NativeForwardResult {
    /** True only when a 2xx native generation was fully delivered without error or disconnect. */
    ok: boolean;
}
/** Gate telemetry/account-success bookkeeping on a real successful generation. */
export declare function wasForwardedSuccessfully(result: NativeForwardResult | undefined): boolean;
/**
 * Rewrite native-model subagent calls at the same Gemini boundary as custom models.
 * Successful bodies are decoded before inspection; upstream HTTP errors remain opaque.
 */
export declare function forwardNativeGeneration(upstream: http.IncomingMessage, downstream: http.ServerResponse, routing: NativeSubagentRouting, streamHint: boolean): Promise<NativeForwardResult>;
//# sourceMappingURL=nativeSubagentResponse.d.ts.map