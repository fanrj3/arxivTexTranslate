import { readText, writeText, mkdir } from "../utils/path";

const ARXIV_ID_KEY = "arxiv-translate-id";

export enum PaperStatus {
  DOWNLOADED = "downloaded",
  TRANSLATING = "translating",
  TRANSLATED = "translated",
  TRANSLATE_FAILED = "translate_failed",
  COMPILED = "compiled",
  COMPILE_FAILED = "compile_failed",
}

export interface PaperRecord {
  arxivId: string;
  title: string;
  status: PaperStatus;
  paperDir: string;
  mainTex: string;
  cnTex: string;
  pdfPath: string;
  itemID: number;
  errorMsg: string;
  updatedAt: number;
  serviceUrl?: string;
  jobId?: string;
}

export const STATUS_DISPLAY_ZH: Record<PaperStatus, string> = {
  [PaperStatus.DOWNLOADED]: "已提交到服务",
  [PaperStatus.TRANSLATING]: "服务端翻译中",
  [PaperStatus.TRANSLATED]: "翻译完成",
  [PaperStatus.TRANSLATE_FAILED]: "翻译失败",
  [PaperStatus.COMPILED]: "中文 PDF 已添加",
  [PaperStatus.COMPILE_FAILED]: "编译失败",
};

export const NEXT_ACTION: Partial<Record<PaperStatus, string>> = {
  [PaperStatus.DOWNLOADED]: "translate",
  [PaperStatus.TRANSLATED]: "compile",
  [PaperStatus.TRANSLATE_FAILED]: "retry_translate",
  [PaperStatus.COMPILE_FAILED]: "retry_compile",
};

export class TranslationStateManager {
  private stateFile: string;

  constructor() {
    const dataDir = (globalThis as any).IOUtils?.profileDir || "";
    this.stateFile = dataDir ? `${dataDir}\\arxiv-translate-state.json` : "";
  }

  async loadAll(): Promise<Record<string, PaperRecord>> {
    if (!this.stateFile) return {};
    try {
      return JSON.parse(await readText(this.stateFile));
    } catch {
      return {};
    }
  }

  async get(arxivId: string): Promise<PaperRecord | null> {
    return (await this.loadAll())[arxivId] || null;
  }

  async getByItem(itemID: number): Promise<PaperRecord | null> {
    for (const rec of Object.values(await this.loadAll())) {
      if (rec.itemID === itemID) return rec;
    }
    return null;
  }

  async put(record: PaperRecord): Promise<void> {
    const records = await this.loadAll();
    record.updatedAt = Date.now();
    records[record.arxivId] = record;
    await this.save(records);
  }

  async setStatus(
    arxivId: string,
    status: PaperStatus,
    errorMsg = "",
  ): Promise<void> {
    const rec = await this.get(arxivId);
    if (!rec) return;
    rec.status = status;
    rec.errorMsg = errorMsg;
    await this.put(rec);
  }

  async delete(arxivId: string): Promise<void> {
    const records = await this.loadAll();
    delete records[arxivId];
    await this.save(records);
  }

  async deleteByItem(itemID: number): Promise<void> {
    const records = await this.loadAll();
    for (const [key, rec] of Object.entries(records)) {
      if (rec.itemID === itemID) {
        delete records[key];
        break;
      }
    }
    await this.save(records);
  }

  async listAll(): Promise<PaperRecord[]> {
    return Object.values(await this.loadAll()).sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
  }

  async listResumable(): Promise<PaperRecord[]> {
    return (await this.listAll()).filter(
      (record) => NEXT_ACTION[record.status] !== undefined,
    );
  }

  static extractArxivId(item: Zotero.Item): string | null {
    const extra = item.getField("extra") || "";
    const fromExtra = extra.match(/arxiv-translate-id:\s*(\d{4}\.\d{4,5})/i);
    if (fromExtra) return fromExtra[1];

    const arxivInExtra = extra.match(/arXiv:\s*(\d{4}\.\d{4,5})/i);
    if (arxivInExtra) return arxivInExtra[1];

    const url = item.getField("url") || "";
    const fromUrl = url.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/i);
    if (fromUrl) return fromUrl[1];

    const doi = item.getField("DOI") || "";
    const fromDoi = doi.match(/10\.48550\/arXiv\.(\d{4}\.\d{4,5})/i);
    return fromDoi ? fromDoi[1] : null;
  }

  static async setItemArxivId(
    item: Zotero.Item,
    arxivId: string,
  ): Promise<void> {
    let extra = (item.getField("extra") || "")
      .replace(/arxiv-translate-id:.*\n?/gi, "")
      .trim();
    extra = extra
      ? `${extra}\n${ARXIV_ID_KEY}: ${arxivId}`
      : `${ARXIV_ID_KEY}: ${arxivId}`;
    item.setField("extra", extra);
    await item.saveTx();
  }

  private async save(records: Record<string, PaperRecord>): Promise<void> {
    if (!this.stateFile) return;
    const dir = this.stateFile.substring(0, this.stateFile.lastIndexOf("\\"));
    try {
      await mkdir(dir);
    } catch {}
    await writeText(this.stateFile, JSON.stringify(records, null, 2));
  }
}
