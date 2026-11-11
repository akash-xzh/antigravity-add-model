import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import * as http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { CustomModel } from '../proxy';
import {
  captureSystemPrompt,
  globalSystemPrompt,
  injectGlobalSystemPrompt,
  withGlobalSystemPrompt,
} from '../proxy/globalPrompt';
import { runCustomModelRequest } from '../proxy/customRequest';
import { stopCleanupInterval } from '../proxy/shared';

vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const dirs: string[] = [];
function promptFile(text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-global-prompt-'));
  dirs.push(dir);
  const file = path.join(dir, 'global-system-prompt.txt');
  if (text) fs.writeFileSync(file, text);
  return file;
}

const previous = process.env.ANTIGRAVITY_GLOBAL_PROMPT;
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  if (previous === undefined) delete process.env.ANTIGRAVITY_GLOBAL_PROMPT;
  else process.env.ANTIGRAVITY_GLOBAL_PROMPT = previous;
  delete process.env.ANTIGRAVITY_CAPTURE_SYSTEM_PROMPT;
  delete process.env.ANTIGRAVITY_GLOBAL_PROMPT_MODE;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
afterAll(stopCleanupInterval);

describe('global system prompt', () => {
  it('reads the operator file, and returns empty text when it is absent', () => {
    process.env.ANTIGRAVITY_GLOBAL_PROMPT = promptFile('  Be terse.  ');
    expect(globalSystemPrompt()).toBe('Be terse.');
    process.env.ANTIGRAVITY_GLOBAL_PROMPT = promptFile('');
    expect(globalSystemPrompt()).toBe('');
  });

  it('ignores the home-default file under test unless a path is configured', () => {
    delete process.env.ANTIGRAVITY_GLOBAL_PROMPT;
    expect(process.env.VITEST).toBeDefined();
    expect(globalSystemPrompt()).toBe('');
  });

  it('keeps the IDE instruction first and appends the global text after it', () => {
    process.env.ANTIGRAVITY_GLOBAL_PROMPT = promptFile('GLOBAL_RULES');
    const body = { systemInstruction: { parts: [{ text: 'IDE_RULES' }] }, contents: [] };
    expect(withGlobalSystemPrompt(body).systemInstruction).toEqual({
      parts: [{ text: 'IDE_RULES' }, { text: 'GLOBAL_RULES' }],
    });
    expect(body.systemInstruction.parts).toHaveLength(1);
  });

  it('creates the instruction when the IDE sent none', () => {
    process.env.ANTIGRAVITY_GLOBAL_PROMPT = promptFile('GLOBAL_RULES');
    expect(withGlobalSystemPrompt({ contents: [] }).systemInstruction).toEqual({ parts: [{ text: 'GLOBAL_RULES' }] });
  });

  it('injects inside the Cloud Code request envelope and leaves non-JSON untouched', () => {
    process.env.ANTIGRAVITY_GLOBAL_PROMPT = promptFile('GLOBAL_RULES');
    const envelope = { model: 'x', request: { systemInstruction: { parts: [{ text: 'IDE_RULES' }] }, contents: [] } };
    const injected = JSON.parse(injectGlobalSystemPrompt(Buffer.from(JSON.stringify(envelope))).toString('utf8'));
    expect(injected.model).toBe('x');
    expect(injected.request.systemInstruction.parts).toEqual([{ text: 'IDE_RULES' }, { text: 'GLOBAL_RULES' }]);

    const raw = Buffer.from('not json');
    expect(injectGlobalSystemPrompt(raw)).toBe(raw);
  });

  it('returns the original buffer when no prompt file exists', () => {
    process.env.ANTIGRAVITY_GLOBAL_PROMPT = promptFile('');
    const raw = Buffer.from(JSON.stringify({ request: { contents: [] } }));
    expect(injectGlobalSystemPrompt(raw)).toBe(raw);
  });

  it('replaces the whole instruction in replace mode, and appends by default', () => {
    process.env.ANTIGRAVITY_GLOBAL_PROMPT = promptFile('GLOBAL_RULES');
    const body = { systemInstruction: { parts: [{ text: 'IDE_RULES' }] }, contents: [] };

    process.env.ANTIGRAVITY_GLOBAL_PROMPT_MODE = 'replace';
    expect(withGlobalSystemPrompt(body).systemInstruction).toEqual({ parts: [{ text: 'GLOBAL_RULES' }] });

    process.env.ANTIGRAVITY_GLOBAL_PROMPT_MODE = 'append';
    expect(withGlobalSystemPrompt(body).systemInstruction).toEqual({
      parts: [{ text: 'IDE_RULES' }, { text: 'GLOBAL_RULES' }],
    });

    delete process.env.ANTIGRAVITY_GLOBAL_PROMPT_MODE;
    expect(withGlobalSystemPrompt(body).systemInstruction.parts).toHaveLength(2);
  });

  it('captures to the data directory for the "1" shorthand', () => {
    const home = promptFile('GLOBAL');
    process.env.ANTIGRAVITY_GLOBAL_PROMPT = home;
    process.env.ANTIGRAVITY_CAPTURE_SYSTEM_PROMPT = '1';
    captureSystemPrompt({ contents: [] });
    const captured = path.join(path.dirname(home), 'captured-request.json');
    expect(fs.readFileSync(captured, 'utf8')).toContain('contents');
    fs.rmSync(captured);
  });

  it('captures the whole request body once without replacing an existing file', () => {
    const target = path.join(path.dirname(promptFile('')), 'captured.json');
    process.env.ANTIGRAVITY_CAPTURE_SYSTEM_PROMPT = target;
    captureSystemPrompt({ systemInstruction: { parts: [{ text: 'IDE_RULES' }] }, contents: [] });
    expect(fs.readFileSync(target, 'utf8')).toContain('IDE_RULES');
    captureSystemPrompt({ systemInstruction: { parts: [{ text: 'REPLACEMENT' }] }, contents: [] });
    expect(fs.readFileSync(target, 'utf8')).not.toContain('REPLACEMENT');
  });

  it('sends the global prompt to the provider after the IDE instruction and before the model prompt', async () => {
    process.env.ANTIGRAVITY_GLOBAL_PROMPT = promptFile('GLOBAL_RULES');
    const captured: Record<string, unknown>[] = [];
    const upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        captured.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
      });
    });
    servers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const model: CustomModel = {
      name: 'models/test',
      displayName: 'test',
      description: '',
      provider: 'openai',
      apiKey: 'test-only-key',
      apiUrl: url,
      externalModelName: 'test-model',
      maxRetries: 0,
      systemPrompt: 'MODEL_RULES',
    };
    const proxy = http.createServer((_req, res) => {
      void runCustomModelRequest(
        res,
        model,
        {
          systemInstruction: { parts: [{ text: 'IDE_RULES' }] },
          contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        },
        false,
        [model],
        false,
      );
    });
    servers.push(proxy);
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}`);
    expect(response.status).toBe(200);

    const system = (captured[0].messages as { role: string; content: string }[])[0];
    expect(system.role).toBe('system');
    expect(system.content.indexOf('IDE_RULES')).toBeLessThan(system.content.indexOf('GLOBAL_RULES'));
    expect(system.content.indexOf('GLOBAL_RULES')).toBeLessThan(system.content.indexOf('MODEL_RULES'));
  });
});
