import { getPref } from "./utils/prefs";
import { mkdir, norm, pathStr, writeBinary } from "./utils/path";
import {
  ArxivServiceClient,
  CompileEvent,
  ServiceTaskEvent,
} from "./modules/serviceClient";
import {
  PaperRecord,
  PaperStatus,
  TranslationStateManager,
} from "./modules/state";
import { StepProgress } from "./ui/progress";

function getOutputDir(): string {
  const pref = pathStr(getPref("outputDir"));
  if (pref) return pref;

  const Z = ztoolkit.getGlobal("Zotero");
  let base = "";
  const dataDir = Z?.Prefs?.get?.("dataDir");
  if (typeof dataDir === "string" && dataDir) base = norm(dataDir);

  if (!base) {
    try {
      const profD = (globalThis as any).Services?.dirsvc?.get?.(
        "ProfD",
        (globalThis as any).Ci?.nsIFile,
      );
      if (profD?.path) base = norm(profD.path);
    } catch {}
  }

  const zd = !base ? Z?.getZoteroDirectory?.() : null;
  if (!base && zd?.path) base = norm(zd.path);

  return base ? `${base}\\arxiv-translate` : "";
}

function sanitizeFileName(value: string): string {
  return (value || "paper")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "paper";
}

function formatTranslateDetail(event: ServiceTaskEvent): string {
  const parts: string[] = [];
  if (event.activeFile) parts.push(event.activeFile);
  if (typeof event.progress === "number") parts.push(`${Math.round(event.progress)}%`);
  if (event.stats?.tokens) parts.push(`${event.stats.tokens} tokens`);
  if (event.stats?.tps) parts.push(`${event.stats.tps.toFixed(1)} tok/s`);
  return parts.join(" · ") || event.phase || event.status || "";
}

function formatCompileDetail(event: CompileEvent): string {
  if (event.type === "start" && event.mainTex) return `主文件 ${event.mainTex}`;
  if (event.type === "step" && event.step) {
    return `${event.step}${event.exitCode ? " · 检查 PDF 输出" : ""}`;
  }
  if (event.type === "done") {
    return event.hasLatexErrors ? "PDF 已生成，有 LaTeX 警告" : "PDF 已生成";
  }
  return event.message || "";
}

export class TranslationPipeline {
  stateManager: TranslationStateManager;
  private service: ArxivServiceClient;

  constructor() {
    this.stateManager = new TranslationStateManager();
    this.service = new ArxivServiceClient();
  }

  async run(item: Zotero.Item, arxivId: string): Promise<boolean> {
    const outputDir = getOutputDir();
    const localDir = outputDir ? `${outputDir}\\${arxivId}` : "";
    const steps = new StepProgress(this.service.baseUrl);

    try {
      steps.addStep("service");
      await this.service.verifyService();
      steps.completeStep("service", this.service.baseUrl);

      steps.addStep("import");
      const imported = await this.service.fetchArxiv(arxivId);
      const title = item.getField("title") || imported.title || arxivId;
      const jobId = imported.jobId || arxivId;
      steps.completeStep(
        "import",
        imported.existing ? "服务中已有任务" : `${imported.fileCount || "?"} 个文件`,
      );

      const baseRecord: PaperRecord = {
        arxivId,
        title,
        status: PaperStatus.DOWNLOADED,
        paperDir: localDir,
        mainTex: imported.mainTex || "",
        cnTex: "",
        pdfPath: "",
        itemID: item.id,
        errorMsg: "",
        updatedAt: Date.now(),
        serviceUrl: this.service.baseUrl,
        jobId,
      };
      await this.stateManager.put(baseRecord);
      await TranslationStateManager.setItemArxivId(item, arxivId);

      steps.addStep("translate");
      await this.stateManager.setStatus(arxivId, PaperStatus.TRANSLATING);
      const translation = await this.service.startTranslation(jobId);
      const finalTranslation = await this.service.streamTranslation(
        translation.taskId,
        (event) => {
          steps.updateStep(
            "translate",
            Math.max(10, Math.min(99, event.progress || 50)),
            formatTranslateDetail(event),
          );
        },
      );
      if (finalTranslation?.status === "error") {
        throw new Error(finalTranslation.result?.error || "Translation failed");
      }
      if (finalTranslation?.status === "partial_error") {
        throw new Error("Translation partially failed. Open the service UI for details.");
      }
      steps.completeStep("translate", "翻译完成");
      await this.stateManager.setStatus(arxivId, PaperStatus.TRANSLATED);

      const pdfPath = await this.compileAndDownload(jobId, localDir, title, steps);
      await this.attachPdf(item.id, pdfPath, title);
      steps.completeStep("attach", "已添加附件");
      steps.done();

      await this.stateManager.put({
        ...baseRecord,
        status: PaperStatus.COMPILED,
        pdfPath,
        updatedAt: Date.now(),
      });
      return true;
    } catch (e: any) {
      const message = e?.message || String(e);
      steps.fail(message);
      const rec = await this.stateManager.get(arxivId);
      const failedStatus = rec?.status === PaperStatus.TRANSLATING
        ? PaperStatus.TRANSLATE_FAILED
        : PaperStatus.COMPILE_FAILED;
      if (rec) await this.stateManager.setStatus(arxivId, failedStatus, message);
      throw e;
    }
  }

