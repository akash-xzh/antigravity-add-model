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

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import log from 'electron-log';
import type { CustomModel } from '../proxy';

export type ModelHealthStatus = 'healthy' | 'slow' | 'unhealthy' | 'cooldown';

export interface ModelHealthResult {
  status: ModelHealthStatus;
  statusCode?: number;
  latencyMs?: number;
  error?: string;
  checkedAt: number;
}

const HEALTH_CHECK_TIMEOUT_MS = 5000;
const FRESHNESS_TTL_MS = 15 * 60 * 1000; // 15 minutes before background refresh is eligible
const CONCURRENCY_LIMIT = 3;
const PACING_DELAY_MS = 150;
const MAX_RECENT_MODELS = 3;

let currentDataDirectory: string | undefined;
const memoryCache = new Map<string, ModelHealthResult>();
const inflightPings = new Map<string, Promise<ModelHealthResult>>();
const recentModelsList: string[] = [];

export function recordRecentModel(modelName: string): void {
  if (!modelName) return;
  const filtered = recentModelsList.filter((m) => m !== modelName);
  recentModelsList.length = 0;
  recentModelsList.push(modelName, ...filtered);
  if (recentModelsList.length > MAX_RECENT_MODELS) {
    recentModelsList.length = MAX_RECENT_MODELS;
  }
  saveHealthCache();
}

export function isRecentModel(modelName: string): boolean {
  return recentModelsList.includes(modelName);
}

export function getRecentModels(): string[] {
  return [...recentModelsList];
}

function getHealthRank(health?: ModelHealthResult | null): number {
  if (!health || health.status === 'healthy') return 1;
  if (health.status === 'slow') return 2;
  if (health.status === 'cooldown') return 3;
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
export function sortCustomModels<T extends { name: string }>(models: T[]): T[] {
  const recentList = getRecentModels();
  return [...models].sort((a, b) => {
    const idxA = recentList.indexOf(a.name);
    const idxB = recentList.indexOf(b.name);
    const isRecA = idxA !== -1;
    const isRecB = idxB !== -1;

    if (isRecA && isRecB) {
      return idxA - idxB;
    }
    if (isRecA) return -1;
    if (isRecB) return 1;

    const healthA = getCachedHealth(a.name);
    const healthB = getCachedHealth(b.name);
    const rankA = getHealthRank(healthA);
    const rankB = getHealthRank(healthB);
    if (rankA !== rankB) return rankA - rankB;

    if (healthA?.status === 'healthy' && healthB?.status === 'healthy') {
      const latA = healthA.latencyMs ?? 9999;
      const latB = healthB.latencyMs ?? 9999;
      return latA - latB;
    }

    return 0;
  });
}

export function setDataDirectory(dir: string | undefined): void {
  currentDataDirectory = dir ? path.resolve(dir) : undefined;
}

export function getHealthCachePath(dataDir?: string): string {
  const base = dataDir || currentDataDirectory || path.join(os.homedir(), '.gemini', 'antigravity');
  return path.join(base, 'model_health_cache.json');
}

export function loadHealthCache(dataDir?: string): Map<string, ModelHealthResult> {
  const filePath = getHealthCachePath(dataDir);
  try {
    if (!fs.existsSync(filePath)) return memoryCache;
    const raw = fs.readFileSync(filePath, 'utf8');
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
        if (
          val &&
          typeof val === 'object' &&
          ['healthy', 'slow', 'unhealthy', 'cooldown'].includes((val as ModelHealthResult).status)
        ) {
          memoryCache.set(key, val as ModelHealthResult);
        }
      }
    }
  } catch (err) {
    log.debug('[ModelHealth] Could not read health cache from disk:', err);
  }
  return memoryCache;
}

