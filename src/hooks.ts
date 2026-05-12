import { getString, initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";
import { TranslationPipeline } from "./pipeline";
import { TranslationStateManager } from "./modules/state";
import { registerTranslationMenu, registerSearchCommand } from "./ui/menu";
import { registerTranslationSection } from "./ui/itemPane";
import { ArxivServiceClient } from "./modules/serviceClient";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  // Register preferences pane
  Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    src: `chrome://${addon.data.config.addonRef}/content/preferences.xhtml`,
    label: getString("prefs-title"),
    image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
  });

  // Register item notifier
  registerTranslationNotifier();

  // Initialize state manager and pipeline
  addon.data.stateManager = new TranslationStateManager();
  addon.data.pipeline = new TranslationPipeline();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  // Startup notification
  const popupWin = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  })
    .createLine({ text: getString("startup-begin"), type: "default", progress: 0 })
    .show();

  // Register right-click translation menus
  registerTranslationMenu();

  // Register Tools menu search command
  registerSearchCommand(win);

  // Register item pane status section
  registerTranslationSection();

  await Zotero.Promise.delay(500);

  popupWin.changeLine({ progress: 100, text: getString("startup-finish") });
  popupWin.startCloseTimer(3000);
}

async function onMainWindowUnload(_win: Window): Promise<void> {
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
}

function onShutdown(): void {
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

function registerTranslationNotifier(): void {
  const callback = {
    notify: async (
      event: string,
      type: string,
      ids: Array<string | number>,
      _extraData: Record<string, any>,
    ) => {
      if (!addon?.data.alive) return;

      // Clean up state when items are deleted
      if (event === "delete" && type === "item") {
        const sm = addon.data.stateManager;
        if (sm) {
          for (const id of ids) {
            sm.deleteByItem(Number(id));
          }
        }
      }
    },
  };

  Zotero.Notifier.registerObserver(callback, ["item"]);
}

async function onPrefsEvent(type: string, data: Record<string, any>): Promise<void> {
  const service = new ArxivServiceClient();
  switch (type) {
    case "load":
      // Bind preferences UI
      break;
    case "verifyService":
      try {
        await service.verifyService();
        data.window?.alert?.(`Service is reachable: ${service.baseUrl}`);
      } catch (e: any) {
        data.window?.alert?.(`Service check failed: ${e?.message || e}`);
      }
      break;
    default:
      break;
  }
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify: () => {},
  onPrefsEvent,
};
