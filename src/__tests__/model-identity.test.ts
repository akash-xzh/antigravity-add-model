import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  allocateModelIdentities,
  legacyPlaceholderId,
  NATIVE_MODEL_CAPACITY,
  placeholderIndex,
} from '../modelIdentity';
import { catalogModelSlug, localModelSlug } from '../proxy/modelCatalog';

const directories: string[] = [];
function directory() {
  const value = fs.mkdtempSync(path.join(tmpdir(), 'agy-identity-'));
  directories.push(value);
  return value;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const value of directories.splice(0)) {
    if (path.dirname(value) !== path.resolve(tmpdir()) || !path.basename(value).startsWith('agy-identity-'))
      throw new Error('Unexpected cleanup path');
    fs.rmSync(value, { recursive: true, force: true });
  }
});
const model = (name: string, displayName = name) => ({
  name: `models/${name}`,
  displayName,
  externalModelName: 'shared-upstream',
});

describe('persistent native model identities', () => {
  it('allocates 300 distinct enums even when every display label and external model are identical', () => {
    const models = Array.from({ length: 300 }, (_, index) => model(`variant-${index}`, 'Shared model'));
    const identities = allocateModelIdentities(directory(), models);
    expect(new Set(identities.map((item) => item.placeholderId)).size).toBe(300);
    expect(new Set(identities.map((item) => item.catalogId)).size).toBe(300);
    expect(identities.every((item) => item.placeholderValue! >= 1000 && item.placeholderValue! <= 1650)).toBe(true);
  });

  it('preserves assignments after reload, reordering, label edits and another model with the same legacy hash', () => {
    const dir = directory();
    const initial = [model('first', 'Identical'), model('second', 'Identical')];
    const first = allocateModelIdentities(dir, initial);
    const changed = allocateModelIdentities(dir, [
      model('new', 'Identical'),
      { ...initial[1], displayName: 'Renamed' },
      initial[0],
    ]);
    for (const entry of first)
      expect(changed.find((item) => item.name === entry.name)?.placeholderId).toBe(entry.placeholderId);
  });

  it('retains an unambiguous legacy enum and never gives a deleted model selection to a different model', () => {
    const dir = directory();
    const original = model('first', 'Known label');
    const first = allocateModelIdentities(dir, [original])[0];
    expect(first.placeholderId).toBe(legacyPlaceholderId(original));
    allocateModelIdentities(dir, []);
    const second = allocateModelIdentities(dir, [model('replacement', 'Known label')])[0];
    expect(second.placeholderId).not.toBe(first.placeholderId);
    expect(allocateModelIdentities(dir, [original])[0].placeholderId).toBe(first.placeholderId);
  });

  it('reserves numeric and symbolic native enums and keeps the reservation during offline fallback', () => {
    const dir = directory();
    const original = model('first');
    const initial = allocateModelIdentities(dir, [original])[0];
    const native = { models: { googleA: { model: initial.placeholderId }, googleB: { model: 1000 } } };
    const updated = allocateModelIdentities(dir, [original], native)[0];
    expect(updated.placeholderId).not.toBe(initial.placeholderId);
    expect(updated.placeholderValue).not.toBe(1000);
    expect(allocateModelIdentities(dir, [original])[0]).toEqual(updated);
  });

  it('reports exhaustion for active models without inventing an enum, and reclaims oldest inactive slots when exhausted', () => {
    const dir = directory();
    const models = Array.from({ length: NATIVE_MODEL_CAPACITY }, (_, index) => model(`item-${index}`));
    const full = allocateModelIdentities(dir, models);
    expect(full.every((item) => item.placeholderId)).toBe(true);

    // True exhaustion: 652 active models cannot all fit in 651 slots.
    const withActiveOverflow = allocateModelIdentities(dir, [...models, model('active-overflow')]);
    const activeOverflow = withActiveOverflow.find((item) => item.name === 'models/active-overflow')!;
    expect(activeOverflow.placeholderId).toBeUndefined();
    expect(activeOverflow.placeholderValue).toBeUndefined();
    expect(activeOverflow.catalogId).toBeTruthy();

    // Pool exhaustion with inactive (deleted) models: oldest inactive slot is reclaimed.
    const beforeReclaim = JSON.parse(fs.readFileSync(path.join(dir, 'custom_model_identities.json'), 'utf8'));
    const [oldestName, oldestIndex] = Object.entries(beforeReclaim.assignments)[0] as [string, number];
    const [secondName, secondIndex] = Object.entries(beforeReclaim.assignments)[1] as [string, number];
    const reclaimed = allocateModelIdentities(dir, [model('overflow')])[0];
    expect(reclaimed.placeholderId).toBe(`MODEL_PLACEHOLDER_M${oldestIndex}`);
    expect(reclaimed.placeholderValue).toBe(oldestIndex + 1000);
    // Remaining inactive models keep their assignments while slots aren't needed.
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'custom_model_identities.json'), 'utf8'));
    expect(persisted.assignments[oldestName]).toBeUndefined();
    expect(persisted.assignments[secondName]).toBe(secondIndex);
  });

  it('never persists keys, endpoints or other model properties in identity metadata', () => {
    const dir = directory();
    allocateModelIdentities(dir, [
      {
        ...model('private'),
        apiKey: 'secret-key',
        apiUrl: 'https://private.example',
        prompt: 'private prompt',
      } as ReturnType<typeof model>,
    ]);
    const metadata = fs.readFileSync(path.join(dir, 'custom_model_identities.json'), 'utf8');
    expect(metadata).not.toMatch(/secret-key|private\.example|private prompt|apiKey|apiUrl/);
    expect(metadata).toContain('models/private');
  });

  it('fails closed on corrupt metadata and a held cross-process allocation lock', () => {
    const dir = directory();
    const filename = path.join(dir, 'custom_model_identities.json');
    fs.writeFileSync(filename, '{broken');
    expect(() => allocateModelIdentities(dir, [model('one')])).toThrow();
    expect(fs.readFileSync(filename, 'utf8')).toBe('{broken');
    expect(fs.existsSync(path.join(dir, 'custom_model_identities.lock'))).toBe(false);
    fs.writeFileSync(
      path.join(dir, 'custom_model_identities.lock'),
      JSON.stringify({ pid: process.pid, token: 'another owner' }),
    );
    expect(() => allocateModelIdentities(dir, [model('one')])).toThrow('another process');
    expect(fs.readFileSync(filename, 'utf8')).toBe('{broken');
  });

  it('prevents an external alias from shadowing another saved model local alias', () => {
    const first = model('first');
    const duplicate = model('duplicate');
    const shadow = { ...model('shadow'), externalModelName: localModelSlug(first).slice('custom-'.length) };
    const models = [first, duplicate, shadow];
    expect(new Set(models.map((entry) => catalogModelSlug(entry, models))).size).toBe(3);
  });

  it('reclaims dead-process and expired locks safely without losing enum ownership', () => {
    const dir = directory();
    const first = allocateModelIdentities(dir, [model('original')])[0];
    const lockfile = path.join(dir, 'custom_model_identities.lock');

    // 1. Dead process lock (ESRCH)
    fs.writeFileSync(lockfile, JSON.stringify({ pid: 999999, token: 'abandoned', createdAt: Date.now() }));
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('No process'), { code: 'ESRCH' });
    });
    const afterDead = allocateModelIdentities(dir, [model('original'), model('replacement')]);
    expect(afterDead[0].placeholderId).toBe(first.placeholderId);
    expect(afterDead[1].placeholderId).toBeTruthy();
    expect(fs.existsSync(lockfile)).toBe(false);
    killSpy.mockRestore();

    // 2. A lock held by a live process must NOT be stolen just because it is
    //    older than the soft stale window (a >10s bulk import is legitimate).
    fs.writeFileSync(lockfile, JSON.stringify({ pid: process.pid, token: 'live-slow-writer', createdAt: Date.now() - 20_000 }));
    expect(() => allocateModelIdentities(dir, [model('original'), model('replacement'), model('third')]))
      .toThrow('being updated by another process');
    expect(fs.readFileSync(lockfile, 'utf8')).toContain('live-slow-writer');

    // 3. A hard-expired lock (possible PID reuse) is still reclaimed.
    fs.writeFileSync(lockfile, JSON.stringify({ pid: process.pid, token: 'reused-pid', createdAt: Date.now() - 11 * 60_000 }));
    const afterExpired = allocateModelIdentities(dir, [model('original'), model('replacement'), model('third')]);
    expect(afterExpired[0].placeholderId).toBe(first.placeholderId);
    expect(afterExpired[2].placeholderId).toBeTruthy();
    expect(fs.existsSync(lockfile)).toBe(false);

    // 3. Backward-compatible plain-PID dead lockfile
    fs.writeFileSync(lockfile, '999998');
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('No process'), { code: 'ESRCH' });
    });
    const afterPlainPid = allocateModelIdentities(dir, [model('original'), model('fourth')]);
    expect(afterPlainPid[1].placeholderId).toBeTruthy();
    expect(fs.existsSync(lockfile)).toBe(false);
  });

  it('uses a lock-free fast path for read-only lookups when all models are already assigned', () => {
    const dir = directory();
    const initial = allocateModelIdentities(dir, [model('cached-one'), model('cached-two')]);
    const lockfile = path.join(dir, 'custom_model_identities.lock');
    // Simulate a live lock held by another process; read-only lookup must not contend on it.
    const liveLock = JSON.stringify({ pid: process.pid, token: 'live-writer', createdAt: Date.now() });
    fs.writeFileSync(lockfile, liveLock);
    const fast = allocateModelIdentities(dir, [model('cached-one'), model('cached-two')]);
    expect(fast).toEqual(initial);
    expect(fs.readFileSync(lockfile, 'utf8')).toBe(liveLock);
  });

  it('accepts only verified enum values', () => {
    expect(placeholderIndex('MODEL_PLACEHOLDER_M650')).toBe(650);
    expect(placeholderIndex(1650)).toBe(650);
    for (const input of [999, 1651, 1000.5, 'MODEL_PLACEHOLDER_M651', '1000', null])
      expect(placeholderIndex(input)).toBeUndefined();
  });
});
