import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type Locale = "zh-CN" | "en-US";

const dictionaries = {
  "zh-CN": {
    "app.subtitle": "\u8bba\u6587\u7ffb\u8bd1\u3001\u7f16\u8bd1\u4e0e\u672c\u5730\u7ba1\u7406",
    "app.refresh": "\u5237\u65b0",
    "app.settings": "\u8bbe\u7f6e",
    "app.backHome": "\u8fd4\u56de\u5de5\u4f5c\u53f0",
    "app.backList": "\u8fd4\u56de\u5217\u8868",
    "app.language": "\u8bed\u8a00",
    "app.chinese": "\u4e2d\u6587",
    "app.english": "English",
    "status.compiled": "\u5df2\u7f16\u8bd1",
    "status.translated": "\u5df2\u7ffb\u8bd1",
    "status.extracted": "\u5df2\u89e3\u5305",
    "status.empty": "\u7a7a\u4efb\u52a1",
    "status.running": "\u8fd0\u884c\u4e2d",
    "status.idle": "\u7a7a\u95f2",
    "home.title": "\u8bba\u6587\u5de5\u4f5c\u53f0",
    "home.description": "\u628a\u6e90\u7801\u62c9\u53d6\u3001\u7ffb\u8bd1\u3001\u7f16\u8bd1\u548c\u7ed3\u679c\u7ba1\u7406\u653e\u5728\u4e00\u4e2a\u73b0\u4ee3\u5316\u63a7\u5236\u53f0\u91cc\u3002",
    "home.searchPlaceholder": "\u641c\u7d22\u6807\u9898\u6216 arXiv ID",
    "home.totalPapers": "\u5168\u90e8\u8bba\u6587",
    "home.translated": "\u5df2\u7ffb\u8bd1",
    "home.compiled": "\u5df2\u7f16\u8bd1",
    "home.estimatedCost": "\u9884\u4f30\u8d39\u7528",
    "home.quickStart": "\u5feb\u901f\u5f00\u59cb",
    "home.quickStartDescription": "\u62c9\u53d6 arXiv \u6e90\u7801\u6216\u5bfc\u5165\u672c\u5730\u6e90\u7801\u5305\u3002",
    "home.arxivInput": "arXiv ID \u6216 URL",
    "home.arxivPlaceholder": "arXiv ID\u3001URL \u6216\u5173\u952e\u8bcd",
    "home.searchOrFetch": "\u641c\u7d22\u6216\u62c9\u53d6\u6e90\u7801",
    "home.uploadTar": "\u9009\u62e9\u6216\u62d6\u5165 .tar.gz",
    "home.uploadHint": "\u81ea\u52a8\u89e3\u5305\u3001\u8bc6\u522b\u4e3b tex \u6587\u4ef6\uff0c\u5e76\u4fdd\u5b58\u4e3a\u672c\u5730\u4efb\u52a1\u3002",
    "home.uploading": "\u6b63\u5728\u5bfc\u5165\u6e90\u7801\u5305",
    "home.uploadingHint": "\u6b63\u5728\u89e3\u5305\u5e76\u8bc6\u522b\u4e3b tex \u6587\u4ef6...",
    "home.runtime": "\u8fd0\u884c\u72b6\u6001",
    "home.runtimeDescription": "\u5f53\u524d\u540e\u53f0\u4efb\u52a1\u548c\u7f16\u8bd1\u5b8c\u6210\u5ea6\u3002",
    "home.backgroundTasks": "\u540e\u53f0\u4efb\u52a1",
    "home.pdfOutput": "PDF \u4ea7\u51fa",
    "home.tokenTotal": "Token \u603b\u91cf",
    "home.emptyTitle": "\u8fd8\u6ca1\u6709\u8bba\u6587\u4efb\u52a1",
    "home.emptyDescription": "\u8f93\u5165 arXiv ID \u6216\u62d6\u5165\u6e90\u7801\u5305\u6765\u521b\u5efa\u7b2c\u4e00\u4e2a\u4efb\u52a1\u3002",
    "job.files": "\u4e2a\u6587\u4ef6",
    "job.openPdf": "\u6253\u5f00 PDF",
    "job.compare": "\u53cc\u9875\u5bf9\u7167",
    "job.compile": "\u7f16\u8bd1 PDF",
    "job.translate": "\u7ffb\u8bd1\u4e2d\u6587",
    "job.folder": "\u76ee\u5f55",
    "job.openFolder": "\u6253\u5f00\u76ee\u5f55",
    "job.delete": "\u5220\u9664\u4efb\u52a1",
    "job.feedback": "\u53cd\u9988",
    "job.openFeedbackFolder": "\u67e5\u770b\u53cd\u9988\u6587\u4ef6\u5939",
    "job.model": "\u6a21\u578b",
    "job.outputTokens": "\u8f93\u51fa Tokens",
    "job.parallelTranslation": "Tex \u5e76\u884c\u7ffb\u8bd1",
    "job.streamingOutput": "\u5b9e\u65f6\u7ffb\u8bd1\u8f93\u51fa",
    "job.streamingOutputDesc": "\u6b63\u5728\u663e\u793a\u6a21\u578b\u8fd4\u56de\u7684\u6700\u65b0\u5185\u5bb9",
    "job.rawLogs": "\u67e5\u770b\u539f\u59cb\u65e5\u5fd7",
    "job.starting": "\u542f\u52a8\u4e2d",
    "job.compiling": "\u7f16\u8bd1\u4e2d",
    "job.packaging": "\u6253\u5305\u4e2d",
    "compare.original": "\u82f1\u6587\u539f\u6587",
    "compare.translated": "\u4e2d\u6587\u8bd1\u6587",
    "compare.ready": "\u9875\u540c\u6b65",
    "compare.openTranslated": "\u4e2d\u6587 PDF",
    "compare.preparing": "\u6b63\u5728\u51c6\u5907\u53cc\u9875 PDF \u5bf9\u7167...",
    "compare.preparingShort": "\u51c6\u5907\u4e2d",
    "compare.failed": "\u51c6\u5907\u5931\u8d25",
    "compare.readyToast": "\u53cc\u9875\u5bf9\u7167\u5df2\u51c6\u5907\u597d",
    "compare.error": "\u53cc\u9875\u5bf9\u7167\u51c6\u5907\u5931\u8d25",
    "settings.title": "\u8bbe\u7f6e",
    "settings.description": "API\u3001LaTeX \u7f16\u8bd1\u5668\u548c\u66f4\u65b0\u68c0\u67e5\u3002",
    "settings.translationApi": "\u7ffb\u8bd1 API",
    "settings.translationApiDesc": "\u914d\u7f6e\u4f1a\u4fdd\u5b58\u5728\u672c\u673a\uff0c\u4ec5\u7528\u4e8e\u5f53\u524d\u5e94\u7528\u53d1\u8d77\u7ffb\u8bd1\u8bf7\u6c42\u3002",
    "settings.save": "\u4fdd\u5b58\u8bbe\u7f6e",
    "settings.verifyApi": "\u9a8c\u8bc1 API Key",
    "settings.latexCompiler": "LaTeX \u7f16\u8bd1\u5668",
    "settings.latexCompilerDesc": "\u9ed8\u8ba4\u81ea\u52a8\u67e5\u627e xelatex\uff1b\u4e5f\u53ef\u4ee5\u6307\u5b9a MiKTeX \u6216 TeX Live \u7684\u5b8c\u6574\u8def\u5f84\u3002",
    "settings.xelatexPath": "xelatex \u8def\u5f84",
    "settings.autoDetect": "\u81ea\u52a8\u68c0\u6d4b",
    "settings.clearPath": "\u6e05\u7a7a\u81ea\u5b9a\u4e49\u8def\u5f84",
    "settings.downloadMiktex": "\u4e0b\u8f7d MiKTeX",
    "settings.update": "\u68c0\u67e5\u66f4\u65b0",
    "settings.updateDesc": "\u901a\u8fc7 GitHub Releases \u68c0\u67e5\u5f53\u524d\u5e94\u7528\u7248\u672c\u3002"
  },
  "en-US": {
    "app.subtitle": "Paper translation, compilation, and local management",
    "app.refresh": "Refresh",
    "app.settings": "Settings",
    "app.backHome": "Back to workspace",
    "app.backList": "Back to list",
    "app.language": "Language",
    "app.chinese": "Chinese",
    "app.english": "English",
    "status.compiled": "Compiled",
    "status.translated": "Translated",
    "status.extracted": "Extracted",
    "status.empty": "Empty",
    "status.running": "Running",
    "status.idle": "Idle",
    "home.title": "Paper Workspace",
    "home.description": "Fetch source packages, translate, compile, and manage results in one modern console.",
    "home.searchPlaceholder": "Search title or arXiv ID",
    "home.totalPapers": "All papers",
    "home.translated": "Translated",
    "home.compiled": "Compiled",
    "home.estimatedCost": "Estimated cost",
    "home.quickStart": "Quick Start",
    "home.quickStartDescription": "Fetch arXiv source or import a local source package.",
    "home.arxivInput": "arXiv ID or URL",
    "home.arxivPlaceholder": "arXiv ID, URL, or keyword",
    "home.searchOrFetch": "Search or fetch source",
    "home.uploadTar": "Choose or drop .tar.gz",
    "home.uploadHint": "Automatically unpack, detect the main tex file, and save as a local task.",
    "home.uploading": "Importing source package",
    "home.uploadingHint": "Unpacking and detecting the main tex file...",
    "home.runtime": "Runtime",
    "home.runtimeDescription": "Current background tasks and PDF build progress.",
    "home.backgroundTasks": "Background tasks",
    "home.pdfOutput": "PDF output",
    "home.tokenTotal": "Token total",
    "home.emptyTitle": "No paper tasks yet",
    "home.emptyDescription": "Enter an arXiv ID or drop a source package to create the first task.",
    "job.files": "files",
    "job.openPdf": "Open PDF",
    "job.compare": "Compare",
    "job.compile": "Compile PDF",
    "job.translate": "Translate",
    "job.folder": "Folder",
    "job.openFolder": "Open folder",
    "job.delete": "Delete task",
    "job.feedback": "Feedback",
    "job.openFeedbackFolder": "Open feedback folder",
    "job.model": "Model",
    "job.outputTokens": "Output tokens",
    "job.parallelTranslation": "Parallel Tex translation",
    "job.streamingOutput": "Live translation output",
    "job.streamingOutputDesc": "Showing the latest model output",
    "job.rawLogs": "View raw logs",
    "job.starting": "Starting",
    "job.compiling": "Compiling",
    "job.packaging": "Packaging",
    "compare.original": "English Original",
    "compare.translated": "Chinese Translation",
    "compare.ready": "pages synced",
    "compare.openTranslated": "Chinese PDF",
    "compare.preparing": "Preparing side-by-side PDF comparison...",
    "compare.preparingShort": "Preparing",
    "compare.failed": "Failed",
    "compare.readyToast": "Side-by-side comparison is ready",
    "compare.error": "Failed to prepare side-by-side comparison",
    "settings.title": "Settings",
    "settings.description": "API, LaTeX compiler, and update checks.",
    "settings.translationApi": "Translation API",
    "settings.translationApiDesc": "Settings are stored locally and used only by this app for translation requests.",
    "settings.save": "Save settings",
    "settings.verifyApi": "Verify API Key",
    "settings.latexCompiler": "LaTeX Compiler",
    "settings.latexCompilerDesc": "The app auto-detects xelatex by default; you can also specify a full MiKTeX or TeX Live path.",
    "settings.xelatexPath": "xelatex path",
    "settings.autoDetect": "Auto detect",
    "settings.clearPath": "Clear custom path",
    "settings.downloadMiktex": "Download MiKTeX",
    "settings.update": "Check updates",
    "settings.updateDesc": "Check the current app version through GitHub Releases."
  }
} satisfies Record<Locale, Record<string, string>>;

