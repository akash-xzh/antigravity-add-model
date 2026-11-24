/** Transport-independent addon actions shared by Electron IPC and the local IDE manager. */
import type { createModelManager } from './modelManagement';
import type { ModelEntry, SecretCodec } from './modelStore';
import { getDiagnostics, clearDiagnostics, getRecentModelNames } from './diagnostics';
import * as path from 'node:path';
import { allocateModelIdentities } from './modelIdentity';
import { nativeCatalogCapabilities, nativeModelExperiments, type CustomModelConfig } from './proxy/modelUtils';
import { getContextInformation } from './chatContext';
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
      const models = manager.store.list();
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
          return {
            ...model,
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
    'storage:save-custom-model': manager.saveModel,
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
