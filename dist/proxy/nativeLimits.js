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
exports.configureNativeLimits = configureNativeLimits;
exports.recordNativeLimits = recordNativeLimits;
exports.findNativeLimit = findNativeLimit;
exports.nativeLimitsPath = nativeLimitsPath;
exports.resetNativeLimits = resetNativeLimits;
/**
 * Context limits for Antigravity's own models, captured from the catalog the language server
 * serves. Official models never appear in custom_models.json, so their limit cannot be inferred
 * from the user's configuration. Cached on disk because the catalog only loads when the picker opens.
 */
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const MAX_ENTRIES = 400;
const limits = new Map();
let configured = '';
let dirty = false;
const key = (value) => value.trim().toLowerCase().replace(/^models\//, '').replace(/[^a-z0-9]/g, '');
const valid = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
function flush() {
    if (!dirty || !configured)
        return;
    while (limits.size > MAX_ENTRIES)
        limits.delete(limits.keys().next().value);
    try {
        fs.writeFileSync(configured, JSON.stringify(Object.fromEntries(limits)));
        dirty = false;
    }
    catch {
        // A read-only profile keeps the limits in memory for this session.
    }
}
function configureNativeLimits(filename) {
    if (filename === configured)
        return;
    configured = filename;
    try {
        const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
            for (const [id, value] of Object.entries(parsed))
                if (valid(value))
                    limits.set(id, value);
    }
    catch {
        // No catalog captured yet; the next GetAvailableModels response fills it.
    }
    // A catalog captured before configure() may still be pending on disk.
    flush();
}
/** Merge `models[slug].maxTokens` from the upstream (official) catalog. */
function recordNativeLimits(catalog) {
    const models = catalog && typeof catalog === 'object' ? catalog.models : undefined;
    if (!models || typeof models !== 'object' || Array.isArray(models))
        return;
    for (const [slug, raw] of Object.entries(models)) {
        const entry = raw && typeof raw === 'object' ? raw : undefined;
        if (!valid(entry?.maxTokens))
            continue;
        const max = entry.maxTokens;
        for (const value of [slug, typeof entry?.displayName === 'string' ? entry.displayName : '']) {
            const id = key(value);
            if (id && limits.get(id) !== max) {
                limits.delete(id);
                limits.set(id, max);
                dirty = true;
            }
        }
    }
    if (dirty)
        flush();
}
/** Exact model, name or slug; an effort suffix such as "(Medium)" is ignored. */
function findNativeLimit(name) {
    if (typeof name !== 'string')
        return undefined;
    const id = key(name);
    const direct = limits.get(id);
    if (direct)
        return direct;
    const bare = key(name.replace(/\s*\((?:minimal|low|medium|high|xhigh|extra)\)\s*$/i, ''));
    return bare && bare !== id ? limits.get(bare) : undefined;
}
function nativeLimitsPath(dataDirectory) {
    return path.join(dataDirectory, 'native_model_limits.json');
}
/** Test seam: drops every captured catalog limit. */
function resetNativeLimits() {
    limits.clear();
    configured = '';
    dirty = false;
}
//# sourceMappingURL=nativeLimits.js.map