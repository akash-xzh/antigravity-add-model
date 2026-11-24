/** Custom-model integration installed alongside the current vendor desktop runtime. */
import { app, dialog, session } from 'electron';
import { registerCustomModelHandlers } from './customIpc';
import { getProxyPort, getUiMitmToken, setLanguageServerPortResolver, stopProxy } from './proxy';

let installed = false;

export function install(getLanguageServerPort: () => number): void {
  if (installed) return;
  installed = true;
  setLanguageServerPortResolver(getLanguageServerPort);
  registerCustomModelHandlers();

  // Registered before the vendor's ready callback, without replacing its startup,
  // updater, WSL integration, certificate policy, or window configuration.
  void app.whenReady().then(() => {
    const webRequest = session.defaultSession.webRequest;
    const rawOnBeforeRequest = webRequest.onBeforeRequest.bind(webRequest);
    type OnBeforeRequestDetails = { url: string };
    type OnBeforeRequestCallback = (response: { cancel?: boolean; redirectURL?: string }) => void;
    type OnBeforeRequestListener = (details: OnBeforeRequestDetails, callback: OnBeforeRequestCallback) => void;
    type WebRequestFilter = { urls?: string[] };
    let chainedListener: OnBeforeRequestListener | null = null;
    let chainedFilterUrls: string[] | null = null;

    const matchesFilter = (url: string, patterns: string[] | null): boolean => {
      if (!patterns || patterns.length === 0) return true;
      for (const pattern of patterns) {
        if (pattern === '<all_urls>' || pattern === '*://*/*') return true;
        const regexStr = '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
        if (new RegExp(regexStr).test(url)) return true;
      }
      return false;
    };

    const passThrough = (details: OnBeforeRequestDetails, callback: OnBeforeRequestCallback): void => {
      if (chainedListener && matchesFilter(details.url, chainedFilterUrls)) {
        chainedListener(details, callback);
      } else {
        callback({});
      }
    };

    const addonListener: OnBeforeRequestListener = (details, callback) => {
      const proxyPort = getProxyPort();
      const lsPort = getLanguageServerPort();
      if (!proxyPort || !lsPort) return passThrough(details, callback);
      let url: URL;
      try {
        url = new URL(details.url);
      } catch {
        return passThrough(details, callback);
      }
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        !['127.0.0.1', 'localhost'].includes(url.hostname) ||
        Number(url.port) !== lsPort
      ) {
        return passThrough(details, callback);
      }
      if (/(?:\/|\.)LanguageServerService\/SetCloudCodeURL$/.test(url.pathname)) {
        callback({ cancel: true });
      } else if (/(?:\/|\.)LanguageServerService\/GetAvailableModels$/.test(url.pathname)) {
        callback({
          redirectURL: `http://127.0.0.1:${proxyPort}/GetAvailableModels?ls=${encodeURIComponent(details.url)}`,
        });
      } else if (url.pathname === '/main.js') {
        const token = typeof getUiMitmToken === 'function' ? getUiMitmToken() : '';
        callback({
          redirectURL: token
            ? `http://127.0.0.1:${proxyPort}/_ui/main.js?t=${encodeURIComponent(token)}`
            : `http://127.0.0.1:${proxyPort}/_ui/main.js`,
        });
      } else {
        passThrough(details, callback);
      }
    };

    rawOnBeforeRequest(addonListener as Parameters<typeof webRequest.onBeforeRequest>[0]);

    // Electron only keeps one onBeforeRequest listener per session; wrap registration
    // so a later vendor listener chains after our non-matching pass-through instead of
    // overwriting MITM / GetAvailableModels / SetCloudCodeURL interception.
    try {
      webRequest.onBeforeRequest = ((
        filterOrListener: WebRequestFilter | OnBeforeRequestListener | null,
        maybeListener?: OnBeforeRequestListener | null,
      ) => {
        if (typeof filterOrListener === 'function') {
          chainedFilterUrls = null;
          chainedListener = filterOrListener;
        } else if (filterOrListener === null) {
          chainedFilterUrls = null;
          chainedListener = null;
          // A vendor call to onBeforeRequest(null) must actually unregister the
          // listener. Our wrapper stays installed and re-adds the addon listener
          // on the next real registration.
          rawOnBeforeRequest(null as unknown as Parameters<typeof webRequest.onBeforeRequest>[0]);
          return;
        } else {
          chainedFilterUrls = Array.isArray(filterOrListener?.urls) ? filterOrListener.urls : null;
          chainedListener = maybeListener ?? null;
        }
        rawOnBeforeRequest(addonListener as Parameters<typeof webRequest.onBeforeRequest>[0]);
      }) as typeof webRequest.onBeforeRequest;
    } catch {
      // If onBeforeRequest is non-writable, addonListener is still registered.
    }
  });

  app.on('browser-window-created', (_event, win) => {
    win.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3 || win.isDestroyed()) return;
      console.error('[Model Patch] Desktop page failed to load:', code, description);
      dialog.showErrorBox(
        'Antigravity could not load',
        `${description} (${code})\n\nCheck the Electron and language-server logs. ` +
          'If this began after an update, reinstall a clean vendor build and run the patch preflight again.',
      );
    });
    win.webContents.on('preload-error', (_event, _preload, error) => {
      console.error('[Model Patch] Preload failed:', error);
    });
  });

  let proxyStopped = false;
  let stoppingProxy = false;
  app.on('will-quit', (event?: { preventDefault?: () => void }) => {
    if (proxyStopped) return;
    if (stoppingProxy) {
      event?.preventDefault?.();
      return;
    }
    stoppingProxy = true;
    if (event?.preventDefault) {
      event.preventDefault();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (timer !== undefined && typeof clearTimeout === 'function') {
          clearTimeout(timer);
          timer = undefined;
        }
        if (proxyStopped) return;
        proxyStopped = true;
        app.quit?.();
      };
      if (typeof setTimeout === 'function') {
        timer = setTimeout(finish, 5000);
      }
      void Promise.resolve(stopProxy())
        .catch(() => {})
        .finally(finish);
    } else {
      proxyStopped = true;
      void Promise.resolve(stopProxy()).catch(() => {});
    }
  });
}
