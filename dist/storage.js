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
exports.StorageManager = void 0;
const fs = __importStar(require("fs/promises"));
const fsSync = __importStar(require("node:fs"));
const path = __importStar(require("path"));
const crypto_1 = require("crypto");
const electron_1 = require("electron");
const events_1 = require("events");
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY']);
const RENAME_MAX_ATTEMPTS = 5;
const LOCK_MAX_ATTEMPTS = 20;
/** One queue per resolved file, not per StorageManager instance. */
const fileQueues = new Map();
async function acquireStorageLock(lockfile) {
    for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
        try {
            const fd = fsSync.openSync(lockfile, 'wx', 0o600);
            try {
                fsSync.writeSync(fd, `pid=${process.pid}\n`);
            }
            finally {
                fsSync.closeSync(fd);
            }
            return () => { try {
                fsSync.unlinkSync(lockfile);
            }
            catch { /* best effort */ } };
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            // Only a lock held by a dead process may be reclaimed; a live writer
            // (including a slow one) must never be stolen.
            try {
                const pid = Number(/^pid=(\d+)/.exec(fsSync.readFileSync(lockfile, 'utf8'))?.[1]);
                if (Number.isInteger(pid) && pid > 0) {
                    try {
                        process.kill(pid, 0);
                    }
                    catch (failure) {
                        if (failure.code === 'ESRCH')
                            fsSync.unlinkSync(lockfile);
                    }
                }
            }
            catch { /* lock vanished or is still owned; retry */ }
            await sleep(10 + attempt * 5);
        }
    }
    throw new Error(`Storage file ${lockfile} is locked by another process`);
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function writeFileAtomic(filePath, content) {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tempPath = `${filePath}.${(0, crypto_1.randomUUID)()}.tmp`;
    try {
        await fs.writeFile(tempPath, content, { encoding: 'utf-8', mode: 0o600 });
        for (let attempt = 0; attempt < RENAME_MAX_ATTEMPTS; attempt++) {
            try {
                await fs.rename(tempPath, filePath);
                return;
            }
            catch (err) {
                const code = err.code;
                if (code && RENAME_RETRY_CODES.has(code) && attempt < RENAME_MAX_ATTEMPTS - 1) {
                    await sleep(10 * (attempt + 1));
                    continue;
                }
                throw err;
            }
        }
    }
    finally {
        try {
            await fs.unlink(tempPath);
        }
        catch {
            /* ignore ENOENT after successful rename or cleanup error */
        }
    }
}
/**
 * Manages persistent storage for the application.
 * Stores key-value pairs.
 */
class StorageManager {
    constructor(storagePath, defaults) {
        this.writeQueue = Promise.resolve();
        this.storagePath = storagePath;
        this.defaults = defaults;
        this.emitter = new events_1.EventEmitter();
        this.onDidChange = (listener) => {
            this.emitter.on('changed', listener);
            return {
                dispose: () => this.emitter.off('changed', listener),
            };
        };
    }
    /**
     * Reads raw items strictly from disk. Returns `{}` only when the file does not exist (`ENOENT`).
     * Throws on read failures or invalid/corrupted JSON so callers never overwrite settings with `{}`.
     */
    async readRawItemsStrict() {
        let content;
        try {
            content = await fs.readFile(this.storagePath, 'utf-8');
        }
        catch (e) {
            if (e.code === 'ENOENT') {
                return {};
            }
            throw e;
        }
        if (!content || content.trim() === '') {
            throw new Error(`Storage file ${this.storagePath} is empty or corrupted`);
        }
        const parsed = JSON.parse(content);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error(`Storage file ${this.storagePath} does not contain a JSON object`);
        }
        return parsed;
    }
    /**
     * Gets raw items from the storage file.
     */
    async getRawItems() {
        try {
            return await this.readRawItemsStrict();
        }
        catch (e) {
            console.error('Error reading storage items:', e);
            throw e;
        }
    }
    /**
     * Startup recovery: move an unreadable settings file aside so the app can boot
     * with defaults. Normal writes still refuse to touch a corrupt file until this
     * has been called explicitly.
     */
    async quarantineCorruptFile() {
        try {
            await this.readRawItemsStrict();
            return false;
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return false;
            const quarantine = `${this.storagePath}.corrupt-${Date.now()}`;
            try {
                await fs.rename(this.storagePath, quarantine);
                console.warn(`[Storage] Quarantined unreadable settings to ${quarantine}`);
                return true;
            }
            catch {
                return false;
            }
        }
    }
    /**
     * Gets all items from the storage, with defaults applied.
     *
     * @returns A record of key-value pairs.
     */
    async getItems() {
        const items = await this.getRawItems();
        const merged = { ...items };
        if (this.defaults) {
            for (const [key, value] of this.defaults.entries()) {
                if (merged[key] === undefined) {
                    merged[key] = String(value);
                }
            }
        }
        return merged;
    }
    /**
     * Updates items in the storage. Serialized via a promise queue and written atomically.
     *
     * @param changes A record of key-value pairs to update. If a value is null, the key will be deleted.
     */
    async updateItems(changes) {
        const key = path.resolve(this.storagePath);
        const prior = fileQueues.get(key) ?? Promise.resolve();
        const run = prior.then(async () => {
            // Serialize across StorageManager instances in this process and across
            // processes via a lockfile; a read-modify-write race would drop keys.
            const release = await acquireStorageLock(`${this.storagePath}.lock`);
            try {
                const currentItems = await this.readRawItemsStrict();
                for (const [key, value] of Object.entries(changes)) {
                    if (value === null) {
                        delete currentItems[key];
                    }
                    else {
                        currentItems[key] = value;
                    }
                }
                await writeFileAtomic(this.storagePath, JSON.stringify(currentItems, null, 2));
                const windows = electron_1.BrowserWindow.getAllWindows();
                for (const win of windows) {
                    const wc = win.webContents;
                    if (!win.isDestroyed() && wc && (typeof wc.isDestroyed !== 'function' || !wc.isDestroyed())) {
                        wc.send('storage:changed', changes);
                    }
                }
                this.emitter.emit('changed', changes);
            }
            finally {
                release();
            }
        });
        // Keep the file queue healthy for subsequent callers even if this write rejects.
        fileQueues.set(key, run.catch(() => { }));
        try {
            await run;
        }
        catch (e) {
            console.error('Error updating storage items:', e);
            throw e;
        }
    }
}
exports.StorageManager = StorageManager;
//# sourceMappingURL=storage.js.map