import { getString } from "../utils/locale";
import {
  PaperStatus,
  STATUS_DISPLAY_ZH,
  TranslationStateManager,
} from "../modules/state";
import { TranslationPipeline } from "../pipeline";

export function registerTranslationSection(): void {
  Zotero.ItemPaneManager.registerSection({
    paneID: "arxiv-translate-status",
    pluginID: addon.data.config.addonID,
    header: {
      l10nID: "item-section-translation-head-text",
      icon: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
    },
    sidenav: {
      l10nID: "item-section-translation-sidenav-tooltip",
      icon: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
    },
    onRender: ({ body, item }: { body: XUL.Element; item: Zotero.Item }) => {
      buildUI(body, item);
    },
  });
}

async function buildUI(body: XUL.Element, item: Zotero.Item): Promise<void> {
  const doc = body.ownerDocument;
  if (!doc) return;

  while (body.firstChild) body.removeChild(body.firstChild);

  const arxivId = TranslationStateManager.extractArxivId(item);
  const sm = addon.data.stateManager as TranslationStateManager;
  const pipeline = addon.data.pipeline as TranslationPipeline;

  const container = doc.createElement("vbox");
  container.style.padding = "8px";
  container.style.gap = "6px";

  if (!arxivId) {
    const label = doc.createElement("description");
    label.textContent = "Not an arXiv paper";
    container.appendChild(label);
    body.appendChild(container);
    return;
  }

  const record = await sm.get(arxivId);
  const statusText = record?.status
    ? STATUS_DISPLAY_ZH[record.status] || String(record.status)
    : "未添加中文翻译";

  container.appendChild(createLabel(doc, `arXiv ID: ${arxivId}`));
  container.appendChild(createLabel(
    doc,
    `${getString("item-info-row-translation-status-label")}: ${statusText}`,
  ));

  if (record?.serviceUrl) container.appendChild(createLabel(doc, `服务: ${record.serviceUrl}`));
  if (record?.errorMsg) {
    const errorLabel = createLabel(doc, record.errorMsg);
    errorLabel.style.color = "#dc2626";
    container.appendChild(errorLabel);
  }

  container.appendChild(doc.createElement("separator"));

  const translateBtn = doc.createElement("button");
  translateBtn.setAttribute("label", "一键添加中文翻译");
  translateBtn.addEventListener("command", async () => {
    translateBtn.setAttribute("label", "正在提交到服务...");
    translateBtn.setAttribute("disabled", "true");
    try {
      await pipeline.run(item, arxivId);
      await buildUI(body, item);
    } catch (e: any) {
      translateBtn.setAttribute("label", `失败: ${e?.message || e}`);
      translateBtn.removeAttribute("disabled");
    }
  });
  container.appendChild(translateBtn);

  if (record && record.status !== PaperStatus.COMPILED) {
    const retryBtn = doc.createElement("button");
    retryBtn.setAttribute("label", "重新提交到服务");
    retryBtn.addEventListener("command", async () => {
      await pipeline.retryTranslate(item, arxivId);
      await buildUI(body, item);
    });
    container.appendChild(retryBtn);
  }

  if (record?.status === PaperStatus.TRANSLATED || record?.status === PaperStatus.COMPILE_FAILED) {
    const compileBtn = doc.createElement("button");
    compileBtn.setAttribute("label", "仅重新编译并添加 PDF");
    compileBtn.addEventListener("command", async () => {
      await pipeline.retryCompile(item, arxivId);
      await buildUI(body, item);
    });
    container.appendChild(compileBtn);
  }

  if (record?.pdfPath) {
    const pdfLabel = createLabel(doc, `PDF: ${record.pdfPath}`);
    pdfLabel.style.cursor = "pointer";
    pdfLabel.style.color = "#2563eb";
    pdfLabel.style.textDecoration = "underline";
    pdfLabel.addEventListener("click", () => {
      try { (Zotero as any).launchFile?.(record.pdfPath); } catch {}
      try { (Zotero.File as any).launchFile?.(record.pdfPath); } catch {}
    });
    container.appendChild(pdfLabel);
  }

  body.appendChild(container);
}

function createLabel(doc: Document, value: string): XUL.Element {
  const label = doc.createElement("label") as unknown as XUL.Element;
  label.setAttribute("value", value);
  return label;
}
