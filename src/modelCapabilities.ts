/**
 * Automatic model capability & context-window resolver for Add/Discover model flows.
 *
 * Precedence ladder (per property):
 *   1. MrPiPidan ai-model-map (regex rules, cached 6h)
 *   2. The-Best-Codes ai-model-directory (all.json, cached 6h)
 *   3. models.dev catalog (api.json, cached 6h)
 *
 * Offline-safe: caches on disk under `<dataDirectory>/capability_cache/` with stale fallback
 * and returns `{}` gracefully when unreachable or unknown.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type VariantEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface DetectedModelCapabilities {
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsVision?: boolean;
  supportsThinking?: boolean;
  reasoningEffort?: ReasoningEffort;
  supportedEfforts?: VariantEffort[];
}

const MRPIPIDAN_URL = 'https://cdn.jsdelivr.net/gh/MrPiPidan/ai-model-map@main/model_capabilities.json';
const BESTCODES_URL = 'https://raw.githubusercontent.com/The-Best-Codes/ai-model-directory/refs/heads/main/data/all.json';
const MODELSDEV_URL = 'https://models.dev/api.json';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const FETCH_TIMEOUT_MS = 10_000;
const MAX_LIMIT = 1_000_000_000;

const VALID_EFFORTS = new Set<ReasoningEffort>(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const VARIANT_EFFORTS = new Set<VariantEffort>(['minimal', 'low', 'medium', 'high', 'xhigh']);

const VENDOR_HYPHEN_PREFIX_RE =
  /^(?:deepseek-ai|nvidia|minimaxai|minimax|qwen|zai-org|moonshotai|anthropic|openai|google|meta-llama|mistralai|stepfun|x-ai|baidu|xiaomi|alibaba|tencent|bytedance|cohere|upstage|together|fireworks|groq)-/i;
const QUANT_SUFFIX_RE = /-(?:nvfp4|fp8|fp16|bf16|int4|int8|awq|gptq|gguf|mlx|4bit|8bit)$/i;

export function candidateModelSlugs(modelId: string): string[] {
  const trimmed = typeof modelId === 'string' ? modelId.trim() : '';
  if (!trimmed) return [];
  const bare = trimmed.includes('/') ? trimmed.slice(trimmed.indexOf('/') + 1) : trimmed;
  const tail = bare.includes('/') ? bare.slice(bare.lastIndexOf('/') + 1) : bare;
  const variants = new Set<string>([trimmed, bare, tail]);
  const expand = (fn: (value: string) => string) => {
    for (const v of [...variants]) {
      const next = fn(v);
      if (next && next !== v) variants.add(next);
    }
  };
  expand((v) => v.replace(/:(free|exacto|thinking|extended|beta)$/i, ''));
  expand((v) => v.replace(VENDOR_HYPHEN_PREFIX_RE, ''));
  expand((v) => v.replace(QUANT_SUFFIX_RE, ''));
  expand((v) =>
    v
      .replace(/([a-z]\d+)-(\d+)(?=-|$|b\b)/gi, '$1.$2')
      .replace(/(^|-)(\d+)-(\d+b)(?=-|$)/gi, '$1$2.$3'),
  );
  return Array.from(variants).filter(Boolean);
}

function normalizeEffort(value: unknown): ReasoningEffort | undefined {
  if (typeof value !== 'string') return undefined;
  const low = value.toLowerCase().trim();
  if (low === 'max' || low === 'extra') return 'xhigh';
  return VALID_EFFORTS.has(low as ReasoningEffort) ? (low as ReasoningEffort) : undefined;
}

async function fetchCachedJson(url: string, cacheDir: string, cacheName: string): Promise<unknown> {
  const cacheFile = path.join(cacheDir, cacheName);
  try {
    if (fs.existsSync(cacheFile)) {
      const stat = fs.statSync(cacheFile);
      if (Date.now() - stat.mtimeMs < CACHE_TTL_MS) {
        return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      }
    }
  } catch {
    /* ignore corrupt cache */
  }

  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(data), 'utf8');
    } catch {
      /* cache write failure is non-fatal */
    }
    return data;
  } catch {
    try {
      if (fs.existsSync(cacheFile)) {
        return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      }
    } catch {
      /* ignore */
    }
    return null;
  }
}

