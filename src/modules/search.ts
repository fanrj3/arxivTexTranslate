/**
 * arXiv API search via Atom XML.
 * Supports field prefixes: au:, ti:, cat:, abs:, all:
 */

import { getPref } from "../utils/prefs";

const ARXIV_API = "https://export.arxiv.org/api/query";
const MAX_RETRIES = 3;
const RETRY_BACKOFF = 2000;

const RE_ARXIV_ID = /(?:arxiv:)?(\d{4}\.\d{4,5})(?:v\d+)?/i;
const RE_ARXIV_URL = /arxiv\.org\/(?:abs|pdf|src)\/(\d{4}\.\d{4,5})/i;
const RE_FIELD_PREFIX = /^(au(?:thor)?|ti(?:tle)?|abs(?:tract)?|cat(?:egory)?|all):\s*/i;

const FIELD_MAP: Record<string, string> = {
  au: "au", author: "au",
  ti: "ti", title: "ti",
  abs: "abs", abstract: "abs",
  cat: "cat", category: "cat",
  all: "all",
};

const FIELD_LABELS: Record<string, string> = {
  au: "Author",
  ti: "Title",
  abs: "Abstract",
  cat: "Category",
  all: "All fields",
};

const FIELD_LABELS_ZH: Record<string, string> = {
  au: "作者",
  ti: "标题",
  abs: "摘要",
  cat: "分类",
  all: "全部字段",
};

export interface PaperInfo {
  arxivId: string;
  title: string;
  authors: string[];
  summary: string;
  published: string;
  updated: string;
  category: string;
  pdfUrl: string;
  srcUrl: string;
  authorLine: string;
}

export function isArxivId(text: string): string | null {
  const s = text.trim();
  const m = RE_ARXIV_ID.exec(s);
  if (m) return m[1];
  const u = RE_ARXIV_URL.exec(s);
  if (u) return u[1];
  return null;
}

export function buildQuery(userInput: string): {
  apiQuery: string;
  displayLabel: string;
  displayLabelZh: string;
} {
  let remaining = userInput.trim();
  const parts: string[] = [];
  const labels: string[] = [];
  const labelsZh: string[] = [];

  while (true) {
    const m = RE_FIELD_PREFIX.exec(remaining);
    if (!m) break;
    const prefixKey = m[1].toLowerCase();
    const field = FIELD_MAP[prefixKey] || "all";
    remaining = remaining.slice(m[0].length).trim();

    const next = RE_FIELD_PREFIX.exec(remaining);
    let value: string;
    if (next) {
      value = remaining.slice(0, next.index).trim();
      remaining = remaining.slice(next.index);
    } else {
      value = remaining.trim();
      remaining = "";
    }

    if (value) {
      parts.push(`${field}:${value}`);
      labels.push(FIELD_LABELS[field] || field);
      labelsZh.push(FIELD_LABELS_ZH[field] || field);
    }
  }

  if (parts.length === 0) {
    parts.push(`all:${userInput.trim()}`);
    labels.push("All fields");
    labelsZh.push("全部字段");
  }

  return {
    apiQuery: parts.join(" AND "),
    displayLabel: labels.join(" + "),
    displayLabelZh: labelsZh.join(" + "),
  };
}

async function apiFetch(url: string): Promise<string> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await Zotero.HTTP.request("GET", url, {
        headers: { "User-Agent": "arxiv-translate-zotero/1.0" },
        responseType: "text",
      });
      if (resp.status !== 200) {
        throw new Error(`HTTP ${resp.status}`);
      }
      return resp.responseText;
    } catch (e: any) {
      lastError = e;
      const code = e?.status;
      if (code && [502, 503, 504, 429].includes(code)) {
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_BACKOFF * Math.pow(2, attempt));
          continue;
        }
      }
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BACKOFF * Math.pow(2, attempt));
        continue;
      }
    }
  }
  throw lastError!;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => Zotero.Promise.delay?.(ms) || setTimeout(r, ms));
}

function parseAtom(xmlText: string): PaperInfo[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "text/xml");
  const entries = doc.getElementsByTagNameNS(
    "http://www.w3.org/2005/Atom",
    "entry",
  );

  const papers: PaperInfo[] = [];
  const atomNS = "http://www.w3.org/2005/Atom";
  const arxivNS = "http://arxiv.org/schemas/atom";

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];

    const idUrl = getTextNS(entry, atomNS, "id") || "";
    const idMatch = RE_ARXIV_ID.exec(idUrl);
    const arxivId = idMatch ? idMatch[1] : idUrl;

    const title = cleanWS(getTextNS(entry, atomNS, "title") || "");
    const summary = cleanWS(getTextNS(entry, atomNS, "summary") || "");
    const published = (getTextNS(entry, atomNS, "published") || "").slice(0, 10);
    const updated = (getTextNS(entry, atomNS, "updated") || "").slice(0, 10);

    const authors: string[] = [];
    const authorEls = entry.getElementsByTagNameNS(atomNS, "author");
    for (let j = 0; j < authorEls.length; j++) {
      const name = getTextNS(authorEls[j], atomNS, "name")?.trim();
      if (name) authors.push(name);
    }

    const catEls = entry.getElementsByTagNameNS(arxivNS, "primary_category");
    const category = catEls[0]?.getAttribute("term") || "";

    const authorLine = formatAuthorLine(authors);

    papers.push({
      arxivId,
      title,
      authors,
      summary,
      published,
      updated,
      category,
      pdfUrl: `https://arxiv.org/pdf/${arxivId}`,
      srcUrl: `https://arxiv.org/src/${arxivId}`,
      authorLine,
    });
  }
  return papers;
}

function getTextNS(
  el: Element,
  ns: string,
  localName: string,
): string | null {
  const children = el.getElementsByTagNameNS(ns, localName);
  return children[0]?.textContent ?? null;
}

function cleanWS(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function formatAuthorLine(authors: string[]): string {
  const names = authors.slice(0, 3).map((a) => {
    const parts = a.split(",");
    if (parts.length === 2) return `${parts[1].trim()} ${parts[0].trim()}`;
    return a;
  });
  let line = names.join(", ");
  if (authors.length > 3) line += " et al.";
  return line;
}

export async function searchArxiv(
  query: string,
  maxResults = 8,
): Promise<{ papers: PaperInfo[]; displayLabel: string; displayLabelZh: string }> {
  const { apiQuery, displayLabel, displayLabelZh } = buildQuery(query);
  const params = new URLSearchParams({
    search_query: apiQuery,
    start: "0",
    max_results: String(maxResults),
    sortBy: "relevance",
    sortOrder: "descending",
  });
  const url = `${ARXIV_API}?${params.toString()}`;
  const raw = await apiFetch(url);
  return { papers: parseAtom(raw), displayLabel, displayLabelZh };
}

export async function getPaper(arxivId: string): Promise<PaperInfo | null> {
  const params = new URLSearchParams({
    search_query: `id:${arxivId}`,
    start: "0",
    max_results: "1",
  });
  const url = `${ARXIV_API}?${params.toString()}`;
  const raw = await apiFetch(url);
  const papers = parseAtom(raw);
  return papers[0] || null;
}
