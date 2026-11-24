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
exports.NATIVE_MODEL_CAPACITY = void 0;
exports.legacyPlaceholderId = legacyPlaceholderId;
exports.placeholderIndex = placeholderIndex;
exports.allocateModelIdentities = allocateModelIdentities;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_crypto_1 = require("node:crypto");
const modelCatalog_1 = require("./proxy/modelCatalog");
/** Verified against the Antigravity IDE 2.5.5 Model enum: M0..M650 = 1000..1650. */
exports.NATIVE_MODEL_CAPACITY = 651;
function hash(value) {
    let result = 5381;
    for (let i = 0; i < value.length; i++)
        result = ((result << 5) + result + value.charCodeAt(i)) | 0;
    return Math.abs(result);
}
function legacyPlaceholderId(model) {
    return `MODEL_PLACEHOLDER_M${400 + (hash((model.displayName || model.name || 'custom-model').toLowerCase()) % 200)}`;
}
function placeholderIndex(value) {
    const index = typeof value === 'number'
        ? value - 1000
        : typeof value === 'string' && /^MODEL_PLACEHOLDER_M\d+$/.test(value)
            ? Number(value.slice('MODEL_PLACEHOLDER_M'.length))
            : undefined;
    return Number.isInteger(index) && index >= 0 && index < exports.NATIVE_MODEL_CAPACITY ? index : undefined;
}
function upstreamPlaceholders(upstream) {
    if (!upstream || typeof upstream !== 'object')
        return [];
    const result = new Set();
    for (const key of ['models', 'availableModels', 'available_models']) {
        const collection = upstream[key];
        if (!collection || typeof collection !== 'object')
            continue;
        for (const entry of Object.values(collection)) {
            if (!entry || typeof entry !== 'object')
                continue;
            const index = placeholderIndex(entry.model);
            if (index !== undefined)
                result.add(index);
        }
    }
    return [...result];
}
function loadState(filename) {
    try {
        const raw = JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (raw?.version !== 1 ||
            !raw.assignments ||
            typeof raw.assignments !== 'object' ||
            Array.isArray(raw.assignments) ||
            !Array.isArray(raw.reserved))
            throw new Error('Invalid native model identity metadata');
        const entries = Object.entries(raw.assignments);
        const valid = (value) => Number.isInteger(value) && Number(value) >= 0 && Number(value) < exports.NATIVE_MODEL_CAPACITY;
        if (entries.some(([name, value]) => !name || !valid(value)) || raw.reserved.some((value) => !valid(value)))
            throw new Error('Invalid native model identity allocation');
        if (new Set(entries.map(([, value]) => value)).size !== entries.length)
            throw new Error('Duplicate native model identity allocation');
        return {
            version: 1,
            assignments: Object.fromEntries(entries),
            reserved: [...new Set(raw.reserved)],
        };
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return { version: 1, assignments: {}, reserved: [] };
        throw error;
    }
}
const LOCK_STALE_MS = 10000;
/** A live holder may run long (bulk import); only reclaim after this hard expiry. */
const LOCK_HARD_EXPIRY_MS = 10 * 60000;
const LOCK_MAX_ATTEMPTS = 15;
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY']);
const RENAME_MAX_ATTEMPTS = 5;
function sleepSync(ms) {
    if (ms <= 0)
        return;
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    }
    catch {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            /* fallback pause */
        }
    }
}
function isLockReclaimable(lockfile) {
    try {
        const stat = fs.statSync(lockfile);
        const ageMs = Date.now() - stat.mtimeMs;
        const raw = fs.readFileSync(lockfile, 'utf8').trim();
        if (!raw) {
            return ageMs > LOCK_STALE_MS;
        }
        let pid;
        let createdAt;
        if (/^\d+$/.test(raw)) {
            pid = Number(raw);
        }
        else {
            const parsed = JSON.parse(raw);
            if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0)
                pid = parsed.pid;
            if (typeof parsed.createdAt === 'number' && Number.isFinite(parsed.createdAt))
                createdAt = parsed.createdAt;
        }
        const age = createdAt !== undefined ? Date.now() - createdAt : ageMs;
        if (pid !== undefined) {
            let alive = true;
            try {
                process.kill(pid, 0);
            }
            catch (failure) {
                if (failure.code === 'ESRCH')
                    alive = false;
            }
            if (alive) {
                // Stealing a lock from a live slow writer lets two read-modify-write
                // cycles clobber each other. Only a hard expiry (where a PID may have
                // been reused) is allowed to win against a live holder.
                return age > LOCK_HARD_EXPIRY_MS;
            }
            return true;
        }
        return age > LOCK_STALE_MS;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        try {
            return Date.now() - fs.statSync(lockfile).mtimeMs > LOCK_STALE_MS;
        }
        catch {
            return false;
        }
    }
}
function formatIdentities(models, assignments) {
    return models.map((model) => {
        const index = assignments.get(model.name);
        return {
            name: model.name,
            catalogId: (0, modelCatalog_1.catalogModelSlug)(model, models),
            ...(index === undefined ? {} : { placeholderId: `MODEL_PLACEHOLDER_M${index}`, placeholderValue: index + 1000 }),
        };
    });
}
function renameWithRetry(source, destination) {
    for (let attempt = 0; attempt < RENAME_MAX_ATTEMPTS; attempt++) {
        try {
            fs.renameSync(source, destination);
            return;
        }
        catch (error) {
            const code = error.code;
            if (code && RENAME_RETRY_CODES.has(code) && attempt < RENAME_MAX_ATTEMPTS - 1) {
                sleepSync(10 * (attempt + 1));
                continue;
            }
            throw error;
        }
    }
}
/**
 * Persist enum ownership independently of model ordering, display labels and secrets.
 * Removed models retain their assignment while free slots remain; if the 651-slot pool
 * is exhausted, oldest inactive assignments are reclaimed before failing.
 * Native enum reservations survive offline catalog fallback; a newly observed native owner wins.
 */
