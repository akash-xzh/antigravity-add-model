"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.globalSystemPromptFile = globalSystemPromptFile;
exports.globalSystemPromptReplaces = globalSystemPromptReplaces;
exports.globalSystemPrompt = globalSystemPrompt;
exports.withGlobalSystemPrompt = withGlobalSystemPrompt;
exports.captureSystemPrompt = captureSystemPrompt;
exports.injectGlobalSystemPrompt = injectGlobalSystemPrompt;
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const electron_log_1 = __importDefault(require("electron-log"));
const requestOptions_1 = require("./requestOptions");
const promptSections_1 = require("./promptSections");
/**
 * Generous cap: a full replacement prompt is about 28k characters, and the
 * per-model `systemPrompt` field's 20k limit does not apply to this file.
 */
const LIMIT = 100000;
function read(file) {
    try {
        const stat = node_fs_1.default.statSync(file);
        if (!stat.isFile() || stat.size > LIMIT * 4)
            return undefined;
        const raw = node_fs_1.default.readFileSync(file, 'utf8').trim();
        if (raw.length > LIMIT) {
            electron_log_1.default.warn(`[Proxy] ${file} exceeds ${LIMIT} characters; using the first ${LIMIT}.`);
            return { mtimeMs: stat.mtimeMs, size: stat.size, text: raw.slice(0, LIMIT) };
        }
        return { mtimeMs: stat.mtimeMs, size: stat.size, text: raw };
    }
    catch {
        return undefined;
    }
}
/**
 * Where the operator's global instruction lives. Default `append` keeps
 * Antigravity's instruction first; `replace` (ANTIGRAVITY_GLOBAL_PROMPT_MODE)
 * discards it entirely, including its tool and agent rules.
 */
function globalSystemPromptFile() {
    return (process.env.ANTIGRAVITY_GLOBAL_PROMPT ||
        node_path_1.default.join(node_os_1.default.homedir(), '.gemini', 'antigravity', 'global-system-prompt.txt'));
}
function globalSystemPromptReplaces() {
    return (process.env.ANTIGRAVITY_GLOBAL_PROMPT_MODE || '').trim().toLowerCase() === 'replace';
}
let cached;
/**
 * The file actually read for injection. An explicit env path always wins; a
 * test run must not pick up the operator's real file from the home directory,
 * which would make unrelated payload assertions depend on the machine.
 */
function activeFile() {
    if (process.env.ANTIGRAVITY_GLOBAL_PROMPT)
        return process.env.ANTIGRAVITY_GLOBAL_PROMPT;
    if (process.env.VITEST)
        return undefined;
    return globalSystemPromptFile();
}
/** Cached by mtime so editing the file applies on the next request without a restart. */
function globalSystemPrompt() {
    const file = activeFile();
    if (!file) {
        cached = undefined;
        return '';
    }
    const current = read(file);
    if (!current) {
        cached = undefined;
        return '';
    }
    if (cached?.file === file && cached.mtimeMs === current.mtimeMs && cached.size === current.size)
        return cached.text;
    cached = { file, ...current };
    return current.text;
}
function withGlobalSystemPrompt(body) {
    // First apply targeted section rewrites to the existing system instruction (if present)
    let workingBody = body;
    const rawInstruction = (body.systemInstruction ?? {});
    if (Array.isArray(rawInstruction.parts) && rawInstruction.parts.length > 0) {
        const updatedParts = rawInstruction.parts.map((p) => {
            const partObj = p;
            if (typeof partObj?.text === 'string') {
                const rewritten = (0, promptSections_1.rewritePromptSections)(partObj.text);
                if (rewritten !== partObj.text) {
                    return { ...partObj, text: rewritten };
                }
            }
            return p;
        });
        workingBody = { ...body, systemInstruction: { ...rawInstruction, parts: updatedParts } };
    }
    const text = globalSystemPrompt();
    if (!text)
        return workingBody;
    if (!globalSystemPromptReplaces())
        return (0, requestOptions_1.appendModelSystemPrompt)(workingBody, text);
    // replace mode: the operator's file becomes the whole instruction.
    const instruction = (workingBody.systemInstruction ?? {});
    return { ...workingBody, systemInstruction: { ...instruction, parts: [{ text }] } };
}
/**
 * Opt-in diagnostic. Antigravity sends most of its own instruction only on the
 * first turn of a conversation, so the whole body is captured once and never
 * replaced. Enable with `ANTIGRAVITY_CAPTURE_SYSTEM_PROMPT=<file>`.
 */
function captureSystemPrompt(body) {
    const setting = process.env.ANTIGRAVITY_CAPTURE_SYSTEM_PROMPT;
    const target = setting === '1'
        ? node_path_1.default.join(node_path_1.default.dirname(globalSystemPromptFile()), 'captured-request.json')
        : setting || '';
    if (!target)
        return;
    try {
        const json = JSON.stringify(body, null, 2) + '\n';
        // flag 'wx' makes this one capture per file: never replace a real record.
        node_fs_1.default.writeFileSync(target, json, { flag: 'wx', mode: 0o600 });
        electron_log_1.default.info(`[Proxy] Captured the Antigravity request body at ${target}`);
    }
    catch {
        /* Already captured, or the path is unusable. */
    }
}
/**
 * Inject into a Gemini-format JSON body, including the Cloud Code `request`
 * envelope. Returns the input buffer untouched when nothing was added or the
 * body is not Gemini JSON (for example the opaque fallback proxy).
 */
function injectGlobalSystemPrompt(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw.toString('utf8'));
    }
    catch {
        return raw;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return raw;
    const envelope = parsed.request;
    const isEnvelope = !!envelope && typeof envelope === 'object' && !Array.isArray(envelope);
    const target = (isEnvelope ? envelope : parsed);
    captureSystemPrompt(target);
    if (!globalSystemPrompt())
        return raw;
    // In replace mode the captured body is left alone only if it already matches.
    const updated = withGlobalSystemPrompt(target);
    if (updated === target)
        return raw;
    return Buffer.from(JSON.stringify(isEnvelope ? { ...parsed, request: updated } : updated));
}
//# sourceMappingURL=globalPrompt.js.map