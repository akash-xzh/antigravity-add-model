import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createModelManager } from '../modelManagement';
import { createModelActions } from '../modelActions';
import { allocateModelIdentities, NATIVE_MODEL_CAPACITY } from '../modelIdentity';
import { clearHealthCache, type ModelHealthResult } from '../proxy/modelHealth';
import type { ModelEntry } from '../modelStore';

const directories: string[] = [];
const codec = {
  encryptString: (value: string) => `test:${Buffer.from(value).toString('base64')}`,
  decryptString: (value: string) =>
    value.startsWith('test:') ? Buffer.from(value.slice(5), 'base64').toString() : value,
};
const example = {
  name: 'models/local-one',
  displayName: 'One',
  provider: 'openai',
  apiUrl: 'https://provider.example/v1',
  externalModelName: 'provider-model',
  apiKey: 'private-key-12345',
  customHeaders: { 'x-tenant': 'private-header-12345' },
};
function fixture() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-actions-test-')));
  directories.push(directory);
  const manager = createModelManager(directory, codec, async () => {});
  const actions = createModelActions(manager);
  const list = () => actions['storage:get-custom-models']() as ModelEntry[];
  return { directory, manager, actions, list };
}
afterEach(() => {
  for (const directory of directories.splice(0)) {
    expect(path.dirname(directory)).toBe(fs.realpathSync(os.tmpdir()));
    expect(path.basename(directory)).toMatch(/^agy-actions-test-/);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('shared management model identity responses', () => {
  it('returns the proxy identity for each saved model without exposing secrets or the registry', () => {
    const f = fixture();
    f.manager.saveModel(example);
    f.manager.saveModel({ ...example, name: 'models/local-two', displayName: 'Two' });
    const identities = allocateModelIdentities(f.directory, f.manager.store.read());
    const response = f.list();
    for (const model of response) {
      const identity = identities.find((entry) => entry.name === model.name)!;
      expect(model).toMatchObject({
        nativeCatalogId: identity.catalogId,
        nativeModelId: identity.placeholderId,
        nativePickerAvailable: true,
        apiKey: '********',
        customHeaders: { 'x-tenant': '********' },
      });
      expect(model).not.toHaveProperty('assignments');
      expect(model).not.toHaveProperty('reserved');
      expect(model.nativePickerError).toBeUndefined();
    }
    expect(new Set(response.map((model) => model.nativeModelId)).size).toBe(2);
    const metadata = fs.readFileSync(path.join(f.directory, 'custom_model_identities.json'), 'utf8');
    for (const secret of [example.apiKey, example.customHeaders['x-tenant']]) {
      expect(JSON.stringify(response)).not.toContain(secret);
      expect(metadata).not.toContain(secret);
    }
  });

  it('keeps native identity after a displayed name edit and reconstructing the management transport', () => {
    const f = fixture();
    f.manager.saveModel(example);
    const original = f.list()[0];
    f.actions['storage:save-custom-model']({ ...original, displayName: 'A completely different label' });
    const reopened = createModelActions(createModelManager(f.directory, codec, async () => {}));
    const updated = reopened['storage:get-custom-models']() as ModelEntry[];
    expect(updated[0]).toMatchObject({
      displayName: 'A completely different label',
      nativeCatalogId: original.nativeCatalogId,
      nativeModelId: original.nativeModelId,
      nativePickerAvailable: true,
    });
  });

  it('returns computed checkpoint metadata to both managers without persisting it', () => {
    const f = fixture();
    f.manager.saveModel({
      ...example, contextWindow: 85000, maxOutputTokens: 8192,
      compactionReasoningEffort: 'low', compactionThresholdPercent: 80,
    });
    const [returned] = f.list();
    expect(returned).toMatchObject({ contextWindow: 85000, nativeContextWindow: 90000, nativeMaxOutputTokens: 8192 });
    const experiments = returned.nativeModelExperiments as { experiments: Record<string, { stringValue: string }> };
    expect(JSON.parse(experiments.experiments.CASCADE_USE_EXPERIMENT_CHECKPOINTER.stringValue)).toEqual({
      useLastPlannerModel: true, maxOutputTokens: 8192, tokenThreshold: 68000, maxTokenLimit: 75784,
    });
    f.actions['storage:save-custom-model'](returned);
    expect(f.manager.store.read()[0]).not.toHaveProperty('nativeModelExperiments');
    expect(f.manager.store.read()[0]).toMatchObject({ compactionThresholdPercent: 80, contextWindow: 85000 });
    expect(f.list()[0].nativeModelExperiments).toEqual(experiments);
    f.actions['storage:save-custom-model']({ ...returned, compactionThresholdPercent: undefined, compactionReasoningEffort: undefined });
    // A declared context window alone keeps the default 80% policy; only the summary override is gone.
    expect(JSON.parse(
      (f.list()[0].nativeModelExperiments as typeof experiments).experiments.CASCADE_USE_EXPERIMENT_CHECKPOINTER.stringValue,
    )).toEqual({ tokenThreshold: 68000, maxTokenLimit: 75784 });
  });

  it('does not trust or persist identity fields supplied by save and import clients', () => {
    const f = fixture();
    const forged = {
      nativeCatalogId: 'native-victim',
      nativeModelId: 'MODEL_PLACEHOLDER_M99999',
      nativePickerAvailable: true,
      nativePickerError: 'forged error',
      nativeContextWindow: 999999999,
      nativeMaxOutputTokens: 1,
      nativeModelExperiments: { experiments: { attacker: { boolValue: true } } },
    };
    f.actions['storage:save-custom-model']({ ...example, ...forged });
    f.actions['storage:import-custom-models']({ models: [{ ...example, name: 'models/imported', ...forged }] });
    for (const saved of f.manager.store.read()) {
      expect(saved).not.toHaveProperty('nativeCatalogId');
      expect(saved).not.toHaveProperty('nativeModelId');
      expect(saved).not.toHaveProperty('nativePickerAvailable');
      expect(saved).not.toHaveProperty('nativePickerError');
      expect(saved).not.toHaveProperty('nativeContextWindow');
      expect(saved).not.toHaveProperty('nativeMaxOutputTokens');
      expect(saved).not.toHaveProperty('nativeModelExperiments');
    }
    for (const returned of f.list()) {
      expect(returned.nativeCatalogId).not.toBe(forged.nativeCatalogId);
      expect(returned.nativeModelId).not.toBe(forged.nativeModelId);
      expect(returned.nativeContextWindow).not.toBe(forged.nativeContextWindow);
      expect(returned.nativeMaxOutputTokens).not.toBe(forged.nativeMaxOutputTokens);
      expect(returned.nativeModelExperiments).toBeUndefined();
    }
  });

  it('keeps management available but disables native injection when the identity registry cannot be read', () => {
    const f = fixture();
    f.manager.saveModel(example);
    const filename = path.join(f.directory, 'custom_model_identities.json');
    fs.writeFileSync(filename, '{corrupted registry');
    expect(f.list()).toMatchObject([{ name: example.name, nativePickerAvailable: false, apiKey: '********' }]);
    expect(f.list()[0].nativeModelId).toBeUndefined();
    expect(f.list()[0].nativePickerError).toEqual(expect.any(String));
    expect(f.list()[0].nativePickerError).not.toContain('capacity reached');
    expect(fs.readFileSync(filename, 'utf8')).toBe('{corrupted registry');
  });

  it('reports capacity overflow explicitly while keeping all models editable with unique assigned IDs', () => {
    const f = fixture();
    f.manager.store.import({
      models: Array.from({ length: NATIVE_MODEL_CAPACITY + 1 }, (_, index) => ({
        ...example,
        name: `models/entry-${index}`,
        displayName: `Model ${index}`,
      })),
    });
    const response = f.list();
    expect(response).toHaveLength(NATIVE_MODEL_CAPACITY + 1);
    const available = response.filter((model) => model.nativePickerAvailable);
    expect(available).toHaveLength(NATIVE_MODEL_CAPACITY);
    expect(new Set(available.map((model) => model.nativeModelId)).size).toBe(NATIVE_MODEL_CAPACITY);
    expect(response.filter((model) => !model.nativePickerAvailable)).toMatchObject([{ nativeModelId: undefined }]);
    expect(response.find((model) => !model.nativePickerAvailable)?.nativePickerError).toContain('capacity reached');
  });

  it('gets and saves model display settings via actions', () => {
    const f = fixture();
    const initial = f.actions['storage:get-display-settings']() as { showStatusEmoji: boolean };
    expect(initial.showStatusEmoji).toBe(true);

    const saved = f.actions['storage:save-display-settings']({ showStatusEmoji: false }) as {
      success: boolean;
      showStatusEmoji: boolean;
    };
    expect(saved.success).toBe(true);
    expect(saved.showStatusEmoji).toBe(false);

    const updated = f.actions['storage:get-display-settings']() as { showStatusEmoji: boolean };
    expect(updated.showStatusEmoji).toBe(false);
  });

  it('decrypts stored credentials for storage:check-model-health and returns {} for unknown model names', async () => {
    const f = fixture();
    const receivedHeaders: http.IncomingHttpHeaders[] = [];
    const server = http.createServer((req, res) => {
      receivedHeaders.push(req.headers);
      if (req.headers.authorization === 'Bearer real-secret-key' && req.headers['x-tenant'] === 'real-tenant-secret') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":"unauthorized"}');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    try {
      clearHealthCache(false, f.directory);
      f.manager.saveModel({
        ...example,
        apiUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'real-secret-key',
        customHeaders: { 'x-tenant': 'real-tenant-secret' },
      });

      // Unknown name must return {} without pinging any model
      const missing = (await f.actions['storage:check-model-health']('models/does-not-exist')) as Record<
        string,
        ModelHealthResult
      >;
      expect(missing).toEqual({});
      expect(receivedHeaders).toHaveLength(0);

      // Single model check sends decrypted key & headers (never "********")
      const single = (await f.actions['storage:check-model-health'](example.name)) as Record<string, ModelHealthResult>;
      expect(single[example.name]?.status).toBe('healthy');
      expect(receivedHeaders).toHaveLength(1);
      expect(receivedHeaders[0].authorization).toBe('Bearer real-secret-key');
      expect(receivedHeaders[0]['x-tenant']).toBe('real-tenant-secret');

      // Full batch check also uses decrypted credentials
      const all = (await f.actions['storage:check-model-health']()) as Record<string, ModelHealthResult>;
      expect(all[example.name]?.status).toBe('healthy');
      expect(receivedHeaders).toHaveLength(2);
      expect(receivedHeaders[1].authorization).toBe('Bearer real-secret-key');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reloads model_health_cache.json in storage:get-model-health when updated externally by the proxy', () => {
    const f = fixture();
    clearHealthCache(false, f.directory);
    expect(f.actions['storage:get-model-health']()).toEqual({});

    const cacheFile = path.join(f.directory, 'model_health_cache.json');
    const firstPayload = {
      models: {
        'models/proxy-updated': { status: 'healthy', latencyMs: 42, checkedAt: Date.now() },
      },
      recent: ['models/proxy-updated'],
    };
    fs.writeFileSync(cacheFile, JSON.stringify(firstPayload, null, 2));
    const firstRead = f.actions['storage:get-model-health']() as Record<string, ModelHealthResult>;
    expect(firstRead['models/proxy-updated']?.status).toBe('healthy');

    // Simulate proxy writing an updated health state with different size/mtime
    const secondPayload = {
      models: {
        'models/proxy-updated': { status: 'cooldown', error: 'Rate Limit (429)', checkedAt: Date.now() + 1000 },
      },
      recent: ['models/proxy-updated'],
    };
    fs.writeFileSync(cacheFile, JSON.stringify(secondPayload, null, 2));
    const secondRead = f.actions['storage:get-model-health']() as Record<string, ModelHealthResult>;
    expect(secondRead['models/proxy-updated']?.status).toBe('cooldown');
  });
});