interface MrRule {
  pattern?: string;
  context?: { max_context?: number; max_input?: number; max_output?: number };
  capabilities?: { vision?: boolean; thinking?: boolean };
  default_effort?: string;
  efforts?: string[];
}

interface CatalogBundle {
  loadedAt: number;
  mrRules: Array<{ regex: RegExp; rule: MrRule }>;
  bestIndex: Map<string, Record<string, unknown>>;
  devIndex: Map<string, Record<string, unknown>>;
}

const bundleCache = new Map<string, CatalogBundle>();
const pendingLoads = new Map<string, Promise<CatalogBundle>>();

function compileMrPipidan(data: unknown): Array<{ regex: RegExp; rule: MrRule }> {
  const rules = (data as { rules?: unknown } | null)?.rules;
  if (!Array.isArray(rules)) return [];
  const compiled: Array<{ regex: RegExp; rule: MrRule }> = [];
  for (const rule of rules as MrRule[]) {
    if (!rule || typeof rule.pattern !== 'string') continue;
    try {
      compiled.push({ regex: new RegExp(`^(?:${rule.pattern})$`, 'i'), rule });
    } catch {
      /* skip invalid regex */
    }
  }
  return compiled;
}

function indexCatalog(data: unknown): Map<string, Record<string, unknown>> {
  const byKey = new Map<string, Record<string, unknown>>();
  if (!data || typeof data !== 'object') return byKey;
  for (const [provId, prov] of Object.entries(data as Record<string, unknown>)) {
    const models = (prov as { models?: unknown } | null)?.models;
    if (!models || typeof models !== 'object') continue;
    for (const [key, entry] of Object.entries(models as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      const id = typeof rec.id === 'string' ? rec.id : '';
      const name = typeof rec.name === 'string' ? rec.name : '';
      for (const k of [`${provId}/${key}`, key, id, name, id ? `${provId}/${id}` : '', name ? `${provId}/${name}` : '']) {
        const low = k.toLowerCase().trim();
        if (low && !byKey.has(low)) byKey.set(low, rec);
      }
    }
  }
  return byKey;
}

async function getCatalogBundle(dataDirectory: string): Promise<CatalogBundle> {
  const cacheDir = path.join(dataDirectory, 'capability_cache');
  const cached = bundleCache.get(cacheDir);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached;
  const inflight = pendingLoads.get(cacheDir);
  if (inflight) return inflight;

  const load = (async (): Promise<CatalogBundle> => {
    const [mrData, bestData, devData] = await Promise.all([
      fetchCachedJson(MRPIPIDAN_URL, cacheDir, 'mrpipidan_capabilities.json'),
      fetchCachedJson(BESTCODES_URL, cacheDir, 'bestcodes_all.json'),
      fetchCachedJson(MODELSDEV_URL, cacheDir, 'models_dev.json'),
    ]);
    const bundle: CatalogBundle = {
      loadedAt: Date.now(),
      mrRules: compileMrPipidan(mrData),
      bestIndex: indexCatalog(bestData),
      devIndex: indexCatalog(devData),
    };
    bundleCache.set(cacheDir, bundle);
    return bundle;
  })();

  pendingLoads.set(cacheDir, load);
  try {
    return await load;
  } finally {
    pendingLoads.delete(cacheDir);
  }
}

export function resolveFromBundle(modelId: string, bundle: CatalogBundle): DetectedModelCapabilities {
  const slugs = candidateModelSlugs(modelId);
  if (!slugs.length) return {};
  const out: DetectedModelCapabilities = {};

  const fill = (patch?: {
    contextWindow?: unknown;
    maxOutputTokens?: unknown;
    supportsVision?: unknown;
    supportsThinking?: unknown;
    reasoningEffort?: unknown;
    supportedEfforts?: unknown;
  }) => {
    if (!patch) return;
    if (
      out.contextWindow === undefined &&
      typeof patch.contextWindow === 'number' &&
      Number.isSafeInteger(patch.contextWindow) &&
      patch.contextWindow > 0
    ) {
      out.contextWindow = Math.min(patch.contextWindow, MAX_LIMIT);
    }
    if (
      out.maxOutputTokens === undefined &&
      typeof patch.maxOutputTokens === 'number' &&
      Number.isSafeInteger(patch.maxOutputTokens) &&
      patch.maxOutputTokens > 0
    ) {
      out.maxOutputTokens = Math.min(patch.maxOutputTokens, MAX_LIMIT);
    }
    if (out.supportsVision === undefined && typeof patch.supportsVision === 'boolean') {
      out.supportsVision = patch.supportsVision;
    }
    if (out.supportsThinking === undefined && typeof patch.supportsThinking === 'boolean') {
      out.supportsThinking = patch.supportsThinking;
    }
    if (out.reasoningEffort === undefined && patch.reasoningEffort !== undefined) {
      const eff = normalizeEffort(patch.reasoningEffort);
      if (eff) out.reasoningEffort = eff;
    }
    if (out.supportedEfforts === undefined && Array.isArray(patch.supportedEfforts)) {
      const filtered = patch.supportedEfforts
        .map((e) => normalizeEffort(e))
        .filter((e): e is VariantEffort => Boolean(e && VARIANT_EFFORTS.has(e as VariantEffort)));
      if (filtered.length) out.supportedEfforts = Array.from(new Set(filtered));
    }
  };

  // 1. MrPiPidan regex rules (skip catch-all ".*" so specific catalog hits win)
  for (const { regex, rule } of bundle.mrRules) {
    if (rule.pattern === '.*' || rule.pattern === '.+') continue;
    if (slugs.some((s) => regex.test(s))) {
      fill({
        contextWindow: rule.context?.max_context ?? rule.context?.max_input,
        maxOutputTokens: rule.context?.max_output,
        supportsVision: rule.capabilities?.vision,
        supportsThinking: rule.capabilities?.thinking,
        reasoningEffort: rule.default_effort,
        supportedEfforts: rule.efforts,
      });
      break;
    }
  }

  // 2. The-Best-Codes ai-model-directory
  for (const s of slugs) {
    const entry = bundle.bestIndex.get(s.toLowerCase());
    if (entry) {
      const limit = entry.limit as { context?: number; output?: number } | undefined;
      const modalities = entry.modalities as { input?: string[] } | undefined;
      fill({
        contextWindow: limit?.context,
        maxOutputTokens: limit?.output,
        supportsVision: Array.isArray(modalities?.input) ? modalities.input.includes('image') : undefined,
        supportsThinking: typeof entry.reasoning === 'boolean' ? entry.reasoning : undefined,
      });
      break;
    }
  }

  // 3. models.dev catalog
  for (const s of slugs) {
    const entry = bundle.devIndex.get(s.toLowerCase());
    if (entry) {
      const limit = entry.limit as { context?: number; output?: number } | undefined;
      const modalities = entry.modalities as { input?: string[] } | undefined;
      fill({
        contextWindow: limit?.context,
        maxOutputTokens: limit?.output,
        supportsVision: Array.isArray(modalities?.input) ? modalities.input.includes('image') : undefined,
        supportsThinking: typeof entry.reasoning === 'boolean' ? entry.reasoning : undefined,
      });
      break;
    }
  }

  // Ensure maxOutputTokens is always strictly less than contextWindow for schema validation
  if (
    typeof out.contextWindow === 'number' &&
    typeof out.maxOutputTokens === 'number' &&
    out.maxOutputTokens >= out.contextWindow
  ) {
    out.maxOutputTokens = out.contextWindow > 1 ? out.contextWindow - 1 : undefined;
  }

  return out;
}

export async function detectModelCapabilitiesBatch(
  modelIds: string[],
  dataDirectory: string,
): Promise<Record<string, DetectedModelCapabilities>> {
  const unique = Array.from(
    new Set(modelIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim())).map((id) => id.trim())),
  ).slice(0, 500);
  if (!unique.length) return {};
  const bundle = await getCatalogBundle(dataDirectory);
  const result: Record<string, DetectedModelCapabilities> = {};
  for (const id of unique) {
    const caps = resolveFromBundle(id, bundle);
    if (Object.keys(caps).length > 0) result[id] = caps;
  }
  return result;
}
