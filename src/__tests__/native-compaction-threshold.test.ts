import { describe, expect, it } from 'vitest';
import { detectModelCapabilities, nativeCatalogCapabilities, nativeCheckpointConfig, nativeModelExperiments } from '../proxy/modelUtils';
import { validateCustomModel } from '../schemaValidator';

const model = {
  name: 'models/ollama/qwen3.8:27b',
  displayName: 'Qwen 3.8 27B',
  provider: 'ollama',
  externalModelName: 'qwen3.8:27b',
  apiUrl: 'http://127.0.0.1:11434/v1',
  apiKey: 'none',
  contextWindow: 85000,
};

describe('native IDE compaction thresholds', () => {
  it('defaults to 80% of a declared context window and keeps the IDE default without one', () => {
    expect(nativeCheckpointConfig(model)).toEqual({ tokenThreshold: 67592, maxTokenLimit: 67592 });
    expect(nativeModelExperiments(model)).toBeDefined();
    expect(nativeCheckpointConfig({ ...model, contextWindow: undefined })).toBeUndefined();
    expect(nativeCheckpointConfig({ ...model, compactionReasoningEffort: 'low' })).toEqual({
      useLastPlannerModel: true, maxOutputTokens: 8192, tokenThreshold: 67592, maxTokenLimit: 67592,
    });
  });

  it('removes both native 40k reserve and independent 50k trigger when an 80% limit is selected', () => {
    const configured = { ...model, maxOutputTokens: 8192, compactionThresholdPercent: 80 };
    expect(validateCustomModel(configured)).toEqual({ valid: true });
    expect(nativeCheckpointConfig(configured)).toEqual({ tokenThreshold: 68000, maxTokenLimit: 75784 });
    expect(detectModelCapabilities(configured)).toMatchObject({ maxTokens: 85000, maxOutputTokens: 8192 });
    expect(JSON.parse(nativeModelExperiments(configured)!.experiments.CASCADE_USE_EXPERIMENT_CHECKPOINTER.stringValue))
      .toEqual({ tokenThreshold: 68000, maxTokenLimit: 75784 });
  });

  it('caps the requested percentage for inferred output tokens without inflating the provider context', () => {
    const configured = { ...model, compactionThresholdPercent: 80 };
    expect(detectModelCapabilities(configured).maxOutputTokens).toBe(16384);
    expect(nativeCheckpointConfig(configured)).toEqual({ tokenThreshold: 67592, maxTokenLimit: 67592 });
    expect(configured.contextWindow).toBe(85000);
    expect(configured).not.toHaveProperty('maxOutputTokens');
  });

  it('keeps independent summary effort while applying a bounded native threshold', () => {
    expect(nativeCheckpointConfig({
      ...model, maxOutputTokens: 8192, compactionThresholdPercent: 90, compactionReasoningEffort: 'none',
    })).toEqual({ useLastPlannerModel: true, maxOutputTokens: 8192, tokenThreshold: 75784, maxTokenLimit: 75784 });
  });

  it('applies a custom threshold to a small window the IDE 50k default would exceed', () => {
    const configured = { ...model, contextWindow: 16000, maxOutputTokens: 2048, compactionThresholdPercent: 80 };
    expect(validateCustomModel(configured)).toEqual({ valid: true });
    expect(nativeCheckpointConfig(configured)).toEqual({ tokenThreshold: 12800, maxTokenLimit: 12928 });
    expect(nativeCatalogCapabilities(configured).maxTokens).toBe(16000);
  });

  it('emits a checkpoint threshold for a 64K model with realistic output tokens', () => {
    const configured = { ...model, contextWindow: 65536, maxOutputTokens: 16384, compactionThresholdPercent: 80 };
    expect(validateCustomModel(configured)).toEqual({ valid: true });
    expect(nativeCheckpointConfig(configured)).toEqual({ tokenThreshold: 48128, maxTokenLimit: 48128 });
  });

  it('caps native summary output when routing checkpoints to a model with a smaller output limit', () => {
    expect(nativeCheckpointConfig({
      ...model, maxOutputTokens: 4096, compactionReasoningEffort: 'low',
    })).toEqual({ useLastPlannerModel: true, maxOutputTokens: 4096, tokenThreshold: 68000, maxTokenLimit: 79880 });
    // A threshold-only override preserves the native summary model and output.
    expect(nativeCheckpointConfig({
      ...model, maxOutputTokens: 4096, compactionThresholdPercent: 80,
    })).not.toHaveProperty('maxOutputTokens');
  });

  it.each([10, 50, 80, 90])('accepts an integer percentage %s within the supported bounds', (compactionThresholdPercent) => {
    expect(validateCustomModel({ ...model, compactionThresholdPercent })).toEqual({ valid: true });
  });

  it.each([0, 9, 91, 100, -1, 50.5, '80', null, true, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid threshold percentage %s', (compactionThresholdPercent) => {
      expect(validateCustomModel({ ...model, compactionThresholdPercent })).toEqual({
        valid: false, error: 'compactionThresholdPercent must be an integer from 10 to 90',
      });
    },
  );

  it('requires the actual context window instead of applying a percentage to a guessed default', () => {
    const configured = { ...model, contextWindow: undefined, compactionThresholdPercent: 80 };
    expect(validateCustomModel(configured)).toMatchObject({ valid: false, error: expect.stringContaining('actual contextWindow') });
    expect(nativeCheckpointConfig(configured)).toBeUndefined();
  });

  it.each([
    { contextWindow: 8192 },
    { contextWindow: 16000, maxOutputTokens: 15000 },
    { contextWindow: 4000, maxOutputTokens: 2048 },
    { contextWindow: 4000, maxOutputTokens: 1024, compactionThresholdPercent: 10 },
  ])('rejects a nonusable input budget after reserving output and checkpoint overhead: %j', (limits) => {
    const configured = { ...model, compactionThresholdPercent: 80, ...limits };
    expect(validateCustomModel(configured)).toMatchObject({ valid: false });
    expect(nativeCheckpointConfig(configured)).toBeUndefined();
  });

  it.each([
    { contextWindow: undefined },
    { contextWindow: '85000' },
    { contextWindow: Number.POSITIVE_INFINITY },
    { contextWindow: -1 },
    { maxOutputTokens: '8192' },
    { maxOutputTokens: 0 },
    { maxOutputTokens: -1 },
    { maxOutputTokens: 85000 },
    { maxOutputTokens: Number.NaN },
    { compactionThresholdPercent: '80' },
    { compactionThresholdPercent: 0 },
  ])('does not emit a threshold override from malformed hand-edited model data: %j', (invalid) => {
    expect(nativeCheckpointConfig({ ...model, compactionThresholdPercent: 80, ...invalid } as unknown as Parameters<typeof nativeCheckpointConfig>[0])).toBeUndefined();
  });

  it('raises only the native catalog floor while preserving the saved and provider context', () => {
    const configured = { ...model, maxOutputTokens: 8192, compactionThresholdPercent: 80 };
    const snapshot = JSON.stringify(configured);
    expect(nativeCatalogCapabilities(configured)).toMatchObject({ maxTokens: 90000, maxOutputTokens: 8192 });
    expect(detectModelCapabilities(configured)).toMatchObject({ maxTokens: 85000, maxOutputTokens: 8192 });
    expect(nativeCheckpointConfig(configured)).toEqual({ tokenThreshold: 68000, maxTokenLimit: 75784 });
    expect(JSON.stringify(configured)).toBe(snapshot);
  });

  it.each([
    {},
    { compactionReasoningEffort: 'low' },
  ])('raises the native catalog floor for a declared window that fits the checkpoint defaults: %j', (fields) => {
    expect(nativeCatalogCapabilities({ ...model, ...fields }).maxTokens).toBe(90000);
  });

  it.each([
    { compactionThresholdPercent: 9 },
    { compactionThresholdPercent: 91 },
    { compactionThresholdPercent: 80, maxOutputTokens: 40000 },
    { maxOutputTokens: 40000 },
  ])('does not raise native context without a usable real input budget: %j', (fields) => {
    const configured = { ...model, ...fields };
    expect(nativeCatalogCapabilities(configured).maxTokens).toBe(85000);
  });

  it('accepts a sub-50k native budget and still emits a usable threshold', () => {
    const configured = { ...model, contextWindow: 59216, maxOutputTokens: 8192, compactionThresholdPercent: 80 };
    expect(validateCustomModel(configured)).toEqual({ valid: true });
    expect(nativeCheckpointConfig(configured)).toEqual({ tokenThreshold: 47372, maxTokenLimit: 50000 });
    expect(nativeCatalogCapabilities(configured).maxTokens).toBe(90000);
    const below = { ...configured, contextWindow: 59215 };
    expect(validateCustomModel(below)).toEqual({ valid: true });
    expect(nativeCheckpointConfig(below)).toEqual({ tokenThreshold: 47372, maxTokenLimit: 49999 });
    // No catalog padding is needed once a smaller threshold is published explicitly.
    expect(nativeCatalogCapabilities(below).maxTokens).toBe(59215);
  });

  it.each([
    { contextWindow: 128000, maxOutputTokens: 8192 },
    { contextWindow: 120000, maxOutputTokens: 60000 },
  ])('leaves an already compatible native context unchanged: %j', (limits) => {
    const configured = { ...model, ...limits, compactionThresholdPercent: 80 };
    expect(nativeCatalogCapabilities(configured).maxTokens).toBe(limits.contextWindow);
  });
});