export function saveHealthCache(dataDir?: string): void {
  const filePath = getHealthCachePath(dataDir);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const modelsObj: Record<string, ModelHealthResult> = {};
    for (const [key, val] of memoryCache.entries()) {
      modelsObj[key] = val;
    }
    const payload = {
      models: modelsObj,
      recent: [...recentModelsList],
    };
    const tmp = `${filePath}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch (err) {
    log.debug('[ModelHealth] Could not save health cache to disk:', err);
  }
}

export function getCachedHealth(modelName: string): ModelHealthResult | undefined {
  return memoryCache.get(modelName);
}

export function getCachedHealthMap(): Map<string, ModelHealthResult> {
  return new Map(memoryCache);
}

export function setCachedHealth(modelName: string, result: ModelHealthResult, persist = true): void {
  memoryCache.set(modelName, result);
  if (persist) {
    saveHealthCache();
  }
}

export function clearHealthCache(persist = false): void {
  memoryCache.clear();
  inflightPings.clear();
  recentModelsList.length = 0;
  if (persist) {
    saveHealthCache();
  }
}

/** Record live chat success: immediately marks the model healthy and tracks as recent */
export function recordModelSuccess(modelName: string, latencyMs?: number): void {
  if (!modelName) return;
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
export function recordModelFailure(modelName: string, error?: string): void {
  if (!modelName) return;
  recordRecentModel(modelName);
  let cleanError = error ? String(error).replace(/^Error:\s*/i, '').trim() : 'Chat error';
  if (cleanError.length > 40) cleanError = cleanError.slice(0, 37) + '…';
  const isRateLimit = cleanError.includes('429') || /rate\s*limit/i.test(cleanError);
  setCachedHealth(modelName, {
    status: isRateLimit ? 'cooldown' : 'unhealthy',
    error: cleanError,
    checkedAt: Date.now(),
  });
}

/** Strip any status dots/emojis, stars, brackets, and bullets from display name */
export function cleanModelDisplayName(name: string): string {
  if (!name) return '';
  return name
    .replace(/^⭐\s*/u, '')
    .replace(/^[🟢🔴⚪🟡⭐\s•·|-]+(?:\[[^\]]+\]\s*)?[•·|-]?\s*/u, '')
    .trim();
}

/**
 * Formats a model's display name with star (⭐ for recent) and status circle (🟢 / 🟡 / 🔴) for the IDE dropdown.
 * Uses cached status so this executes in ~0ms with zero network calls.
 */
export function formatHealthDisplayName(
  baseName: string,
  health?: ModelHealthResult | null,
  isRecent = false,
): string {
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Pings a single model endpoint with a lightweight HTTP/HTTPS GET, aborting
 * immediately on headers to avoid downloading content or burning usage.
 */
export function pingCustomModel(model: CustomModel): Promise<ModelHealthResult> {
  // If provider is Google Cloud Code, check accounts without making external requests
  if (model.provider === 'google-cloudcode') {
    const hasAccount = Array.isArray(model.googleAccounts) && model.googleAccounts.some((a) => a.enabled !== false);
    const result: ModelHealthResult = hasAccount
      ? { status: 'healthy', latencyMs: 5, checkedAt: Date.now() }
      : { status: 'unhealthy', error: 'No account', checkedAt: Date.now() };
    setCachedHealth(model.name, result);
    return Promise.resolve(result);
  }

  if (!model.apiUrl) {
    const result: ModelHealthResult = { status: 'unhealthy', error: 'No URL', checkedAt: Date.now() };
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

  const pingPromise = new Promise<ModelHealthResult>((resolve) => {
    const startTime = Date.now();
    let settled = false;
    let req: http.ClientRequest | null = null;

    const finish = (result: ModelHealthResult) => {
      if (settled) return;
      settled = true;
      setCachedHealth(model.name, result);
      resolve(result);
    };

    const timer = setTimeout(() => {
      if (req) {
        try {
          req.destroy();
        } catch {
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
      const client = isHttps ? https : http;

      const headers: Record<string, string> = {
        'User-Agent': 'Antigravity-HealthCheck/1.0',
        Accept: 'application/json, text/plain, */*',
      };
      if (model.apiKey && model.apiKey !== 'none') {
        headers['Authorization'] = `Bearer ${model.apiKey}`;
      }
      if (model.customHeaders) {
        for (const [k, v] of Object.entries(model.customHeaders)) {
          if (typeof v === 'string') headers[k] = v;
        }
      }

      req = client.request(
        parsedUrl,
        {
          method: 'GET',
          timeout: HEALTH_CHECK_TIMEOUT_MS,
          rejectUnauthorized: model.allowUnauthorized ? false : true,
          headers,
        },
        (res) => {
          clearTimeout(timer);
          const latencyMs = Date.now() - startTime;
          const statusCode = res.statusCode || 0;

          // Abort response immediately to save bandwidth & time
          try {
            res.destroy();
            req?.destroy();
          } catch {
            /* ignore */
          }

          if (statusCode === 429) {
            finish({ status: 'cooldown', statusCode, latencyMs, error: 'Rate Limit (429)', checkedAt: Date.now() });
          } else if (statusCode === 401 || statusCode === 403) {
            finish({ status: 'unhealthy', statusCode, latencyMs, error: 'Auth Error', checkedAt: Date.now() });
          } else if (statusCode >= 500) {
            finish({
              status: 'unhealthy',
              statusCode,
              latencyMs,
              error: `Server Error (${statusCode})`,
              checkedAt: Date.now(),
            });
          } else if (latencyMs > 1500) {
            finish({ status: 'slow', statusCode, latencyMs, checkedAt: Date.now() });
          } else {
            // 200-399 or 400/404/405 means endpoint is alive and reached
            finish({ status: 'healthy', statusCode, latencyMs, checkedAt: Date.now() });
          }
        },
      );

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
    } catch (e) {
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
export async function checkAllModelsHealth(
  models: CustomModel[],
  force = false,
): Promise<Map<string, ModelHealthResult>> {
  if (!models || models.length === 0) return getCachedHealthMap();

  // Deduplicate by endpoint
  const endpointGroups = new Map<string, CustomModel[]>();
  for (const m of models) {
    if (m.enabled === false) continue;
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

  log.debug(
    `[ModelHealth] Smart health check: ${models.length} models across ${endpointGroups.size} unique endpoints (force=${force})`,
  );

  const entries = Array.from(endpointGroups.entries());
  let index = 0;

  const workers = Array.from({ length: Math.min(CONCURRENCY_LIMIT, entries.length) }, async () => {
    while (index < entries.length) {
      const current = entries[index++];
      if (!current) break;
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
