/** Transport-independent addon actions shared by Electron IPC and the local IDE manager. */
import type { createModelManager } from './modelManagement';
import {
  decodeSecret,
  isMaskedSecret,
  redactModel,
  type ModelEntry,
  type SecretCodec,
} from './modelStore';
import { resolveApiFormat } from './providers';
import { validateCustomModel } from './schemaValidator';
import type { GoogleAccount } from './googleAccounts';
import { getDiagnostics, clearDiagnostics, getRecentModelNames } from './diagnostics';
import * as path from 'node:path';
import { allocateModelIdentities } from './modelIdentity';
import { nativeCatalogCapabilities, nativeModelExperiments, type CustomModelConfig } from './proxy/modelUtils';
import { getContextInformation } from './chatContext';
import { detectModelCapabilitiesBatch } from './modelCapabilities';
import {
  DEFAULT_PROMPT_SECTIONS,
  getAvailableTags,
  getEffectivePromptDefaults,
  loadPromptSectionsConfig,
  PromptSectionsConfig,
  savePromptSectionsConfig,
  STATIC_TAGS,
} from './proxy/promptSections';
import {
  getCachedHealthMap,
  pingCustomModel,
  checkAllModelsHealth,
  getRecentModels,
  isRecentModel,
  loadDisplaySettings,
  saveDisplaySettings,
  type ModelDisplaySettings,
} from './proxy/modelHealth';
import type { CustomModel } from './proxy';

const ENCRYPTED_SECRET_RE = /^(enc:|local-gcm:|fallback:)/;

const VALID_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
type EffortLevel = (typeof VALID_EFFORTS)[number];

const EFFORT_DISPLAY_LABELS: Record<EffortLevel, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
};

const EFFORT_THINKING_BUDGETS: Record<EffortLevel, number> = {
  minimal: 512,
  low: 1024,
  medium: 4096,
  high: 8192,
  xhigh: 16384,
};

const EFFORT_DISPLAY_SUFFIX_RE = /\s*\((?:minimal|low|medium|high|xhigh|extra)\)\s*$/i;
const EFFORT_NAME_SUFFIX_RE = /-(?:minimal|low|medium|high|xhigh)$/i;

const TRANSIENT_MODEL_FIELDS = [
  'originalName',
  'copyFrom',
  'apiKeyLength',
  'configIndex',
  'isRecent',
  'nativeCatalogId',
  'nativeModelId',
  'nativePickerAvailable',
  'nativePickerError',
  'nativeContextWindow',
  'nativeMaxOutputTokens',
  'nativeModelExperiments',
] as const;

function normalizeModelName(name: string): string {
  const trimmed = name.trim();
  return trimmed.startsWith('models/') ? trimmed : `models/${trimmed}`;
}

function stripTransientFields(model: ModelEntry): ModelEntry {
  const cleaned: ModelEntry = { ...model };
  for (const field of TRANSIENT_MODEL_FIELDS) {
    delete cleaned[field];
  }
  return cleaned;
}

function decryptModelForHealth(model: ModelEntry, codec: SecretCodec): CustomModel {
  const copy: Record<string, unknown> = { ...model };
  if (typeof model.apiKey === 'string' && model.apiKey && model.apiKey !== 'none') {
    if (model.encrypted || ENCRYPTED_SECRET_RE.test(model.apiKey)) {
      copy.apiKey = codec.decryptString(model.apiKey);
      copy.encrypted = false;
    }
  }
  if (model.customHeaders && typeof model.customHeaders === 'object' && !Array.isArray(model.customHeaders)) {
    const rawHeaders = model.customHeaders as Record<string, unknown>;
    const decryptedHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) {
      if (typeof v !== 'string') continue;
      decryptedHeaders[k] = model.encryptedHeaders || ENCRYPTED_SECRET_RE.test(v) ? codec.decryptString(v) : v;
    }
    copy.customHeaders = decryptedHeaders;
    copy.encryptedHeaders = false;
  }
  return copy as unknown as CustomModel;
}

