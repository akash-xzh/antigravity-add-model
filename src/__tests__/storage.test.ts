import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { mockWindows, renameHook } = vi.hoisted(() => ({
  mockWindows: [] as Array<{
    isDestroyed: () => boolean;
    webContents: { send: ReturnType<typeof vi.fn>; isDestroyed?: () => boolean };
  }>,
  renameHook: {
    fn: undefined as ((oldPath: string, newPath: string, real: (a: string, b: string) => Promise<void>) => Promise<void>) | undefined,
  },
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    rename: (oldPath: string, newPath: string) =>
      renameHook.fn ? renameHook.fn(oldPath, newPath, actual.rename) : actual.rename(oldPath, newPath),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => mockWindows,
  },
}));

import { StorageManager } from '../storage';

const dirs: string[] = [];

function makeTempStorage(name = 'storage.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-storage-test-'));
  dirs.push(dir);
  return { dir, filePath: path.join(dir, name) };
}

afterEach(() => {
  mockWindows.length = 0;
  renameHook.fn = undefined;
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('StorageManager durability and concurrency', () => {
  it('serializes concurrent updateItems calls without losing keys and writes atomically', async () => {
    const { dir, filePath } = makeTempStorage();
    const manager = new StorageManager(filePath);

    await Promise.all([
      manager.updateItems({ a: '1' }),
      manager.updateItems({ b: '2' }),
      manager.updateItems({ c: '3' }),
      manager.updateItems({ d: '4', a: '1b' }),
    ]);

    expect(await manager.getRawItems()).toEqual({ a: '1b', b: '2', c: '3', d: '4' });
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('does not overwrite existing settings when the storage file contains corrupted JSON', async () => {
    const { filePath } = makeTempStorage();
    fs.writeFileSync(filePath, '{corrupted json', 'utf-8');
    const manager = new StorageManager(filePath);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(manager.getRawItems()).rejects.toThrow();
      await expect(manager.updateItems({ newKey: 'val' })).rejects.toThrow();
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('{corrupted json');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('quarantines corrupt settings at startup so defaults can be used and writes can recover', async () => {
    const { dir, filePath } = makeTempStorage();
    fs.writeFileSync(filePath, '{corrupted json', 'utf-8');
    const manager = new StorageManager(filePath);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await manager.quarantineCorruptFile()).toBe(true);
      expect(fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'))).toHaveLength(1);
      expect(await manager.getRawItems()).toEqual({});
      await manager.updateItems({ recovered: 'yes' });
      expect(await manager.getRawItems()).toEqual({ recovered: 'yes' });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('serializes writes across different StorageManager instances on the same file', async () => {
    const { filePath } = makeTempStorage();
    const first = new StorageManager(filePath);
    const second = new StorageManager(filePath);
    await Promise.all([
      first.updateItems({ fromFirst: '1' }),
      second.updateItems({ fromSecond: '2' }),
      first.updateItems({ shared: '3' }),
      second.updateItems({ last: '4' }),
    ]);
    expect(await second.getRawItems()).toEqual({ fromFirst: '1', fromSecond: '2', shared: '3', last: '4' });
  });

  it('retries EBUSY/EPERM on atomic rename and keeps queue usable after a failed write', async () => {
    const { dir, filePath } = makeTempStorage();
    const manager = new StorageManager(filePath);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    let calls = 0;
    renameHook.fn = async (oldPath, newPath, real) => {
      calls++;
      if (calls <= 2) {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      }
      return real(oldPath, newPath);
    };

    try {
      await manager.updateItems({ retried: 'yes' });
      expect(calls).toBe(3);
      expect(await manager.getRawItems()).toEqual({ retried: 'yes' });

      // Simulate a hard write failure and verify subsequent writes still work
      renameHook.fn = async () => {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      };
      await expect(manager.updateItems({ failed: 'no' })).rejects.toThrow('disk full');
      expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);

      renameHook.fn = undefined;
      await manager.updateItems({ recovered: 'yes' });
      expect(await manager.getRawItems()).toEqual({ retried: 'yes', recovered: 'yes' });
    } finally {
      errSpy.mockRestore();
    }
  });

  it('skips destroyed BrowserWindows when broadcasting storage:changed', async () => {
    const { filePath } = makeTempStorage();
    const aliveSend = vi.fn();
    const deadSend = vi.fn();
    const deadWcSend = vi.fn();
    mockWindows.push(
      { isDestroyed: () => false, webContents: { send: aliveSend, isDestroyed: () => false } },
      { isDestroyed: () => true, webContents: { send: deadSend, isDestroyed: () => false } },
      { isDestroyed: () => false, webContents: { send: deadWcSend, isDestroyed: () => true } },
    );

    const manager = new StorageManager(filePath);
    await manager.updateItems({ theme: 'dark' });

    expect(aliveSend).toHaveBeenCalledWith('storage:changed', { theme: 'dark' });
    expect(deadSend).not.toHaveBeenCalled();
    expect(deadWcSend).not.toHaveBeenCalled();
  });
});
