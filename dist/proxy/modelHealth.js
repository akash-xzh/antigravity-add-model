"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordRecentModel = recordRecentModel;
exports.isRecentModel = isRecentModel;
exports.getRecentModels = getRecentModels;
exports.sortCustomModels = sortCustomModels;
exports.setDataDirectory = setDataDirectory;
exports.getHealthCachePath = getHealthCachePath;
exports.loadHealthCache = loadHealthCache;
exports.saveHealthCache = saveHealthCache;
exports.getCachedHealth = getCachedHealth;
exports.getCachedHealthMap = getCachedHealthMap;
exports.setCachedHealth = setCachedHealth;
exports.clearHealthCache = clearHealthCache;
exports.recordModelSuccess = recordModelSuccess;
exports.recordModelFailure = recordModelFailure;
exports.cleanModelDisplayName = cleanModelDisplayName;
exports.formatHealthDisplayName = formatHealthDisplayName;
exports.pingCustomModel = pingCustomModel;
exports.checkAllModelsHealth = checkAllModelsHealth;
const node_http_1 = __importDefault(require("node:http"));
const node_https_1 = __importDefault(require("node:https"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_os_1 = __importDefault(require("node:os"));
const node_crypto_1 = require("node:crypto");
const electron_log_1 = __importDefault(require("electron-log"));
const HEALTH_CHECK_TIMEOUT_MS = 5000;
const FRESHNESS_TTL_MS = 15 * 60 * 1000; // 15 minutes before background refresh is eligible
const CONCURRENCY_LIMIT = 3;
const PACING_DELAY_MS = 150;
const MAX_RECENT_MODELS = 3;
let currentDataDirectory;
const memoryCache = new Map();
const inflightPings = new Map();
const recentModelsList = [];
function recordRecentModel(modelName) {
    if (!modelName)
        return;
    const filtered = recentModelsList.filter((m) => m !== modelName);
    recentModelsList.length = 0;
    recentModelsList.push(modelName, ...filtered);
    if (recentModelsList.length > MAX_RECENT_MODELS) {
        recentModelsList.length = MAX_RECENT_MODELS;
    }
    saveHealthCache();
}
function isRecentModel(modelName) {
    return recentModelsList.includes(modelName);
}
function getRecentModels() {
    return [...recentModelsList];
}
function getHealthRank(health) {
    if (!health || health.status === 'healthy')
        return 1;
    if (health.status === 'slow')
        return 2;
    if (health.status === 'cooldown')
        return 3;
    return 4; // unhealthy
}
/**
 * Sorts custom models:
 * 1. Starred / recently used models at the top (most recent first).
 * 2. Healthy models next (fastest latency first).
 * 3. Slow models next.
 * 4. Cooldown models next.
 * 5. Unhealthy / offline models last.
 */
function sortCustomModels(models) {
    const recentList = getRecentModels();
    return [...models].sort((a, b) => {
        const idxA = recentList.indexOf(a.name);
        const idxB = recentList.indexOf(b.name);
        const isRecA = idxA !== -1;
        const isRecB = idxB !== -1;
        if (isRecA && isRecB) {
            return idxA - idxB;
        }
        if (isRecA)
            return -1;
        if (isRecB)
            return 1;
        const healthA = getCachedHealth(a.name);
        const healthB = getCachedHealth(b.name);
        const rankA = getHealthRank(healthA);
        const rankB = getHealthRank(healthB);
        if (rankA !== rankB)
            return rankA - rankB;
        if (healthA?.status === 'healthy' && healthB?.status === 'healthy') {
            const latA = healthA.latencyMs ?? 9999;
            const latB = healthB.latencyMs ?? 9999;
            return latA - latB;
        }
        return 0;
    });
}
function setDataDirectory(dir) {
    currentDataDirectory = dir ? node_path_1.default.resolve(dir) : undefined;
}
function getHealthCachePath(dataDir) {
    const base = dataDir || currentDataDirectory || node_path_1.default.join(node_os_1.default.homedir(), '.gemini', 'antigravity');
    return node_path_1.default.join(base, 'model_health_cache.json');
}
function loadHealthCache(dataDir) {
    const filePath = getHealthCachePath(dataDir);
    try {
        if (!node_fs_1.default.existsSync(filePath))
            return memoryCache;
        const raw = node_fs_1.default.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            const modelsObj = parsed.models && typeof parsed.models === 'object' ? parsed.models : parsed;
            if (Array.isArray(parsed.recent)) {
                recentModelsList.length = 0;
                for (const item of parsed.recent) {
                    if (typeof item === 'string' && item && !recentModelsList.includes(item)) {
                        recentModelsList.push(item);
                    }
                }
                if (recentModelsList.length > MAX_RECENT_MODELS) {
                    recentModelsList.length = MAX_RECENT_MODELS;
                }
            }
            for (const [key, val] of Object.entries(modelsObj)) {
                if (val &&
                    typeof val === 'object' &&
                    ['healthy', 'slow', 'unhealthy', 'cooldown'].includes(val.status)) {
                    memoryCache.set(key, val);
                }
            }
        }
    }
    catch (err) {
        electron_log_1.default.debug('[ModelHealth] Could not read health cache from disk:', err);
    }
    return memoryCache;
}
function saveHealthCache(dataDir) {
    const filePath = getHealthCachePath(dataDir);
    try {
        node_fs_1.default.mkdirSync(node_path_1.default.dirname(filePath), { recursive: true, mode: 0o700 });
        const modelsObj = {};
        for (const [key, val] of memoryCache.entries()) {
            modelsObj[key] = val;
        }
        const payload = {
            models: modelsObj,
            recent: [...recentModelsList],
        };
        const tmp = `${filePath}.${(0, node_crypto_1.randomUUID)()}.tmp`;
        node_fs_1.default.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
        node_fs_1.default.renameSync(tmp, filePath);
    }
    catch (err) {
        electron_log_1.default.debug('[ModelHealth] Could not save health cache to disk:', err);
    }
}
function getCachedHealth(modelName) {
    return memoryCache.get(modelName);
}
function getCachedHealthMap() {
    return new Map(memoryCache);
}
function setCachedHealth(modelName, result, persist = true) {
    memoryCache.set(modelName, result);
    if (persist) {
        saveHealthCache();
    }
}
function clearHealthCache(persist = false) {
    memoryCache.clear();
    inflightPings.clear();
    recentModelsList.length = 0;
    if (persist) {
        saveHealthCache();
    }
}
/** Record live chat success: immediately marks the model healthy and tracks as recent */
function recordModelSuccess(modelName, latencyMs) {
    if (!modelName)
        return;
    recordRecentModel(modelName);
    const roundedLat = typeof latencyMs === 'number' && latencyMs > 0 ? Math.round(latencyMs) : undefined;
    const isSlow = roundedLat !== undefined && roundedLat > 2000;
    setCachedHealth(modelName, {
        status: isSlow ? 'slow' : 'healthy',
        latencyMs: roundedLat,
        checkedAt: Date.now(),
    });
}
/** Record live chat failure: immediately marks the model unhealthy/cooldown and tracks as recent */
function recordModelFailure(modelName, error) {
    if (!modelName)
        return;
    recordRecentModel(modelName);
    let cleanError = error ? String(error).replace(/^Error:\s*/i, '').trim() : 'Chat error';
    if (cleanError.length > 40)
        cleanError = cleanError.slice(0, 37) + '…';
    const isRateLimit = cleanError.includes('429') || /rate\s*limit/i.test(cleanError);
    setCachedHealth(modelName, {
        status: isRateLimit ? 'cooldown' : 'unhealthy',
        error: cleanError,
        checkedAt: Date.now(),
    });
}
/** Strip any status dots/emojis, stars, brackets, and bullets from display name */
function cleanModelDisplayName(name) {
    if (!name)
        return '';
    return name
        .replace(/^⭐\s*/u, '')
        .replace(/^[🟢🔴⚪🟡⭐\s•·|-]+(?:\[[^\]]+\]\s*)?[•·|-]?\s*/u, '')
        .trim();
}
/**
 * Formats a model's display name with star (⭐ for recent) and status circle (🟢 / 🟡 / 🔴) for the IDE dropdown.
 * Uses cached status so this executes in ~0ms with zero network calls.
 */
