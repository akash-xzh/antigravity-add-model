import { createHash } from 'node:crypto';

import { cleanModelDisplayName, formatHealthDisplayName, isStatusEmojiEnabled, type ModelHealthResult } from './modelHealth';

export interface CatalogIdentity {
  name: string;
  externalModelName?: string;
  displayName?: string;
}
const slugPart = (value: string) =>
  value
    .replace(/^models\//, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
export function legacyModelSlug(model: CatalogIdentity): string {
  return 'custom-' + slugPart(model.externalModelName || model.name);
}
/** An always-available routing alias tied to the saved model, including its effort settings. */
export function localModelSlug(model: CatalogIdentity): string {
  return `custom-${slugPart(model.name)}-${createHash('sha256').update(model.name).digest('hex').slice(0, 12)}`;
}
export function catalogModelSlug(model: CatalogIdentity, models: CatalogIdentity[]): string {
  const legacy = legacyModelSlug(model);
  return models.filter((item) => legacyModelSlug(item) === legacy).length === 1 &&
    !models.some((item) => item.name !== model.name && localModelSlug(item) === legacy)
    ? legacy
    : localModelSlug(model);
}
export function matchesModelSlug(model: CatalogIdentity, value: string, models: CatalogIdentity[]): boolean {
  const id = value.replace(/^models\//, '');
  return id === localModelSlug(model) || id === catalogModelSlug(model, models);
}

export function fallbackModelDisplayName(model: CatalogIdentity): string {
  const display = typeof model.displayName === 'string' ? model.displayName.trim() : '';
  if (display) return display;
  const external = typeof model.externalModelName === 'string' ? model.externalModelName.trim() : '';
  if (external) return external;
  return String(model.name || '').replace(/^models\//, '').trim() || String(model.name || '');
}

/** The native IDE resolves sorted options by label, so display labels must also be unique. */
export function catalogDisplayNames(
  models: CatalogIdentity[],
  upstream: unknown = {},
  healthMap?: Map<string, ModelHealthResult>,
  recentModels?: string[] | Set<string>,
  showStatusEmoji?: boolean,
): Map<string, string> {
  const used = new Set<string>();
  if (upstream && typeof upstream === 'object') {
    for (const key of ['models', 'availableModels', 'available_models']) {
      const collection = (upstream as Record<string, unknown>)[key];
      if (!collection || typeof collection !== 'object') continue;
      for (const entry of Object.values(collection)) {
        if (typeof entry?.displayName === 'string') {
          used.add(entry.displayName);
          const cleaned = cleanModelDisplayName(entry.displayName);
          if (cleaned) used.add(cleaned);
        }
      }
    }
  }
  const counts = new Map<string, number>();
  for (const model of models) {
    const raw = fallbackModelDisplayName(model);
    const cleaned = cleanModelDisplayName(raw) || raw;
    counts.set(cleaned, (counts.get(cleaned) || 0) + 1);
  }
  const emojiEnabled = showStatusEmoji !== undefined ? showStatusEmoji : isStatusEmojiEnabled();
  const labels = new Map<string, string>();
  const usedFinal = new Set<string>(used);
  for (const model of [...models].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const rawBase = fallbackModelDisplayName(model);
    const base = cleanModelDisplayName(rawBase) || rawBase;
    let label = base;
    if ((counts.get(base) || 0) > 1 || used.has(label)) label = `${base} (${model.name.replace(/^models\//, '')})`;
    let suffix = 2;
    while (used.has(label)) label = `${base} (${model.name.replace(/^models\//, '')} #${suffix++})`;
    used.add(label);
    const isRecent = recentModels
      ? Array.isArray(recentModels)
        ? recentModels.includes(model.name)
        : recentModels.has(model.name)
      : false;
    let finalLabel = healthMap
      ? formatHealthDisplayName(label, healthMap.get(model.name), isRecent, emojiEnabled)
      : isRecent && emojiEnabled
        ? `⭐ ${label}`
        : label;
    while (usedFinal.has(finalLabel)) {
      const disambiguated = `${base} (${model.name.replace(/^models\//, '')} #${suffix++})`;
      used.add(disambiguated);
      finalLabel = healthMap
        ? formatHealthDisplayName(disambiguated, healthMap.get(model.name), isRecent, emojiEnabled)
        : isRecent && emojiEnabled
          ? `⭐ ${disambiguated}`
          : disambiguated;
    }
    usedFinal.add(finalLabel);
    labels.set(model.name, finalLabel);
  }
  return labels;
}

export interface CatalogEntry {
  slug: string;
  mapEntry: Record<string, unknown>;
  listEntry: Record<string, unknown>;
}

/** Preserve native metadata while advertising only configured custom models in every response shape. */
export function mergeCloudCodeCatalog(upstream: unknown, entries: CatalogEntry[]): Record<string, unknown> {
  const result: Record<string, unknown> =
    upstream && typeof upstream === 'object' && !Array.isArray(upstream)
      ? { ...(upstream as Record<string, unknown>) }
      : {};
  let merged = false;
  for (const key of ['models', 'availableModels', 'available_models']) {
    const value = result[key];
    if (Array.isArray(value)) {
      const customNames = new Set(entries.map((entry) => entry.listEntry.name));
      result[key] = [
        ...entries.map((entry) => ({ ...entry.listEntry })),
        ...value.filter((item) => !customNames.has(item?.name)),
      ];
      merged = true;
    } else if (value && typeof value === 'object') {
      result[key] = {
        ...(value as Record<string, unknown>),
        ...Object.fromEntries(entries.map((entry) => [entry.slug, { ...entry.mapEntry }])),
      };
      merged = true;
    }
  }
  if (!merged) result.models = Object.fromEntries(entries.map((entry) => [entry.slug, { ...entry.mapEntry }]));
  if (!entries.length) return result;

  const ids = [...new Set(entries.map((entry) => entry.slug))];
  const sorts = Array.isArray(result.agentModelSorts) ? result.agentModelSorts : [];
  let attached = false;
  result.agentModelSorts = sorts.map((sort) => {
    if (!sort || typeof sort !== 'object' || !Array.isArray(sort.groups)) return sort;
    return {
      ...sort,
      groups: sort.groups.map((group: unknown) => {
        if (!group || typeof group !== 'object') return group;
        const original = group as Record<string, unknown>;
        if (!Array.isArray(original.modelIds)) return group;
        attached = true;
        return { ...original, modelIds: [...new Set([...original.modelIds, ...ids])] };
      }),
    };
  });
  if (!attached)
    (result.agentModelSorts as unknown[]).push({ displayName: 'Custom models', groups: [{ modelIds: ids }] });
  return result;
}
