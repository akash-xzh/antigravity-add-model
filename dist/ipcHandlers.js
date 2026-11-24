"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerIpcHandlers = registerIpcHandlers;
const electron_1 = require("electron");
const electron_updater_1 = require("electron-updater");
const updater_1 = require("./updater");
const main_1 = __importDefault(require("electron-log/main"));
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const customScheme_1 = require("./customScheme");
const tray_1 = require("./tray");
const constants_1 = require("./ideInstall/constants");
const customIpc_1 = require("./customIpc");
const LOOPBACK_AUTHORITY_RE = /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/?$/i;
function parseLoopbackAuthorityOrigin(value) {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    if (!LOOPBACK_AUTHORITY_RE.test(trimmed))
        return null;
    let parsed;
    try {
        parsed = new URL(trimmed);
    }
    catch {
        return null;
    }
    if (parsed.protocol !== 'http:')
        return null;
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost')
        return null;
    if (parsed.username || parsed.password)
        return null;
    if (parsed.pathname !== '/' || parsed.search || parsed.hash)
        return null;
    const port = Number(parsed.port || '80');
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        return null;
    return parsed.origin;
}
function getActiveWindow() {
    const focused = electron_1.BrowserWindow.getFocusedWindow?.();
    if (focused && !focused.isDestroyed?.())
        return focused;
    return electron_1.BrowserWindow.getAllWindows().find((win) => win && !win.isDestroyed?.());
}
function isWebContentsDestroyed(webContents) {
    const wc = webContents;
    return Boolean(wc?.isDestroyed?.());
}
/**
 * Registers all IPC handlers for the main process.
 */