function allocateModelIdentities(dataDirectory, models, upstream) {
    const unique = new Map(models.map((model) => [model.name, model]));
    if (unique.size !== models.length)
        throw new Error('Duplicate saved model names cannot have distinct native identities');
    // Lock-free fast path for read-only lookups when all requested models already have valid
    // non-reserved assignments and no new upstream reservations need persisting.
    const filename = path.join(dataDirectory, 'custom_model_identities.json');
    try {
        const state = loadState(filename);
        const reservedSet = new Set(state.reserved);
        const upstreamIndices = upstreamPlaceholders(upstream);
        const hasNewReservations = upstreamIndices.some((index) => !reservedSet.has(index));
        const allAssigned = models.every((model) => {
            const index = state.assignments[model.name];
            return index !== undefined && !reservedSet.has(index);
        });
        if (!hasNewReservations && allAssigned) {
            return formatIdentities(models, new Map(Object.entries(state.assignments)));
        }
    }
    catch {
        // Fall through to locked path so corrupt state or concurrent lock contention is handled consistently.
    }
    fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const lockfile = path.join(dataDirectory, 'custom_model_identities.lock');
    const owner = JSON.stringify({ pid: process.pid, token: (0, node_crypto_1.randomUUID)(), createdAt: Date.now() });
    let lock;
    for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
        try {
            lock = fs.openSync(lockfile, 'wx', 0o600);
            break;
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            if (isLockReclaimable(lockfile)) {
                try {
                    fs.unlinkSync(lockfile);
                }
                catch {
                    /* ignore ENOENT or transient unlink race */
                }
                continue;
            }
            if (attempt < LOCK_MAX_ATTEMPTS - 1) {
                sleepSync(Math.min(40, 10 + attempt * 2));
            }
        }
    }
    if (lock === undefined) {
        throw new Error('Native model identities are being updated by another process; retry after it finishes');
    }
    try {
        fs.writeFileSync(lock, owner);
        return allocateLocked(dataDirectory, models, upstream);
    }
    finally {
        try {
            fs.closeSync(lock);
        }
        catch {
            /* ignore close errors */
        }
        try {
            if (fs.existsSync(lockfile) && fs.readFileSync(lockfile, 'utf8') === owner) {
                fs.unlinkSync(lockfile);
            }
        }
        catch {
            /* never mask an earlier error */
        }
    }
}
function allocateLocked(dataDirectory, models, upstream) {
    const filename = path.join(dataDirectory, 'custom_model_identities.json');
    const state = loadState(filename);
    const before = JSON.stringify(state);
    const reserved = new Set([...state.reserved, ...upstreamPlaceholders(upstream)]);
    const assignments = new Map(Object.entries(state.assignments));
    // A Google catalog can start using an enum that was free at installation time.
    // Retire our old ownership instead of ever routing that native selection to a custom provider.
    for (const [name, index] of assignments)
        if (reserved.has(index))
            assignments.delete(name);
    const used = new Set([...reserved, ...assignments.values()]);
    const unique = new Map(models.map((model) => [model.name, model]));
    if (unique.size !== models.length)
        throw new Error('Duplicate saved model names cannot have distinct native identities');
    const ordered = [...unique.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const legacyCounts = new Map();
    for (const model of ordered) {
        const index = placeholderIndex(legacyPlaceholderId(model));
        legacyCounts.set(index, (legacyCounts.get(index) || 0) + 1);
    }
    // Preserve unambiguous legacy IDs during migration, before allocating collision replacements.
    for (const model of ordered) {
        if (assignments.has(model.name))
            continue;
        const legacy = placeholderIndex(legacyPlaceholderId(model));
        if (legacyCounts.get(legacy) === 1 && !used.has(legacy)) {
            assignments.set(model.name, legacy);
            used.add(legacy);
        }
    }
    // Inactive assignments (oldest first in insertion order) can be reclaimed ONLY if the 651-slot pool is exhausted.
    const reclaimable = [];
    for (const [name, index] of assignments) {
        if (!unique.has(name) && !reserved.has(index)) {
            reclaimable.push([name, index]);
        }
    }
    for (const model of ordered) {
        if (assignments.has(model.name))
            continue;
        const start = hash(model.name) % exports.NATIVE_MODEL_CAPACITY;
        let allocated = false;
        for (let offset = 0; offset < exports.NATIVE_MODEL_CAPACITY; offset++) {
            const index = (start + offset) % exports.NATIVE_MODEL_CAPACITY;
            if (used.has(index))
                continue;
            assignments.set(model.name, index);
            used.add(index);
            allocated = true;
            break;
        }
        if (!allocated && reclaimable.length > 0) {
            const [evictedName, reclaimedIndex] = reclaimable.shift();
            assignments.delete(evictedName);
            assignments.set(model.name, reclaimedIndex);
        }
    }
    state.assignments = Object.fromEntries(assignments);
    state.reserved = [...reserved].sort((a, b) => a - b);
    if (JSON.stringify(state) !== before) {
        fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
        const temporary = `${filename}.${(0, node_crypto_1.randomUUID)()}.tmp`;
        try {
            fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
            renameWithRetry(temporary, filename);
        }
        finally {
            try {
                if (fs.existsSync(temporary))
                    fs.unlinkSync(temporary);
            }
            catch {
                /* ignore cleanup error */
            }
        }
    }
    return formatIdentities(models, assignments);
}
//# sourceMappingURL=modelIdentity.js.map