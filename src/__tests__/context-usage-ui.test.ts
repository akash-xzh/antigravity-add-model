import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const preload = ts.transpileModule(readFileSync(resolve('src/contextUsagePreload.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const idA = 'aaaaaaaa-1111-2222-3333-444444444444';
const idB = 'bbbbbbbb-1111-2222-3333-444444444444';
const composer = '<div data-testid="agent-input-box"><textarea></textarea><button data-testid="model-selector-trigger">Exact model</button></div>';
const windows: JSDOM[] = [];
const settle = () => new Promise<void>((done) => setImmediate(done));
afterEach(() => {
  for (const dom of windows.splice(0)) {
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    dom.window.close();
  }
});
async function fixture(html = composer, route = `/c/${idA}`) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url: `https://app.example${route}`, runScripts: 'outside-only', pretendToBeVisual: true,
  });
  windows.push(dom);
  await new Promise<void>((done) => dom.window.addEventListener('DOMContentLoaded', () => done(), { once: true }));
  const requests: { payload: any; resolve: (value: any) => void }[] = [];
  const invoke = vi.fn((channel: string, payload?: unknown) => {
    if (channel === 'storage:get-custom-models') return Promise.resolve([]);
    if (channel === 'storage:get-chat-context-usage') return new Promise((resolve) => requests.push({ payload, resolve }));
    throw new Error(`Unexpected IPC ${channel}`);
  });
  Object.assign(dom.getInternalVMContext(), {
    exports: {}, require: (name: string) => {
      if (name !== 'electron') throw new Error(`Sandbox dependency ${name}`);
      return { ipcRenderer: { invoke } };
    },
  });
  runInContext(preload, dom.getInternalVMContext());
  dom.window.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  await settle();
  return { dom, requests, invoke, ring: () => dom.window.document.querySelector<HTMLButtonElement>('[data-agy-context-ring]')! };
}
describe('reactive context ring', () => {
  it('mounts after native renderer hydration and identifies estimates honestly', async () => {
    const f = await fixture('');
    expect(f.ring()).toBeNull();
    f.dom.window.document.body.innerHTML = composer;
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    f.requests[0].resolve({ conversationId: idA, source: 'estimated', currentTokens: 1234, maxTokens: 85000, limitSource: 'configured' });
    await settle();
    expect(f.ring().title).toContain('Visible transcript estimate: ~1,234 tokens');
    expect(f.ring().title).toContain('85,000 context limit (configured)');
    expect(f.ring().title).toContain('actual usage can be higher');
    expect(f.ring().textContent).toBe('~1.2K / 85.0K');
  });

  it('uses the page-world conversation attribute instead of a stale single-composer route', async () => {
    const html = `<div data-agy-conversation-id="${idB}">` + composer + '</div>';
    const f = await fixture(html, `/c/${idA}`);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].payload.conversationId).toBe(idB);
  });

  it('discards an old chat response and immediately requests the queued new chat', async () => {
    const f = await fixture();
    expect(f.requests).toHaveLength(1);
    f.dom.window.history.pushState({}, '', `/c/${idB}`);
    f.dom.window.dispatchEvent(new f.dom.window.PopStateEvent('popstate'));
    expect(f.requests).toHaveLength(1);
    f.requests[0].resolve({ conversationId: idA, source: 'estimated', currentTokens: 110000 });
    await settle();
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1].payload.conversationId).toBe(idB);
    expect(f.ring().title).not.toContain('110,000');
    f.requests[1].resolve({ conversationId: idB, source: 'estimated', currentTokens: 200 });
    await settle();
    expect(f.ring().title).toContain('~200 tokens');
  });

  it('rejects an old model limit when switching models during a request', async () => {
    const f = await fixture();
    f.dom.window.document.querySelector('[data-testid="model-selector-trigger"]')!.textContent = 'Different model';
    f.dom.window.dispatchEvent(new f.dom.window.Event('focus'));
    f.requests[0].resolve({ conversationId: idA, source: 'estimated', currentTokens: 500, maxTokens: 999999 });
    await settle();
    expect(f.requests[1].payload.modelName).toBe('Different model');
    expect(f.ring().title).not.toContain('999,999');
    f.requests[1].resolve({ conversationId: idA, source: 'estimated', currentTokens: 500, maxTokens: 42000, limitSource: 'configured' });
    await settle();
    expect(f.ring().title).toContain('42,000');
  });

  it('never treats arbitrary React UUIDs or last-used storage as the open conversation', async () => {
    const f = await fixture(composer, '/');
    const box = f.dom.window.document.querySelector('[data-testid="agent-input-box"]') as any;
    box.__reactFiberFixture = { memoizedProps: { toolId: idA, item: { id: idB } } };
    f.dom.window.localStorage.setItem(`antigravity-multi-conversation-layout-v3-${idA}`, idA);
    f.dom.window.dispatchEvent(new f.dom.window.Event('focus'));
    await settle();
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].payload.conversationId).toBeUndefined();
    expect(f.ring().title).toContain('could not be identified');
    f.requests[0].resolve({ conversationId: '', source: 'unavailable' });
    await settle();
    // The focus refresh was queued behind the initial request.
    f.requests.at(-1)!.resolve({ conversationId: '', source: 'unavailable' });
    await settle();
    f.ring().click();
    expect(f.requests.at(-1)!.payload).toMatchObject({ modelName: 'Exact model', discoverLimit: true });
    expect(f.requests.every((request) => request.payload.conversationId === undefined)).toBe(true);
  });

  it('uses named native composer conversation properties in multiple panes', async () => {
    const f = await fixture(composer + composer, '/');
    const boxes = [...f.dom.window.document.querySelectorAll('[data-testid="agent-input-box"]')] as any[];
    boxes[0].setAttribute('data-agy-conversation-id', idA);
    boxes[1].setAttribute('data-agy-conversation-id', idB);
    f.dom.window.dispatchEvent(new f.dom.window.Event('focus'));
    f.requests[0].resolve({ conversationId: '', source: 'unavailable' });
    f.requests[1].resolve({ conversationId: '', source: 'unavailable' });
    await settle();
    expect(f.requests.slice(2).map((request) => request.payload.conversationId)).toEqual([idA, idB]);
    f.dom.window.dispatchEvent(new f.dom.window.Event('pagehide'));
    expect(f.dom.window.document.querySelector('[data-agy-context-ring]')).toBeNull();
  });

  it('locates the actual 2.23 Lexical composer and its sibling model toolbar after hydration', async () => {
    const f = await fixture('');
    f.dom.window.document.body.innerHTML = '<main><section><div class="relative w-full">' +
      '<div role="combobox" contenteditable="true" aria-label="Message input" data-lexical-editor="true"></div></div>' +
      '<div class="toolbar"><button data-testid="model-selector-trigger" aria-label="Select model, current: Exact model">' +
      '<span>Exact model</span></button></div></section></main>';
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    expect(f.requests[0].payload).toMatchObject({ conversationId: idA, modelName: 'Exact model' });
    expect(f.ring().previousElementSibling?.getAttribute('data-testid')).toBe('model-selector-trigger');
    expect(f.ring().style.flex).toBe('0 0 auto');
  });

  it('creates one inline ring when native 2.23 marks both the editor and model toolbar no-focus-agent-input', async () => {
    const native = '<main><div class="no-focus-agent-input"><div data-testid="agent-input-box">' +
      '<div class="relative w-full"><div role="combobox" contenteditable="true" aria-label="Message input" data-lexical-editor="true"></div></div>' +
      '<div class="min-w-0 no-focus-agent-input"><div class="min-w-0">' +
      '<button data-testid="model-selector-trigger" aria-label="Select model, current: Exact model" class="flex"><span>Exact model</span></button>' +
      '</div></div></div></div></main>';
    const f = await fixture(native);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].payload.conversationId).toBe(idA);
    expect(f.dom.window.document.querySelectorAll('[data-agy-context-ring]')).toHaveLength(1);
    expect(f.ring().parentElement?.hasAttribute('data-agy-context-toolbar')).toBe(true);
    expect(f.dom.window.getComputedStyle(f.ring().parentElement!).display).toBe('inline-flex');
    expect(f.dom.window.getComputedStyle(f.ring().parentElement!).alignItems).toBe('center');
    const input = f.dom.window.document.querySelector('[role="combobox"]') as any;
    input.setAttribute('data-agy-conversation-id', idB);
    f.dom.window.dispatchEvent(new f.dom.window.Event('focus'));
    f.requests[0].resolve({ conversationId: idA, source: 'estimated', currentTokens: 100 });
    await settle();
    expect(f.requests.at(-1)!.payload.conversationId).toBe(idB);
    expect(f.dom.window.document.querySelectorAll('[data-agy-context-ring]')).toHaveLength(1);
  });

  it('does not resurrect an old ring after a composer hides and remounts while IPC is pending', async () => {
    const f = await fixture();
    const box = f.dom.window.document.querySelector<HTMLElement>('[data-testid="agent-input-box"]')!;
    box.hidden = true;
    f.dom.window.dispatchEvent(new f.dom.window.Event('focus'));
    expect(f.ring()).toBeNull();
    box.hidden = false;
    f.dom.window.dispatchEvent(new f.dom.window.Event('focus'));
    expect(f.requests).toHaveLength(2);
    f.requests[1].resolve({ conversationId: idA, source: 'estimated', currentTokens: 200 });
    await settle();
    f.requests[0].resolve({ conversationId: idA, source: 'estimated', currentTokens: 90000 });
    await settle();
    expect(f.dom.window.document.querySelectorAll('[data-agy-context-ring]')).toHaveLength(1);
    expect(f.ring().title).toContain('~200 tokens');
    expect(f.ring().title).not.toContain('90,000');
  });

  it('shows real usage, overhead, compaction countdown and cache hits in the popover', async () => {
    const f = await fixture();
    expect(f.requests).toHaveLength(1);
    f.requests[0].resolve({
      conversationId: idA,
      source: 'actual',
      actualTokens: 94466,
      actualInputTokens: 4042,
      actualCachedTokens: 90424,
      actualOutputTokens: 440,
      currentTokens: 4042,
      overheadTokens: 90424,
      sessionInputTokens: 1200000,
      sessionCachedTokens: 84000,
      sessionOutputTokens: 41338,
      turns: 18,
      compactions: 2,
      turnsUntilCompaction: 6,
      maxTokens: 200000,
      limitSource: 'configured',
      compactionThresholdPercent: 80,
      compactionAtTokens: 160000,
      tokensUntilCompaction: 65534,
    });
    await settle();
    expect(f.ring().textContent).toBe('94.5K / 200K');
    expect(f.ring().dataset.agyContextSource).toBe('actual');
    expect(f.ring().title).toContain('Actual context: 94,466 tokens');
    expect(f.ring().title).toContain('90,424 tokens for system prompt, tools and images');
    f.ring().dispatchEvent(new f.dom.window.Event('pointerenter'));
    const pop = f.dom.window.document.querySelector('.agy-ctx-popover');
    expect(pop?.textContent).toContain('94,466 / 200,000 (47.2%)');
    expect(pop?.textContent).toContain('Auto-compact (80%)');
    expect(pop?.textContent).toContain('65.5K left · ~6 turns');
    expect(pop?.textContent).toContain('Tools, files & system90.4K');
    expect(pop?.textContent).toContain('90.4K cached (96%)');
    expect(pop?.textContent).toContain('1.3M in · 41.3K out');
    expect(pop?.textContent).not.toContain('Real provider usage');
    f.ring().dispatchEvent(new f.dom.window.Event('pointerleave'));
    expect(f.dom.window.document.querySelector('.agy-ctx-popover')).toBeNull();
  });

  it('labels the IDE-managed checkpoint default instead of a window percentage', async () => {
    const f = await fixture();
    f.requests[0].resolve({
      conversationId: idA, source: 'actual', actualTokens: 94466, currentTokens: 4042,
      actualInputTokens: 4042, actualCachedTokens: 90424, actualOutputTokens: 440,
      maxTokens: 1000000, limitSource: 'native-catalog', compactionSource: 'ide',
    });
    await settle();
    f.ring().dispatchEvent(new f.dom.window.Event('pointerenter'));
    const pop = f.dom.window.document.querySelector('.agy-ctx-popover');
    expect(pop?.textContent).toContain('Auto-compactAutomatic (Antigravity)');
    expect(pop?.textContent).not.toContain('Auto-compact (');
    f.ring().dispatchEvent(new f.dom.window.Event('pointerleave'));
  });

  it('shows the measured generation speed beside the pill and in the popover', async () => {
    const f = await fixture();
    f.requests[0].resolve({
      conversationId: idA,
      source: 'actual',
      actualTokens: 94466,
      actualInputTokens: 4042,
      actualCachedTokens: 90424,
      actualOutputTokens: 440,
      currentTokens: 4042,
      overheadTokens: 90424,
      maxTokens: 1000000,
      limitSource: 'native-catalog',
      tokensPerSecond: 47.8,
      ttftMs: 1200,
    });
    await settle();
    expect(f.ring().textContent).toBe('94.5K / 1.0M · 48 t/s');
    expect(f.ring().title).toContain('model catalog');
    expect(f.ring().title).toContain('last generation 48 t/s (first token 1.20s)');
    f.ring().dispatchEvent(new f.dom.window.Event('pointerenter'));
    const pop = f.dom.window.document.querySelector('.agy-ctx-popover');
    expect(pop?.textContent).toContain('Speed48 t/s · 1.20s TTFT');
    f.ring().dispatchEvent(new f.dom.window.Event('pointerleave'));
    expect(f.dom.window.document.querySelector('.agy-ctx-popover')).toBeNull();
  });

  it('shows unclamped overflow percentages while clamping the bar width and refreshes an open popover in place', async () => {
    const f = await fixture();
    // Open popover before usage resolves, then verify live in-place refresh.
    f.ring().dispatchEvent(new f.dom.window.Event('pointerenter'));
    const pop = f.dom.window.document.querySelector('.agy-ctx-popover');
    expect(pop?.textContent).toContain('Unavailable');
    f.requests[0].resolve({
      conversationId: idA,
      source: 'actual',
      actualTokens: 500_000,
      actualInputTokens: 50_000,
      actualCachedTokens: 450_000,
      actualOutputTokens: 400,
      currentTokens: 50_000,
      overheadTokens: 450_000,
      maxTokens: 200_000,
      limitSource: 'configured',
    });
    await settle();
    expect(f.dom.window.document.querySelector('.agy-ctx-popover')).toBe(pop);
    expect(pop?.textContent).toContain('500,000 / 200,000 (250.0%)');
    const fill = pop?.querySelector<HTMLElement>('.agy-ctx-pop-fill');
    expect(fill?.style.width).toMatch(/^100(\.0)?%$/);
    f.ring().dispatchEvent(new f.dom.window.Event('pointerleave'));
  });
});
