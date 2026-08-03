import type { ContextMenuItem, LocalApi } from "@t3tools/contracts";

import { resetRequestLatencyStateForTests } from "./rpc/requestLatencyState";
import { showContextMenuFallback } from "./contextMenuFallback";
import { readBrowserClientSettings, writeBrowserClientSettings } from "./clientPersistenceStorage";

let cachedApi: LocalApi | undefined;

const unavailableLocalBackendError = () =>
  new Error("Local server API is unavailable in the browser.");

function createBrowserLocalApi(): LocalApi {
  return {
    dialogs: {
      pickFolder: async (options) => {
        if (!window.desktopBridge) return null;
        return window.desktopBridge.pickFolder(options);
      },
      confirm: async (message) => {
        if (window.desktopBridge) {
          return window.desktopBridge.confirm(message);
        }
        return window.confirm(message);
      },
    },
    shell: {
      openExternal: async (url) => {
        if (window.desktopBridge) {
          const opened = await window.desktopBridge.openExternal(url);
          if (!opened) {
            throw new Error("Unable to open link.");
          }
          return;
        }

        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
    contextMenu: {
      show: async <T extends string>(
        items: readonly ContextMenuItem<T>[],
        position?: { x: number; y: number },
      ): Promise<T | null> => {
        if (window.desktopBridge) {
          return window.desktopBridge.showContextMenu(items, position) as Promise<T | null>;
        }
        return showContextMenuFallback(items, position);
      },
    },
    persistence: {
      getClientSettings: async () => {
        if (window.desktopBridge) {
          return window.desktopBridge.getClientSettings();
        }
        return readBrowserClientSettings();
      },
      setClientSettings: async (settings) => {
        if (window.desktopBridge) {
          return window.desktopBridge.setClientSettings(settings);
        }
        writeBrowserClientSettings(settings);
      },
    },
    server: {
      getConfig: () => Promise.reject(unavailableLocalBackendError()),
      refreshProviders: () => Promise.reject(unavailableLocalBackendError()),
      updateProvider: () => Promise.reject(unavailableLocalBackendError()),
      upsertKeybinding: () => Promise.reject(unavailableLocalBackendError()),
      removeKeybinding: () => Promise.reject(unavailableLocalBackendError()),
      getSettings: () => Promise.reject(unavailableLocalBackendError()),
      updateSettings: () => Promise.reject(unavailableLocalBackendError()),
      discoverSourceControl: () => Promise.reject(unavailableLocalBackendError()),
      getTraceDiagnostics: () => Promise.reject(unavailableLocalBackendError()),
      getProcessDiagnostics: () => Promise.reject(unavailableLocalBackendError()),
      getProcessResourceHistory: () => Promise.reject(unavailableLocalBackendError()),
      signalProcess: () => Promise.reject(unavailableLocalBackendError()),
      cursorLocalHistoryDryRun: () => Promise.reject(unavailableLocalBackendError()),
      cursorLocalHistoryImport: () => Promise.reject(unavailableLocalBackendError()),
      claudeLocalHistoryDryRun: () => Promise.reject(unavailableLocalBackendError()),
      claudeLocalHistoryImport: () => Promise.reject(unavailableLocalBackendError()),
    },
  };
}

export function createLocalApi(): LocalApi {
  return createBrowserLocalApi();
}

export function readLocalApi(): LocalApi | undefined {
  if (typeof window === "undefined") return undefined;
  if (cachedApi) return cachedApi;

  cachedApi = createLocalApi();
  return cachedApi;
}

export function ensureLocalApi(): LocalApi {
  const api = readLocalApi();
  if (!api) {
    throw new Error("Local API not found");
  }
  return api;
}

export async function __resetLocalApiForTests() {
  cachedApi = undefined;
  const { __resetClientSettingsPersistenceForTests } = await import("./hooks/useSettings");
  __resetClientSettingsPersistenceForTests();
  resetRequestLatencyStateForTests();
}
