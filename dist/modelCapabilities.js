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
exports.candidateModelSlugs = candidateModelSlugs;
exports.resolveFromBundle = resolveFromBundle;
exports.detectModelCapabilitiesBatch = detectModelCapabilitiesBatch;
/**
 * Automatic model capability & context-window resolver for Add/Discover model flows.
 *
 * Precedence ladder (per property):
 *   1. MrPiPidan ai-model-map (regex rules, cached 6h)
 *   2. The-Best-Codes ai-model-directory (all.json, cached 6h)
 *   3. models.dev catalog (api.json, cached 6h)
 *
 * Offline-safe: caches on disk under `<dataDirectory>/capability_cache/` with stale fallback
 * and returns `{}` gracefully when unreachable or unknown.
 */
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const MRPIPIDAN_URL = 'https://cdn.jsdelivr.net/gh/MrPiPidan/ai-model-map@main/model_capabilities.json';
const BESTCODES_URL = 'https://raw.githubusercontent.com/The-Best-Codes/ai-model-directory/refs/heads/main/data/all.json';
const MODELSDEV_URL = 'https://models.dev/api.json';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const FETCH_TIMEOUT_MS = 10000;
const MAX_LIMIT = 1000000000;
const VALID_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const VARIANT_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);
const VENDOR_HYPHEN_PREFIX_RE = /^(?:deepseek-ai|nvidia|minimaxai|minimax|qwen|zai-org|moonshotai|anthropic|openai|google|meta-llama|mistralai|stepfun|x-ai|baidu|xiaomi|alibaba|tencent|bytedance|cohere|upstage|together|fireworks|groq)-/i;
const QUANT_SUFFIX_RE = /-(?:nvfp4|fp8|fp16|bf16|int4|int8|awq|gptq|gguf|mlx|4bit|8bit)$/i;
function candidateModelSlugs(modelId) {
    const trimmed = typeof modelId === 'string' ? modelId.trim() : '';
    if (!trimmed)
        return [];
    const bare = trimmed.includes('/') ? trimmed.slice(trimmed.indexOf('/') + 1) : trimmed;
    const tail = bare.includes('/') ? bare.slice(bare.lastIndexOf('/') + 1) : bare;
    const variants = new Set([trimmed, bare, tail]);
    const expand = (fn) => {
        for (const v of [...variants]) {
            const next = fn(v);
            if (next && next !== v)
                variants.add(next);
        }
    };
    expand((v) => v.replace(/:(free|exacto|thinking|extended|beta)$/i, ''));
    expand((v) => v.replace(VENDOR_HYPHEN_PREFIX_RE, ''));
    expand((v) => v.replace(QUANT_SUFFIX_RE, ''));
    expand((v) => v
        .replace(/([a-z]\d+)-(\d+)(?=-|$|b\b)/gi, '$1.$2')
        .replace(/(^|-)(\d+)-(\d+b)(?=-|$)/gi, '$1$2.$3'));
    return Array.from(variants).filter(Boolean);
}
function normalizeEffort(value) {
    if (typeof value !== 'string')
        return undefined;
    const low = value.toLowerCase().trim();
    if (low === 'max' || low === 'extra')
        return 'xhigh';
    return VALID_EFFORTS.has(low) ? low : undefined;
}
async function fetchCachedJson(url, cacheDir, cacheName) {
    const cacheFile = path.join(cacheDir, cacheName);
    try {
        if (fs.existsSync(cacheFile)) {
            const stat = fs.statSync(cacheFile);
            if (Date.now() - stat.mtimeMs < CACHE_TTL_MS) {
                return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
            }
        }
    }
    catch {
        /* ignore corrupt cache */
    }
    try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!resp.ok)
            throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        try {
            fs.mkdirSync(cacheDir, { recursive: true });
            fs.writeFileSync(cacheFile, JSON.stringify(data), 'utf8');
        }
        catch {
            /* cache write failure is non-fatal */
        }
        return data;
    }
    catch {
        try {
            if (fs.existsSync(cacheFile)) {
                return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
            }
        }
        catch {
            /* ignore */
        }
        return null;
    }
}
const bundleCache = new Map();
const pendingLoads = new Map();
function compileMrPipidan(data) {
    const rules = data?.rules;
    if (!Array.isArray(rules))
        return [];
    const compiled = [];
    for (const rule of rules) {
        if (!rule || typeof rule.pattern !== 'string')
            continue;
        try {
            compiled.push({ regex: new RegExp(`^(?:${rule.pattern})$`, 'i'), rule });
        }
        catch {
            /* skip invalid regex */
        }
    }
    return compiled;
}
function indexCatalog(data) {
    const byKey = new Map();
    if (!data || typeof data !== 'object')
        return byKey;
    for (const [provId, prov] of Object.entries(data)) {
        const models = prov?.models;
        if (!models || typeof models !== 'object')
            continue;
        for (const [key, entry] of Object.entries(models)) {
            if (!entry || typeof entry !== 'object')
                continue;
            const rec = entry;
            const id = typeof rec.id === 'string' ? rec.id : '';
            const name = typeof rec.name === 'string' ? rec.name : '';
            for (const k of [`${provId}/${key}`, key, id, name, id ? `${provId}/${id}` : '', name ? `${provId}/${name}` : '']) {
                const low = k.toLowerCase().trim();
                if (low && !byKey.has(low))
                    byKey.set(low, rec);
            }
        }
    }
    return byKey;
}
async function getCatalogBundle(dataDirectory) {
    const cacheDir = path.join(dataDirectory, 'capability_cache');
    const cached = bundleCache.get(cacheDir);
    if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS)
        return cached;
    const inflight = pendingLoads.get(cacheDir);
    if (inflight)
        return inflight;
    const load = (async () => {
        const [mrData, bestData, devData] = await Promise.all([
            fetchCachedJson(MRPIPIDAN_URL, cacheDir, 'mrpipidan_capabilities.json'),
            fetchCachedJson(BESTCODES_URL, cacheDir, 'bestcodes_all.json'),
            fetchCachedJson(MODELSDEV_URL, cacheDir, 'models_dev.json'),
        ]);
        const bundle = {
            loadedAt: Date.now(),
            mrRules: compileMrPipidan(mrData),
            bestIndex: indexCatalog(bestData),
            devIndex: indexCatalog(devData),
        };
        bundleCache.set(cacheDir, bundle);
        return bundle;
    })();
    pendingLoads.set(cacheDir, load);
    try {
        return await load;
    }
    finally {
        pendingLoads.delete(cacheDir);
    }
}
function resolveFromBundle(modelId, bundle) {
    const slugs = candidateModelSlugs(modelId);
    if (!slugs.length)
        return {};
    const out = {};
    const fill = (patch) => {
        if (!patch)
            return;
        if (out.contextWindow === undefined &&
            typeof patch.contextWindow === 'number' &&
            Number.isSafeInteger(patch.contextWindow) &&
            patch.contextWindow > 0) {
            out.contextWindow = Math.min(patch.contextWindow, MAX_LIMIT);
        }
        if (out.maxOutputTokens === undefined &&
            typeof patch.maxOutputTokens === 'number' &&
            Number.isSafeInteger(patch.maxOutputTokens) &&
            patch.maxOutputTokens > 0) {
            out.maxOutputTokens = Math.min(patch.maxOutputTokens, MAX_LIMIT);
        }
        if (out.supportsVision === undefined && typeof patch.supportsVision === 'boolean') {
            out.supportsVision = patch.supportsVision;
        }
        if (out.supportsThinking === undefined && typeof patch.supportsThinking === 'boolean') {
            out.supportsThinking = patch.supportsThinking;
        }
        if (out.reasoningEffort === undefined && patch.reasoningEffort !== undefined) {
            const eff = normalizeEffort(patch.reasoningEffort);
            if (eff)
                out.reasoningEffort = eff;
        }
        if (out.supportedEfforts === undefined && Array.isArray(patch.supportedEfforts)) {
            const filtered = patch.supportedEfforts
                .map((e) => normalizeEffort(e))
                .filter((e) => Boolean(e && VARIANT_EFFORTS.has(e)));
            if (filtered.length)
                out.supportedEfforts = Array.from(new Set(filtered));
        }
    };
    // 1. MrPiPidan regex rules (skip catch-all ".*" so specific catalog hits win)
    for (const { regex, rule } of bundle.mrRules) {
        if (rule.pattern === '.*' || rule.pattern === '.+')
            continue;
        if (slugs.some((s) => regex.test(s))) {
            fill({
                contextWindow: rule.context?.max_context ?? rule.context?.max_input,
                maxOutputTokens: rule.context?.max_output,
                supportsVision: rule.capabilities?.vision,
                supportsThinking: rule.capabilities?.thinking,
                reasoningEffort: rule.default_effort,
                supportedEfforts: rule.efforts,
            });
            break;
        }
    }
    // 2. The-Best-Codes ai-model-directory
    for (const s of slugs) {
        const entry = bundle.bestIndex.get(s.toLowerCase());
        if (entry) {
            const limit = entry.limit;
            const modalities = entry.modalities;
            fill({
                contextWindow: limit?.context,
                maxOutputTokens: limit?.output,
                supportsVision: Array.isArray(modalities?.input) ? modalities.input.includes('image') : undefined,
                supportsThinking: typeof entry.reasoning === 'boolean' ? entry.reasoning : undefined,
            });
            break;
        }
    }
    // 3. models.dev catalog
    for (const s of slugs) {
        const entry = bundle.devIndex.get(s.toLowerCase());
        if (entry) {
            const limit = entry.limit;
            const modalities = entry.modalities;
            fill({
                contextWindow: limit?.context,
                maxOutputTokens: limit?.output,
                supportsVision: Array.isArray(modalities?.input) ? modalities.input.includes('image') : undefined,
                supportsThinking: typeof entry.reasoning === 'boolean' ? entry.reasoning : undefined,
            });
            break;
        }
    }
    // Ensure maxOutputTokens is always strictly less than contextWindow for schema validation
    if (typeof out.contextWindow === 'number' &&
        typeof out.maxOutputTokens === 'number' &&
        out.maxOutputTokens >= out.contextWindow) {
        out.maxOutputTokens = out.contextWindow > 1 ? out.contextWindow - 1 : undefined;
    }
    return out;
}
async function detectModelCapabilitiesBatch(modelIds, dataDirectory) {
    const unique = Array.from(new Set(modelIds.filter((id) => typeof id === 'string' && Boolean(id.trim())).map((id) => id.trim()))).slice(0, 500);
    if (!unique.length)
        return {};
    const bundle = await getCatalogBundle(dataDirectory);
    const result = {};
    for (const id of unique) {
        const caps = resolveFromBundle(id, bundle);
        if (Object.keys(caps).length > 0)
            result[id] = caps;
    }
    return result;
}
//# sourceMappingURL=modelCapabilities.js.map