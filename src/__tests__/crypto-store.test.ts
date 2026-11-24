import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(fs.readFileSync(path.resolve('src/cryptoStore.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const directories: string[] = [];
function fixture(available = false, failEncryption = false, failDecryption = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-crypto-'));
  directories.push(directory);
  const logs: unknown[][] = [];
  const api = {} as {
    encryptString(value: string): string;
    decryptString(value: string): string;
    encryptModels(models: Array<Record<string, unknown>> | null): Array<Record<string, unknown>>;
    decryptModels(models: Array<Record<string, unknown>> | null): Array<Record<string, unknown>>;
    backupFile(filePath: string): void;
    removeBackupFile(filePath: string): void;
  };
  const dependencies: Record<string, unknown> = {
    fs,
    path,
    crypto,
    'node:os': os,
    'electron-log': { info: (...args: unknown[]) => logs.push(args), error: (...args: unknown[]) => logs.push(args) },
    electron: {
      app: { getPath: () => directory },
      safeStorage: {
        isEncryptionAvailable: () => available,
        encryptString: (value: string) => {
          if (failEncryption) throw new Error('sensitive-provider-token');
          return Buffer.from(`os:${value}`);
        },
        decryptString: (value: Buffer) => {
          if (failDecryption) throw new Error('sensitive-provider-token');
          return value.toString().slice(3);
        },
      },
    },
  };
  runInNewContext(source, {
    exports: api,
    require: (id: string) => {
      if (!(id in dependencies)) throw new Error(`Unexpected import: ${id}`);
      return dependencies[id];
    },
    Buffer,
    console: { log() {}, error() {} },
  });
  return { ...api, logs, directory, keyPath: path.join(directory, '.gemini', 'antigravity', '.model-credentials-key') };
}
afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('agy-crypto-'))
      throw new Error('Invalid fixture path');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
describe('credential encryption', () => {
  it('uses randomized authenticated encryption when OS storage is unavailable', () => {
    const codec = fixture();
    const first = codec.encryptString('secret-token');
    const second = codec.encryptString('secret-token');
    expect(first).toMatch(/^local-gcm:/);
    expect(second).not.toBe(first);
    expect(codec.decryptString(first)).toBe('secret-token');
    expect(fs.readFileSync(codec.keyPath)).toHaveLength(32);
    const tampered = Buffer.from(first.slice(10), 'base64');
    tampered[tampered.length - 1] ^= 1;
    expect(codec.decryptString(`local-gcm:${tampered.toString('base64')}`)).toBe('DECRYPTION_FAILED');
  });
  it('fails closed for missing, replaced or truncated encryption data', () => {
    const codec = fixture();
    const encrypted = codec.encryptString('secret');
    fs.writeFileSync(codec.keyPath, crypto.randomBytes(32));
    expect(codec.decryptString(encrypted)).toBe('DECRYPTION_FAILED');
    fs.unlinkSync(codec.keyPath);
    expect(codec.decryptString(encrypted)).toBe('DECRYPTION_FAILED');
    expect(fs.existsSync(codec.keyPath)).toBe(false);
    expect(codec.decryptString('local-gcm:AA==')).toBe('DECRYPTION_FAILED');
    expect(codec.decryptString('enc:AA==')).toBe('DECRYPTION_FAILED_STORAGE_UNAVAILABLE');
  });
  it('prefers OS storage and can still read legacy configuration', () => {
    const codec = fixture(true);
    const encrypted = codec.encryptString('secret');
    expect(encrypted).toMatch(/^enc:/);
    expect(codec.decryptString(encrypted)).toBe('secret');
    expect(fs.existsSync(codec.keyPath)).toBe(false);
    expect(codec.decryptString('fallback:c2VjcmV0')).toBe('secret');
    expect(codec.decryptString('plain-old-key')).toBe('plain-old-key');
  });
  it('uses authenticated fallback when OS encryption throws', () => {
    const codec = fixture(true, true);
    const encrypted = codec.encryptString('secret');
    expect(encrypted).toMatch(/^local-gcm:/);
    expect(codec.decryptString(encrypted)).toBe('secret');
    expect(codec.logs.flat().join(' ')).toContain('safeStorage encryption failed');
    expect(JSON.stringify(codec.logs)).not.toContain('sensitive-provider-token');
  });
  it('reports credential failures through the logger without raw exception details', () => {
    const codec = fixture(true, false, true);
    expect(codec.decryptString('enc:c2VjcmV0')).toBe('DECRYPTION_FAILED');
    expect(codec.logs.flat().join(' ')).toContain('OS-backed credentials could not be decrypted');
    expect(JSON.stringify(codec.logs)).not.toContain('sensitive-provider-token');
  });

  it('never double-encrypts ciphertext prefixes and decrypts prefixed keys even when encrypted flag is falsy', () => {
    const codec = fixture(false);
    const encrypted = codec.encryptString('my-api-secret');
    expect(encrypted).toMatch(/^local-gcm:/);

    // Omitted/false encrypted flag on an already-encrypted key must not double-encrypt
    const reEncrypted = codec.encryptModels([{ name: 'm1', apiKey: encrypted, encrypted: false }]);
    expect(reEncrypted[0].apiKey).toBe(encrypted);
    expect(reEncrypted[0].encrypted).toBe(true);

    // Falsy encrypted flag on an encrypted key must still decrypt
    const decrypted = codec.decryptModels([{ name: 'm1', apiKey: encrypted, encrypted: false }]);
    expect(decrypted[0].apiKey).toBe('my-api-secret');
    expect(decrypted[0].encrypted).toBe(false);

    // Legacy fallback prefix with missing encrypted flag also decrypts
    const decryptedLegacy = codec.decryptModels([{ name: 'm2', apiKey: 'fallback:bGVnYWN5' }]);
    expect(decryptedLegacy[0].apiKey).toBe('legacy');
  });

  it('repairs a zero-byte key left by an interrupted first boot instead of locking out credentials', () => {
    const codec = fixture();
    fs.mkdirSync(path.dirname(codec.keyPath), { recursive: true });
    fs.writeFileSync(codec.keyPath, Buffer.alloc(0));
    const encrypted = codec.encryptString('secret-after-repair');
    expect(encrypted).toMatch(/^local-gcm:/);
    expect(fs.readFileSync(codec.keyPath)).toHaveLength(32);
    expect(codec.decryptString(encrypted)).toBe('secret-after-repair');
    expect(fs.readdirSync(path.dirname(codec.keyPath)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('creates 0o600 backups, removes them on cleanup, and leaves no temp key files on fresh boot', () => {
    const codec = fixture(false);
    codec.encryptString('bootstrap-key');
    const keyDir = path.dirname(codec.keyPath);
    expect(fs.readdirSync(keyDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);

    const configPath = path.join(codec.directory, 'custom_models.json');
    fs.writeFileSync(configPath, JSON.stringify({ models: [{ name: 'models/a', apiKey: 'plain' }] }));
    codec.backupFile(configPath);
    const bakPath = `${configPath}.bak`;
    expect(fs.existsSync(bakPath)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(bakPath).mode & 0o777).toBe(0o600);
    }
    codec.removeBackupFile(configPath);
    expect(fs.existsSync(bakPath)).toBe(false);
  });
});
