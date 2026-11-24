import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync(path.resolve('src/languageServer.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

function createFixture(timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout }) {
  const startProxy = vi.fn<() => Promise<number>>();
  const stopProxy = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const setLanguageServerPortResolver = vi.fn<(getPort: () => number) => void>();
  const logStreams: { end: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> }[] = [];
  const createWriteStream = vi.fn(() => {
    const log = { end: vi.fn(), write: vi.fn() };
    logStreams.push(log);
    return log;
  });
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  const spawn = vi.fn((_binary: string, _args: string[], _options: unknown) => child);
  const shellEnvSync = vi.fn(() => ({}));
  const dependencies: Record<string, unknown> = {
    child_process: { spawn },
    electron: { app: { isPackaged: false, getVersion: () => '2.12.2' }, session: {} },
    'shell-env': { shellEnvSync },
    fs: { createWriteStream },
    path,
    readline,
    stream: { PassThrough },
    './paths': {
      getLsLogPath: () => path.resolve('fixture', 'language-server.log'),
      getAppDataDirName: () => 'fixture',
      getActivePortFilePath: () => path.resolve('fixture', 'port'),
    },
    './constants': {},
    './utils': { setupNodeWrapper: vi.fn() },
    './proxy': { startProxy, stopProxy, setLanguageServerPortResolver },
  };
  const module = {
    exports: {} as {
      startLanguageServer: (port: number, csrf: string, headless?: boolean) => Promise<{ port: number; exitPromise: Promise<unknown> }>;
      startAndMonitorLanguageServer: (
        port: number,
        csrf: string,
        options?: { headless?: boolean; onPortChanged?: (newPort: number) => void },
      ) => Promise<{ port: number; exitPromise: Promise<unknown> }>;
      getLsProcess: () => unknown;
      killLanguageServer: () => Promise<void>;
      setIntentionalTermination: (value: boolean) => void;
    },
  };
  runInNewContext(source, {
    exports: module.exports,
    module,
    require: (id: string) => {
      if (!Object.hasOwn(dependencies, id)) throw new Error(`Unexpected dependency: ${id}`);
      return dependencies[id];
    },
    __dirname: path.resolve('src'),
    process: { platform: process.platform, env: {} },
    console: { error: vi.fn(), log: vi.fn(), warn: vi.fn() },
    setTimeout: timers?.setTimeout ?? setTimeout,
    clearTimeout: timers?.clearTimeout ?? clearTimeout,
  });
  return {
    startProxy,
    stopProxy,
    setLanguageServerPortResolver,
    spawn,
    shellEnvSync,
    logStreams,
    child,
    start: module.exports.startLanguageServer,
    startAndMonitor: module.exports.startAndMonitorLanguageServer,
    getLsProcess: module.exports.getLsProcess,
    stop: module.exports.killLanguageServer,
    resetTermination: () => module.exports.setIntentionalTermination(false),
  };
}

describe('language-server proxy startup dependency', () => {
  it.each([false, true])('cancels pending startup across shutdown (restart requested early=%s)', async (restartEarly) => {
    const fixture = createFixture();
    let ready!: (port: number) => void;
    const proxyReady = new Promise<number>((resolve) => { ready = resolve; });
    fixture.startProxy.mockReturnValue(proxyReady);
    fixture.stopProxy.mockImplementation(async () => { await proxyReady; });
    const starting = fixture.start(0, 'fixture-token');
    const cancelled = expect(starting).rejects.toThrow('startup cancelled during shutdown');
    const stopping = fixture.stop();
    if (restartEarly) fixture.resetTermination();
    ready(61002);
    await Promise.all([cancelled, stopping]);
    expect(fixture.spawn).not.toHaveBeenCalled();
    expect(fixture.shellEnvSync).not.toHaveBeenCalled();
    expect(fixture.logStreams[0].end).toHaveBeenCalledOnce();

    // startAndMonitorLanguageServer explicitly clears intentional termination.
    fixture.resetTermination();
    const restarted = fixture.start(0, 'fixture-token');
    await new Promise((resolve) => setImmediate(resolve));
    fixture.child.stdout.write('listening on HTTP port at 60001 for HTTP\n');
    const handle = await restarted;
    expect(fixture.spawn).toHaveBeenCalledOnce();
    fixture.child.emit('exit', 0, null);
    await handle.exitPromise;
    fixture.child.stdout.end();
    fixture.child.stderr.end();
  });

  it('terminates the LS while its unfinished proxy responses are draining', async () => {
    const fixture = createFixture();
    fixture.startProxy.mockResolvedValue(61002);
    const starting = fixture.start(0, 'fixture-token');
    await new Promise((resolve) => setImmediate(resolve));
    fixture.child.stdout.write('listening on HTTP port at 60001 for HTTP\n');
    await starting;
    let drained!: () => void;
    fixture.stopProxy.mockImplementation(() => new Promise<void>((resolve) => { drained = resolve; }));
    const kill = vi.fn(() => { fixture.child.emit('exit', 0, null); return true; });
    Object.assign(fixture.child, { kill });
    const stopping = fixture.stop();
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    drained();
    await stopping;
    fixture.child.stdout.end();
    fixture.child.stderr.end();
  });

  it.each([
    ['EADDRINUSE', 'Port 50999 is occupied. The patched language server requires this exact port'],
    ['EINVAL', 'Invalid antigravity-proxy.json: the binary patch requires port 50999'],
    ['EACCES', 'Proxy listener permission denied'],
  ])('does not spawn or silently select a remote fallback after proxy rejection: %s', async (code, message) => {
    const fixture = createFixture();
    const failure = Object.assign(new Error(message), { code });
    fixture.startProxy.mockRejectedValue(failure);
    await expect(fixture.start(0, 'fixture-token')).rejects.toBe(failure);
    expect(fixture.spawn).not.toHaveBeenCalled();
    expect(fixture.shellEnvSync).not.toHaveBeenCalled();
    expect(fixture.logStreams[0].end).toHaveBeenCalledOnce();
  });

  it('can retry successfully after the proxy startup condition is resolved', async () => {
    const fixture = createFixture();
    const failure = Object.assign(new Error('Port 50999 is occupied'), { code: 'EADDRINUSE' });
    fixture.startProxy.mockRejectedValueOnce(failure).mockResolvedValueOnce(50999);
    await expect(fixture.start(0, 'fixture-token')).rejects.toBe(failure);

    const pending = fixture.start(0, 'fixture-token');
    await new Promise((resolve) => setImmediate(resolve));
    expect(fixture.spawn).toHaveBeenCalledOnce();
    const args = fixture.spawn.mock.calls[0][1] as string[];
    expect(args[args.indexOf('--api_server_url') + 1]).toBe('http://localhost:50999');
    fixture.child.stdout.write('listening on HTTP port at 60001 for HTTP\n');
    const handle = await pending;
    expect(handle.port).toBe(60001);
    fixture.child.emit('exit', 0, null);
    await handle.exitPromise;
    fixture.child.stdout.end();
    fixture.child.stderr.end();
    expect(fixture.logStreams.every((stream) => stream.end.mock.calls.length === 1)).toBe(true);
  });

  it('uses a dynamic proxy port when normal unpatched startup succeeds', async () => {
    const fixture = createFixture();
    fixture.startProxy.mockResolvedValue(61002);
    const pending = fixture.start(0, 'fixture-token');
    await new Promise((resolve) => setImmediate(resolve));
    expect(fixture.startProxy).toHaveBeenCalledWith();
    expect(fixture.setLanguageServerPortResolver).toHaveBeenCalledOnce();
    const livePort = fixture.setLanguageServerPortResolver.mock.calls[0][0];
    expect(livePort()).toBe(0);
    const args = fixture.spawn.mock.calls[0][1] as string[];
    for (const flag of ['--api_server_url', '--cloud_code_endpoint', '--inference_api_server_url']) {
      expect(args[args.indexOf(flag) + 1]).toBe('http://localhost:61002');
    }
    fixture.child.stdout.write('listening on HTTP port at 60003 for HTTP\n');
    const handle = await pending;
    expect(handle.port).toBe(60003);
    expect(livePort()).toBe(60003);
    fixture.child.emit('exit', 0, null);
    await handle.exitPromise;
    expect(livePort()).toBe(0);
    fixture.child.stdout.end();
    fixture.child.stderr.end();
  });

  it('clears the old trusted port while restarting and ignores a replaced child exiting late', async () => {
    const fixture = createFixture();
    fixture.startProxy.mockResolvedValue(61002);
    const firstPending = fixture.start(0, 'fixture-token');
    await new Promise((resolve) => setImmediate(resolve));
    fixture.child.stdout.write('listening on HTTP port at 60001 for HTTP\n');
    const first = await firstPending;
    const livePort = fixture.setLanguageServerPortResolver.mock.calls[0][0];
    expect(livePort()).toBe(60001);

    const second = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    });
    fixture.spawn.mockReturnValueOnce(second);
    const secondPending = fixture.start(0, 'fixture-token');
    expect(livePort()).toBe(0);
    await new Promise((resolve) => setImmediate(resolve));
    second.stdout.write('listening on HTTP port at 60002 for HTTP\n');
    const replacement = await secondPending;
    expect(livePort()).toBe(60002);
    fixture.child.emit('exit', 0, null);
    await first.exitPromise;
    expect(livePort()).toBe(60002);
    second.emit('exit', 0, null);
    await replacement.exitPromise;
    expect(livePort()).toBe(0);
    fixture.child.stdout.end(); fixture.child.stderr.end();
    second.stdout.end(); second.stderr.end();
  });

  it('rejects cleanly and closes logStream on async child spawn error (ENOENT)', async () => {
    const fixture = createFixture();
    fixture.startProxy.mockResolvedValue(61002);
    const starting = fixture.start(0, 'fixture-token');
    await new Promise((resolve) => setImmediate(resolve));
    fixture.child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    await expect(starting).rejects.toThrow('Failed to spawn language server: spawn ENOENT');
    expect(fixture.getLsProcess()).toBeNull();
    expect(fixture.logStreams[0].end).toHaveBeenCalledOnce();
  });

  it('rejects cleanly and closes logStream when sync setup throws before spawn', async () => {
    const fixture = createFixture();
    fixture.startProxy.mockResolvedValue(61002);
    fixture.shellEnvSync.mockImplementation(() => {
      throw new Error('shell env failed');
    });
    await expect(fixture.start(0, 'fixture-token')).rejects.toThrow('shell env failed');
    expect(fixture.spawn).not.toHaveBeenCalled();
    expect(fixture.logStreams[0].end).toHaveBeenCalledOnce();
  });

  it('kills the orphan child, clears _lsProcess, and closes logStream on startup timeout', async () => {
    const scheduled: Array<() => void> = [];
    const fixture = createFixture({
      setTimeout: ((fn: () => void) => {
        scheduled.push(fn);
        return scheduled.length as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
      clearTimeout: vi.fn() as unknown as typeof clearTimeout,
    });
    fixture.startProxy.mockResolvedValue(61002);
    const starting = fixture.start(0, 'fixture-token');
    await new Promise((resolve) => setImmediate(resolve));
    expect(scheduled.length).toBe(1);
    scheduled[0]();
    await expect(starting).rejects.toThrow('Timeout: language server did not report its port');
    expect(fixture.child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(fixture.getLsProcess()).toBeNull();
    expect(fixture.logStreams[0].end).toHaveBeenCalledOnce();
  });

  it('preserves headless option and retries crash-restart after a transient startup failure', async () => {
    const fixture = createFixture({
      setTimeout: ((fn: () => void, ms?: number) => {
        // Run restart cooldown timers quickly while leaving the 60s startup timeout pending.
        if (ms && ms < 30000) return setTimeout(fn, 0);
        return setTimeout(fn, ms);
      }) as unknown as typeof setTimeout,
      clearTimeout,
    });
    const makeChild = () =>
      Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(() => true),
      });
    const firstChild = makeChild();
    const recoveredChild = makeChild();
    fixture.spawn.mockReturnValueOnce(firstChild).mockReturnValueOnce(recoveredChild);
    fixture.startProxy
      .mockResolvedValueOnce(61002)
      .mockRejectedValueOnce(new Error('transient proxy error'))
      .mockResolvedValueOnce(61002);

    const portChanges: number[] = [];
    const starting = fixture.startAndMonitor(0, 'fixture-token', {
      headless: true,
      onPortChanged: (p) => portChanges.push(p),
    });
    await new Promise((resolve) => setImmediate(resolve));
    firstChild.stdout.write('listening on HTTP port at 60001 for HTTP\n');
    await starting;
    expect(portChanges).toEqual([60001]);

    // Simulate crash; attempt 1 fails with transient error, attempt 2 succeeds with --headless preserved
    firstChild.emit('exit', 1, null);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fixture.spawn).toHaveBeenCalledTimes(2);
    expect((fixture.spawn.mock.calls[1][1] as string[])).toContain('--headless');
    recoveredChild.stdout.write('listening on HTTP port at 60005 for HTTP\n');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(portChanges).toEqual([60001, 60005]);

    await fixture.stop();
    recoveredChild.emit('exit', 0, null);
  });
});
