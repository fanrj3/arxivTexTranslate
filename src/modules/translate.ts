/**
 * Translation engine — calls DeepSeek Anthropic-compatible API.
 */

import { getPref } from "../utils/prefs";
import { SYSTEM_PROMPT, USER_PROMPT_TEMPLATE } from "./prompts";
import { SEP, readText, writeText, listDir } from "../utils/path";
import type { PaperStructure } from "./download";

const MAX_OUTPUT_TOKENS = 32768;

export async function gatherFiles(paperDir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const textExts = [".tex", ".bib", ".sty", ".cls", ".bst", ".cfg", ".def", ".clo"];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 8) return;
    let entries: string[];
    try { entries = await listDir(dir); } catch (e) { ztoolkit.log(`listDir failed for ${dir}:`, e); return; }
    ztoolkit.log(`walk ${dir}: ${entries.length} entries`);

    for (const entry of entries) {
      // IOUtils.getChildren may return full paths on some platforms
      const isFullPath = entry.includes("\\") || entry.includes("/");
      const name = isFullPath ? entry.split(/[\\/]/).pop()! : entry;
      const fullPath = isFullPath ? entry : (dir + SEP + name);
      const lower = name.toLowerCase();
      const ext = lower.includes(".") ? "." + lower.split(".").pop()! : "";

      if (textExts.includes(ext) && !name.startsWith(".") && !name.endsWith("~")) {
        try {
          let content = await readText(fullPath);
          if (content) {
            if (content.length > 200_000) content = content.slice(0, 200_000) + "\n... (truncated)\n";
            const rel = fullPath.slice(paperDir.length + 1);
            files[rel] = content;
          }
        } catch {}
      } else if (![".png", ".jpg", ".pdf", ".eps"].includes(ext)) {
        // Might be a directory
        try { await walk(fullPath, depth + 1); } catch {}
      }
    }
  }

  await walk(paperDir, 0);
  ztoolkit.log(`gatherFiles: ${Object.keys(files).length} files from ${paperDir}`);
  return files;
}

export function buildUserPrompt(paperDir: string, files: Record<string, string>): string {
  const sorted = Object.entries(files).sort(([a], [b]) => {
    const la = a.toLowerCase(), lb = b.toLowerCase();
    if (la.includes("main.tex") || la.includes("paper.tex")) return -1;
    if (lb.includes("main.tex") || lb.includes("paper.tex")) return 1;
    if (la.includes("table")) return -1;
    if (lb.includes("table")) return 1;
    if (la.endsWith(".tex") && lb.endsWith(".bib")) return -1;
    if (lb.endsWith(".tex") && la.endsWith(".bib")) return 1;
    return a.localeCompare(b);
  });

  let fileBlock = "";
  for (const [relPath, content] of sorted) {
    fileBlock += `---FILE: ${relPath}---\n${content}\n---END FILE---\n\n`;
  }

  return USER_PROMPT_TEMPLATE.replace("{paper_dir}", paperDir).replace("{file_contents}", fileBlock);
}

export function parseResponse(text: string): { files: Record<string, string>; compileCmds: string | null } {
  const files: Record<string, string> = {};
  let compileCmds: string | null = null;
  const re = /---FILE:\s*(.+?)\s*---\n([\s\S]*?)---END FILE---/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) files[m[1].trim()] = m[2].trim();
  const cc = /---COMPILE---(.*?)---END COMPILE---/s.exec(text);
  if (cc) compileCmds = cc[1].trim();
  return { files, compileCmds };
}

export async function writeTranslatedFiles(paperDir: string, files: Record<string, string>): Promise<void> {
  const IO = (globalThis as any).IOUtils;
  for (const [relPath, content] of Object.entries(files)) {
    // Agent may output paths with forward slashes — normalize to backslashes
    const normalizedRel = relPath.replace(/[\\/]/g, "\\");
    const target = paperDir + "\\" + normalizedRel;
    const dir = target.substring(0, target.lastIndexOf("\\"));
    if (dir) {
      try { await IO.makeDirectory(dir, { createAncestors: true }); } catch {}
    }
    await writeText(target, content);
  }
}

async function callDeepSeekAPI(systemPrompt: string, userContent: string, onProgress?: (msg: string) => void): Promise<string> {
  const apiKey = getPref("apikey");
  const apiEndpoint = getPref("apiEndpoint");
  const model = getPref("model");
  if (!apiKey) throw new Error("API key not configured");

  const url = `${apiEndpoint}/messages`;
  const body = JSON.stringify({
    model, max_tokens: MAX_OUTPUT_TOKENS, stream: true,
    system: systemPrompt, messages: [{ role: "user", content: userContent }],
    temperature: 0.3,
  });

  onProgress?.("Connecting...");
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body,
  });
  if (!resp.ok) { const e = await resp.text().catch(() => ""); throw new Error(`API ${resp.status}: ${e.slice(0, 200)}`); }
  if (!resp.body) throw new Error("No response body");

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let totalChars = 0;
  let buffer = "";
  const startTime = Date.now();

  while (true) {
    const { done, value } = await (reader as any).read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Parse SSE lines
    const lines = buffer.split("\n");
    buffer = lines.pop() || ""; // keep incomplete line
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const evt = JSON.parse(line.slice(6));
        if (evt.type === "content_block_delta" && evt.delta?.text) {
          fullText += evt.delta.text;
          totalChars += evt.delta.text.length;
          const elapsed = (Date.now() - startTime) / 1000;
          const cps = elapsed > 0 ? Math.round(totalChars / elapsed) : 0;
          onProgress?.(`输出 ${totalChars} 字符 · ${cps} tok/s (估)`);
        }
      } catch {}
    }
  }
  // Drain remaining buffer
  for (const line of buffer.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const evt = JSON.parse(line.slice(6));
      if (evt.type === "content_block_delta" && evt.delta?.text) {
        fullText += evt.delta.text;
        totalChars += evt.delta.text.length;
      }
    } catch {}
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  onProgress?.(`${totalChars} 字符 · ${elapsed}s`);
  return fullText;
}

export async function translatePaper(
  paperDir: string, mainTex: string, structure: PaperStructure,
  onProgress?: (msg: string) => void,
): Promise<boolean> {
  onProgress?.("Collecting source files...");
  const files = await gatherFiles(paperDir);
  const totalChars = Object.values(files).reduce((s, c) => s + c.length, 0);
  onProgress?.(`${Object.keys(files).length} files, ${totalChars.toLocaleString()} chars`);

  onProgress?.("Building prompt...");
  const userPrompt = buildUserPrompt(paperDir, files);

  onProgress?.("Calling DeepSeek API...");
  const responseText = await callDeepSeekAPI(SYSTEM_PROMPT, userPrompt, onProgress);
  onProgress?.(`Response: ${responseText.length.toLocaleString()} chars`);

  const { files: translatedFiles } = parseResponse(responseText);
  if (Object.keys(translatedFiles).length === 0) {
    const preview = responseText.slice(0, 300);
    throw new Error(`No translated files in API response. Preview: ${preview}`);
  }

  onProgress?.(`Writing ${Object.keys(translatedFiles).length} files...`);
  await writeTranslatedFiles(paperDir, translatedFiles);
  return true;
}
