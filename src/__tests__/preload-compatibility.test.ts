import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const preload = ts.transpileModule(readFileSync(path.resolve('src/customPreload.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const modelsUrl = 'http://localhost:50999/fetchAvailableModels';

function createFixture(response: Response) {
  let onDomLoaded = () => {};
  const exposeInMainWorld = vi.fn();
  const vendorStorage = Object.freeze({ getItems: vi.fn(), updateItems: vi.fn() });
  const nativeFetch = vi.fn().mockResolvedValue(response);
  const nativeOpen = vi.fn();
  const nativeSend = vi.fn();
  class TestXHR {
    readyState = 0;
    status = 0;
    responseType = '';
    responseText = '{"models":{"existing":{"displayName":"Existing"}}}';
    response: unknown = this.responseText;
    onreadystatechange: ((event: Event) => unknown) | null = null;
    onload: (() => void) | null = null;
    open(...args: unknown[]) {
      nativeOpen(...args);
    }
    send(...args: unknown[]) {
      nativeSend(...args);
    }
    complete() {
      this.readyState = 4;
      this.status = 200;
      const result = this.onreadystatechange?.(new Event('readystatechange'));
      this.onload?.();
      return result;
    }
  }
  const originalXhrOpen = TestXHR.prototype.open;
  const originalXhrSend = TestXHR.prototype.send;
  const window = {
    location: { href: 'http://localhost:54321/', pathname: '/', hash: '' },
    nativeStorage: vendorStorage,
    fetch: nativeFetch as typeof fetch,
    addEventListener: (name: string, callback: () => void) => {
      if (name === 'DOMContentLoaded') onDomLoaded = callback;
    },
  };
  runInNewContext(preload, {
    exports: {},
    require: (id: string) => {
      if (id !== 'electron') throw new Error(`Unexpected preload dependency: ${id}`);
      return { contextBridge: { exposeInMainWorld }, ipcRenderer: { invoke: vi.fn() }, webFrame: {} };
    },
    window,
    document: { querySelectorAll: () => [], getElementById: () => null },
    location: window.location,
    setInterval: vi.fn(),
    XMLHttpRequest: TestXHR,
    URL,
    Request,
    Response,
    console,
  });
  onDomLoaded();
  return { window, nativeFetch, TestXHR, nativeOpen, nativeSend, exposeInMainWorld, vendorStorage, originalXhrOpen, originalXhrSend };
}

// contextIsolation keeps preload scripts in a separate V8 world: patches to
// window.fetch / XMLHttpRequest never see renderer traffic. Model injection is
// performed by the proxy's /_ui/main.js MITM instead. These tests pin the
// pass-through behaviour so a future change cannot reintroduce dead patching.
describe('preload model-response compatibility', () => {
  it('runs with Electron alone and preserves APIs exposed by the vendor preload', () => {
    const fixture = createFixture(new Response());
    expect(fixture.exposeInMainWorld).not.toHaveBeenCalled();
    expect(fixture.window.nativeStorage).toBe(fixture.vendorStorage);
    expect(Object.keys(fixture.window.nativeStorage)).toEqual(['getItems', 'updateItems']);
  });

  it('does not monkey-patch fetch or XMLHttpRequest from the isolated preload world', () => {
    const fixture = createFixture(new Response());
    expect(fixture.window.fetch).toBe(fixture.nativeFetch);
    expect(fixture.TestXHR.prototype.open).toBe(fixture.originalXhrOpen);
    expect(fixture.TestXHR.prototype.send).toBe(fixture.originalXhrSend);
  });

  it.each(['string', 'URL', 'Request'])('passes %s fetch inputs through untouched', async (kind) => {
    const original = new Response('{"models":{"existing":{"displayName":"Existing"}}}', {
      headers: { 'content-type': 'Application/JSON; charset=utf-8' },
    });
    const fixture = createFixture(original);
    const input = kind === 'URL' ? new URL(modelsUrl) : kind === 'Request' ? new Request(modelsUrl) : modelsUrl;
    const result = await fixture.window.fetch(input);
    expect(result).toBe(original);
    expect(fixture.nativeFetch).toHaveBeenCalledWith(input);
    expect(original.bodyUsed).toBe(false);
  });

  it('preserves the fetch rejection when the request fails', async () => {
    const fixture = createFixture(new Response());
    const failure = new TypeError('Network request failed');
    fixture.nativeFetch.mockRejectedValue(failure);
    await expect(fixture.window.fetch(new URL(modelsUrl))).rejects.toBe(failure);
  });

  it('leaves protocol framed RPC responses unread', async () => {
    for (const url of [
      'http://localhost:54321/exa.language_server_pb.LanguageServerService/GetAvailableModels',
      'http://localhost:54321/LanguageServerService/GetAvailableModels',
    ]) {
      const original = new Response('\0\0\0\0\x02{}', { headers: { 'content-type': 'application/json' } });
      const clone = vi.spyOn(original, 'clone');
      const fixture = createFixture(original);
      expect(await fixture.window.fetch(url)).toBe(original);
      expect(clone).not.toHaveBeenCalled();
      expect(original.bodyUsed).toBe(false);
    }
  });

  it('passes XHR open/send through in both async and synchronous modes', () => {
    const fixture = createFixture(new Response());
    const xhr = new fixture.TestXHR();
    const onReady = vi.fn();
    xhr.onreadystatechange = onReady;
    xhr.open('GET', modelsUrl);
    expect(fixture.nativeOpen).toHaveBeenLastCalledWith('GET', modelsUrl);
    xhr.send();
    expect(fixture.nativeSend).toHaveBeenCalledOnce();
    xhr.complete();
    expect(onReady).toHaveBeenCalledOnce();
    expect(xhr.responseText).toBe('{"models":{"existing":{"displayName":"Existing"}}}');
    xhr.open('GET', modelsUrl, false);
    expect(fixture.nativeOpen).toHaveBeenLastCalledWith('GET', modelsUrl, false);
  });

  it('does not read unsupported XHR responses and preserves native event order', () => {
    const fixture = createFixture(new Response());
    const xhr = new fixture.TestXHR();
    Object.assign(xhr, { contentType: 'application/connect+json', responseType: 'arraybuffer' });
    const readText = vi.fn(() => {
      throw new Error('Unsupported responseText access');
    });
    Object.defineProperty(xhr, 'responseText', { get: readText });
    const events: string[] = [];
    xhr.onreadystatechange = () => { events.push('readystatechange'); };
    xhr.onload = () => { events.push('load'); };
    xhr.open('GET', modelsUrl);
    xhr.send();
    expect(xhr.complete()).toBeUndefined();
    expect(events).toHaveLength(2);
    expect(events).toEqual(['readystatechange', 'load']);
    expect(readText).not.toHaveBeenCalled();
  });
});
