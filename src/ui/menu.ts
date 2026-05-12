/**
 * Right-click context menu registration for arXiv translation.
 */

import { getString } from "../utils/locale";
import { TranslationPipeline } from "../pipeline";
import { TranslationStateManager } from "../modules/state";

function getPipeline(): TranslationPipeline {
  return (addon.data.pipeline as TranslationPipeline);
}

function getStateManager(): TranslationStateManager {
  return (addon.data.stateManager as TranslationStateManager);
}

export function registerTranslationMenu(): void {
  const menuIcon = `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`;

  // Main translate menu item
  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    id: "zotero-itemmenu-arxivtranslate-translate",
    label: getString("menuitem-translate"),
    icon: menuIcon,
    commandListener: async () => {
      const pane = Zotero.getActiveZoteroPane?.();
      const items = pane?.getSelectedItems?.() || [];
      if (items.length === 0) return;

      for (const item of items) {
        const arxivId = TranslationStateManager.extractArxivId(item);
        if (!arxivId) {
          ztoolkit.log("Selected item is not an arXiv paper");
          continue;
        }
        await runTranslation(item, arxivId);
      }
    },
  });

  // Submenu for additional operations
  ztoolkit.Menu.register("item", {
    tag: "menu",
    label: "arXiv Translate",
    children: [
      {
        tag: "menuitem",
        id: "zotero-itemmenu-arxivtranslate-retranslate",
        label: "重新提交到翻译服务",
        commandListener: async () => {
          const items = Zotero.getActiveZoteroPane?.()?.getSelectedItems?.() || [];
          for (const item of items) {
            const aid = TranslationStateManager.extractArxivId(item);
            if (aid) {
              const pipeline = getPipeline();
              await pipeline.retryTranslate(item, aid);
            }
          }
        },
      },
      {
        tag: "menuitem",
        id: "zotero-itemmenu-arxivtranslate-recompile",
        label: "仅重新编译并添加 PDF",
        commandListener: async () => {
          const items = Zotero.getActiveZoteroPane?.()?.getSelectedItems?.() || [];
          for (const item of items) {
            const aid = TranslationStateManager.extractArxivId(item);
            if (aid) {
              const pipeline = getPipeline();
              await pipeline.retryCompile(item, aid);
            }
          }
        },
      },
      {
        tag: "menuseparator",
      },
      {
        tag: "menuitem",
        id: "zotero-itemmenu-arxivtranslate-clear",
        label: "清除本地状态",
        commandListener: async () => {
          const items = Zotero.getActiveZoteroPane?.()?.getSelectedItems?.() || [];
          for (const item of items) {
            const aid = TranslationStateManager.extractArxivId(item);
            if (aid) {
              await getStateManager().deleteByItem(item.id);
            }
          }
        },
      },
    ],
  });
}

async function runTranslation(item: Zotero.Item, arxivId: string): Promise<void> {
  try {
    const pipeline = getPipeline();
    await pipeline.run(item, arxivId);
    await TranslationStateManager.setItemArxivId(item, arxivId);
  } catch (e: any) {
    ztoolkit.log("Translation failed:", e?.message || e);
  }
}

export function registerSearchCommand(win: Window): void {
  // Register a Zotero command that can be triggered via Tools menu or shortcut
  ztoolkit.Menu.register("menuTools", {
    tag: "menuitem",
    label: getString("menuitem-search-arxiv"),
    commandListener: () => {
      // Will be implemented as search dialog
      ztoolkit.log("Search arXiv dialog not yet implemented");
    },
  });
}