type I18nContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  isSwitching: boolean;
  t: (key: string, fallback?: string) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

function initialLocale(): Locale {
  const saved = localStorage.getItem("locale");
  if (saved === "zh-CN" || saved === "en-US") return saved;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => initialLocale());
  const [isSwitching, setIsSwitching] = useState(false);

  useEffect(() => {
    localStorage.setItem("locale", locale);
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((nextLocale: Locale) => {
    if (nextLocale === locale) return;

    const updateLocale = () => setLocaleState(nextLocale);
    const finishSwitching = () => {
      window.setTimeout(() => setIsSwitching(false), 80);
    };
    const viewTransitionDocument = document as Document & {
      startViewTransition?: (callback: () => void) => { finished: Promise<void> };
    };

    setIsSwitching(true);
    if (viewTransitionDocument.startViewTransition) {
      const transition = viewTransitionDocument.startViewTransition(updateLocale);
      transition.finished.finally(finishSwitching);
      return;
    }

    window.requestAnimationFrame(updateLocale);
    window.setTimeout(finishSwitching, 260);
  }, [locale]);

  const value = useMemo<I18nContextValue>(() => ({
    locale,
    setLocale,
    isSwitching,
    t: (key, fallback) => dictionaries[locale][key] || dictionaries["zh-CN"][key] || fallback || key,
  }), [isSwitching, locale, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}
