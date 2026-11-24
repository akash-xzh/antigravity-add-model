/**
 * Manages persistent storage for the application.
 * Stores key-value pairs.
 */
export declare class StorageManager {
    private storagePath;
    private defaults;
    private emitter;
    private writeQueue;
    onDidChange: (listener: (changes: Record<string, string | null>) => void) => {
        dispose(): void;
    };
    constructor(storagePath: string, defaults?: Map<string, boolean>);
    /**
     * Reads raw items strictly from disk. Returns `{}` only when the file does not exist (`ENOENT`).
     * Throws on read failures or invalid/corrupted JSON so callers never overwrite settings with `{}`.
     */
    private readRawItemsStrict;
    /**
     * Gets raw items from the storage file.
     */
    getRawItems(): Promise<Record<string, string>>;
    /**
     * Startup recovery: move an unreadable settings file aside so the app can boot
     * with defaults. Normal writes still refuse to touch a corrupt file until this
     * has been called explicitly.
     */
    quarantineCorruptFile(): Promise<boolean>;
    /**
     * Gets all items from the storage, with defaults applied.
     *
     * @returns A record of key-value pairs.
     */
    getItems(): Promise<Record<string, string | null>>;
    /**
     * Updates items in the storage. Serialized via a promise queue and written atomically.
     *
     * @param changes A record of key-value pairs to update. If a value is null, the key will be deleted.
     */
    updateItems(changes: Record<string, string | null>): Promise<void>;
}
//# sourceMappingURL=storage.d.ts.map