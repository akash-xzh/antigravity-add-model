/** Addon-owned channels only; vendor desktop APIs are left intact. */
import { app, ipcMain, shell } from 'electron';
import * as path from 'node:path';
import * as cryptoStore from './cryptoStore';
import { createModelManager } from './modelManagement';
import { createModelActions } from './modelActions';

let handlersRegistered = false;

export function registerCustomModelHandlers(): void {
  // Both main.ts (via ipcHandlers) and desktop.ts can load this module in one
  // process. ipcMain.handle throws on a duplicate channel registration.
  if (handlersRegistered) return;
  handlersRegistered = true;
  const manager = createModelManager(path.join(app.getPath('home'), '.gemini', 'antigravity'), cryptoStore, (url) =>
    shell.openExternal(url),
  );
  const handle = (channel: string, action: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return await action(...args);
      } catch (error) {
        if (channel === 'storage:get-custom-models' || channel === 'storage:export-custom-models') throw error;
        const status =
          error && typeof error === 'object' && 'status' in error && typeof (error as { status?: unknown }).status === 'number'
            ? (error as { status: number }).status
            : undefined;
        const message =
          error instanceof Error
            ? error.message
            : error && typeof error === 'object' && 'message' in error && typeof (error as { message?: unknown }).message === 'string'
              ? (error as { message: string }).message
              : String(error);
        return { success: false, error: message, ...(status ? { status } : {}) };
      }
    });
  };
  for (const [channel, action] of Object.entries(createModelActions(manager))) handle(channel, action);
}
