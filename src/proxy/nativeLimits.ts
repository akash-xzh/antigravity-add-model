/**
 * Context limits for Antigravity's own models, captured from the catalog the language server
 * serves. Official models never appear in custom_models.json, so their limit cannot be inferred
 * from the user's configuration. Cached on disk because the catalog only loads when the picker opens.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const MAX_ENTRIES = 400;
const limits = new Map<string, number>();
let configured = '';
let dirty = false;

const key = (value: string) =>
  value.trim().toLowerCase().replace(/^models\//, '').replace(/[^a-z0-9]/g, '');
const valid = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

function flush(): void {
  if (!dirty || !configured) return;
  while (limits.size > MAX_ENTRIES) limits.delete(limits.keys().next().value!);
  try {
    fs.writeFileSync(configured, JSON.stringify(Object.fromEntries(limits)));
    dirty = false;
  } catch {
    // A read-only profile keeps the limits in memory for this session.
  }
}

export function configureNativeLimits(filename: string): void {
  if (filename === configured) return;
  configured = filename;
  try {
    const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      for (const [id, value] of Object.entries(parsed)) if (valid(value)) limits.set(id, value);
  } catch {
    // No catalog captured yet; the next GetAvailableModels response fills it.
  }
  // A catalog captured before configure() may still be pending on disk.
  flush();
}

/** Merge `models[slug].maxTokens` from the upstream (official) catalog. */
export function recordNativeLimits(catalog: unknown): void {
  const models = catalog && typeof catalog === 'object' ? (catalog as { models?: unknown }).models : undefined;
  if (!models || typeof models !== 'object' || Array.isArray(models)) return;
  for (const [slug, raw] of Object.entries(models as Record<string, unknown>)) {
    const entry = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
    if (!valid(entry?.maxTokens)) continue;
    const max = entry!.maxTokens as number;
    for (const value of [slug, typeof entry?.displayName === 'string' ? entry.displayName : '']) {
      const id = key(value);
      if (id && limits.get(id) !== max) {
        limits.delete(id);
        limits.set(id, max);
        dirty = true;
      }
    }
  }
  if (dirty) flush();
}

/** Exact model, name or slug; an effort suffix such as "(Medium)" is ignored. */
export function findNativeLimit(name: unknown): number | undefined {
  if (typeof name !== 'string') return undefined;
  const id = key(name);
  const direct = limits.get(id);
  if (direct) return direct;
  const bare = key(name.replace(/\s*\((?:minimal|low|medium|high|xhigh|extra)\)\s*$/i, ''));
  return bare && bare !== id ? limits.get(bare) : undefined;
}

export function nativeLimitsPath(dataDirectory: string): string {
  return path.join(dataDirectory, 'native_model_limits.json');
}

/** Test seam: drops every captured catalog limit. */
export function resetNativeLimits(): void {
  limits.clear();
  configured = '';
  dirty = false;
}