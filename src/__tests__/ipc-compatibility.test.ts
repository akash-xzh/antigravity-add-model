import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createModelManager } from '../modelManagement';
import { createModelActions } from '../modelActions';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const fixtureHomes: string[] = [];
afterEach(() => {
  for (const home of fixtureHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

type Handler = (...args: unknown[]) => unknown;
type State = { type: string; update?: { version: string } };

// Execute the production CommonJS modules with an explicit Electron boundary.
// No app, updater, shell or network operation runs here; model files use isolated temporary homes.
const compiled = new Map(
  ['updater', 'ipcHandlers', 'customIpc', 'customScheme', 'preload', 'customPreload', 'contextUsagePreload'].map((name) => [
    name,
    ts.transpileModule(readFileSync(path.resolve('src', `${name}.ts`), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    }).outputText,
  ]),
);

function loadModule(name: string, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const module = { exports: {} as Record<string, Handler> };
  runInNewContext(compiled.get(name)!, {
    module,
    exports: module.exports,
    require: (id: string) => {
      if (!Object.hasOwn(dependencies, id)) throw new Error(`Unexpected dependency: ${id}`);
      return dependencies[id];
    },
    process,
    console,
    URL,
    ...globals,
  });
  return module.exports;
}

function createFixture(customOnly = false) {
  const handlers = new Map<string, Handler>();
  const listeners = new Map<string, Set<Handler>>();
  const exposed: Record<string, Record<string, Handler>> = {};
  const stat = vi.fn();
  const homePath = mkdtempSync(path.join(tmpdir(), 'antigravity-ipc-'));
  fixtureHomes.push(homePath);
  let savedModels = '{"models":[]}';
  const readFile = vi.fn(async () => savedModels);
  const writeFile = vi.fn(async (_filename: string, contents: string) => {
    savedModels = contents;
  });
  const mkdir = vi.fn();
  const showOpenDialog = vi.fn();
  const showItemInFolder = vi.fn();
  const openExternal = vi.fn().mockResolvedValue(undefined);
  const extensionAuthorities = new Map<string, string>();
  let responseStatus = 200;
  const request = vi.fn((_options: unknown, onResponse: (response: unknown) => void) => ({
    setTimeout: vi.fn(),
    on: vi.fn(),
    end: () => onResponse({ statusCode: responseStatus, resume: vi.fn() }),
  }));
  const idePath = path.resolve('fixture', 'Antigravity IDE');
  const send = vi.fn((channel: string, ...args: unknown[]) => {
    for (const callback of listeners.get(channel) || []) callback({}, ...args);
  });
  const electron = {
    app: { isPackaged: false, getPath: () => homePath },
    BrowserWindow: { getAllWindows: () => [{ webContents: { send } }] },
    dialog: { showOpenDialog },
    shell: { showItemInFolder, openExternal },
    ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
    ipcRenderer: {
      invoke: async (channel: string, ...args: unknown[]) => {
        const handler = handlers.get(channel);
        if (!handler) throw new Error(`No handler registered for ${channel}`);
        return handler({}, ...args);
      },
      on: (channel: string, callback: Handler) => {
        if (!listeners.has(channel)) listeners.set(channel, new Set());
        listeners.get(channel)!.add(callback);
      },
      removeListener: (channel: string, callback: Handler) => listeners.get(channel)?.delete(callback),
    },
    contextBridge: {
      exposeInMainWorld: (name: string, api: Record<string, Handler>) => {
        exposed[name] = api;
      },
    },
    webFrame: {},
  };
  const dependencies = {
    electron,
    path,
    'node:path': path,
    './modelManagement': { createModelManager },
    './modelActions': { createModelActions },
    child_process: {},
    'electron-updater': { autoUpdater: {} },
    'electron-log/main': {},
    'fs/promises': { stat, readFile, writeFile, mkdir },
    http: { request },
    https: { request },
    './cryptoStore': {
      encryptString: (value: string) => `encrypted:${value}`,
      decryptString: (value: string) => value.replace(/^encrypted:/, ''),
    },
    './customScheme': { extensionAuthorities },
    './tray': {},
    './ideInstall/constants': { getIdeInstallPath: () => idePath },
  };
  const updater = loadModule('updater', dependencies);
  const customIpc = loadModule('customIpc', dependencies);
  if (customOnly) {
    customIpc.registerCustomModelHandlers();
  } else {
    const ipc = loadModule('ipcHandlers', { ...dependencies, './updater': updater, './customIpc': customIpc });
    ipc.registerIpcHandlers({});
  }
  const globals = { window: { addEventListener: vi.fn() } };
  const customPreload = loadModule('customPreload', dependencies, globals);
  const contextUsagePreload = loadModule('contextUsagePreload', dependencies, globals);
  if (!customOnly) loadModule('preload', { ...dependencies, './customPreload': customPreload, './contextUsagePreload': contextUsagePreload }, globals);
  return {
    handlers,
    invoke: electron.ipcRenderer.invoke,
    readFile,
    writeFile,
    mkdir,
    homePath,
    exposed,
    updater,
    stat,
    showOpenDialog,
    showItemInFolder,
    openExternal,
    extensionAuthorities,
    idePath,
    send,
    request,
    setResponseStatus: (status: number) => {
      responseStatus = status;
    },
  };
}

describe('renderer compatibility IPC contracts', () => {
  let fixture: ReturnType<typeof createFixture>;
  beforeEach(() => {
    fixture = createFixture();
  });

  it('resolves the renderer startup state before an updater event has occurred', async () => {
    await expect(fixture.exposed.electronUpdater.getState()).resolves.toEqual({ type: 'idle' });
  });

  it('recovers missed updater events and returns independent state snapshots', async () => {
    const state = { type: 'ready', update: { version: '2.12.2' } };
    fixture.updater.broadcastState(state);
    state.update.version = 'mutated input';
    const snapshot = (await fixture.exposed.electronUpdater.getState()) as State;
    expect(snapshot).toEqual({ type: 'ready', update: { version: '2.12.2' } });
    snapshot.update!.version = 'mutated snapshot';
    await expect(fixture.exposed.electronUpdater.getState()).resolves.toEqual({
      type: 'ready',
      update: { version: '2.12.2' },
    });
  });

  it('preserves subscriptions, unsubscribe, and the existing apply API', async () => {
    const changed = vi.fn();
    const unsubscribe = fixture.exposed.electronUpdater.onStateChanged(changed) as () => void;
    await fixture.exposed.electronUpdater.applyUpdate();
    expect(changed).toHaveBeenCalledWith({ type: 'ready' });
    await expect(fixture.exposed.electronUpdater.getState()).resolves.toEqual({ type: 'ready' });
    unsubscribe();
    fixture.updater.broadcastState({ type: 'idle' });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('returns all selected workspaces while preserving the singular API', async () => {
    const folders = [path.resolve('first folder'), path.resolve('second folder')];
    fixture.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: folders });
    await expect(fixture.exposed.dialog.showOpenMultipleFolderDialog()).resolves.toEqual(folders);
    expect(fixture.showOpenDialog).toHaveBeenLastCalledWith({
      properties: ['openDirectory', 'createDirectory', 'multiSelections'],
      title: 'Open workspaces',
    });
    await expect(fixture.exposed.dialog.showOpenDialog()).resolves.toBe(folders[0]);
    expect(fixture.showOpenDialog.mock.lastCall![0].properties).not.toContain('multiSelections');
  });

  it.each([
    { canceled: true, filePaths: [path.resolve('ignored')] },
    { canceled: false, filePaths: [] },
  ])('returns undefined for a canceled or empty folder selection: %j', async (result) => {
    fixture.showOpenDialog.mockResolvedValue(result);
    await expect(fixture.exposed.dialog.showOpenMultipleFolderDialog()).resolves.toBeUndefined();
  });

  it('reveals an existing absolute path without executing a command', async () => {
    const filename = path.resolve('fixture', 'folder with spaces', 'report.txt');
    fixture.stat.mockResolvedValue({ isDirectory: () => false });
    await expect(fixture.exposed.electronNative.revealInFilePicker(filename)).resolves.toBeUndefined();
    expect(fixture.stat).toHaveBeenCalledWith(filename);
    expect(fixture.showItemInFolder).toHaveBeenCalledWith(filename);
  });

  it.each(['', '   ', 'relative/path', 'https://example.com/file', `bad\0path`, null, 42])(
    'rejects an invalid reveal argument before accessing the filesystem: %j',
    async (filename) => {
      await expect(fixture.exposed.electronNative.revealInFilePicker(filename)).rejects.toThrow(
        'absolute filesystem path',
      );
      expect(fixture.stat).not.toHaveBeenCalled();
      expect(fixture.showItemInFolder).not.toHaveBeenCalled();
    },
  );

  it('does not reveal a missing file', async () => {
    fixture.stat.mockRejectedValue(Object.assign(new Error('File not found'), { code: 'ENOENT' }));
    await expect(fixture.exposed.electronNative.revealInFilePicker(path.resolve('missing'))).rejects.toThrow(
      'File not found',
    );
    expect(fixture.showItemInFolder).not.toHaveBeenCalled();
  });

  it('reports an existing IDE installation directory', async () => {
    fixture.stat.mockResolvedValue({ isDirectory: () => true });
    await expect(fixture.exposed.ide.isInstalled()).resolves.toBe(true);
    expect(fixture.stat).toHaveBeenCalledWith(fixture.idePath);
  });

  it('does not mistake a file for an IDE installation', async () => {
    fixture.stat.mockResolvedValue({ isDirectory: () => false });
    await expect(fixture.exposed.ide.isInstalled()).resolves.toBe(false);
  });

  it.each(['ENOENT', 'EACCES'])('keeps startup working when IDE lookup returns %s', async (code) => {
    fixture.stat.mockRejectedValue(Object.assign(new Error(code), { code }));
    await expect(fixture.exposed.ide.isInstalled()).resolves.toBe(false);
  });

  // Provider HTTP status/body/credential behavior is exercised against real local
  // servers in model-management.test.ts.
});

describe('standalone custom model addon', () => {
  it('registers only addon storage channels and exposes no replacement renderer APIs', () => {
    const fixture = createFixture(true);
    expect([...fixture.handlers.keys()]).toEqual([
      'storage:get-custom-models',
      'storage:save-custom-model',
      'storage:delete-custom-model',
      'storage:test-model-connection',
      'storage:test-model-generation',
      'storage:create-effort-variants',
      'storage:get-provider-presets',
      'storage:discover-models',
      'storage:discover-local',
      'storage:export-custom-models',
      'storage:import-custom-models',
      'storage:get-gateway',
      'storage:save-gateway',
      'storage:test-gateway',
      'storage:import-gateway-models',
      'storage:open-gateway-dashboard',
      'storage:google-login',
      'storage:google-login-cancel',
      'storage:google-test-account',
      'storage:google-account-prepare',
      'storage:google-pool-status',
      'storage:google-link-account',
      'storage:google-select-account',
      'storage:google-remove-account',
      'storage:get-diagnostics',
      'storage:clear-diagnostics',
      'storage:get-chat-context-usage',
      'storage:get-prompt-sections',
      'storage:save-prompt-sections',
      'storage:reset-prompt-sections',
      'storage:get-model-health',
      'storage:check-model-health',
      'storage:get-display-settings',
      'storage:save-display-settings',
    ]);
    expect(fixture.exposed).toEqual({});
  });

  it('persists, masks, edits and deletes models using the existing configuration location', async () => {
    const fixture = createFixture(true);
    const model = {
      name: 'models/my-model',
      displayName: 'My model',
      provider: 'openai',
      apiUrl: 'https://provider.example/v1',
      apiKey: 'secret-long-api-key',
      externalModelName: 'provider-model',
    };
    await expect(fixture.invoke('storage:save-custom-model', { ...model })).resolves.toEqual({ success: true });
    const filename = path.join(fixture.homePath, '.gemini', 'antigravity', 'custom_models.json');
    const persisted = JSON.parse(readFileSync(filename, 'utf8'));
    expect(persisted.models).toEqual([{ ...model, apiKey: 'encrypted:secret-long-api-key', encrypted: true }]);

    const models = (await fixture.invoke('storage:get-custom-models')) as Array<typeof model>;
    expect(models[0].apiKey).toBe('********');
    await fixture.invoke('storage:save-custom-model', { ...models[0], displayName: 'Renamed model' });
    const edited = JSON.parse(readFileSync(filename, 'utf8'));
    expect(edited.models).toHaveLength(1);
    expect(edited.models[0]).toMatchObject({
      displayName: 'Renamed model',
      apiKey: 'encrypted:secret-long-api-key',
      encrypted: true,
    });

    await expect(fixture.invoke('storage:delete-custom-model', model.name)).resolves.toEqual({ success: true });
    await expect(fixture.invoke('storage:get-custom-models')).resolves.toEqual([]);
  });

  it('keeps provider connectivity failures available through its own IPC handler', async () => {
    const fixture = createFixture(true);

    await expect(
      fixture.invoke('storage:test-model-connection', {
        apiUrl: 'file:///not-an-api',
        provider: 'openai',
      }),
    ).resolves.toMatchObject({ success: false, error: expect.stringContaining('HTTP(S)') });
  });

  it('handles thrown non-object primitives safely in customIpc without crashing', async () => {
    const handlers = new Map<string, Handler>();
    const tempHome = mkdtempSync(path.join(tmpdir(), 'antigravity-ipc-prim-'));
    fixtureHomes.push(tempHome);
    const electron = {
      app: { getPath: () => tempHome },
      ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
      shell: { openExternal: vi.fn() },
    };
    const customIpc = loadModule('customIpc', {
      electron,
      'node:path': path,
      './cryptoStore': {},
      './modelManagement': { createModelManager: () => ({}) },
      './modelActions': {
        createModelActions: () => ({
          'storage:save-custom-model': () => {
            throw 'plain-string-error';
          },
          'storage:delete-custom-model': () => {
            throw null;
          },
        }),
      },
    });
    customIpc.registerCustomModelHandlers();
    await expect(handlers.get('storage:save-custom-model')!({})).resolves.toEqual({
      success: false,
      error: 'plain-string-error',
    });
    await expect(handlers.get('storage:delete-custom-model')!({})).resolves.toEqual({
      success: false,
      error: 'null',
    });
  });
});

describe('IPC and plugin:// custom scheme security hardening', () => {
  it('validates extensionAuthorities strictly to loopback HTTP URLs and rejects SSRF targets', async () => {
    const fixture = createFixture();
    await fixture.invoke('extensions:send-authorities', {
      ext1: 'http://127.0.0.1:41234',
      ext2: 'http://localhost:41235/',
    });
    expect(fixture.extensionAuthorities.get('ext1')).toBe('http://127.0.0.1:41234');
    expect(fixture.extensionAuthorities.get('ext2')).toBe('http://localhost:41235');

    for (const bad of [
      { ext: 'file:///etc/passwd' },
      { ext: 'https://127.0.0.1:41234' },
      { ext: 'http://169.254.169.254:80' },
      { ext: 'http://evil.example:41234' },
      { ext: 'http://user:pass@127.0.0.1:41234' },
      { ext: 'http://127.0.0.1:41234/prefix' },
      { ext: 'http://127.0.0.1' },
      { ext: 12345 },
      null,
    ]) {
      await expect(fixture.invoke('extensions:send-authorities', bad)).rejects.toThrow();
    }
    // Prior valid entries survive failed updates atomically.
    expect(fixture.extensionAuthorities.get('ext1')).toBe('http://127.0.0.1:41234');
  });

  it('guards shell:open-external against non-strings and unsafe protocols', async () => {
    const fixture = createFixture();
    await fixture.invoke('shell:open-external', null);
    await fixture.invoke('shell:open-external', 42);
    await fixture.invoke('shell:open-external', 'file:///C:/Windows/win.ini');
    await fixture.invoke('shell:open-external', 'javascript:alert(1)');
    expect(fixture.openExternal).not.toHaveBeenCalled();

    await fixture.invoke('shell:open-external', 'https://example.com/docs');
    expect(fixture.openExternal).toHaveBeenCalledWith('https://example.com/docs');
  });

  it('blocks SSRF, non-loopback authorities, and malformed URLs in plugin:// scheme handler', async () => {
    let schemeHandler!: (req: Request) => Promise<Response>;
    const netFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const customScheme = loadModule(
      'customScheme',
      {
        electron: {
          protocol: {
            registerSchemesAsPrivileged: vi.fn(),
            handle: (_scheme: string, fn: (req: Request) => Promise<Response>) => {
              schemeHandler = fn;
            },
          },
          net: { fetch: netFetch },
        },
      },
      { Response, Request },
    );
    customScheme.registerCustomSchemeHandlers();
    const authorities = customScheme.extensionAuthorities as unknown as Map<string, string>;

    // Malformed request URL returns 400
    const badReq = { url: 'http://[::1', method: 'GET', headers: new Headers(), body: null } as unknown as Request;
    expect((await schemeHandler(badReq)).status).toBe(400);

    // Non-loopback or file:// authority injected directly into map is rejected with 403
    authorities.set('evil', 'file:///etc/passwd');
    expect((await schemeHandler(new Request('plugin://evil/secret'))).status).toBe(403);
    authorities.set('external', 'http://169.254.169.254:80');
    expect((await schemeHandler(new Request('plugin://external/latest/meta-data'))).status).toBe(403);

    // Protocol-relative pathname escape is rejected with 403
    authorities.set('local', 'http://127.0.0.1:41234');
    const protoRelReq = {
      url: 'plugin://local//evil.example/steal',
      method: 'GET',
      headers: new Headers(),
      body: null,
    } as unknown as Request;
    expect((await schemeHandler(protoRelReq)).status).toBe(403);
    expect(netFetch).not.toHaveBeenCalled();

    // Valid loopback request succeeds
    const okRes = await schemeHandler(new Request('plugin://local/index.html?v=1'));
    expect(okRes.status).toBe(200);
    expect(netFetch).toHaveBeenCalledWith('http://127.0.0.1:41234/index.html?v=1', expect.any(Object));
  });
});