  async retryTranslate(item: Zotero.Item, arxivId: string): Promise<boolean> {
    return this.run(item, arxivId);
  }

  async retryCompile(item: Zotero.Item, arxivId: string): Promise<boolean> {
    const rec = await this.stateManager.get(arxivId);
    if (!rec?.jobId) return this.run(item, arxivId);

    const steps = new StepProgress(rec.serviceUrl || this.service.baseUrl);
    try {
      const pdfPath = await this.compileAndDownload(
        rec.jobId,
        rec.paperDir || `${getOutputDir()}\\${arxivId}`,
        rec.title || item.getField("title") || arxivId,
        steps,
      );
      await this.attachPdf(item.id, pdfPath, rec.title || item.getField("title") || arxivId);
      steps.completeStep("attach", "已添加附件");
      steps.done();
      await this.stateManager.put({
        ...rec,
        status: PaperStatus.COMPILED,
        pdfPath,
        errorMsg: "",
        updatedAt: Date.now(),
      });
      return true;
    } catch (e: any) {
      const message = e?.message || String(e);
      steps.fail(message);
      await this.stateManager.setStatus(arxivId, PaperStatus.COMPILE_FAILED, message);
      throw e;
    }
  }

  private async compileAndDownload(
    jobId: string,
    localDir: string,
    title: string,
    steps: StepProgress,
  ): Promise<string> {
    steps.addStep("compile");
    const finalCompile = await this.service.compile(jobId, (event) => {
      if (!event.type) return;
      steps.updateStep("compile", event.type === "done" ? 99 : 55, formatCompileDetail(event));
    });
    if (!finalCompile?.success) {
      throw new Error(finalCompile?.log || finalCompile?.message || "PDF compilation failed");
    }
    if (finalCompile.hasLatexErrors) {
      throw new Error("PDF was generated but LaTeX reported hard errors. Open the service UI to inspect the log before attaching it to Zotero.");
    }
    steps.completeStep(
      "compile",
      "PDF 已生成",
    );

    steps.addStep("attach");
    const pdfData = await this.service.downloadPdf(jobId);
    if (!localDir) throw new Error("No Zotero output directory available");
    await mkdir(localDir);
    const pdfPath = `${localDir}\\${sanitizeFileName(title)}_zh.pdf`;
    await writeBinary(pdfPath, pdfData);
    return pdfPath;
  }

  private async attachPdf(
    itemID: number,
    pdfPath: string,
    title: string,
  ): Promise<void> {
    const ZoteroLib: any = ztoolkit.getGlobal("Zotero");
    if (ZoteroLib.Attachments?.importFromFile) {
      await ZoteroLib.Attachments.importFromFile({
        file: pdfPath,
        parentItemID: itemID,
        title: `${title} (中文翻译)`,
      });
      return;
    }

    const attachment = new ZoteroLib.Item("attachment");
    attachment.setField("title", `${title} (中文翻译)`);
    attachment.parentID = itemID;
    attachment.setField("contentType", "application/pdf");
    attachment.setField("path", pdfPath);
    await attachment.saveTx();
  }
}