export function createModelActions(
  manager: ReturnType<typeof createModelManager>,
): Record<string, (...args: unknown[]) => unknown> {
  return {
    'storage:get-custom-models': () => {
      const rawModels = manager.store.read();
      const models = rawModels.map(redactModel);
      const uniqueModels: typeof models = [];
      const seenNames = new Set<string>();
      for (const model of models) {
        if (typeof model.name === 'string' && model.name && !seenNames.has(model.name)) {
          seenNames.add(model.name);
          uniqueModels.push(model);
        }
      }
      // The proxy and both management transports share the same persistent
      // native identity registry. Do not regenerate enum IDs in the renderer.
      let identities: ReturnType<typeof allocateModelIdentities> = [];
      let identityError: string | undefined;
      try {
        identities = allocateModelIdentities(path.dirname(manager.store.filename), uniqueModels);
      } catch (error) {
        // Listing/editing saved providers remains possible when the identity
        // registry is unavailable; native injection must fail closed.
        identityError =
          (error instanceof Error ? error.message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 512) : '') ||
          'Native model identity metadata is unavailable. Retry after resolving the local metadata error.';
      }
      const byName = new Map(identities.map((identity) => [identity.name, identity]));
      const recent = [...new Set([...getRecentModels(), ...getRecentModelNames()])];
      const rank = (name: string) => {
        const index = recent.indexOf(name);
        return index < 0 ? recent.length : index;
      };
      const assignedNames = new Set<string>();
      return models
        .map((model, configIndex) => {
          const isFirstOccurrence = typeof model.name === 'string' && model.name.length > 0 && !assignedNames.has(model.name);
          if (isFirstOccurrence) assignedNames.add(model.name);
          const identity = isFirstOccurrence ? byName.get(model.name) : undefined;
          const capabilities = nativeCatalogCapabilities(model as CustomModelConfig);
          const rawModel = rawModels[configIndex];
          let apiKeyLength: number | undefined;
          if (rawModel && typeof rawModel.apiKey === 'string' && rawModel.apiKey && rawModel.apiKey !== 'none') {
            try {
              const decrypted = decodeSecret(rawModel.apiKey, manager.store.codec);
              if (decrypted && decrypted !== 'none') apiKeyLength = decrypted.length;
            } catch {
              // Omit apiKeyLength if the stored key cannot be decrypted on this machine.
            }
          }
          return {
            ...model,
            ...(apiKeyLength !== undefined ? { apiKeyLength } : {}),
            configIndex,
            isRecent: isRecentModel(model.name) || recent.slice(0, 3).includes(model.name),
            nativeCatalogId: identity?.catalogId,
            nativeModelId: identity?.placeholderId,
            nativePickerAvailable: !!identity?.placeholderId,
            nativeContextWindow: capabilities.maxTokens,
            nativeMaxOutputTokens: capabilities.maxOutputTokens,
            nativeModelExperiments: nativeModelExperiments(model as CustomModelConfig),
            nativePickerError: identity?.placeholderId
              ? undefined
              : !isFirstOccurrence
                ? 'Duplicate model name in configuration; only the first entry is active in the native picker.'
                : identityError ||
                  'Native model picker capacity reached; direct API alias remains available. 651 supported slots include native reservations and retained deleted models.',
          };
        })
        .sort((a, b) => rank(a.name) - rank(b.name));
    },
    'storage:save-custom-model': (model: unknown) => {
      if (model && typeof model === 'object' && !Array.isArray(model)) {
        const cleaned = { ...(model as ModelEntry) };
        delete cleaned.apiKeyLength;
        delete cleaned.configIndex;
        delete cleaned.isRecent;
        return manager.saveModel(cleaned);
      }
      return manager.saveModel(model as ModelEntry);
    },
    'storage:reveal-api-key': (name: unknown) => {
      if (typeof name !== 'string' || !name.trim()) {
        return { success: false, error: 'Model name is required' };
      }
      const trimmed = name.trim();
      const target = manager.store.read().find((m) => m.name === trimmed);
      if (!target) {
        return { success: false, error: 'Model not found' };
      }
      if (typeof target.apiKey !== 'string' || !target.apiKey || target.apiKey === 'none') {
        return { success: true, apiKey: '' };
      }
      try {
        const decrypted = decodeSecret(target.apiKey, manager.store.codec);
        return { success: true, apiKey: decrypted === 'none' ? '' : decrypted };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    'storage:sync-model-efforts': (payload: unknown) => {
      try {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          return { success: false, error: 'Invalid sync-model-efforts payload' };
        }
        const { baseModel, efforts, existingVariantNames } = payload as {
          baseModel?: ModelEntry & { originalName?: string; copyFrom?: string };
          efforts?: unknown;
          existingVariantNames?: unknown;
        };
        if (!baseModel || typeof baseModel !== 'object' || Array.isArray(baseModel)) {
          return { success: false, error: 'baseModel is required' };
        }
        if (!Array.isArray(efforts)) {
          return { success: false, error: 'efforts must be an array' };
        }
        const uniqueEfforts: EffortLevel[] = [];
        const seenEfforts = new Set<string>();
        for (const item of efforts) {
          if (typeof item !== 'string') {
            return { success: false, error: `Invalid reasoning effort: ${String(item)}` };
          }
          const normalized = item.trim().toLowerCase();
          if (!(VALID_EFFORTS as readonly string[]).includes(normalized)) {
            return { success: false, error: `Invalid reasoning effort: ${item}` };
          }
          if (!seenEfforts.has(normalized)) {
            seenEfforts.add(normalized);
            uniqueEfforts.push(normalized as EffortLevel);
          }
        }
        if (typeof baseModel.name !== 'string' || !baseModel.name.trim()) {
          return { success: false, error: 'Model name is required' };
        }
        const prefixedName = normalizeModelName(baseModel.name);
        if (prefixedName === 'models/') {
          return { success: false, error: 'Model name is required' };
        }
        const strippedStem = prefixedName.replace(EFFORT_NAME_SUFFIX_RE, '');
        const baseNameStem = strippedStem !== 'models/' ? strippedStem : prefixedName;

        const normalizedExisting: string[] = [];
        if (Array.isArray(existingVariantNames)) {
          const seenExisting = new Set<string>();
          for (const rawVariant of existingVariantNames) {
            if (typeof rawVariant !== 'string' || !rawVariant.trim()) continue;
            const norm = normalizeModelName(rawVariant);
            if (norm !== 'models/' && !seenExisting.has(norm)) {
              seenExisting.add(norm);
              normalizedExisting.push(norm);
            }
          }
        }

        const rawModels = manager.store.read();
        const candidateNames: string[] = [];
        for (const candidate of [baseModel.originalName, baseModel.copyFrom, prefixedName, ...normalizedExisting]) {
          if (typeof candidate === 'string' && candidate.trim()) {
            const norm = normalizeModelName(candidate);
            if (!candidateNames.includes(norm)) candidateNames.push(norm);
          }
        }
        const credentialSource = candidateNames
          .map((candidate) => rawModels.find((m) => m.name === candidate))
          .find((found): found is ModelEntry => !!found);

        const cleanBase = stripTransientFields(baseModel);
        if (
          credentialSource &&
          typeof cleanBase.apiUrl === 'string' &&
          typeof credentialSource.apiUrl === 'string'
        ) {
          let originChanged = false;
          try {
            originChanged = new URL(cleanBase.apiUrl).origin !== new URL(credentialSource.apiUrl).origin;
          } catch {
            // Invalid URL will be rejected by validateCustomModel below.
          }
          if (cleanBase.provider !== credentialSource.provider || originChanged) {
            if (
              (credentialSource.apiKey &&
                credentialSource.apiKey !== 'none' &&
                (!cleanBase.apiKey || isMaskedSecret(cleanBase.apiKey))) ||
              Object.values((cleanBase.customHeaders as Record<string, unknown>) || {}).some(isMaskedSecret)
            ) {
              return { success: false, error: 'Enter fresh credentials when changing the provider or server address' };
            }
          }
        }

        // Resolve masked API key from existing saved model/variant
        if (isMaskedSecret(cleanBase.apiKey) || cleanBase.apiKey === undefined) {
          if (isMaskedSecret(cleanBase.apiKey) && (!credentialSource?.apiKey || credentialSource.apiKey === 'none')) {
            return { success: false, error: 'Enter a key for this new model' };
          }
          if (credentialSource?.apiKey && credentialSource.apiKey !== 'none') {
            cleanBase.apiKey = decodeSecret(credentialSource.apiKey, manager.store.codec);
          } else {
            cleanBase.apiKey = '';
          }
        }

        // Resolve masked customHeaders from existing saved model/variant
        if (cleanBase.customHeaders && typeof cleanBase.customHeaders === 'object' && !Array.isArray(cleanBase.customHeaders)) {
          const oldHeaders = (credentialSource?.customHeaders || {}) as Record<string, string>;
          const resolvedHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(cleanBase.customHeaders as Record<string, unknown>)) {
            if (isMaskedSecret(value)) {
              if (!oldHeaders[key]) {
                return { success: false, error: `Enter a value for header ${key}` };
              }
              resolvedHeaders[key] =
                credentialSource?.encryptedHeaders || ENCRYPTED_SECRET_RE.test(oldHeaders[key])
                  ? decodeSecret(oldHeaders[key], manager.store.codec)
                  : oldHeaders[key];
            } else {
              resolvedHeaders[key] = String(value);
            }
          }
          cleanBase.customHeaders = resolvedHeaders;
        }

        // Resolve masked googleAccounts credentials from existing saved model/variant
        if (Array.isArray(cleanBase.googleAccounts) && Array.isArray(credentialSource?.googleAccounts)) {
          const previousAccounts = credentialSource.googleAccounts as GoogleAccount[];
          cleanBase.googleAccounts = (cleanBase.googleAccounts as GoogleAccount[]).map((account) => {
            const copy = { ...account };
            const stored = previousAccounts.find((item) => item.id === copy.id);
            if (stored) {
              for (const field of ['accessToken', 'refreshToken', 'clientSecret'] as const) {
                if (isMaskedSecret(copy[field]) && stored[field]) {
                  copy[field] = credentialSource.encryptedGoogleAccounts
                    ? decodeSecret(stored[field], manager.store.codec)
                    : stored[field];
                }
              }
            }
            return copy;
          });
        }

        const baseDisplayName = String(
          cleanBase.displayName || cleanBase.externalModelName || baseNameStem.replace(/^models\//, ''),
        )
          .replace(EFFORT_DISPLAY_SUFFIX_RE, '')
          .trim();

        const entriesToSave: ModelEntry[] = [];
        if (uniqueEfforts.length === 0) {
          const targetName =
            normalizedExisting.length > 0 && EFFORT_NAME_SUFFIX_RE.test(prefixedName) && baseNameStem !== 'models/'
              ? baseNameStem
              : prefixedName;
          const singleEntry: ModelEntry = {
            ...cleanBase,
            name: targetName,
            displayName: baseDisplayName,
          };
          const validation = validateCustomModel(singleEntry);
          if (!validation.valid) {
            return { success: false, error: validation.error || 'Invalid model configuration' };
          }
          entriesToSave.push(singleEntry);
        } else {
          if (cleanBase.supportsThinking === false) {
            return { success: false, error: 'This model is configured without reasoning support' };
          }
          const format = resolveApiFormat(
            cleanBase.provider,
            cleanBase.apiFormat as 'openai' | 'anthropic' | 'google' | undefined,
          );
          for (const effort of uniqueEfforts) {
            const variantEntry: ModelEntry = {
              ...cleanBase,
              name: `${baseNameStem}-${effort}`,
              displayName: `${baseDisplayName} (${EFFORT_DISPLAY_LABELS[effort]})`,
              reasoningEffort: effort,
            };
            if (format !== 'openai') {
              const budget = EFFORT_THINKING_BUDGETS[effort];
              variantEntry.thinkingBudget = budget;
              variantEntry.maxOutputTokens = Math.max(Number(cleanBase.maxOutputTokens) || 16384, budget + 1024);
              if (variantEntry.contextWindow && Number(variantEntry.contextWindow) <= Number(variantEntry.maxOutputTokens)) {
                return {
                  success: false,
                  error:
                    'The configured context window is too small for these thinking budgets. Adjust the model limits first.',
                };
              }
            }
            const validation = validateCustomModel(variantEntry);
            if (!validation.valid) {
              return { success: false, error: validation.error || 'Invalid model configuration' };
            }
            entriesToSave.push(variantEntry);
          }
        }

        for (const entry of entriesToSave) {
          manager.saveModel(entry);
        }
        const keptNames = new Set(entriesToSave.map((entry) => entry.name));
        for (const oldName of normalizedExisting) {
          if (!keptNames.has(oldName)) {
            manager.store.delete(oldName);
          }
        }
        return { success: true, count: entriesToSave.length };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    'storage:delete-custom-model': (name: string) => {
      manager.store.delete(name);
      return { success: true };
    },
    'storage:test-model-connection': manager.testModel,
    'storage:test-model-generation': manager.testGeneration,
    'storage:create-effort-variants': manager.createEffortVariants,
    'storage:get-provider-presets': manager.presets,
    'storage:discover-models': manager.discoverModels,
    'storage:discover-local': manager.discoverLocal,
    'storage:detect-model-capabilities': async (payload?: unknown) => {
      const ids = Array.isArray(payload)
        ? payload
        : typeof payload === 'string'
          ? [payload]
          : [];
      const capabilities = await detectModelCapabilitiesBatch(
        ids.filter((id): id is string => typeof id === 'string'),
        path.dirname(manager.store.filename),
      );
      return { success: true, capabilities };
    },
    'storage:export-custom-models': () => manager.store.export(),
    'storage:import-custom-models': (payload) => ({ success: true, count: manager.store.import(payload) }),
    'storage:get-gateway': manager.getGateway,
    'storage:save-gateway': manager.saveGateway,
    'storage:test-gateway': manager.testGateway,
    'storage:import-gateway-models': manager.importGatewayModels,
    'storage:open-gateway-dashboard': manager.openDashboard,
    'storage:google-login': manager.googleLogin,
    'storage:google-login-cancel': manager.googleLoginCancel,
    'storage:google-test-account': manager.googleTestAccount,
    'storage:google-account-prepare': manager.googlePrepareAccount,
    'storage:google-pool-status': manager.googlePoolStatus,
    'storage:google-link-account': manager.googleLinkAccount,
    'storage:google-select-account': manager.googleSelectAccount,
    'storage:google-remove-account': manager.googleRemoveAccount,
    'storage:get-diagnostics': getDiagnostics,
    'storage:clear-diagnostics': clearDiagnostics,
    'storage:get-chat-context-usage': (payload?: unknown) =>
      getContextInformation(payload, path.dirname(manager.store.filename), manager.store.list()),
    'storage:get-prompt-sections': () => ({
      success: true,
      tags: getAvailableTags(),
      defaults: getEffectivePromptDefaults(),
      config: loadPromptSectionsConfig(),
    }),
    'storage:save-prompt-sections': (config: PromptSectionsConfig) => {
      savePromptSectionsConfig(config);
      return { success: true };
    },
    'storage:reset-prompt-sections': () => {
      savePromptSectionsConfig({ overrides: {}, enabled: {} });
      return {
        success: true,
        tags: getAvailableTags(),
        defaults: getEffectivePromptDefaults(),
        config: { overrides: {}, enabled: {} },
      };
    },
    'storage:get-model-health': () => {
      return Object.fromEntries(getCachedHealthMap(path.dirname(manager.store.filename)));
    },
    'storage:check-model-health': async (name?: unknown) => {
      const dataDir = path.dirname(manager.store.filename);
      const rawModels = manager.store.read();
      if (typeof name === 'string' && name.trim()) {
        const trimmed = name.trim();
        const target = rawModels.find((m) => m.name === trimmed);
        if (!target) {
          return {};
        }
        const decryptedTarget = decryptModelForHealth(target, manager.store.codec);
        const res = await pingCustomModel(decryptedTarget, dataDir);
        return { [target.name]: res };
      }
      const decryptedModels = rawModels.map((m) => decryptModelForHealth(m, manager.store.codec));
      const healthMap = await checkAllModelsHealth(decryptedModels, true, dataDir);
      return Object.fromEntries(healthMap);
    },
    'storage:get-display-settings': () => {
      return loadDisplaySettings(path.dirname(manager.store.filename));
    },
    'storage:save-display-settings': (settings: unknown) => {
      const showStatusEmoji =
        typeof (settings as { showStatusEmoji?: unknown })?.showStatusEmoji === 'boolean'
          ? (settings as { showStatusEmoji: boolean }).showStatusEmoji
          : true;
      saveDisplaySettings({ showStatusEmoji }, path.dirname(manager.store.filename));
      return { success: true, showStatusEmoji };
    },
  };
}