function registerIpcHandlers(storageManager) {
    // Dialog
    electron_1.ipcMain.handle('dialog:open-workspace', async () => {
        const result = await electron_1.dialog.showOpenDialog({
            properties: ['openDirectory', 'createDirectory'],
            title: 'Open workspace',
        });
        if (result.canceled || result.filePaths.length === 0) {
            return undefined;
        }
        return result.filePaths[0];
    });
    electron_1.ipcMain.handle('dialog:open-workspaces', async () => {
        const result = await electron_1.dialog.showOpenDialog({
            properties: ['openDirectory', 'createDirectory', 'multiSelections'],
            title: 'Open workspaces',
        });
        return result.canceled || result.filePaths.length === 0 ? undefined : result.filePaths;
    });
    // Auto-updater
    electron_1.ipcMain.handle('updater:get-state', () => (0, updater_1.getUpdaterState)());
    electron_1.ipcMain.handle('updater:apply', async () => {
        (0, updater_1.broadcastState)({ type: 'ready' });
    });
    electron_1.ipcMain.handle('updater:quit-and-install', () => {
        if (!electron_1.app.isPackaged) {
            console.log('[AutoUpdater] Skipping quitAndInstall (requires a packaged app).');
            return;
        }
        electron_updater_1.autoUpdater.quitAndInstall();
    });
    // Notifications
    electron_1.ipcMain.handle('notification:send', (_event, options) => {
        if (!options || typeof options !== 'object' || typeof options.title !== 'string' || typeof options.body !== 'string')
            return;
        const notification = new electron_1.Notification({
            title: options.title,
            body: options.body,
            silent: options.silent ?? false,
        });
        notification.on('click', () => {
            const win = electron_1.BrowserWindow.getAllWindows().find((w) => w && !w.isDestroyed?.());
            if (win && !win.isDestroyed?.()) {
                if (win.isMinimized()) {
                    win.restore();
                }
                win.show();
                win.focus();
                if (options.payload && !isWebContentsDestroyed(win.webContents)) {
                    win.webContents.send('notification:clicked', options.payload);
                }
            }
        });
        notification.show();
    });
    // Note: copied from our desktop AGY implementation:
    // vs/platform/nativeNotification/electron-main/electronNotificationService.ts
    electron_1.ipcMain.handle('notification:open-system-preferences', async () => {
        if (process.platform === 'darwin') {
            await electron_1.shell.openExternal('x-apple.systempreferences:com.apple.preference.notifications').catch(() => { });
        }
        else if (process.platform === 'win32') {
            await electron_1.shell.openExternal('ms-settings:notifications').catch(() => { });
        }
        else if (process.platform === 'linux') {
            const { spawn } = await Promise.resolve().then(() => __importStar(require('child_process')));
            const commands = [
                ['gnome-control-center', ['notifications']],
                ['systemsettings', ['kcm_notifications']],
                ['xfce4-notifyd-config', []],
                ['gnome-control-center', []],
                ['systemsettings', []],
            ];
            for (const [cmd, args] of commands) {
                const launched = await new Promise((resolve) => {
                    try {
                        const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
                        child.once('spawn', () => {
                            child.unref?.();
                            resolve(true);
                        });
                        child.once('error', () => resolve(false));
                    }
                    catch {
                        resolve(false);
                    }
                });
                if (launched)
                    return;
            }
        }
    });
    // Storage
    electron_1.ipcMain.handle('storage:get-items', async () => {
        return storageManager.getItems();
    });
    electron_1.ipcMain.handle('storage:update-items', async (_event, changes) => {
        await storageManager.updateItems(changes);
    });
    (0, customIpc_1.registerCustomModelHandlers)();
    // Logs
    electron_1.ipcMain.handle('logs:electron', async () => {
        try {
            const logPath = main_1.default.transports.file.getFile().path;
            const contents = await fs.readFile(logPath, 'utf-8');
            return contents;
        }
        catch (err) {
            return `Failed to read logs: ${String(err)}`;
        }
    });
    // Sidecar extension custom scheme
    electron_1.ipcMain.handle('extensions:send-authorities', async (_event, authorities) => {
        if (!authorities || typeof authorities !== 'object' || Array.isArray(authorities)) {
            throw new Error('Expected an extension authorities map');
        }
        const validated = new Map();
        for (const [key, value] of Object.entries(authorities)) {
            if (!key)
                continue;
            const origin = parseLoopbackAuthorityOrigin(value);
            if (!origin) {
                throw new Error(`Invalid extension authority URL for "${key}": must be http://127.0.0.1:<port> or http://localhost:<port>`);
            }
            validated.set(key, origin);
        }
        customScheme_1.extensionAuthorities.clear();
        for (const [key, value] of validated) {
            customScheme_1.extensionAuthorities.set(key, value);
        }
    });
    // Agent
    electron_1.ipcMain.handle('agent:update-active-count', async (_event, count) => {
        (0, tray_1.updateTrayAgentCount)(count);
    });
    // Window
    electron_1.ipcMain.handle('window:set-title-bar-overlay', async (_event, options) => {
        if (!options || typeof options !== 'object' || typeof options.color !== 'string' || typeof options.symbolColor !== 'string')
            return;
        const win = getActiveWindow();
        if (win && !win.isDestroyed?.() && process.platform === 'win32') {
            win.setTitleBarOverlay({
                color: options.color,
                symbolColor: options.symbolColor,
                height: 30,
            });
        }
    });
    electron_1.ipcMain.handle('window:minimize', async () => {
        const win = getActiveWindow();
        if (win && !win.isDestroyed?.()) {
            win.minimize();
        }
    });
    electron_1.ipcMain.handle('window:maximize', async () => {
        const win = getActiveWindow();
        if (win && !win.isDestroyed?.()) {
            win.maximize();
        }
    });
    electron_1.ipcMain.handle('window:unmaximize', async () => {
        const win = getActiveWindow();
        if (win && !win.isDestroyed?.()) {
            win.unmaximize();
        }
    });
    electron_1.ipcMain.handle('window:is-maximized', async () => {
        const win = getActiveWindow();
        return win && !win.isDestroyed?.() ? win.isMaximized() : false;
    });
    electron_1.ipcMain.handle('window:close', async () => {
        const win = getActiveWindow();
        if (win && !win.isDestroyed?.()) {
            win.close();
        }
    });
    electron_1.ipcMain.handle('window:toggle-devtools', async () => {
        const win = getActiveWindow();
        if (win && !win.isDestroyed?.() && !isWebContentsDestroyed(win.webContents)) {
            win.webContents.toggleDevTools();
        }
    });
    // Auto-updater manual check
    electron_1.ipcMain.handle('updater:check-for-updates', () => {
        (0, updater_1.checkForUpdates)(true);
    });
    // Safe external shell launch
    electron_1.ipcMain.handle('shell:open-external', async (_event, url) => {
        if (typeof url !== 'string')
            return;
        let parsed;
        try {
            parsed = new URL(url);
        }
        catch {
            return;
        }
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
            await electron_1.shell.openExternal(url);
        }
    });
    electron_1.ipcMain.handle('shell:reveal-in-file-picker', async (_event, filePath) => {
        if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0') || !path.isAbsolute(filePath)) {
            throw new Error('Expected an absolute filesystem path');
        }
        // Do not send URLs or nonexistent paths to a platform shell.
        await fs.stat(filePath);
        electron_1.shell.showItemInFolder(filePath);
    });
    electron_1.ipcMain.handle('ide:is-installed', async () => {
        try {
            const installation = await fs.stat((0, constants_1.getIdeInstallPath)());
            return installation.isDirectory();
        }
        catch {
            return false;
        }
    });
}
//# sourceMappingURL=ipcHandlers.js.map