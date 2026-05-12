/**
 * Extract arXiv source tar.gz using pako + tar.
 */

import pako from "pako";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import path from "path";

const SEP = path.sep;

export function extractTarGz(tarGzPath, outputDir) {
  const data = readFileSync(tarGzPath);
  const decompressed = pako.ungzip(data);

  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

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
    if (typeFlag !== 0x30 && typeFlag !== 0 && typeFlag !== 0x00) continue; // files only

    filename = filename.replace(/^\.\//, "").replace(/^\/+/, "");
    if (!filename) continue;

    const fullPath = path.join(outputDir, filename);
    const dir = path.dirname(fullPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, content);
    written++;
  }
  return { outputDir, filesWritten: written };
}

export function findMainTex(dir) {
  const candidates = ["main.tex", "paper.tex", "article.tex", "ms.tex", "root.tex"];
  for (const c of candidates) {
    const p = path.join(dir, c);
    if (existsSync(p)) return p;
  }
  return null;
}