function formatHealthDisplayName(baseName, health, isRecent = false) {
    const clean = cleanModelDisplayName(baseName);
    const star = isRecent ? '⭐ ' : '';
    if (!health || health.status === 'healthy') {
        return `${star}🟢 • ${clean}`;
    }
    if (health.status === 'slow' || health.status === 'cooldown') {
        return `${star}🟡 • ${clean}`;
    }
    return `${star}🔴 • ${clean}`;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Pings a single model endpoint with a lightweight HTTP/HTTPS GET, aborting
 * immediately on headers to avoid downloading content or burning usage.
 */
function pingCustomModel(model) {
    // If provider is Google Cloud Code, check accounts without making external requests
    if (model.provider === 'google-cloudcode') {
        const hasAccount = Array.isArray(model.googleAccounts) && model.googleAccounts.some((a) => a.enabled !== false);
        const result = hasAccount
            ? { status: 'healthy', latencyMs: 5, checkedAt: Date.now() }
            : { status: 'unhealthy', error: 'No account', checkedAt: Date.now() };
        setCachedHealth(model.name, result);
        return Promise.resolve(result);
    }
    if (!model.apiUrl) {
        const result = { status: 'unhealthy', error: 'No URL', checkedAt: Date.now() };
        setCachedHealth(model.name, result);
        return Promise.resolve(result);
    }
    // Deduplicate concurrent in-flight pings to the exact same endpoint
    const endpointKey = `${model.apiUrl}::${model.apiKey || ''}::${model.provider || ''}`;
    const existingInflight = inflightPings.get(endpointKey);
    if (existingInflight) {
        return existingInflight.then((res) => {
            setCachedHealth(model.name, res);
            return res;
        });
    }
    const pingPromise = new Promise((resolve) => {
        const startTime = Date.now();
        let settled = false;
        let req = null;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            setCachedHealth(model.name, result);
            resolve(result);
        };
        const timer = setTimeout(() => {
            if (req) {
                try {
                    req.destroy();
                }
                catch {
                    /* ignore */
                }
            }
            finish({
                status: 'unhealthy',
                latencyMs: Date.now() - startTime,
                error: 'Timeout',
                checkedAt: Date.now(),
            });
        }, HEALTH_CHECK_TIMEOUT_MS);
        try {
            const parsedUrl = new URL(model.apiUrl);
            const isHttps = parsedUrl.protocol === 'https:';
            const client = isHttps ? node_https_1.default : node_http_1.default;
            const headers = {
                'User-Agent': 'Antigravity-HealthCheck/1.0',
                Accept: 'application/json, text/plain, */*',
            };
            if (model.apiKey && model.apiKey !== 'none') {
                headers['Authorization'] = `Bearer ${model.apiKey}`;
            }
            if (model.customHeaders) {
                for (const [k, v] of Object.entries(model.customHeaders)) {
                    if (typeof v === 'string')
                        headers[k] = v;
                }
            }
            req = client.request(parsedUrl, {
                method: 'GET',
                timeout: HEALTH_CHECK_TIMEOUT_MS,
                rejectUnauthorized: model.allowUnauthorized ? false : true,
                headers,
            }, (res) => {
                clearTimeout(timer);
                const latencyMs = Date.now() - startTime;
                const statusCode = res.statusCode || 0;
                // Abort response immediately to save bandwidth & time
                try {
                    res.destroy();
                    req?.destroy();
                }
                catch {
                    /* ignore */
                }
                if (statusCode === 429) {
                    finish({ status: 'cooldown', statusCode, latencyMs, error: 'Rate Limit (429)', checkedAt: Date.now() });
                }
                else if (statusCode === 401 || statusCode === 403) {
                    finish({ status: 'unhealthy', statusCode, latencyMs, error: 'Auth Error', checkedAt: Date.now() });
                }
                else if (statusCode >= 500) {
                    finish({
                        status: 'unhealthy',
                        statusCode,
                        latencyMs,
                        error: `Server Error (${statusCode})`,
                        checkedAt: Date.now(),
                    });
                }
                else if (latencyMs > 1500) {
                    finish({ status: 'slow', statusCode, latencyMs, checkedAt: Date.now() });
                }
                else {
                    // 200-399 or 400/404/405 means endpoint is alive and reached
                    finish({ status: 'healthy', statusCode, latencyMs, checkedAt: Date.now() });
                }
            });
            req.on('error', (err) => {
                clearTimeout(timer);
                const msg = err.message || 'Error';
                const error = msg.includes('ECONNREFUSED')
                    ? 'Offline'
                    : msg.includes('ENOTFOUND')
                        ? 'DNS Error'
                        : msg.slice(0, 24);
                finish({
                    status: 'unhealthy',
                    latencyMs: Date.now() - startTime,
                    error,
                    checkedAt: Date.now(),
                });
            });
            req.end();
        }
        catch (e) {
            clearTimeout(timer);
            finish({
                status: 'unhealthy',
                latencyMs: 0,
                error: e instanceof Error ? e.message.slice(0, 24) : 'Invalid URL',
                checkedAt: Date.now(),
            });
        }
    });
    inflightPings.set(endpointKey, pingPromise);
    pingPromise.finally(() => {
        if (inflightPings.get(endpointKey) === pingPromise) {
            inflightPings.delete(endpointKey);
        }
    });
    return pingPromise;
}
/**
 * Smart batch health check:
 * - Deduplicates endpoints so multiple models using 1 API key/host only trigger 1 ping.
 * - Paces requests (concurrency limit = 3, 150ms delay) to prevent burst rate limits.
 * - Reuses fresh cache unless force=true.
 */
