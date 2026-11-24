"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.findContextModel = findContextModel;
exports.findConversationIdByTitle = findConversationIdByTitle;
exports.getChatContextUsage = getChatContextUsage;
exports.discoverContextLimit = discoverContextLimit;
exports.getContextInformation = getContextInformation;
/** Read-only context information. Native transcripts omit system prompts and usage metadata. */
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const readline = __importStar(require("node:readline"));
const conversationUsage_1 = require("./proxy/conversationUsage");
const nativeLimits_1 = require("./proxy/nativeLimits");
const modelUtils_1 = require("./proxy/modelUtils");
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const transcriptCache = new Map();
const pendingTranscripts = new Map();
const validLimit = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const validPercent = (value) => typeof value === 'number' && Number.isInteger(value) && value >= 10 && value <= 90 ? value : undefined;
const count = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const entryTimestamp = (value) => {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0)
        return value;
    if (typeof value === 'string' && value.trim()) {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed) && parsed > 0)
            return parsed;
    }
    return undefined;
};
const label = (value) => typeof value === 'string' ? value.trim().replace(/[▾▲▼◂▸◀▶]/g, '').replace(/\s+/g, ' ').trim().toLowerCase() : '';
const modelKey = (value) => label(value).replace(/^models\//, '').replace(/[^a-z0-9]/g, '');
/** Never let an earlier prefix match shadow an exact model or effort variant. */
function findContextModel(name, models) {
    const nameLabel = label(name);
    if (!nameLabel)
        return undefined;
    for (const field of ['displayName', 'name', 'externalModelName']) {
        const matches = models.filter((model) => label(model[field]) === nameLabel);
        if (matches.length === 1)
            return matches[0];
        if (matches.length > 1)
            return undefined;
    }
    const key = modelKey(name);
    const matches = models.filter((model) => [model.displayName, model.name, model.externalModelName].some((value) => value && modelKey(value) === key));
    return matches.length === 1 ? matches[0] : undefined;
}
/** A title is usable only when it identifies one conversation, including archived rows. */
function findConversationIdByTitle(title, dataDirectory) {
    if (typeof title !== 'string' || !title.trim() || title.length > 512)
        return undefined;
    const filename = path.join(dataDirectory, 'conversation_summaries.db');
    if (!fs.existsSync(filename))
        return undefined;
    try {
        // Electron versions without node:sqlite simply leave identity unavailable.
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(filename, { readOnly: true });
        try {
            const rows = db.prepare('SELECT conversation_id FROM conversation_summaries WHERE title = ? LIMIT 2')
                .all(title.trim());
            return rows.length === 1 && UUID.test(rows[0].conversation_id) ? rows[0].conversation_id : undefined;
        }
        finally {
            db.close();
        }
    }
    catch {
        return undefined;
    }
}
async function readChatContextSnapshot(conversationId, dataDirectory) {
    const id = typeof conversationId === 'string' && UUID.test(conversationId) ? conversationId : '';
    const unavailable = { result: { conversationId: id, source: 'unavailable' }, mtimeMs: 0 };
    if (!id)
        return unavailable;
    const filename = path.join(dataDirectory, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
    try {
        const stat = await fs.promises.stat(filename);
        // Do not show a truncated tail as the whole context. Large/unsupported files are explicitly unavailable.
        if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES)
            return unavailable;
        const stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
        const cached = transcriptCache.get(filename);
        if (cached?.stamp === stamp)
            return { ...cached.snapshot, result: { ...cached.snapshot.result } };
        const pending = pendingTranscripts.get(filename);
        if (pending) {
            const resolved = await pending;
            return { ...resolved, result: { ...resolved.result } };
        }
        const read = async () => {
            let characters = 0;
            let inputChars = 0;
            let outputChars = 0;
            let entries = 0;
            let malformed = false;
            let compactions = 0;
            let turns = 0;
            let lastPrompt = 0;
            let lastInput = 0;
            let lastCached = 0;
            let lastOutput = 0;
            let sessionInput = 0;
            let sessionCached = 0;
            let sessionOutput = 0;
            let lastCheckpointAt;
            let lastUsageAt;
            const input = fs.createReadStream(filename, { encoding: 'utf8' });
            const lines = readline.createInterface({ input, crlfDelay: Infinity });
            try {
                for await (const line of lines) {
                    if (!line.trim())
                        continue;
                    try {
                        const entry = JSON.parse(line);
                        if (!entry || typeof entry !== 'object' || typeof entry.type !== 'string' ||
                            typeof entry.source !== 'string') {
                            malformed = true;
                            continue;
                        }
                        const ts = entryTimestamp(entry.created_at);
                        // The native structured CHECKPOINT starts a new visible context while preserving
                        // cumulative session burn totals across compactions.
                        // Quoted "resuming" text in user messages is never a checkpoint.
                        if (entry.type === 'CHECKPOINT' && entry.source === 'SYSTEM') {
                            characters = 0;
                            inputChars = 0;
                            outputChars = 0;
                            compactions += 1;
                            turns = 0;
                            lastPrompt = 0;
                            lastInput = 0;
                            lastCached = 0;
                            lastOutput = 0;
                            lastUsageAt = undefined;
                            if (ts !== undefined)
                                lastCheckpointAt = ts;
                        }
                        let entryChars = 0;
                        if (typeof entry.content === 'string')
                            entryChars += entry.content.length;
                        if (typeof entry.thinking === 'string')
                            entryChars += entry.thinking.length;
                        if (Array.isArray(entry.tool_calls))
                            entryChars += JSON.stringify(entry.tool_calls).length;
                        characters += entryChars;
                        if (entry.source === 'MODEL' || entry.type === 'PLANNER_RESPONSE')
                            outputChars += entryChars;
                        else
                            inputChars += entryChars;
                        // Native per-step usage: immediate input excludes cached prompt tokens, so the real
                        // prompt size is both together and includes the hidden system prompt, tools and images.
                        const rawInput = count(entry.input_tokens);
                        const cached = count(entry.cache_read_tokens);
                        const output = count(entry.output_tokens);
                        if (rawInput !== undefined || output !== undefined) {
                            turns += 1;
                            lastInput = rawInput ?? 0;
                            lastCached = cached ?? 0;
                            lastOutput = output ?? 0;
                            lastPrompt = lastInput + lastCached;
                            sessionInput += lastInput;
                            sessionCached += lastCached;
                            sessionOutput += lastOutput;
                            if (ts !== undefined)
                                lastUsageAt = ts;
                        }
                        entries++;
                    }
                    catch {
                        malformed = true;
                    }
                }
            }
            finally {
                lines.close();
                input.destroy();
            }
            const after = await fs.promises.stat(filename);
            // A concurrent append or partial JSON line must not cache a falsely small count.
            if (malformed || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || !entries)
                return unavailable;
            const result = {
                conversationId: id,
                source: 'estimated',
                currentTokens: Math.ceil(characters / 4),
                visibleInputTokens: Math.ceil(inputChars / 4),
                visibleOutputTokens: Math.ceil(outputChars / 4),
                compactions,
            };
            if (turns) {
                result.source = 'actual';
                result.actualTokens = lastPrompt;
                result.actualInputTokens = lastInput;
                result.actualCachedTokens = lastCached;
                result.actualOutputTokens = lastOutput;
                result.sessionInputTokens = sessionInput;
                result.sessionCachedTokens = sessionCached;
                result.sessionOutputTokens = sessionOutput;
                result.turns = turns;
                result.overheadTokens = Math.max(0, lastPrompt - result.currentTokens);
                result.tokensPerTurn = Math.max(1, Math.round((sessionInput + sessionCached) / turns));
            }
            else if (sessionInput || sessionCached || sessionOutput) {
                result.sessionInputTokens = sessionInput;
                result.sessionCachedTokens = sessionCached;
                result.sessionOutputTokens = sessionOutput;
            }
            const snapshot = { result, mtimeMs: stat.mtimeMs, lastCheckpointAt, lastUsageAt };
            if (transcriptCache.size >= 100)
                transcriptCache.delete(transcriptCache.keys().next().value);
            transcriptCache.set(filename, { stamp, snapshot });
            return { ...snapshot, result: { ...result } };
        };
        const promise = read();
        pendingTranscripts.set(filename, promise);
        try {
            return await promise;
        }
        finally {
            pendingTranscripts.delete(filename);
        }
    }
    catch {
        return unavailable;
    }
}
async function getChatContextUsage(conversationId, dataDirectory) {
    return (await readChatContextSnapshot(conversationId, dataDirectory)).result;
}
let catalog;
let catalogExpires = 0;
let catalogPending;
async function publicCatalog() {
    if (Date.now() < catalogExpires)
        return catalog;
    if (catalogPending)
        return catalogPending;
    catalogPending = (async () => {
        catalogExpires = Date.now() + 60000;
        try {
            // A fixed public catalog URL receives no conversation, model name or credentials.
            const response = await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(5000) });
            if (!response.ok || !response.body)
                return undefined;
            const reader = response.body.getReader();
            const chunks = [];
            let bytes = 0;
            try {
                for (;;) {
                    const chunk = await reader.read();
                    if (chunk.done)
                        break;
                    bytes += chunk.value.byteLength;
                    if (bytes > 32 * 1024 * 1024)
                        return undefined;
                    chunks.push(chunk.value);
                }
            }
            finally {
                await reader.cancel().catch(() => { });
            }
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                return undefined;
            catalog = parsed;
            catalogExpires = Date.now() + 300000;
            return catalog;
        }
        catch {
            return undefined;
        }
    })();
    try {
        return await catalogPending;
    }
    finally {
        catalogPending = undefined;
    }
}
/** Exact catalog identifiers only; conflicting provider limits remain unknown. */
async function discoverContextLimit(modelName, provider) {
    const key = modelKey(modelName);
    if (!key)
        return undefined;
    const data = await publicCatalog();
    if (!data)
        return undefined;
    const preferred = provider && data[provider]?.models ? [[provider, data[provider]]] : Object.entries(data);
    const limits = new Set();
    for (const [, entry] of preferred) {
        if (!entry || typeof entry !== 'object' || !entry.models || typeof entry.models !== 'object')
            continue;
        for (const [id, model] of Object.entries(entry.models)) {
            if (!model || typeof model !== 'object' || !validLimit(model.limit?.context))
                continue;
            if (modelKey(id) === key || modelKey(model.name) === key)
                limits.add(model.limit.context);
        }
    }
    return limits.size === 1 ? [...limits][0] : undefined;
}
async function getContextInformation(payload, dataDirectory, models) {
    const request = payload && typeof payload === 'object' ? payload : {};
    const id = request.conversationId || findConversationIdByTitle(request.title, dataDirectory);
    const snapshot = await readChatContextSnapshot(id, dataDirectory);
    const result = snapshot.result;
    // The proxy records the provider's real usage and stream timing in-process. Usage covers custom
    // models whose steps the language server has not annotated yet, and is lost when the app restarts.
    // Timing also covers native models, whose tokens the transcript already carries.
    let recorded = (0, conversationUsage_1.getConversationUsage)(id);
    // Right after a CHECKPOINT resets post-compaction turns to 0, do not re-inject pre-compaction
    // recorded usage as ghost tokens.
    if (recorded && (result.compactions ?? 0) > 0 && !result.turns && snapshot.lastCheckpointAt !== undefined) {
        // Only a parsed CHECKPOINT timestamp is a reliable boundary. mtimeMs is after
        // the checkpoint and would erase genuine post-compaction usage.
        if (recorded.updatedAt <= snapshot.lastCheckpointAt)
            recorded = undefined;
    }
    if (recorded) {
        const recordedHasTokens = recorded.hasTokens === true || (recorded.hasTokens === undefined && (recorded.inputTokens > 0 || recorded.outputTokens > 0));
        const transcriptUsageAt = snapshot.lastUsageAt ?? snapshot.mtimeMs;
        if (recordedHasTokens) {
            const recordedIsNewer = !result.actualTokens || recorded.updatedAt > transcriptUsageAt;
            if (recordedIsNewer) {
                // diagnostics.ts stores total prompt tokens (already including cached tokens) in inputTokens.
                result.source = 'actual';
                result.actualTokens = recorded.inputTokens;
                result.actualInputTokens = Math.max(0, recorded.inputTokens - recorded.cachedTokens);
                result.actualCachedTokens = recorded.cachedTokens;
                result.actualOutputTokens = recorded.outputTokens;
                result.overheadTokens = Math.max(0, result.actualTokens - (result.currentTokens ?? 0));
            }
            // Only attribute speed/TTFT when recorded belongs to the active turn (never mix turns).
            if (recordedIsNewer || result.actualOutputTokens === recorded.outputTokens) {
                const speed = (0, conversationUsage_1.tokensPerSecond)(recorded.outputTokens, recorded.decodeMs);
                if (speed !== undefined)
                    result.tokensPerSecond = speed;
                if (recorded.ttftMs !== undefined)
                    result.ttftMs = recorded.ttftMs;
            }
        }
        else if (result.actualTokens) {
            // Timing-only native entry: `entry.created_at` is the step start time (always earlier
            // than stream-end `recorded.updatedAt`), while `snapshot.mtimeMs` records when the
            // language server flushed the finished turn. Allow a 2s flush grace so native t/s shows
            // reliably while still rejecting genuinely stale Turn 1 transcripts.
            const transcriptFlushedAt = Math.max(snapshot.lastUsageAt ?? 0, snapshot.mtimeMs);
            const staleForTranscriptTurn = transcriptFlushedAt > 0 && recorded.updatedAt > transcriptFlushedAt + 2000;
            if (!staleForTranscriptTurn) {
                const speed = (0, conversationUsage_1.tokensPerSecond)(result.actualOutputTokens, recorded.decodeMs);
                if (speed !== undefined)
                    result.tokensPerSecond = speed;
                if (recorded.ttftMs !== undefined)
                    result.ttftMs = recorded.ttftMs;
            }
        }
    }
    const name = typeof request.modelName === 'string' && request.modelName.length <= 512 ? request.modelName : '';
    const configured = findContextModel(name, models);
    if (validLimit(configured?.contextWindow)) {
        result.maxTokens = configured.contextWindow;
        result.limitSource = 'configured';
    }
    else {
        // Official models are absent from the user's configuration; their limit is the one the
        // language server's own catalog declares. A saved custom model keeps its own endpoint limit.
        const native = !configured && name ? (0, nativeLimits_1.findNativeLimit)(name) : undefined;
        if (validLimit(native)) {
            result.maxTokens = native;
            result.limitSource = 'native-catalog';
        }
        else if (request.discoverLimit === true && name) {
            const limit = await discoverContextLimit(configured?.externalModelName || name, configured?.provider);
            if (limit) {
                result.maxTokens = limit;
                result.limitSource = 'public-catalog';
            }
        }
    }
    if (validLimit(result.maxTokens)) {
        // Mirror the IDE's real trigger instead of guessing a share of the window. The proxy only
        // installs a checkpoint override for a saved model that declares its real context window;
        // every other model (including official ones) keeps the IDE's own new-token default.
        const checkpoint = configured
            ? (0, modelUtils_1.nativeCheckpointConfig)(configured)
            : undefined;
        const configuredPercent = validPercent(configured?.compactionThresholdPercent);
        if (checkpoint?.tokenThreshold !== undefined) {
            // Reflect the effective capped share when maxOutputTokens + reserve cap tokenThreshold below 80%.
            result.compactionThresholdPercent = Math.round((checkpoint.tokenThreshold / result.maxTokens) * 100)
                || (configuredPercent ?? modelUtils_1.DEFAULT_COMPACTION_THRESHOLD_PERCENT);
            result.compactionSource = configuredPercent === undefined ? 'default' : 'custom';
            result.compactionAtTokens = checkpoint.tokenThreshold;
            const inUse = result.actualTokens ?? result.currentTokens;
            if (typeof inUse === 'number' && Number.isFinite(inUse)) {
                result.tokensUntilCompaction = Math.max(0, checkpoint.tokenThreshold - inUse);
                if (result.tokensPerTurn) {
                    result.turnsUntilCompaction = Math.ceil(result.tokensUntilCompaction / result.tokensPerTurn);
                }
            }
        }
        else {
            result.compactionSource = 'ide';
        }
    }
    return result;
}
//# sourceMappingURL=chatContext.js.map