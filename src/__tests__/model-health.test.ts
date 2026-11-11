import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  cleanModelDisplayName,
  formatHealthDisplayName,
  getCachedHealth,
  getCachedHealthMap,
  setCachedHealth,
  recordModelSuccess,
  recordModelFailure,
  setDataDirectory,
  loadHealthCache,
  saveHealthCache,
  clearHealthCache,
  checkAllModelsHealth,
  pingCustomModel,
  recordRecentModel,
  isRecentModel,
  getRecentModels,
  sortCustomModels,
} from '../proxy/modelHealth';
import { catalogDisplayNames } from '../proxy/modelCatalog';
import type { CustomModel } from '../proxy';

describe('Model Health Checker & Status Signals', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-health-test-'));
    setDataDirectory(tempDir);
    clearHealthCache();
  });

  afterEach(() => {
    clearHealthCache();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('cleanModelDisplayName & formatHealthDisplayName', () => {
    it('cleans status emojis, bullets, stars, and error tags from model names', () => {
      expect(cleanModelDisplayName('🟢 • GPT-4o')).toBe('GPT-4o');
      expect(cleanModelDisplayName('🔴 [Error] • Claude 3.5 Sonnet')).toBe('Claude 3.5 Sonnet');
      expect(cleanModelDisplayName('🟡 • Local Llama')).toBe('Local Llama');
      expect(cleanModelDisplayName('⭐ • DeepSeek')).toBe('DeepSeek');
      expect(cleanModelDisplayName('⭐ 🟢 • Gemini Pro')).toBe('Gemini Pro');
      expect(cleanModelDisplayName('⭐ 🔴 [Offline] • Mistral')).toBe('Mistral');
      expect(cleanModelDisplayName('GPT-4o')).toBe('GPT-4o');
    });

    it('formats display names with 🟢 for healthy models', () => {
      const formatted = formatHealthDisplayName('GPT-4o', {
        status: 'healthy',
        latencyMs: 120,
        checkedAt: Date.now(),
      });
      expect(formatted).toBe('🟢 • GPT-4o');
    });

    it('formats display names with ⭐ 🟢 for recently used healthy models', () => {
      const formatted = formatHealthDisplayName(
        'GPT-4o',
        {
          status: 'healthy',
          latencyMs: 120,
          checkedAt: Date.now(),
        },
        true,
      );
      expect(formatted).toBe('⭐ 🟢 • GPT-4o');
    });

    it('formats display names with 🟡 for slow models without brackets', () => {
      const formatted = formatHealthDisplayName('Local Llama', {
        status: 'slow',
        latencyMs: 1650,
        checkedAt: Date.now(),
      });
      expect(formatted).toBe('🟡 • Local Llama');
    });

    it('formats display names with 🟡 for cooldown models without brackets', () => {
      const formatted = formatHealthDisplayName('DeepSeek', {
        status: 'cooldown',
        checkedAt: Date.now(),
      });
      expect(formatted).toBe('🟡 • DeepSeek');
    });

    it('formats display names with 🔴 for unhealthy models without brackets', () => {
      const formatted = formatHealthDisplayName('Claude 3.5 Sonnet', {
        status: 'unhealthy',
        error: 'Auth Error',
        checkedAt: Date.now(),
      });
      expect(formatted).toBe('🔴 • Claude 3.5 Sonnet');
    });

    it('defaults to 🟢 if health result is not provided or undefined', () => {
      expect(formatHealthDisplayName('My Model', undefined)).toBe('🟢 • My Model');
    });
  });

  describe('Recent models tracking', () => {
    it('records and retrieves recently used models', () => {
      recordRecentModel('model-x');
      recordRecentModel('model-y');
      expect(isRecentModel('model-y')).toBe(true);
      expect(isRecentModel('model-x')).toBe(true);
      expect(isRecentModel('model-z')).toBe(false);
      expect(getRecentModels()[0]).toBe('model-y');
    });

    it('limits recent models to 3 and deduplicates on record', () => {
      for (let i = 1; i <= 7; i++) {
        recordRecentModel(`model-${i}`);
      }
      const recent = getRecentModels();
      expect(recent.length).toBe(3);
      expect(recent[0]).toBe('model-7');

      recordRecentModel('model-6');
      const updated = getRecentModels();
      expect(updated[0]).toBe('model-6');
      expect(updated.filter((m) => m === 'model-6').length).toBe(1);
    });

    it('sorts custom models so that recently used models appear first', () => {
      setCachedHealth('model-a', { status: 'healthy', latencyMs: 20, checkedAt: Date.now() });
      setCachedHealth('model-b', { status: 'healthy', latencyMs: 50, checkedAt: Date.now() });
      setCachedHealth('model-c', { status: 'unhealthy', error: 'Offline', checkedAt: Date.now() });
      recordRecentModel('model-b');

      const list = [{ name: 'model-a' }, { name: 'model-b' }, { name: 'model-c' }];
      const sorted = sortCustomModels(list);

      // model-b is recent (starred), so it comes first
      expect(sorted[0].name).toBe('model-b');
      // model-a is healthy non-recent, so it comes second
      expect(sorted[1].name).toBe('model-a');
      // model-c is unhealthy non-recent, so it comes last
      expect(sorted[2].name).toBe('model-c');
    });
  });

  describe('Live chat status updates', () => {
    it('recordModelSuccess records healthy status, latency, and marks model recent', () => {
      recordModelSuccess('custom-model-1', 145);
      const health = getCachedHealth('custom-model-1');
      expect(health).toBeDefined();
      expect(health?.status).toBe('healthy');
      expect(health?.latencyMs).toBe(145);
      expect(isRecentModel('custom-model-1')).toBe(true);
    });

    it('recordModelFailure records unhealthy status, cleans error message, and marks recent', () => {
      recordModelFailure('custom-model-2', 'Error: 401 Unauthorized request to upstream');
      const health = getCachedHealth('custom-model-2');
      expect(health).toBeDefined();
      expect(health?.status).toBe('unhealthy');
      expect(health?.error).toContain('401 Unauthorized');
      expect(isRecentModel('custom-model-2')).toBe(true);
    });

    it('recordModelFailure identifies 429 as cooldown', () => {
      recordModelFailure('custom-model-3', 'Rate limit exceeded 429');
      const health = getCachedHealth('custom-model-3');
      expect(health?.status).toBe('cooldown');
    });
  });

  describe('Cache persistence to disk', () => {
    it('saves and reloads health cache and recent models across restarts', () => {
      recordModelSuccess('model-a', 50);
      recordModelFailure('model-b', 'Timeout');

      // Verify file written
      const cacheFile = path.join(tempDir, 'model_health_cache.json');
      expect(fs.existsSync(cacheFile)).toBe(true);

      // Clear memory cache and reload
      clearHealthCache(false);
      expect(getCachedHealth('model-a')).toBeUndefined();
      expect(isRecentModel('model-a')).toBe(false);

      loadHealthCache(tempDir);
      const a = getCachedHealth('model-a');
      const b = getCachedHealth('model-b');

      expect(a?.status).toBe('healthy');
      expect(a?.latencyMs).toBe(50);
      expect(b?.status).toBe('unhealthy');
      expect(b?.error).toBe('Timeout');
      expect(isRecentModel('model-a')).toBe(true);
    });
  });

  describe('Smart health checking & endpoint deduplication', () => {
    it('deduplicates pings when multiple models share the same endpoint and credentials', async () => {
      let pingCount = 0;
      const server = http.createServer((req, res) => {
        pingCount++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const port = (server.address() as any).port;
      const testUrl = `http://127.0.0.1:${port}/v1`;

      const models: CustomModel[] = [
        {
          name: 'model-1',
          displayName: 'Model 1',
          description: '',
          provider: 'openai',
          apiUrl: testUrl,
          apiKey: 'key-abc',
          externalModelName: 'm1',
        },
        {
          name: 'model-2',
          displayName: 'Model 2',
          description: '',
          provider: 'openai',
          apiUrl: testUrl,
          apiKey: 'key-abc', // Same API key and URL -> should be deduplicated
          externalModelName: 'm2',
        },
        {
          name: 'model-3',
          displayName: 'Model 3',
          description: '',
          provider: 'openai',
          apiUrl: testUrl,
          apiKey: 'key-abc', // Same API key and URL -> should be deduplicated
          externalModelName: 'm3',
        },
      ];

      try {
        const resultMap = await checkAllModelsHealth(models, true);

        // Only 1 ping should have been made to the server despite 3 models
        expect(pingCount).toBe(1);

        // All 3 models should have health results recorded
        expect(resultMap.get('model-1')?.status).toBe('healthy');
        expect(resultMap.get('model-2')?.status).toBe('healthy');
        expect(resultMap.get('model-3')?.status).toBe('healthy');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('marks google-cloudcode models healthy if accounts exist without making network requests', async () => {
      const model: CustomModel = {
        name: 'google-model',
        displayName: 'Google Model',
        description: '',
        provider: 'google-cloudcode',
        apiUrl: 'http://localhost:9999',
        apiKey: '',
        externalModelName: 'gemini',
        googleAccounts: [{ id: 'acc1', email: 'test@example.com', enabled: true }] as any,
      };

      const result = await pingCustomModel(model);
      expect(result.status).toBe('healthy');
    });
  });

  describe('catalogDisplayNames integration', () => {
    it('applies health status and star formatting to catalog display names', () => {
      recordModelSuccess('custom-1', 40);
      recordRecentModel('custom-1');
      recordModelFailure('custom-2', 'Server Error');

      const models = [
        { name: 'custom-1', displayName: 'Claude 3.7' },
        { name: 'custom-2', displayName: 'DeepSeek R1' },
      ];

      const labels = catalogDisplayNames(models, {}, getCachedHealthMap(), getRecentModels());

      expect(labels.get('custom-1')).toBe('⭐ 🟢 • Claude 3.7');
      expect(labels.get('custom-2')).toBe('⭐ 🔴 • DeepSeek R1');
    });
  });
});