async function checkAllModelsHealth(models, force = false) {
    if (!models || models.length === 0)
        return getCachedHealthMap();
    // Deduplicate by endpoint
    const endpointGroups = new Map();
    for (const m of models) {
        if (m.enabled === false)
            continue;
        const existing = memoryCache.get(m.name);
        if (!force && existing && Date.now() - existing.checkedAt < FRESHNESS_TTL_MS) {
            continue; // Cache is still fresh
        }
        const key = `${m.apiUrl || ''}::${m.apiKey || ''}::${m.provider || ''}`;
        const list = endpointGroups.get(key) || [];
        list.push(m);
        endpointGroups.set(key, list);
    }
    if (endpointGroups.size === 0) {
        return getCachedHealthMap();
    }
    electron_log_1.default.debug(`[ModelHealth] Smart health check: ${models.length} models across ${endpointGroups.size} unique endpoints (force=${force})`);
    const entries = Array.from(endpointGroups.entries());
    let index = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY_LIMIT, entries.length) }, async () => {
        while (index < entries.length) {
            const current = entries[index++];
            if (!current)
                break;
            const [, groupModels] = current;
            const primary = groupModels[0];
            const res = await pingCustomModel(primary);
            for (const m of groupModels) {
                setCachedHealth(m.name, res, false);
            }
            if (PACING_DELAY_MS > 0) {
                await sleep(PACING_DELAY_MS);
            }
        }
    });
    await Promise.allSettled(workers);
    saveHealthCache();
    return getCachedHealthMap();
}
// Initial cache load from default location
loadHealthCache();
//# sourceMappingURL=modelHealth.js.map