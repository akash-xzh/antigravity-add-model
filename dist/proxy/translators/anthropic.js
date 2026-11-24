"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearAnthropicThinkingCache = clearAnthropicThinkingCache;
exports.mapGeminiToAnthropic = mapGeminiToAnthropic;
exports.mapAnthropicToGemini = mapAnthropicToGemini;
exports.mapAnthropicChunkToGemini = mapAnthropicChunkToGemini;
exports.mapGeminiToolsToAnthropic = mapGeminiToolsToAnthropic;
/**
 * Anthropic provider translator.
 * Handles Gemini ↔ Anthropic request/response mapping and streaming SSE events.
 */
const fs_1 = require("fs");
const electron_log_1 = __importDefault(require("electron-log"));
const images_1 = require("./images");
const utils_1 = require("./utils");
const shared_1 = require("../shared");
const modelUtils_1 = require("../modelUtils");
const MAX_THINKING_CACHE_ENTRIES = 256;
const MAX_THINKING_TEXT_CHARS = 256 * 1024;
const MAX_COMPLETED_STREAMS = 512;
const thinkingBlocksByToolCallIds = new Map();
const thinkingSignatureByText = new Map();
const redactedThinkingData = new Set();
const completedStreamIds = new Set();
const anthropicStreamStates = new WeakMap();
function setBoundedMap(map, key, value, limit = MAX_THINKING_CACHE_ENTRIES) {
    if (map.has(key))
        map.delete(key);
    map.set(key, value);
    while (map.size > limit) {
        const oldest = map.keys().next().value;
        if (oldest === undefined)
            break;
        map.delete(oldest);
    }
}
function addBoundedSet(set, value, limit = MAX_THINKING_CACHE_ENTRIES) {
    if (set.has(value))
        set.delete(value);
    set.add(value);
    while (set.size > limit) {
        const oldest = set.values().next().value;
        if (oldest === undefined)
            break;
        set.delete(oldest);
    }
}
function toolCallIdsKey(ids) {
    return [...new Set(ids.filter(Boolean))].sort().join('\0');
}
/** Signed thinking is replayable only inside the same request/conversation scope. */
function thinkingReplayKey(scope, toolIds) {
    return `${scope || ''}\0${toolCallIdsKey(toolIds)}`;
}
function recordThinkingSignature(thinking, signature) {
    if (!signature || thinking.length > MAX_THINKING_TEXT_CHARS)
        return;
    setBoundedMap(thinkingSignatureByText, thinking, signature);
}
function recordRedactedThinking(data) {
    if (!data)
        return;
    addBoundedSet(redactedThinkingData, data);
}
function recordThinkingBlocksForTools(toolIds, blocks, scope) {
    const key = thinkingReplayKey(scope, toolIds);
    if (!key || blocks.length === 0)
        return;
    setBoundedMap(thinkingBlocksByToolCallIds, key, blocks.map((block) => ({ ...block })));
}
function clearAnthropicThinkingCache() {
    thinkingBlocksByToolCallIds.clear();
    thinkingSignatureByText.clear();
    redactedThinkingData.clear();
    completedStreamIds.clear();
}
function extractAssistantThinkingBlocks(parts, thinkingDisabled, scope) {
    if (thinkingDisabled)
        return [];
    const hasInlineSignature = parts.some((p) => p.thought && Boolean(p.thoughtSignature));
    if (hasInlineSignature) {
        const blocks = [];
        let pendingThinking = '';
        for (const p of parts) {
            if (!p.thought)
                continue;
            if (p.thoughtSignature) {
                const isRedacted = redactedThinkingData.has(p.thoughtSignature) || (p.text === undefined && !pendingThinking);
                if (isRedacted) {
                    if (pendingThinking) {
                        const cachedSig = thinkingSignatureByText.get(pendingThinking);
                        if (cachedSig)
                            blocks.push({ type: 'thinking', thinking: pendingThinking, signature: cachedSig });
                        pendingThinking = '';
                    }
                    blocks.push({ type: 'redacted_thinking', data: p.thoughtSignature });
                }
                else {
                    const thinkingText = pendingThinking + (p.text || '');
                    pendingThinking = '';
                    blocks.push({ type: 'thinking', thinking: thinkingText, signature: p.thoughtSignature });
                }
            }
            else if (typeof p.text === 'string') {
                pendingThinking += p.text;
            }
        }
        if (pendingThinking) {
            const cachedSig = thinkingSignatureByText.get(pendingThinking);
            if (cachedSig)
                blocks.push({ type: 'thinking', thinking: pendingThinking, signature: cachedSig });
        }
        return blocks;
    }
    // Fallback to bounded replay cache when the client omitted thoughtSignature or stripped thought parts.
    const toolIds = parts.map((p) => p.functionCall?.id).filter((id) => Boolean(id));
    if (toolIds.length > 0) {
        const cachedByTools = thinkingBlocksByToolCallIds.get(thinkingReplayKey(scope, toolIds));
        if (cachedByTools?.length)
            return cachedByTools.map((block) => ({ ...block }));
    }
    const combinedThought = parts
        .filter((p) => p.thought && typeof p.text === 'string')
        .map((p) => p.text)
        .join('');
    if (combinedThought) {
        const cachedSig = thinkingSignatureByText.get(combinedThought);
        if (cachedSig)
            return [{ type: 'thinking', thinking: combinedThought, signature: cachedSig }];
    }
    return [];
}
function toContentBlocks(content) {
    if (typeof content === 'string') {
        return content ? [{ type: 'text', text: content }] : [];
    }
    return content;
}
function isThinkingBlock(block) {
    return block.type === 'thinking' || block.type === 'redacted_thinking';
}
function pushMessage(messages, msg) {
    let normalizedContent;
    if (typeof msg.content === 'string') {
        if (!msg.content)
            return;
        normalizedContent = msg.content;
    }
    else {
        const filtered = msg.content.filter((block) => block.type !== 'text' || Boolean(block.text));
        if (filtered.length === 0)
            return;
        normalizedContent = filtered;
    }
    const prev = messages[messages.length - 1];
    if (prev && prev.role === msg.role) {
        if (typeof prev.content === 'string' && typeof normalizedContent === 'string') {
            prev.content = `${prev.content}\n${normalizedContent}`;
            return;
        }
        const merged = [...toContentBlocks(prev.content), ...toContentBlocks(normalizedContent)];
        if (msg.role === 'user') {
            const toolResults = merged.filter((b) => b.type === 'tool_result');
            const others = merged.filter((b) => b.type !== 'tool_result');
            prev.content = [...toolResults, ...others];
        }
        else {
            const thinking = merged.filter(isThinkingBlock);
            const others = merged.filter((b) => !isThinkingBlock(b));
            prev.content = [...thinking, ...others];
        }
        return;
    }
    messages.push({ role: msg.role, content: normalizedContent });
}
// ─── REQUEST: Gemini → Anthropic ──────────────────────────────────────────
function mapContentParts(parts) {
    const content = [];
    for (const part of parts) {
        if (part.thought)
            continue;
        const image = (0, images_1.getImageSource)(part);
        if (image) {
            content.push({ type: 'image', source: image });
        }
        else if (part.text) {
            content.push({ type: 'text', text: part.text });
        }
        else if (part.fileData) {
            const file = part.fileData;
            let text = `[File: ${file.fileUri} (${file.mimeType})]`;
            let url;
            try {
                url = new URL(file.fileUri);
            }
            catch {
                // Preserve the existing reference fallback for non-image files.
            }
            if (url?.protocol === 'file:') {
                const localPath = (0, images_1.localFilePath)(url);
                try {
                    text = `[File:\n${(0, fs_1.readFileSync)(localPath, 'utf-8')}\n]`;
                }
                catch {
                    // Preserve the reference fallback for unreadable local text files.
                }
            }
            content.push({ type: 'text', text });
        }
        else if (part.inlineData) {
            content.push({ type: 'text', text: `[${part.inlineData.mimeType}: ${part.inlineData.data}]` });
        }
    }
    return content;
}
function mapGeminiToolsToAnthropic(geminiTools) {
    if (!geminiTools || !Array.isArray(geminiTools))
        return [];
    const anthropicTools = [];
    for (const toolGroup of geminiTools) {
        if (toolGroup.functionDeclarations && Array.isArray(toolGroup.functionDeclarations)) {
            for (const func of toolGroup.functionDeclarations) {
                const declaration = func.parametersJsonSchema ?? func.parameters;
                const params = (0, utils_1.normalizeToolSchema)(declaration ?? { type: 'object', properties: {} });
                anthropicTools.push({
                    name: func.name,
                    description: func.description || '',
                    input_schema: params,
                });
            }
        }
    }
    return anthropicTools;
}
function mapGeminiToAnthropic(geminiBody, modelName, stateKey = modelName) {
    const messages = [];
    const historyCallIds = new Map();
    const pendingToolResults = [];
    const pendingToolResponseContent = [];
    const flushToolResults = () => {
        if (!pendingToolResults.length)
            return;
        pushMessage(messages, { role: 'user', content: [...pendingToolResults, ...pendingToolResponseContent] });
        pendingToolResults.length = 0;
        pendingToolResponseContent.length = 0;
    };
    let system = undefined;
    const tc = geminiBody.generationConfig?.thinkingConfig;
    const thinkingExplicitlyDisabled = tc?.thinkingBudget === 0 ||
        tc?.thinking_budget === 0 ||
        tc?.includeThoughts === false ||
        tc?.include_thoughts === false;
    if (geminiBody.systemInstruction && geminiBody.systemInstruction.parts) {
        (0, images_1.assertUserImageParts)(geminiBody.systemInstruction.parts, 'system');
        const sysText = geminiBody.systemInstruction.parts
            .filter((p) => !p.thought)
            .map((p) => p.text || '')
            .join('');
        if (sysText)
            system = sysText;
    }
    if (geminiBody.contents) {
        for (const item of geminiBody.contents) {
            if (item.parts) {
                (0, images_1.assertUserImageParts)(item.parts, item.role || 'user');
                const hasFunctionCall = item.parts.some((p) => p.functionCall);
                const hasFunctionResponse = item.parts.some((p) => p.functionResponse);
                if (!hasFunctionResponse)
                    flushToolResults();
                if (hasFunctionCall && item.role === 'model') {
                    const contentBlocks = [
                        ...extractAssistantThinkingBlocks(item.parts, thinkingExplicitlyDisabled, stateKey),
                    ];
                    for (const p of item.parts) {
                        if (p.thought)
                            continue;
                        if (p.text)
                            contentBlocks.push({ type: 'text', text: p.text });
                        if (p.functionCall) {
                            const callId = p.functionCall.id || 'call_' + Math.random().toString(36).slice(2, 10);
                            const ids = historyCallIds.get(p.functionCall.name) || [];
                            ids.push(callId);
                            historyCallIds.set(p.functionCall.name, ids);
                            let originalName = p.functionCall.name;
                            let originalArgs = p.functionCall.args;
                            const translatedInfo = shared_1.translatedToolCalls.get(callId);
                            if (translatedInfo) {
                                originalName = translatedInfo.originalName;
                                originalArgs = { CommandLine: translatedInfo.cmd, Cwd: translatedInfo.cwd };
                            }
                            let parsedInput = {};
                            if (typeof originalArgs === 'string') {
                                try {
                                    const parsed = JSON.parse(originalArgs);
                                    parsedInput =
                                        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                                            ? parsed
                                            : {};
                                }
                                catch (e) {
                                    electron_log_1.default.debug('[Anthropic] History tool args parse fallback:', e.message);
                                    parsedInput = {};
                                }
                            }
                            else if (originalArgs && typeof originalArgs === 'object' && !Array.isArray(originalArgs)) {
                                parsedInput = originalArgs;
                            }
                            contentBlocks.push({
                                type: 'tool_use',
                                id: callId,
                                name: originalName,
                                input: parsedInput,
                            });
                        }
                    }
                    pushMessage(messages, { role: 'assistant', content: contentBlocks });
                }
                else if (hasFunctionResponse) {
                    for (const p of item.parts) {
                        if (!p.thought)
                            pendingToolResponseContent.push(...mapContentParts([p]));
                        if (p.functionResponse) {
                            // Tool media arrives as nested parts, not as top-level image parts.
                            const nestedContent = mapContentParts((0, images_1.nestedFunctionResponseParts)(p));
                            if (nestedContent.length)
                                pendingToolResponseContent.push(...nestedContent);
                            const funcName = p.functionResponse.name || '';
                            const modelTCIds = shared_1.modelToolCallIds.get(stateKey) || {};
                            const ids = historyCallIds.get(funcName) || [];
                            const toolCallId = p.functionResponse.id || ids.shift() || modelTCIds[funcName] || 'call_' + funcName;
                            if (p.functionResponse.id) {
                                const matched = ids.indexOf(p.functionResponse.id);
                                if (matched >= 0)
                                    ids.splice(matched, 1);
                            }
                            const responseData = p.functionResponse.response;
                            let contentStr = '';
                            const translatedInfo = shared_1.translatedToolCalls.get(toolCallId);
                            if (translatedInfo) {
                                contentStr = (0, utils_1.formatTranslatedResponse)(translatedInfo, responseData);
                            }
                            else {
                                contentStr = typeof responseData === 'string' ? responseData : JSON.stringify(responseData || {});
                            }
                            pendingToolResults.push({
                                type: 'tool_result',
                                tool_use_id: toolCallId,
                                content: contentStr,
                            });
                        }
                    }
                }
                else {
                    const roleStr = item.role === 'model' ? 'assistant' : item.role || 'user';
                    const parts = mapContentParts(item.parts);
                    if (roleStr === 'system') {
                        const sysText = parts.map((part) => part.text || '').filter(Boolean).join('\n');
                        if (sysText)
                            system = system ? `${system}\n${sysText}` : sysText;
                    }
                    else if (roleStr === 'assistant') {
                        const thinkingBlocks = extractAssistantThinkingBlocks(item.parts, thinkingExplicitlyDisabled, stateKey);
                        if (thinkingBlocks.length > 0) {
                            pushMessage(messages, { role: 'assistant', content: [...thinkingBlocks, ...parts] });
                        }
                        else {
                            const content = parts.some((part) => part.type === 'image')
                                ? parts
                                : parts.map((part) => part.text || '').join('\n');
                            pushMessage(messages, { role: 'assistant', content });
                        }
                    }
                    else {
                        const content = parts.some((part) => part.type === 'image')
                            ? parts
                            : parts.map((part) => part.text || '').join('\n');
                        pushMessage(messages, { role: 'user', content });
                    }
                }
            }
        }
    }
    // Anthropic requires tool results before text, even when Gemini splits the results across items.
    flushToolResults();
    const result = {
        model: modelName,
        messages,
        system,
        max_tokens: geminiBody.generationConfig?.maxOutputTokens ?? 16000,
    };
    // Claude thinking models don't support temperature (centralized detection)
    const { isThinkingModel } = (0, modelUtils_1.detectModelCapabilitiesByName)(modelName);
    if (!isThinkingModel) {
        const temp = geminiBody.generationConfig?.temperature;
        if (temp !== undefined && temp !== null)
            result.temperature = temp;
    }
    if (geminiBody.tools && Array.isArray(geminiBody.tools)) {
        const anthTools = mapGeminiToolsToAnthropic(geminiBody.tools);
        if (anthTools.length > 0)
            result.tools = anthTools;
    }
    return result;
}
// ─── RESPONSE: Anthropic → Gemini ─────────────────────────────────────────
function mapAnthropicToGemini(anthRes, modelName, toolSchemas) {
    const contentBlocks = anthRes.content || [];
    const parts = [];
    const functionCalls = [];
    const thinkingBlocks = [];
    const toolIds = [];
    for (const block of contentBlocks) {
        if (block.type === 'text' && block.text) {
            parts.push({ text: block.text });
        }
        else if (block.type === 'thinking' && (block.thinking || block.signature)) {
            const thinkingText = block.thinking || '';
            if (block.signature) {
                recordThinkingSignature(thinkingText, block.signature);
                thinkingBlocks.push({ type: 'thinking', thinking: thinkingText, signature: block.signature });
                parts.push({ text: thinkingText, thought: true, thoughtSignature: block.signature });
            }
            else {
                parts.push({ text: thinkingText, thought: true });
            }
        }
        else if (block.type === 'redacted_thinking' && block.data) {
            recordRedactedThinking(block.data);
            thinkingBlocks.push({ type: 'redacted_thinking', data: block.data });
            parts.push({ thought: true, thoughtSignature: block.data });
        }
        else if (block.type === 'tool_use') {
            if (block.id)
                toolIds.push(block.id);
            const modelTCIds = shared_1.modelToolCallIds.get(modelName) || {};
            modelTCIds[block.name || ''] = block.id || '';
            shared_1.modelToolCallIds.set(modelName, modelTCIds);
            (0, shared_1.touchStateTimestamp)(shared_1.stateTimestamps.toolCallIds, modelName);
            const normalizedInput = (0, utils_1.normalizeToolArgs)(block.name || '', block.input || {}, toolSchemas);
            const translated = (0, utils_1.translateToolCallToNative)(block.name || '', normalizedInput, toolSchemas);
            if (translated.name !== block.name) {
                translated.args = (0, utils_1.normalizeToolArgs)(translated.name, translated.args, toolSchemas);
                shared_1.translatedToolCalls.set(block.id || '', {
                    originalName: block.name || '',
                    translatedName: translated.name,
                    cmd: normalizedInput.CommandLine || '',
                    cwd: normalizedInput.Cwd || '',
                });
                (0, shared_1.touchStateTimestamp)(shared_1.stateTimestamps.translatedCalls, block.id || '');
            }
            functionCalls.push({
                functionCall: { name: translated.name, args: translated.args, id: block.id },
            });
        }
    }
    if (toolIds.length > 0 && thinkingBlocks.length > 0) {
        recordThinkingBlocksForTools(toolIds, thinkingBlocks, modelName);
    }
    if (functionCalls.length > 0) {
        return {
            candidates: [
                { content: { parts: [...parts, ...functionCalls], role: 'model' }, finishReason: 'STOP', index: 0 },
            ],
            usageMetadata: {
                promptTokenCount: anthRes.usage?.input_tokens || 0,
                candidatesTokenCount: anthRes.usage?.output_tokens || 0,
                totalTokenCount: (anthRes.usage?.input_tokens || 0) + (anthRes.usage?.output_tokens || 0),
            },
        };
    }
    const finishReason = anthRes.stop_reason === 'end_turn' || anthRes.stop_reason === 'stop_sequence'
        ? 'STOP'
        : anthRes.stop_reason === 'max_tokens'
            ? 'MAX_TOKENS'
            : 'OTHER';
    return {
        candidates: [{ content: { parts, role: 'model' }, finishReason, index: 0 }],
        usageMetadata: {
            promptTokenCount: anthRes.usage?.input_tokens || 0,
            candidatesTokenCount: anthRes.usage?.output_tokens || 0,
            totalTokenCount: (anthRes.usage?.input_tokens || 0) + (anthRes.usage?.output_tokens || 0),
        },
    };
}
// ─── STREAM CHUNK: Anthropic SSE → Gemini ─────────────────────────────────
function getAnthropicStreamState(context) {
    let state = anthropicStreamStates.get(context);
    if (!state) {
        state = { thinkingBlocks: new Map() };
        anthropicStreamStates.set(context, state);
    }
    return state;
}
function finalizeStreamThinking(state, toolIds, scope) {
    const unemittedParts = [];
    const finalized = [];
    const sortedIndices = [...state.thinkingBlocks.keys()].sort((a, b) => a - b);
    for (const idx of sortedIndices) {
        const tb = state.thinkingBlocks.get(idx);
        if (tb.type === 'thinking' && tb.signature) {
            recordThinkingSignature(tb.thinking, tb.signature);
            finalized.push({ type: 'thinking', thinking: tb.thinking, signature: tb.signature });
            if (!tb.signatureEmitted) {
                tb.signatureEmitted = true;
                unemittedParts.push({ text: '', thought: true, thoughtSignature: tb.signature });
            }
        }
        else if (tb.type === 'redacted_thinking' && tb.data) {
            finalized.push({ type: 'redacted_thinking', data: tb.data });
        }
    }
    if (toolIds && toolIds.length > 0 && finalized.length > 0) {
        recordThinkingBlocksForTools(toolIds, finalized, scope);
    }
    return unemittedParts;
}
function mapAnthropicChunkToGemini(chunk, modelName, streamKey, toolSchemas) {
    const type = chunk.type;
    const streamId = streamKey || chunk.message?.id || 'anthropic_stream';
    // Suppress duplicate terminal event when message_delta already finalized a tool_use stream.
    if (type === 'message_stop' && completedStreamIds.has(streamId)) {
        completedStreamIds.delete(streamId);
        return null;
    }
    if (type !== 'message_stop') {
        completedStreamIds.delete(streamId);
    }
    if (!shared_1.activeStreamContexts.has(streamId)) {
        shared_1.activeStreamContexts.set(streamId, { accumulatedText: '', accumulatedReasoning: '', toolCalls: {} });
        (0, shared_1.touchStateTimestamp)(shared_1.stateTimestamps.streamCtx, streamId);
    }
    const context = shared_1.activeStreamContexts.get(streamId);
    const streamState = getAnthropicStreamState(context);
    if (type === 'content_block_start') {
        const block = chunk.content_block;
        const idx = chunk.index ?? 0;
        if (block?.type === 'tool_use') {
            context.toolCalls[idx] = {
                id: block.id || '',
                name: block.name || '',
                arguments: block.input && Object.keys(block.input).length ? JSON.stringify(block.input) : '',
            };
        }
        else if (block?.type === 'thinking') {
            streamState.thinkingBlocks.set(idx, {
                type: 'thinking',
                thinking: block.thinking || '',
                signature: block.signature || '',
                data: '',
                signatureEmitted: false,
            });
        }
        else if (block?.type === 'redacted_thinking' && block.data) {
            recordRedactedThinking(block.data);
            streamState.thinkingBlocks.set(idx, {
                type: 'redacted_thinking',
                thinking: '',
                signature: '',
                data: block.data,
                signatureEmitted: true,
            });
            return {
                content: { parts: [{ thought: true, thoughtSignature: block.data }], role: 'model' },
                finishReason: 'OTHER',
                index: 0,
            };
        }
    }
    if (type === 'content_block_delta') {
        const delta = chunk.delta;
        const idx = chunk.index ?? 0;
        if (delta?.type === 'text_delta') {
            const text = delta.text || '';
            context.accumulatedText += text;
            return { content: { parts: [{ text }], role: 'model' }, finishReason: 'OTHER', index: 0 };
        }
        else if (delta?.type === 'thinking_delta') {
            const thinkingText = delta.thinking || '';
            context.accumulatedReasoning += thinkingText;
            let tb = streamState.thinkingBlocks.get(idx);
            if (!tb) {
                tb = { type: 'thinking', thinking: '', signature: '', data: '', signatureEmitted: false };
                streamState.thinkingBlocks.set(idx, tb);
            }
            tb.thinking += thinkingText;
            return {
                content: { parts: [{ text: thinkingText, thought: true }], role: 'model' },
                finishReason: 'OTHER',
                index: 0,
            };
        }
        else if (delta?.type === 'signature_delta') {
            const sig = delta.signature || '';
            if (sig) {
                let tb = streamState.thinkingBlocks.get(idx);
                if (!tb) {
                    tb = { type: 'thinking', thinking: '', signature: '', data: '', signatureEmitted: false };
                    streamState.thinkingBlocks.set(idx, tb);
                }
                tb.signature += sig;
            }
            return null;
        }
        else if (delta?.type === 'input_json_delta' || delta?.type === 'input_delta') {
            if (context.toolCalls[idx]) {
                context.toolCalls[idx].arguments += delta.partial_json || '';
            }
        }
    }
    if (type === 'content_block_stop') {
        const idx = chunk.index ?? 0;
        const tb = streamState.thinkingBlocks.get(idx);
        if (tb && tb.type === 'thinking' && tb.signature && !tb.signatureEmitted) {
            tb.signatureEmitted = true;
            recordThinkingSignature(tb.thinking, tb.signature);
            return {
                content: { parts: [{ text: '', thought: true, thoughtSignature: tb.signature }], role: 'model' },
                finishReason: 'OTHER',
                index: 0,
            };
        }
    }
    if (type === 'message_delta') {
        const delta = chunk.delta;
        if (delta?.stop_reason === 'tool_use') {
            const toolIds = [];
            const parts = Object.values(context.toolCalls).map((tc) => {
                if (tc.id)
                    toolIds.push(tc.id);
                let args = {};
                try {
                    args = JSON.parse(tc.arguments || '{}');
                }
                catch (e) {
                    electron_log_1.default.debug('[Anthropic] Stream tool args parse fallback:', e.message);
                    args = {};
                }
                args = (0, utils_1.normalizeToolArgs)(tc.name, args, toolSchemas);
                const modelTCIds = shared_1.modelToolCallIds.get(modelName) || {};
                modelTCIds[tc.name] = tc.id;
                shared_1.modelToolCallIds.set(modelName, modelTCIds);
                (0, shared_1.touchStateTimestamp)(shared_1.stateTimestamps.toolCallIds, modelName);
                const translated = (0, utils_1.translateToolCallToNative)(tc.name, args, toolSchemas);
                if (translated.name !== tc.name) {
                    translated.args = (0, utils_1.normalizeToolArgs)(translated.name, translated.args, toolSchemas);
                    shared_1.translatedToolCalls.set(tc.id, {
                        originalName: tc.name,
                        translatedName: translated.name,
                        cmd: args.CommandLine || '',
                        cwd: args.Cwd || '',
                    });
                    (0, shared_1.touchStateTimestamp)(shared_1.stateTimestamps.translatedCalls, tc.id);
                }
                return { functionCall: { name: translated.name, args: translated.args, id: tc.id } };
            });
            const unemittedThinkingParts = finalizeStreamThinking(streamState, toolIds, streamKey);
            shared_1.activeStreamContexts.delete(streamId);
            addBoundedSet(completedStreamIds, streamId, MAX_COMPLETED_STREAMS);
            return { content: { parts: [...unemittedThinkingParts, ...parts], role: 'model' }, finishReason: 'STOP', index: 0 };
        }
        if (delta?.stop_reason) {
            streamState.stopReason = delta.stop_reason;
        }
    }
    if (type === 'message_stop') {
        const unemittedThinkingParts = finalizeStreamThinking(streamState);
        const stopReason = streamState.stopReason;
        const finishReason = stopReason === 'max_tokens'
            ? 'MAX_TOKENS'
            : !stopReason || stopReason === 'end_turn' || stopReason === 'stop_sequence'
                ? 'STOP'
                : 'OTHER';
        shared_1.activeStreamContexts.delete(streamId);
        return { content: { parts: unemittedThinkingParts, role: 'model' }, finishReason, index: 0 };
    }
    return null;
}
//# sourceMappingURL=anthropic.js.map