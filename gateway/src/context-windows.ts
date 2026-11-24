import { logger } from './logger.js';

const DEFAULT_CONTEXT_WINDOW = 128000;

const contextWindows = new Map<string, number>();
const manualOverrides = new Map<string, number>();

function isValidContextWindow(tokens: unknown): tokens is number {
  return typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0;
}

export function setContextWindow(model: string, tokens: number): void {
  if (!model || !isValidContextWindow(tokens)) {
    logger.warn(`[context-windows] Ignoring invalid context window for '${model}': ${String(tokens)}`);
    return;
  }
  manualOverrides.set(model, Math.floor(tokens));
}

export function getContextWindow(model: string): number {
  const manualExact = manualOverrides.get(model);
  if (isValidContextWindow(manualExact)) return manualExact;

  const loadedExact = contextWindows.get(model);
  if (isValidContextWindow(loadedExact)) return loadedExact;

  // Prefix resolution: pick the longest matching prefix across both maps,
  // preferring manualOverrides on equal prefix length.
  let bestLen = 0;
  let bestValue: number | undefined;

  for (const [key, value] of contextWindows) {
    if (key.length > 0 && isValidContextWindow(value) && model.startsWith(key) && key.length > bestLen) {
      bestLen = key.length;
      bestValue = value;
    }
  }
  for (const [key, value] of manualOverrides) {
    if (key.length > 0 && isValidContextWindow(value) && model.startsWith(key) && key.length >= bestLen) {
      bestLen = key.length;
      bestValue = value;
    }
  }
  if (bestValue !== undefined) return bestValue;

  return DEFAULT_CONTEXT_WINDOW;
}

export function loadContextWindowsFromModels(windows: Record<string, number>): void {
  let loaded = 0;
  for (const [model, tokens] of Object.entries(windows || {})) {
    if (!model || !isValidContextWindow(tokens)) {
      logger.warn(`[context-windows] Ignoring invalid model context window for '${model}': ${String(tokens)}`);
      continue;
    }
    if (!manualOverrides.has(model)) {
      contextWindows.set(model, Math.floor(tokens));
    }
    loaded++;
  }
  logger.info(`[context-windows] Loaded ${loaded} context window definitions`);
}

export function clearContextWindows(): void {
  contextWindows.clear();
  manualOverrides.clear();
}