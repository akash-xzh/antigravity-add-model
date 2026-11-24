import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getContextWindow, setContextWindow, loadContextWindowsFromModels, clearContextWindows } from '../src/context-windows.js';

describe('ContextWindowRegistry', () => {
  beforeEach(() => {
    clearContextWindows();
  });

  it('returns default 128000 for unknown models', () => {
    assert.equal(getContextWindow('unknown-model'), 128000);
  });

  it('returns configured value for known model', () => {
    setContextWindow('gpt-4o', 128000);
    assert.equal(getContextWindow('gpt-4o'), 128000);
  });

  it('loads from models.json _context_windows', () => {
    const windows = { 'claude-sonnet-4': 200000, 'gpt-4o': 128000 };
    loadContextWindowsFromModels(windows);
    assert.equal(getContextWindow('claude-sonnet-4'), 200000);
    assert.equal(getContextWindow('gpt-4o'), 128000);
  });

  it('manual override takes precedence over loaded values', () => {
    loadContextWindowsFromModels({ 'model-a': 100000 });
    setContextWindow('model-a', 200000);
    assert.equal(getContextWindow('model-a'), 200000);
  });

  it('selects the longest matching prefix regardless of insertion order', () => {
    loadContextWindowsFromModels({
      'gpt-4': 8192,
      'gpt-4o': 128000,
      'gpt-4o-mini': 64000,
    });
    assert.equal(getContextWindow('gpt-4-0613'), 8192);
    assert.equal(getContextWindow('gpt-4o-2024-08-06'), 128000);
    assert.equal(getContextWindow('gpt-4o-mini-2024-07-18'), 64000);
  });

  it('resolves longest prefix across manualOverrides and contextWindows', () => {
    loadContextWindowsFromModels({
      'claude-sonnet': 200000,
      'claude-sonnet-4': 250000,
    });
    setContextWindow('claude-sonnet-4-5', 1000000);
    setContextWindow('claude-sonnet', 180000);
    // Longer manual prefix wins
    assert.equal(getContextWindow('claude-sonnet-4-5-20260101'), 1000000);
    // More specific loaded prefix beats shorter manual prefix
    assert.equal(getContextWindow('claude-sonnet-4-20250514'), 250000);
    // Equal-length manual prefix overrides loaded prefix
    assert.equal(getContextWindow('claude-sonnet-3'), 180000);
  });

  it('rejects non-positive and non-finite context window values', () => {
    setContextWindow('bad-zero', 0);
    setContextWindow('bad-neg', -5000);
    setContextWindow('bad-nan', Number.NaN);
    setContextWindow('bad-inf', Number.POSITIVE_INFINITY);
    loadContextWindowsFromModels({
      'loaded-zero': 0,
      'loaded-neg': -1,
      'loaded-nan': Number.NaN,
      'loaded-inf': Number.NEGATIVE_INFINITY,
      'valid-model': 64000,
    });
    assert.equal(getContextWindow('bad-zero'), 128000);
    assert.equal(getContextWindow('bad-neg'), 128000);
    assert.equal(getContextWindow('bad-nan'), 128000);
    assert.equal(getContextWindow('bad-inf'), 128000);
    assert.equal(getContextWindow('loaded-zero'), 128000);
    assert.equal(getContextWindow('loaded-neg'), 128000);
    assert.equal(getContextWindow('loaded-nan'), 128000);
    assert.equal(getContextWindow('loaded-inf'), 128000);
    assert.equal(getContextWindow('valid-model'), 64000);
  });
});
