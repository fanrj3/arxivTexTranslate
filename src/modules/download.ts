/**
 * Download arXiv source tar.gz and extract using pako.
 * File I/O uses global IOUtils (Firefox 115+, available in Zotero 7).
 */

import pako from "pako";

const IOUtils = (globalThis as any).IOUtils;

async function writeFile(path: string, data: Uint8Array): Promise<void> {
  await IOUtils.write(path, data);
}

async function makeDir(path: string): Promise<void> {
  await IOUtils.makeDirectory(path, { createAncestors: true });
}

async function fileExists(path: string): Promise<boolean> {
  try { return await IOUtils.exists(path); } catch { return false; }
}

export interface PaperStructure {
  mainTex: string | null;
  bibFiles: string[];
  tableFiles: string[];
  figureDirs: string[];
  clsFiles: string[];
  styFiles: string[];
  bstFiles: string[];
  otherTex: string[];
}

const IMG_EXTENSIONS = [".png", ".jpg", ".jpeg", ".pdf", ".eps"];

export async function downloadSource(
  arxivId: string,
  outputDir: string,
  onProgress?: (downloaded: number, total: number) => void,
): Promise<string> {
  const url = `https://arxiv.org/src/${arxivId}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": "arxiv-translate-zotero/1.0" },
  });
  if (resp.status === 404) throw new Error(`arXiv ${arxivId} has no source package`);
  if (!resp.ok) throw new Error(`Download failed: HTTP ${resp.status}`);

  const buf = await resp.arrayBuffer();
  const data = new Uint8Array(buf);
  if (onProgress) onProgress(data.length, data.length);

  const decompressed = pako.ungzip(data);
  const extractDir = outputDir;
  await makeDir(extractDir);

  // Parse tar and write text files
  let pos = 0;
  let written = 0;
  while (pos < decompressed.length) {
    if (pos + 512 > decompressed.length) break;
    const header = decompressed.slice(pos, pos + 512);

    let allZero = true;
    for (let i = 0; i < 512; i++) { if (header[i] !== 0) { allZero = false; break; } }
    if (allZero) break;

    let filename = "";
    for (let i = 0; i < 100; i++) { if (header[i] === 0) break; filename += String.fromCharCode(header[i]); }

    let sizeStr = "";
    for (let i = 124; i < 136; i++) { if (header[i] === 0 || header[i] === 32) break; sizeStr += String.fromCharCode(header[i]); }
    const fileSize = parseInt(sizeStr, 8) || 0;
    const typeFlag = header[156];

    pos += 512;
    const content = decompressed.slice(pos, pos + fileSize);
    pos += Math.ceil(fileSize / 512) * 512;

    if (!filename || fileSize === 0) continue;
    if (typeFlag !== 0x30 && typeFlag !== 0 && typeFlag !== 0x00) continue;
    filename = filename.replace(/^\.\//, "").replace(/^\/+/, "");
    if (!filename) continue;

    const fullPath = extractDir + "\\" + filename.replace(/\//g, "\\");
    const dir = fullPath.substring(0, fullPath.lastIndexOf("\\"));
    if (dir) await makeDir(dir);
    await writeFile(fullPath, content);
    written++;
  }
  return extractDir;
}

export async function findMainTex(paperDir: string): Promise<string | null> {
  const candidates = ["main.tex", "paper.tex", "article.tex", "ms.tex", "root.tex"];
  // Use a simple sync check via Zotero.File if available
  for (const c of candidates) {
    const p = paperDir + "\\" + c;
    try {
      const content = (Zotero as any).File?.getContents?.(p);
      if (content && content.includes("\\documentclass") && content.includes("\\begin{document")) return p;
    } catch {}
  }
  // Walk the dir looking for any .tex with \documentclass
  try {
    const entries = IOUtils.getChildren(paperDir);
    for (const entry of entries) {
      const p = paperDir + "\\" + entry;
      if (!entry.endsWith(".tex")) continue;
      try {
        const bytes = await IOUtils.read(p);
        const text = new TextDecoder().decode(bytes);
        if (text.includes("\\documentclass")) return p;
      } catch {}
    }
  } catch {}
  return null;
}

export async function analyzePaper(paperDir: string): Promise<PaperStructure> {
  const result: PaperStructure = {
    mainTex: null, bibFiles: [], tableFiles: [],
    figureDirs: [], clsFiles: [], styFiles: [], bstFiles: [], otherTex: [],
  };
  const main = await findMainTex(paperDir);
  result.mainTex = main;
  return result;
}
