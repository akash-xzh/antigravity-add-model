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
exports.ModelStore = void 0;
exports.normalizeModelConfig = normalizeModelConfig;
exports.readModelConfig = readModelConfig;
exports.writeJsonAtomic = writeJsonAtomic;
exports.isMaskedSecret = isMaskedSecret;
exports.decodeSecret = decodeSecret;
exports.redactModel = redactModel;
/** Backward-compatible model storage shared by the addon and proxy. */
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_crypto_1 = require("node:crypto");
const schemaValidator_1 = require("./schemaValidator");
function object(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Expected an object');
    return value;
}
/** Accept flat legacy files and provider-group exports without losing model overrides. */
function normalizeModelConfig(payload) {
    let value = payload;
    if (typeof value === 'string') {
        const text = value.trim();
        if (text.length > 4 * 1024 * 1024)
            throw new Error('Model import exceeds 4 MB');
        try {
            value = JSON.parse(text);
        }
        catch {
            value = JSON.parse(Buffer.from(text, 'base64').toString('utf8'));
        }
    }
    let entries;
    if (Array.isArray(value))
        entries = value;
    else {
        const root = object(value);
        if (Array.isArray(root.models))
            entries = root.models;
        else if (Array.isArray(root.providers)) {
            entries = root.providers.flatMap((entry) => {
                const provider = object(entry);
                if (!Array.isArray(provider.models))
                    throw new Error('Provider models must be an array');
                return provider.models.map((item) => {
                    const model = typeof item === 'string' ? { id: item } : object(item);
                    const external = String(model.externalModelName || model.id || model.name || '');
                    const { models: _models, id: _id, name: _name, ...defaults } = provider;
                    return {
                        ...defaults,
                        ...model,
                        name: model.name || `models/${String(provider.id || provider.provider || 'custom')}-${external}`,
                        provider: model.provider || provider.provider || 'custom',
                        externalModelName: external,
                        enabled: provider.enabled !== false && model.enabled !== false,
                    };
                });
            });
        }
        else
            throw new Error('Configuration must contain a models or providers array');
    }
    if (entries.length > 5000)
        throw new Error('Too many models (maximum 5000)');
    return entries.map((entry) => {
        const model = { ...object(entry) };
        if (model.extraHeaders && !model.customHeaders)
            model.customHeaders = model.extraHeaders;
        if (model.useRawBaseUrl !== undefined && model.rawUrl === undefined)
            model.rawUrl = model.useRawBaseUrl;
        if (model.supportsImages !== undefined && model.supportsVision === undefined)
            model.supportsVision = model.supportsImages;
        if (typeof model.fallbackModel === 'string' && !model.fallbackModels)
            model.fallbackModels = [model.fallbackModel];
        delete model.extraHeaders;
        delete model.useRawBaseUrl;
        delete model.supportsImages;
        model.externalModelName || (model.externalModelName = typeof model.name === 'string' ? model.name.replace(/^models\//, '') : '');
        return model;
    });
}
function readModelConfig(filename) {
    try {
        return normalizeModelConfig(JSON.parse(fs.readFileSync(filename, 'utf8')));
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw error;
    }
}
const LOCK_STALE_MS = 10000;
/** A live holder may run long (bulk import); only reclaim after this hard expiry. */
const LOCK_HARD_EXPIRY_MS = 10 * 60000;
const LOCK_MAX_ATTEMPTS = 20;
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
function isLockReclaimable(lockfile) {
    try {
        const stat = fs.statSync(lockfile);
        const ageMs = Date.now() - stat.mtimeMs;
        const raw = fs.readFileSync(lockfile, 'utf8').trim();
        if (!raw)
            return ageMs > LOCK_STALE_MS;
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
            if (alive)
                return age > LOCK_HARD_EXPIRY_MS;
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
function withStoreLock(filename, fn) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const lockfile = `${filename}.lock`;
    const owner = JSON.stringify({ pid: process.pid, token: (0, node_crypto_1.randomUUID)(), createdAt: Date.now() });
    let lockFd;
    for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
        try {
            lockFd = fs.openSync(lockfile, 'wx', 0o600);
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
                    /* ignore transient unlink race */
                }
                continue;
            }
            if (attempt < LOCK_MAX_ATTEMPTS - 1) {
                sleepSync(Math.min(40, 10 + attempt * 2));
            }
        }
    }
    if (lockFd === undefined) {
        throw new Error('Model configuration is being updated by another process; retry after it finishes');
    }
    try {
        fs.writeFileSync(lockFd, owner);
        return fn();
    }
    finally {
        try {
            fs.closeSync(lockFd);
        }
        catch {
            /* ignore close error */
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
function writeJsonAtomic(filename, value) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${(0, node_crypto_1.randomUUID)()}.tmp`;
    try {
        fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        renameWithRetry(temporary, filename);
        // Clean up plaintext migration backup once the atomic encrypted write has succeeded.
        if (path.basename(filename) === 'custom_models.json') {
            const backupPath = `${filename}.bak`;
            try {
                if (fs.existsSync(backupPath))
                    fs.unlinkSync(backupPath);
            }
            catch {
                /* best-effort cleanup */
            }
        }
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
function isMaskedSecret(value) {
    return value === '********';
}
function decodeSecret(value, codec) {
    if (!value || value === 'none')
        return '';
    const decoded = codec.decryptString(value);
    if (!decoded || decoded.startsWith('DECRYPTION_FAILED'))
        throw new Error('Saved key cannot be decrypted on this machine. Enter it again.');
    return decoded;
}
function redactModel(model) {
    const result = { ...model };
    result.apiKey = model.apiKey && model.apiKey !== 'none' ? '********' : '';
    if (model.customHeaders && typeof model.customHeaders === 'object') {
        result.customHeaders = Object.fromEntries(Object.keys(model.customHeaders).map((key) => [key, '********']));
    }
    if (Array.isArray(model.googleAccounts)) {
        result.googleAccounts = model.googleAccounts.map((account) => {
            const masked = { ...account };
            for (const field of ['accessToken', 'refreshToken', 'clientSecret'])
                if (masked[field])
                    masked[field] = '********';
            return masked;
        });
    }
    return result;
}
/** All writes are synchronous atomic read/modify/write operations, including bulk imports. */
class ModelStore {
    constructor(filename, codec, pendingAccount) {
        this.filename = filename;
        this.codec = codec;
        this.pendingAccount = pendingAccount;
    }
    read() {
        return readModelConfig(this.filename);
    }
    list() {
        return this.read().map(redactModel);
    }
    prepare(input, existing) {
        const model = { ...input };
        delete model.originalName;
        delete model.copyFrom;
        // Management response metadata is allocated locally, never imported or
        // accepted from an editor payload as an authoritative native identity.
        delete model.nativeCatalogId;
        delete model.nativeModelId;
        delete model.nativePickerAvailable;
        delete model.nativePickerError;
        delete model.nativeContextWindow;
        delete model.nativeMaxOutputTokens;
        delete model.nativeModelExperiments;
        if (typeof model.name !== 'string' || !model.name.trim())
            throw new Error('Model name is required');
        const trimmedName = model.name.trim();
        model.name = trimmedName.startsWith('models/') ? trimmedName : `models/${trimmedName}`;
        if (model.name === 'models/')
            throw new Error('Model name is required');
        const valid = (0, schemaValidator_1.validateCustomModel)(model);
        if (!valid.valid)
            throw new Error(valid.error);
        if (existing &&
            (model.provider !== existing.provider || new URL(model.apiUrl).origin !== new URL(existing.apiUrl).origin)) {
            if ((existing.apiKey && existing.apiKey !== 'none' && (!model.apiKey || isMaskedSecret(model.apiKey))) ||
                Object.values(model.customHeaders || {}).some(isMaskedSecret)) {
                throw new Error('Enter fresh credentials when changing the provider or server address');
            }
        }
        if (isMaskedSecret(model.apiKey) || model.apiKey === undefined) {
            if (isMaskedSecret(model.apiKey) && !existing?.apiKey)
                throw new Error('Enter a key for this new model');
            model.apiKey = existing?.apiKey || '';
            model.encrypted = existing?.encrypted || false;
            if (model.apiKey && !model.encrypted) {
                model.apiKey = this.codec.encryptString(decodeSecret(model.apiKey, this.codec));
                model.encrypted = true;
            }
        }
        else {
            if (/^(enc:|local-gcm:)/.test(model.apiKey || ''))
                throw new Error('Machine-encrypted keys cannot be imported. Enter a fresh key.');
            const plain = decodeSecret(model.apiKey, this.codec);
            model.apiKey = plain ? this.codec.encryptString(plain) : '';
            model.encrypted = !!plain;
        }
        if (model.customHeaders && typeof model.customHeaders === 'object') {
            const old = (existing?.customHeaders || {});
            model.customHeaders = Object.fromEntries(Object.entries(model.customHeaders).map(([key, value]) => {
                if (isMaskedSecret(value)) {
                    if (!old[key])
                        throw new Error(`Enter a value for header ${key}`);
                    return [key, existing?.encryptedHeaders ? old[key] : this.codec.encryptString(old[key])];
                }
                if (typeof value === 'string' && /^(enc:|local-gcm:)/.test(value)) {
                    throw new Error(`Machine-encrypted value cannot be imported for header ${key}. Enter a fresh value.`);
                }
                return [key, this.codec.encryptString(String(value))];
            }));
            model.encryptedHeaders = true;
        }
        if (Array.isArray(model.googleAccounts)) {
            const previous = Array.isArray(existing?.googleAccounts) ? existing.googleAccounts : [];
            const ids = new Set();
            model.googleAccounts = model.googleAccounts.map((input) => {
                const account = { ...object(input) };
                if (typeof account.id !== 'string' || !account.id)
                    throw new Error('Google account id is required');
                if (ids.has(account.id))
                    throw new Error('Duplicate Google account id');
                ids.add(account.id);
                const stored = previous.find((item) => item.id === account.id);
                const pending = this.pendingAccount?.(account.id);
                const source = stored || pending;
                for (const field of ['accessToken', 'refreshToken', 'clientSecret']) {
                    const value = account[field];
                    if (isMaskedSecret(value) || value === undefined) {
                        if (isMaskedSecret(value) && !source?.[field])
                            throw new Error('Account credentials expired or unavailable; sign in or import them again');
                        if (source?.[field])
                            account[field] =
                                stored && existing?.encryptedGoogleAccounts
                                    ? source[field]
                                    : this.codec.encryptString(String(source[field]));
                        else
                            delete account[field];
                    }
                    else if (value) {
                        if (typeof value !== 'string' || /^(enc:|local-gcm:)/.test(value))
                            throw new Error('Enter fresh account credentials instead of a machine-encrypted token');
                        account[field] = this.codec.encryptString(value);
                    }
                }
                return account;
            });
            model.encryptedGoogleAccounts = true;
        }
        return model;
    }
    save(input) {
        if (typeof input?.name !== 'string' || !input.name.trim()) {
            throw new Error('Model name is required');
        }
        const trimmedName = input.name.trim();
        const target = trimmedName.startsWith('models/') ? trimmedName : `models/${trimmedName}`;
        if (target === 'models/') {
            throw new Error('Model name is required');
        }
        withStoreLock(this.filename, () => {
            const models = this.read();
            const sourceName = input.originalName || input.copyFrom || target;
            const existing = models.find((model) => model.name === sourceName);
            if ((input.originalName || input.copyFrom) && !existing)
                throw new Error('Original model no longer exists');
            if ((input.originalName || input.copyFrom) && sourceName !== target && models.some((m) => m.name === target)) {
                throw new Error('A model with that name already exists');
            }
            const prepared = this.prepare({ ...input, name: target }, existing);
            const replaceName = input.copyFrom ? target : sourceName;
            const index = models.findIndex((model) => model.name === replaceName);
            if (index < 0)
                models.push(prepared);
            else
                models[index] = prepared;
            if (input.originalName && sourceName !== target) {
                for (const model of models) {
                    if (Array.isArray(model.fallbackModels))
                        model.fallbackModels = model.fallbackModels.map((name) => (name === sourceName ? target : name));
                }
            }
            writeJsonAtomic(this.filename, { models });
        });
    }
    delete(name) {
        withStoreLock(this.filename, () => {
            const models = this.read().filter((model) => model.name !== name);
            for (const model of models) {
                if (Array.isArray(model.fallbackModels))
                    model.fallbackModels = model.fallbackModels.filter((item) => item !== name);
            }
            writeJsonAtomic(this.filename, { models });
        });
    }
    import(payload) {
        const incoming = normalizeModelConfig(payload);
        return withStoreLock(this.filename, () => {
            const models = this.read();
            const seen = new Set();
            for (const item of incoming) {
                if (typeof item.name !== 'string' || !item.name.trim()) {
                    throw new Error('Model name is required');
                }
                const trimmedName = item.name.trim();
                const name = trimmedName.startsWith('models/') ? trimmedName : `models/${trimmedName}`;
                if (name === 'models/')
                    throw new Error('Model name is required');
                if (seen.has(name))
                    throw new Error(`Duplicate model in import: ${name}`);
                seen.add(name);
                const index = models.findIndex((m) => m.name === name);
                const prepared = this.prepare({ ...item, name }, models[index]);
                if (index < 0)
                    models.push(prepared);
                else
                    models[index] = prepared;
            }
            writeJsonAtomic(this.filename, { models });
            return incoming.length;
        });
    }
    export() {
        return {
            version: 1,
            models: this.read().map((entry) => {
                const model = { ...entry };
                delete model.apiKey;
                delete model.encrypted;
                // Headers may contain arbitrary credentials; require re-entry after export.
                delete model.customHeaders;
                delete model.extraHeaders;
                delete model.encryptedHeaders;
                delete model.encryptedGoogleAccounts;
                if (Array.isArray(model.googleAccounts))
                    model.googleAccounts = model.googleAccounts.map((account) => {
                        const redacted = { ...account };
                        for (const field of ['accessToken', 'refreshToken', 'clientSecret'])
                            delete redacted[field];
                        return redacted;
                    });
                return model;
            }),
        };
    }
}
exports.ModelStore = ModelStore;
//# sourceMappingURL=modelStore.js.map