import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import { broadcastState, checkForUpdates, getUpdaterState } from './updater';
import log from 'electron-log/main';
import * as fs from 'fs/promises';
import * as path from 'path';
import { extensionAuthorities } from './customScheme';
import { updateTrayAgentCount } from './tray';
import { StorageManager } from './storage';
import { getIdeInstallPath } from './ideInstall/constants';

import { registerCustomModelHandlers } from './customIpc';

const LOOPBACK_AUTHORITY_RE = /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/?$/i;

function parseLoopbackAuthorityOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!LOOPBACK_AUTHORITY_RE.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:') return null;
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
  const port = Number(parsed.port || '80');
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return parsed.origin;
}

function getActiveWindow() {
  const focused = BrowserWindow.getFocusedWindow?.();
  if (focused && !focused.isDestroyed?.()) return focused;
  return BrowserWindow.getAllWindows().find((win) => win && !win.isDestroyed?.());
}

function isWebContentsDestroyed(webContents: unknown): boolean {
  const wc = webContents as { isDestroyed?: () => boolean } | undefined;
  return Boolean(wc?.isDestroyed?.());
}

/**
 * Registers all IPC handlers for the main process.
 */
export function registerIpcHandlers(storageManager: StorageManager): void {
  // Dialog
  ipcMain.handle('dialog:open-workspace', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Open workspace',
    });
    if (result.canceled || result.filePaths.length === 0) {
      return undefined;
    }
    return result.filePaths[0];
  });
  ipcMain.handle('dialog:open-workspaces', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory', 'multiSelections'],
      title: 'Open workspaces',
    });
    return result.canceled || result.filePaths.length === 0 ? undefined : result.filePaths;
  });

  // Auto-updater
  ipcMain.handle('updater:get-state', () => getUpdaterState());
  ipcMain.handle('updater:apply', async () => {
    broadcastState({ type: 'ready' });
  });
  ipcMain.handle('updater:quit-and-install', () => {
    if (!app.isPackaged) {
      console.log('[AutoUpdater] Skipping quitAndInstall (requires a packaged app).');
      return;
    }
    autoUpdater.quitAndInstall();
  });

  // Notifications
  ipcMain.handle(
    'notification:send',
    (_event, options: { title: string; body: string; silent?: boolean; payload?: unknown }) => {
      if (!options || typeof options !== 'object' || typeof options.title !== 'string' || typeof options.body !== 'string') return;
      const notification = new Notification({
        title: options.title,
        body: options.body,
        silent: options.silent ?? false,
      });
      notification.on('click', () => {
        const win = BrowserWindow.getAllWindows().find((w) => w && !w.isDestroyed?.());
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
    },
  );

  // Note: copied from our desktop AGY implementation:
  // vs/platform/nativeNotification/electron-main/electronNotificationService.ts
  ipcMain.handle('notification:open-system-preferences', async () => {
    if (process.platform === 'darwin') {
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.notifications').catch(() => {});
    } else if (process.platform === 'win32') {
      await shell.openExternal('ms-settings:notifications').catch(() => {});
    } else if (process.platform === 'linux') {
      const { spawn } = await import('child_process');
      const commands: [string, string[]][] = [
        ['gnome-control-center', ['notifications']],
        ['systemsettings', ['kcm_notifications']],
        ['xfce4-notifyd-config', []],
        ['gnome-control-center', []],
        ['systemsettings', []],
      ];
      for (const [cmd, args] of commands) {
        const launched = await new Promise<boolean>((resolve) => {
          try {
            const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
            child.once('spawn', () => {
              child.unref?.();
              resolve(true);
            });
            child.once('error', () => resolve(false));
          } catch {
            resolve(false);
          }
        });
        if (launched) return;
      }
    }
  });

  // Storage
  ipcMain.handle('storage:get-items', async () => {
    return storageManager.getItems();
  });
  ipcMain.handle('storage:update-items', async (_event, changes: Record<string, string | null>) => {
    await storageManager.updateItems(changes);
  });
  registerCustomModelHandlers();

  // Logs
  ipcMain.handle('logs:electron', async () => {
    try {
      const logPath = log.transports.file.getFile().path;
      const contents = await fs.readFile(logPath, 'utf-8');
      return contents;
    } catch (err) {
      return `Failed to read logs: ${String(err)}`;
    }
  });

  // Sidecar extension custom scheme
  ipcMain.handle('extensions:send-authorities', async (_event, authorities: unknown) => {
    if (!authorities || typeof authorities !== 'object' || Array.isArray(authorities)) {
      throw new Error('Expected an extension authorities map');
    }
    const validated = new Map<string, string>();
    for (const [key, value] of Object.entries(authorities as Record<string, unknown>)) {
      if (!key) continue;
      const origin = parseLoopbackAuthorityOrigin(value);
      if (!origin) {
        throw new Error(
          `Invalid extension authority URL for "${key}": must be http://127.0.0.1:<port> or http://localhost:<port>`,
        );
      }
      validated.set(key, origin);
    }
    extensionAuthorities.clear();
    for (const [key, value] of validated) {
      extensionAuthorities.set(key, value);
    }
  });

  // Agent
  ipcMain.handle('agent:update-active-count', async (_event, count: number) => {
    updateTrayAgentCount(count);
  });

  // Window
  ipcMain.handle('window:set-title-bar-overlay', async (_event, options: { color: string; symbolColor: string }) => {
    if (!options || typeof options !== 'object' || typeof options.color !== 'string' || typeof options.symbolColor !== 'string') return;
    const win = getActiveWindow();
    if (win && !win.isDestroyed?.() && process.platform === 'win32') {
      win.setTitleBarOverlay({
        color: options.color,
        symbolColor: options.symbolColor,
        height: 30,
      });
    }
  });
  ipcMain.handle('window:minimize', async () => {
    const win = getActiveWindow();
    if (win && !win.isDestroyed?.()) {
      win.minimize();
    }
  });
  ipcMain.handle('window:maximize', async () => {
    const win = getActiveWindow();
    if (win && !win.isDestroyed?.()) {
      win.maximize();
    }
  });
  ipcMain.handle('window:unmaximize', async () => {
    const win = getActiveWindow();
    if (win && !win.isDestroyed?.()) {
      win.unmaximize();
    }
  });
  ipcMain.handle('window:is-maximized', async () => {
    const win = getActiveWindow();
    return win && !win.isDestroyed?.() ? win.isMaximized() : false;
  });
  ipcMain.handle('window:close', async () => {
    const win = getActiveWindow();
    if (win && !win.isDestroyed?.()) {
      win.close();
    }
  });
  ipcMain.handle('window:toggle-devtools', async () => {
    const win = getActiveWindow();
    if (win && !win.isDestroyed?.() && !isWebContentsDestroyed(win.webContents)) {
      win.webContents.toggleDevTools();
    }
  });

  // Auto-updater manual check
  ipcMain.handle('updater:check-for-updates', () => {
    checkForUpdates(true);
  });

  // Safe external shell launch
  ipcMain.handle('shell:open-external', async (_event, url: unknown) => {
    if (typeof url !== 'string') return;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      await shell.openExternal(url);
    }
  });
  ipcMain.handle('shell:reveal-in-file-picker', async (_event, filePath: string) => {
    if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0') || !path.isAbsolute(filePath)) {
      throw new Error('Expected an absolute filesystem path');
    }
    // Do not send URLs or nonexistent paths to a platform shell.
    await fs.stat(filePath);
    shell.showItemInFolder(filePath);
  });

  ipcMain.handle('ide:is-installed', async () => {
    try {
      const installation = await fs.stat(getIdeInstallPath());
      return installation.isDirectory();
    } catch {
      return false;
    }
  });
}
