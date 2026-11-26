"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.install = install;
/** Custom-model integration installed alongside the current vendor desktop runtime. */
const electron_1 = require("electron");
const customIpc_1 = require("./customIpc");
const proxy_1 = require("./proxy");
let installed = false;
function install(getLanguageServerPort) {
    if (installed)
        return;
    installed = true;
    (0, proxy_1.setLanguageServerPortResolver)(getLanguageServerPort);
    if (typeof proxy_1.setCompactionNotifier === 'function') {
        (0, proxy_1.setCompactionNotifier)((event) => {
            const label = event.modelName || (event.isCustom ? 'Custom model' : 'Antigravity');
            try {
                const Notif = electron_1.Notification;
                if (Notif && typeof Notif.isSupported === 'function' && Notif.isSupported()) {
                    new Notif({
                        title: 'Antigravity · Auto-Compacting',
                        body: `Summarizing earlier context using ${label}.`,
                    }).show();
                }
            }
            catch {
                /* OS notification may be unavailable in headless sessions. */
            }
            try {
                if (electron_1.BrowserWindow && typeof electron_1.BrowserWindow.getAllWindows === 'function') {
                    for (const win of electron_1.BrowserWindow.getAllWindows()) {
                        if (!win.isDestroyed())
                            win.webContents.send('agy:compaction-event', event);
                    }
                }
            }
            catch {
                /* Window broadcast is best-effort. */
            }
        });
    }
    (0, customIpc_1.registerCustomModelHandlers)();
    // Registered before the vendor's ready callback, without replacing its startup,
    // updater, WSL integration, certificate policy, or window configuration.
    void electron_1.app.whenReady().then(() => {
        const webRequest = electron_1.session.defaultSession.webRequest;
        const rawOnBeforeRequest = webRequest.onBeforeRequest.bind(webRequest);
        let chainedListener = null;
        let chainedFilterUrls = null;
        const matchesFilter = (url, patterns) => {
            if (!patterns || patterns.length === 0)
                return true;
            for (const pattern of patterns) {
                if (pattern === '<all_urls>' || pattern === '*://*/*')
                    return true;
                const regexStr = '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
                if (new RegExp(regexStr).test(url))
                    return true;
            }
            return false;
        };
        const passThrough = (details, callback) => {
            if (chainedListener && matchesFilter(details.url, chainedFilterUrls)) {
                chainedListener(details, callback);
            }
            else {
                callback({});
            }
        };
        const addonListener = (details, callback) => {
            const proxyPort = (0, proxy_1.getProxyPort)();
            const lsPort = getLanguageServerPort();
            if (!proxyPort || !lsPort)
                return passThrough(details, callback);
            let url;
            try {
                url = new URL(details.url);
            }
            catch {
                return passThrough(details, callback);
            }
            if (!['http:', 'https:'].includes(url.protocol) ||
                !['127.0.0.1', 'localhost'].includes(url.hostname) ||
                Number(url.port) !== lsPort) {
                return passThrough(details, callback);
            }
            if (/(?:\/|\.)LanguageServerService\/SetCloudCodeURL$/.test(url.pathname)) {
                callback({ cancel: true });
            }
            else if (/(?:\/|\.)LanguageServerService\/GetAvailableModels$/.test(url.pathname)) {
                callback({
                    redirectURL: `http://127.0.0.1:${proxyPort}/GetAvailableModels?ls=${encodeURIComponent(details.url)}`,
                });
            }
            else if (url.pathname === '/main.js') {
                const token = typeof proxy_1.getUiMitmToken === 'function' ? (0, proxy_1.getUiMitmToken)() : '';
                callback({
                    redirectURL: token
                        ? `http://127.0.0.1:${proxyPort}/_ui/main.js?t=${encodeURIComponent(token)}`
                        : `http://127.0.0.1:${proxyPort}/_ui/main.js`,
                });
            }
            else {
                passThrough(details, callback);
            }
        };
        rawOnBeforeRequest(addonListener);
        // Electron only keeps one onBeforeRequest listener per session; wrap registration
        // so a later vendor listener chains after our non-matching pass-through instead of
        // overwriting MITM / GetAvailableModels / SetCloudCodeURL interception.
        try {
            webRequest.onBeforeRequest = ((filterOrListener, maybeListener) => {
                if (typeof filterOrListener === 'function') {
                    chainedFilterUrls = null;
                    chainedListener = filterOrListener;
                }
                else if (filterOrListener === null) {
                    chainedFilterUrls = null;
                    chainedListener = null;
                    // A vendor call to onBeforeRequest(null) must actually unregister the
                    // listener. Our wrapper stays installed and re-adds the addon listener
                    // on the next real registration.
                    rawOnBeforeRequest(null);
                    return;
                }
                else {
                    chainedFilterUrls = Array.isArray(filterOrListener?.urls) ? filterOrListener.urls : null;
                    chainedListener = maybeListener ?? null;
                }
                rawOnBeforeRequest(addonListener);
            });
        }
        catch {
            // If onBeforeRequest is non-writable, addonListener is still registered.
        }
    });
    electron_1.app.on('browser-window-created', (_event, win) => {
        win.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
            if (!isMainFrame || code === -3 || win.isDestroyed())
                return;
            console.error('[Model Patch] Desktop page failed to load:', code, description);
            electron_1.dialog.showErrorBox('Antigravity could not load', `${description} (${code})\n\nCheck the Electron and language-server logs. ` +
                'If this began after an update, reinstall a clean vendor build and run the patch preflight again.');
        });
        win.webContents.on('preload-error', (_event, _preload, error) => {
            console.error('[Model Patch] Preload failed:', error);
        });
    });
    let proxyStopped = false;
    let stoppingProxy = false;
    electron_1.app.on('will-quit', (event) => {
        if (proxyStopped)
            return;
        if (stoppingProxy) {
            event?.preventDefault?.();
            return;
        }
        stoppingProxy = true;
        if (event?.preventDefault) {
            event.preventDefault();
            let timer;
            const finish = () => {
                if (timer !== undefined && typeof clearTimeout === 'function') {
                    clearTimeout(timer);
                    timer = undefined;
                }
                if (proxyStopped)
                    return;
                proxyStopped = true;
                electron_1.app.quit?.();
            };
            if (typeof setTimeout === 'function') {
                timer = setTimeout(finish, 5000);
            }
            void Promise.resolve((0, proxy_1.stopProxy)())
                .catch(() => { })
                .finally(finish);
        }
        else {
            proxyStopped = true;
            void Promise.resolve((0, proxy_1.stopProxy)()).catch(() => { });
        }
    });
}
//# sourceMappingURL=desktop.js.map