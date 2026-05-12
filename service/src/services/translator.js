/**
 * DeepSeek API translation service.
 * Streams progress via callback: onProgress({ type, chars, cps, text })
 */

import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import {
  applyUnitTranslations,
  buildStructureNote,
  detectEnglishResiduals,
  extractTranslationUnits,
  validateTranslatedTex,
} from "./latex-structure.js";

const MAX_OUTPUT_TOKENS = 32768;
const CONTEXT_OUTPUT_TOKENS = 4096;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CP1252_REVERSE = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84],
  [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88],
  [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
  [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
  [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

function cp1252Byte(char) {
  const code = char.codePointAt(0);
  if (code <= 0xff) return code;
  return CP1252_REVERSE.get(code);
}

function mojibakeScore(text) {
  const markers = text.match(/[ÃÂâ€â€™â€œâ€�åæçèéäãï¼ðŸ]/g)?.length || 0;
  const controls = text.match(/[\u0080-\u009f]/g)?.length || 0;
  return markers + controls * 2;
}

export function repairMojibake(text) {
  if (!text || mojibakeScore(text) < 8) return text;

  const bytes = [];
  for (const char of text) {
    const byte = cp1252Byte(char);
    if (byte === undefined) return text;
    bytes.push(byte);
  }

  const repaired = new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
  return mojibakeScore(repaired) < mojibakeScore(text) ? repaired : text;
}

function estimateTokensByLength(text) {
  return Math.ceil((text || "").length / 2);
}

function pythonCommand() {
  return process.platform === "win32" ? "python" : "python3";
}

function countTokensWithDeepSeekTokenizer(texts) {
  return new Promise((resolve) => {
    const script = path.join(__dirname, "tokenizer-count.py");
    const proc = spawn(pythonCommand(), [script], { cwd: path.join(__dirname, "..", ".."), shell: false });
    let stdout = "";
    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.on("error", () => resolve(null));
    proc.on("close", (code) => {
      if (code !== 0) return resolve(null);
      try {
        const data = JSON.parse(stdout);
        resolve(Array.isArray(data.counts) ? data.counts : null);
      } catch {
        resolve(null);
      }
    });
    proc.stdin.end(JSON.stringify({ texts }));
  });
}

async function estimateTokens(text) {
  const counts = await countTokensWithDeepSeekTokenizer([text || ""]);
  return counts?.[0] || estimateTokensByLength(text);
}

function rawUsageFromData(data) {
  return data?.usage || data?.message?.usage || data?.delta?.usage || null;
}

async function normalizeUsage(rawUsage, inputText, outputText) {
  const raw = rawUsage || {};
  const estimatedCounts = rawUsage ? [] : await countTokensWithDeepSeekTokenizer([inputText || "", outputText || ""]);
  const estimatedInputTokens = estimatedCounts?.[0] || estimateTokensByLength(inputText);
  const estimatedOutputTokens = estimatedCounts?.[1] || estimateTokensByLength(outputText);
  const cachedInputTokens = raw.prompt_cache_hit_tokens
    || raw.input_cache_hit_tokens
    || raw.cache_read_input_tokens
    || 0;
  const cacheMissTokens = raw.prompt_cache_miss_tokens || raw.input_cache_miss_tokens || 0;
  const inputTokens = raw.input_tokens
    || raw.prompt_tokens
    || (cachedInputTokens + cacheMissTokens)
    || estimatedInputTokens;
  const outputTokens = raw.output_tokens
    || raw.completion_tokens
    || estimatedOutputTokens;
  const uncachedInputTokens = cacheMissTokens || Math.max(inputTokens - cachedInputTokens, 0);

  return {
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimated: !rawUsage,
    tokenizer: rawUsage ? "api" : (estimatedCounts ? "deepseek_v3_tokenizer" : "length_estimate"),
  };
}

const SYSTEM_PROMPT = `You are an expert academic paper translator. Translate LaTeX papers from English to Simplified Chinese (简体中文).

## Translation Rules

### Translate to Chinese:
- All body text: sections, paragraphs, bullet points, itemized lists
- Figure captions and table captions
- Table column headers
- Abstract, keywords, acknowledgments, footnotes

### Keep as-is (DO NOT translate):
- LaTeX commands, environments, packages, options
- Citation keys: \\cite{...}, \\citep{...}, \\citet{...}
- References: \\ref{...}, \\label{...}, \\autoref{...}
- ALL math: $...$, $$...$$, \\[...\\], equation/gather/align environments
- Author names, institution names, email addresses
- Journal/conference names in .bib files
- File paths: \\includegraphics{...}, \\input{...}, \\bibliography{...}
- URLs, DOIs, \\url{...}
- Technical abbreviations: CVGL, GPS, FoV, HNM, ViT, CNN, etc.
- English abbreviations: e.g., i.e., et al., etc.

### LaTeX Modifications Required:
1. Remove: \\usepackage[T1]{fontenc} — conflicts with xelatex + Chinese
2. Add BEFORE \\begin{document}:
   \\usepackage[fontset=windows]{ctex}
   \\xeCJKsetup{AutoFakeBold=2}
   \\setCJKmainfont{Noto Serif SC}[BoldFont={Noto Serif SC}, BoldFeatures={FakeBold=2}, ItalicFont=KaiTi]
   \\setCJKsansfont{Noto Sans SC}[BoldFont={Noto Sans SC}, BoldFeatures={FakeBold=2}]
   \\setCJKmonofont{FangSong}
3. Do not add citation packages such as \\usepackage{cite}; preserve the original citation stack.
4. **CRITICAL — pdflatex compatibility**: This paper is compiled with xelatex.
   Search the ENTIRE document for pdflatex-only commands. If ANY of these exist:
   - \\pdfglyphtounicode{...}
   - \\pdfminorversion=...
   - \\pdfoutput=1
   - \\pdfstringdefDisableCommands{...}
   You MUST handle them. Either wrap in \\ifdefined, or add this BEFORE \\begin{document}:

   % Begin pdflatex compatibility shim
   \\ifdefined\\pdfglyphtounicode\\else
   \\let\\pdfglyphtounicode\\@gobbletwo
   \\fi
   % End pdflatex compatibility shim

### Output Format
For each file you modify/create, use this exact format:
\`\`\`
---FILE: path/relative/to/paper_dir/filename.tex---
(complete file content)
---END FILE---
\`\`\`

IMPORTANT:
- Output COMPLETE file content for each file
- Main .tex → <name>_cn.tex
- Table files → <name>_cn.tex, update \\input paths in main_cn.tex
- End with:
\`\`\`
---COMPILE---
xelatex -interaction=nonstopmode main_cn.tex
bibtex main_cn
xelatex -interaction=nonstopmode main_cn.tex
xelatex -interaction=nonstopmode main_cn.tex
---END COMPILE---
\`\`\``;

export function buildTranslationPrompt(files) {
  // Sort: main tex first, then tables, then bib, then rest
  const entries = Object.entries(files).sort(([a], [b]) => {
    const la = a.toLowerCase(), lb = b.toLowerCase();
    if (la.includes("main.tex") || la.includes("paper.tex")) return -1;
    if (lb.includes("main.tex") || lb.includes("paper.tex")) return 1;
    if (la.includes("table")) return -1;
    if (lb.includes("table")) return 1;
    if (la.endsWith(".tex") && lb.endsWith(".bib")) return -1;
    return a.localeCompare(b);
  });

  let fileBlock = "";
  for (const [path, content] of entries) {
    fileBlock += `---FILE: ${path}---\n${content}\n---END FILE---\n\n`;
  }

  return `Translate this LaTeX paper to Chinese. Below are all the source files.

## Source files

${fileBlock}

## Instructions
1. Read all files to understand the paper structure
2. Translate the main .tex file → <name>_cn.tex
3. Translate all table .tex files → <name>_cn.tex
4. Update \\input paths in main_cn.tex
5. Add Chinese LaTeX preamble (ctex, xeCJK fonts) to main_cn.tex
6. Output ALL files using ---FILE: ... ---END FILE--- format
7. End with ---COMPILE--- block`;
}

function normalizeEndpoint(apiEndpoint = "https://api.deepseek.com/anthropic") {
  return apiEndpoint.replace(/\/+$/, "");
}

function apiFormat(apiEndpoint = "") {
  return normalizeEndpoint(apiEndpoint).toLowerCase().endsWith("/anthropic") ? "anthropic" : "openai";
}

function requestUrl(apiEndpoint) {
  const base = normalizeEndpoint(apiEndpoint);
  return apiFormat(base) === "anthropic" ? `${base}/messages` : `${base}/chat/completions`;
}

function requestHeaders(apiEndpoint, apiKey) {
  if (apiFormat(apiEndpoint) === "anthropic") {
    return { "Content-Type": "application/json", "x-api-key": apiKey };
  }
  return { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
}

function requestBody(apiEndpoint, model, systemPrompt, userPrompt, stream, maxTokens) {
  if (apiFormat(apiEndpoint) === "anthropic") {
    return {
      model,
      max_tokens: maxTokens,
      stream,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      temperature: 0.3,
    };
  }
  return {
    model,
    max_tokens: maxTokens,
    stream,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.3,
  };
}

function responseContent(data) {
  const openAiContent = data.choices?.[0]?.message?.content;
  if (typeof openAiContent === "string") return openAiContent;
  const anthropicContent = data.content?.map?.(block => block.text || "").join("");
  if (typeof anthropicContent === "string") return anthropicContent;
  return "";
}

async function callTextModel({ apiEndpoint, apiKey, model, systemPrompt, userPrompt, maxTokens = MAX_OUTPUT_TOKENS, onProgress }) {
  const startTime = Date.now();
  onProgress?.({ type: "start" });
  try {
    return await callTextModelStreaming({ apiEndpoint, apiKey, model, systemPrompt, userPrompt, maxTokens, startTime, onProgress });
  } catch (error) {
    onProgress?.({ type: "fallback", message: error.message });
  }

  const resp = await fetch(requestUrl(apiEndpoint), {
    method: "POST",
    headers: requestHeaders(apiEndpoint, apiKey),
    body: JSON.stringify(requestBody(apiEndpoint, model, systemPrompt, userPrompt, false, maxTokens)),
  });

  if (!resp.ok) {
    const e = await resp.text().catch(() => "");
    throw new Error(`API ${resp.status}: ${e.slice(0, 300)}`);
  }

  const rawText = await resp.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    throw new Error(`Failed to parse API response: ${e.message}. Raw: ${rawText.slice(0, 200)}`);
  }
  if (data.error) throw new Error(`API error: ${data.error.message || JSON.stringify(data.error)}`);

  let fullText = repairMojibake(responseContent(data));
  if (!fullText) throw new Error(`Unexpected API response: ${JSON.stringify(data).slice(0, 300)}`);

  const usage = await normalizeUsage(rawUsageFromData(data), userPrompt, fullText);
  const stats = progressStats(fullText, startTime, usage);
  onProgress?.({ type: "progress", ...stats, usage });
  onProgress?.({ type: "done", ...stats, usage, text: fullText });
  return { text: fullText, usage, stats };
}

async function callTextModelStreaming({ apiEndpoint, apiKey, model, systemPrompt, userPrompt, maxTokens, startTime, onProgress }) {
  const resp = await fetch(requestUrl(apiEndpoint), {
    method: "POST",
    headers: requestHeaders(apiEndpoint, apiKey),
    body: JSON.stringify(requestBody(apiEndpoint, model, systemPrompt, userPrompt, true, maxTokens)),
  });

  if (!resp.ok || !resp.body) {
    const e = await resp.text().catch(() => "");
    throw new Error(`stream unavailable: API ${resp.status}: ${e.slice(0, 200)}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let rawUsage = null;
  let lastEmit = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      let data;
      try {
        data = JSON.parse(payload);
      } catch {
        continue;
      }
      if (data.error) throw new Error(`API error: ${data.error.message || JSON.stringify(data.error)}`);

      const delta = streamDelta(data);
      if (delta) fullText += delta;
      rawUsage = streamUsage(data) || rawUsage;

      const now = Date.now();
      if (delta && now - lastEmit > 250) {
        lastEmit = now;
        onProgress?.({ type: "progress", ...progressStats(repairMojibake(fullText), startTime) });
      }
    }
  }

  fullText = repairMojibake(fullText);
  if (!fullText) throw new Error("stream finished without translated content");

  const usage = await normalizeUsage(rawUsage, userPrompt, fullText);
  const stats = progressStats(fullText, startTime, usage);
  onProgress?.({ type: "progress", ...stats, usage });
  onProgress?.({ type: "done", ...stats, usage, text: fullText });
  return { text: fullText, usage, stats };
}

function compactTexForContext(content) {
  const important = [];
  const patterns = [
    /\\title\{[\s\S]*?\}/g,
    /\\begin\{abstract\}[\s\S]*?\\end\{abstract\}/g,
    /\\section\*?\{[^}]+\}/g,
    /\\subsection\*?\{[^}]+\}/g,
    /\\caption\{[\s\S]*?\}/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) important.push(match[0].slice(0, 1200));
  }
  const summary = important.join("\n");
  return (summary || content.slice(0, 6000)).slice(0, 12000);
}

function trimContextBlocks(files, limit = 50000) {
  let remaining = limit;
  let output = "";
  for (const [relPath, content] of Object.entries(files)) {
    if (!relPath.toLowerCase().endsWith(".tex")) continue;
    const block = `---FILE: ${relPath}---\n${compactTexForContext(content)}\n---END FILE---\n\n`;
    if (remaining <= 0) break;
    output += block.slice(0, remaining);
    remaining -= block.length;
  }
  return output;
}

const CONTEXT_SYSTEM_PROMPT = `You are preparing translation context for an academic LaTeX paper.
Return a concise context note in Simplified Chinese with:
- paper topic and contribution
- key terms and preferred Chinese translations
- notation, datasets, methods, and citation style notes
- file structure notes if relevant
Do not translate the full paper.`;

export async function buildPaperContext(files, apiKey, apiEndpoint, model, onProgress) {
  const userPrompt = `Read the following compacted LaTeX sources and produce global translation context for later per-file translation.

${trimContextBlocks(files)}

Return only the context note.`;
  return callTextModel({
    apiEndpoint,
    apiKey,
    model,
    systemPrompt: CONTEXT_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: CONTEXT_OUTPUT_TOKENS,
    onProgress,
  });
}

function translatedTexPath(relPath) {
  return relPath.replace(/\.tex$/i, "_cn.tex");
}

const SINGLE_FILE_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

Additional requirement:
- You are translating exactly one LaTeX file.
- Preserve all LaTeX commands, labels, citations, math, file paths, and bibliography keys.
- Output exactly one ---FILE--- block for the requested target path, plus no commentary.
- Never invent absolute/container paths such as /home/user/paper. Use the exact target path only.
- If this file inputs another translated tex file, use the _cn.tex target path provided in the file map.`;

const STRUCTURED_BLOCK_SYSTEM_PROMPT = `You are translating extracted text units from a LaTeX paper to Simplified Chinese.

Hard rules:
- Return strict JSON only: {"translations":[{"id":"...","text":"..."}]}.
- Preserve every placeholder token exactly, for example @@LATEX_0@@.
- Do not add, remove, reorder, or rename LaTeX commands, labels, citations, references, file paths, environments, braces, or math.
- Translate only natural language inside each text value.
- Translate section labels and bold lead-in phrases too; for important terminology use Chinese with English in parentheses when helpful.
- Do not leave complete English sentences untranslated.
- Keep technical abbreviations and proper nouns when Chinese translation would be ambiguous.
- Do not output Markdown fences or commentary.`;

export async function translateTexFile(relPath, content, contextNote, texFileMap, apiKey, apiEndpoint, model, onProgress) {
  const targetPath = translatedTexPath(relPath);
  const mapText = texFileMap.map(item => `${item.source} -> ${item.target}`).join("\n");
  const userPrompt = `Translate this single LaTeX file to Simplified Chinese.

## Global context
${contextNote}

## File map
${mapText}

## Target path
${targetPath}

## Source file
---FILE: ${relPath}---
${content}
---END FILE---

Output exactly:
---FILE: ${targetPath}---
(complete translated file content)
---END FILE---`;

  return callTextModel({
    apiEndpoint,
    apiKey,
    model,
    systemPrompt: SINGLE_FILE_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: MAX_OUTPUT_TOKENS,
    onProgress,
  });
}

function chunkUnits(units, maxChars = 7000, maxItems = 18) {
  const batches = [];
  let current = [];
  let chars = 0;
  for (const unit of units) {
    const size = unit.protectedText.length;
    if (current.length && (current.length >= maxItems || chars + size > maxChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(unit);
    chars += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

function parseJsonObject(text) {
  const cleaned = repairMojibake(String(text || ""))
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error(`Translation batch did not return JSON: ${cleaned.slice(0, 160)}`);
  }
}

function buildBatchPrompt({ relPath, targetPath, contextNote, texFileMap, manifest, batch, batchIndex, batchCount }) {
  const mapText = texFileMap.map(item => `${item.source} -> ${item.target}`).join("\n");
  const structureText = manifest ? buildStructureNote(manifest) : "";
  return `Translate these extracted LaTeX text units.

## Global paper context
${contextNote}

## Project structure
${structureText}

## Current file
${relPath} -> ${targetPath}

## File map
${mapText}

## Batch
${batchIndex + 1}/${batchCount}

## Units JSON
${JSON.stringify({
  file: relPath,
  target: targetPath,
  units: batch.map((unit) => ({
    id: unit.id,
    type: unit.type,
    text: unit.protectedText,
  })),
}, null, 2)}

Return JSON only with one translated text per id.`;
}

function hasUntranslatedEnglish(unit, translatedText) {
  const sourceResidual = detectEnglishResiduals(unit.protectedText, 2);
  if (sourceResidual.length === 0) return false;
  const residual = detectEnglishResiduals(translatedText, 2);
  if (residual.length === 0) return false;
  const sourcePlain = unit.protectedText.replace(/\s+/g, " ").trim();
  const targetPlain = String(translatedText || "").replace(/\s+/g, " ").trim();
  return !/[\u3400-\u9fff]/.test(targetPlain) || sourcePlain === targetPlain || residual.some((line) => targetPlain.includes(line));
}

function placeholderSet(text) {
  return new Set(String(text || "").match(/@@LATEX_\d+@@/g) || []);
}

function hasBalancedBraces(text) {
  let depth = 0;
  const value = String(text || "");
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "\\" && i + 1 < value.length) {
      i++;
      continue;
    }
    if (value[i] === "{") depth++;
    if (value[i] === "}") depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

function sanitizeUnitTranslation(unit, translatedText) {
  const text = String(translatedText || "");
  if (!text.trim()) return { ok: false, reason: "empty translation" };
  if (!hasBalancedBraces(text)) return { ok: false, reason: "unbalanced braces" };
  const expected = placeholderSet(unit.protectedText);
  const actual = placeholderSet(text);
  for (const token of expected) {
    if (!actual.has(token)) return { ok: false, reason: `missing protected placeholder ${token}` };
  }
  return { ok: true, text };
}

async function translateBatch({ relPath, targetPath, contextNote, texFileMap, manifest, batch, batchIndex, batchCount, totalUnitCount, apiKey, apiEndpoint, model, onProgress, retry = false }) {
  const userPrompt = buildBatchPrompt({
    relPath,
    targetPath,
    contextNote,
    texFileMap,
    manifest,
    batch,
    batchIndex,
    batchCount,
  }) + (retry ? "\n\nIMPORTANT RETRY: The previous result left English prose untranslated. Translate every English sentence in these units while preserving placeholders exactly." : "");
  const batchResult = await callTextModel({
    apiEndpoint,
    apiKey,
    model,
    systemPrompt: STRUCTURED_BLOCK_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: Math.min(MAX_OUTPUT_TOKENS, Math.max(4096, Math.ceil(userPrompt.length * 1.6))),
    onProgress: (evt) => {
      if (evt.type === "progress") {
        onProgress?.({
          ...evt,
          batchIndex,
          batchCount,
          unitCount: totalUnitCount || batch.length,
          progressRatio: (batchIndex + Math.min((evt.chars || 0) / Math.max(userPrompt.length, 1), 0.9)) / batchCount,
        });
      } else {
        onProgress?.(evt);
      }
    },
  });
  const data = parseJsonObject(batchResult.text);
  const list = Array.isArray(data.translations) ? data.translations : [];
  return { batchResult, list };
}

export async function translateStructuredTexFile(relPath, content, contextNote, texFileMap, manifest, apiKey, apiEndpoint, model, onProgress) {
  const targetPath = translatedTexPath(relPath);
  const units = extractTranslationUnits(content, relPath);
  if (units.length === 0) {
    const text = `---FILE: ${targetPath}---\n${content}\n---END FILE---`;
    return {
      text,
      translatedContent: content,
      usage: null,
      stats: { chars: content.length, tokens: 0, cps: 0, tps: 0, preview: content.slice(-5000) },
      structured: true,
      unitCount: 0,
      validation: validateTranslatedTex(content, content, relPath),
    };
  }

  const batches = chunkUnits(units);
  const usageParts = [];
  const translations = new Map();
  const rejectedUnits = [];
  const startTime = Date.now();

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    const { batchResult, list } = await translateBatch({
      relPath,
      targetPath,
      contextNote,
      texFileMap,
      manifest,
      batch,
      batchIndex,
      batchCount: batches.length,
      totalUnitCount: units.length,
      apiKey,
      apiEndpoint,
      model,
      onProgress,
    });
    usageParts.push(batchResult.usage);
    for (const item of list) {
      if (!item?.id || typeof item.text !== "string") continue;
      const unit = units.find((candidate) => candidate.id === item.id);
      if (!unit) continue;
      const sanitized = sanitizeUnitTranslation(unit, item.text);
      if (sanitized.ok) translations.set(item.id, sanitized.text);
      else rejectedUnits.push({ id: item.id, reason: sanitized.reason });
    }

    const partial = applyUnitTranslations(content, units, translations);
    const elapsed = Math.max((Date.now() - startTime) / 1000, 0.1);
    const usage = mergeUsage(usageParts);
    onProgress?.({
      type: "progress",
      chars: partial.length,
      tokens: usage.outputTokens,
      cps: Math.round(partial.length / elapsed),
      tps: Number((usage.outputTokens / elapsed).toFixed(1)),
      preview: partial.slice(-5000),
      usage,
      batchIndex,
      batchCount: batches.length,
      unitCount: units.length,
      progressRatio: (batchIndex + 1) / batches.length,
    });
  }

  const residualUnits = units.filter((unit) => translations.has(unit.id) && hasUntranslatedEnglish(unit, translations.get(unit.id)));
  if (residualUnits.length > 0) {
    onProgress?.({ type: "fallback", message: `Retrying ${residualUnits.length} units with untranslated English` });
    const retryBatches = chunkUnits(residualUnits, 4500, 10);
    for (let retryIndex = 0; retryIndex < retryBatches.length; retryIndex++) {
      const retryBatch = retryBatches[retryIndex];
      const { batchResult, list } = await translateBatch({
        relPath,
        targetPath,
        contextNote,
        texFileMap,
        manifest,
        batch: retryBatch,
        batchIndex: retryIndex,
        batchCount: retryBatches.length,
        totalUnitCount: units.length,
        apiKey,
        apiEndpoint,
        model,
        onProgress,
        retry: true,
      });
      usageParts.push(batchResult.usage);
      for (const item of list) {
        if (!item?.id || typeof item.text !== "string") continue;
        const unit = units.find((candidate) => candidate.id === item.id);
        if (!unit) continue;
        const sanitized = sanitizeUnitTranslation(unit, item.text);
        if (sanitized.ok) translations.set(item.id, sanitized.text);
        else rejectedUnits.push({ id: item.id, reason: sanitized.reason });
      }
    }
  }

  const missing = units.filter((unit) => !translations.has(unit.id));
  if (missing.length) {
    for (const unit of missing) translations.set(unit.id, unit.protectedText);
    const rejectedText = rejectedUnits.length
      ? ` (${rejectedUnits.slice(0, 3).map((item) => `${item.id}: ${item.reason}`).join("; ")})`
      : "";
    onProgress?.({ type: "fallback", message: `Preserved ${missing.length} source units for structural safety${rejectedText}` });
  }

  const translatedContent = applyUnitTranslations(content, units, translations);
  const usage = mergeUsage(usageParts);
  const elapsed = Math.max((Date.now() - startTime) / 1000, 0.1);
  const stats = {
    chars: translatedContent.length,
    tokens: usage.outputTokens,
    cps: Math.round(translatedContent.length / elapsed),
    tps: Number((usage.outputTokens / elapsed).toFixed(1)),
    preview: translatedContent.slice(-5000),
  };
  const validation = validateTranslatedTex(content, translatedContent, relPath);
  return {
    text: `---FILE: ${targetPath}---\n${translatedContent}\n---END FILE---`,
    translatedContent,
    usage,
    stats,
    structured: true,
    unitCount: units.length,
    batchCount: batches.length,
    validation,
  };
}

export function mergeUsage(usages) {
  const merged = {
    inputTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimated: false,
    tokenizer: "",
  };
  const tokenizers = new Set();
  for (const usage of usages.filter(Boolean)) {
    merged.inputTokens += Number(usage.inputTokens || 0);
    merged.cachedInputTokens += Number(usage.cachedInputTokens || 0);
    merged.uncachedInputTokens += Number(usage.uncachedInputTokens || 0);
    merged.outputTokens += Number(usage.outputTokens || 0);
    merged.totalTokens += Number(usage.totalTokens || 0);
    merged.estimated = merged.estimated || Boolean(usage.estimated);
    if (usage.tokenizer) tokenizers.add(usage.tokenizer);
  }
  merged.totalTokens ||= merged.inputTokens + merged.outputTokens;
  merged.tokenizer = [...tokenizers].join(",") || "unknown";
  return merged;
}

export async function translateViaAPI(files, apiKey, apiEndpoint, model, onProgress) {
  const userPrompt = buildTranslationPrompt(files);
  const result = await callTextModel({ apiEndpoint, apiKey, model, systemPrompt: SYSTEM_PROMPT, userPrompt, onProgress });
  return result.text;
}

function progressStats(text, startTime, usage = null) {
  const elapsed = Math.max((Date.now() - startTime) / 1000, 0.1);
  const tokens = usage?.outputTokens || estimateTokensByLength(text);
  return {
    chars: text.length,
    tokens,
    cps: Math.round(text.length / elapsed),
    tps: Number((tokens / elapsed).toFixed(1)),
    preview: text.slice(-5000),
  };
}

function streamDelta(data) {
  return data.choices?.[0]?.delta?.content
    || data.delta?.text
    || data.content_block?.text
    || "";
}

function streamUsage(data) {
  return rawUsageFromData(data);
}

async function translateStreaming(url, apiKey, model, userPrompt, startTime, onProgress) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      model, max_tokens: MAX_OUTPUT_TOKENS, stream: true,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
      temperature: 0.3,
    }),
  });

  if (!resp.ok || !resp.body) {
    const e = await resp.text().catch(() => "");
    throw new Error(`stream unavailable: API ${resp.status}: ${e.slice(0, 200)}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let rawUsage = null;
  let lastEmit = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      let data;
      try {
        data = JSON.parse(payload);
      } catch {
        continue;
      }
      if (data.error) throw new Error(`API error: ${data.error.message || JSON.stringify(data.error)}`);

      const delta = streamDelta(data);
      if (delta) fullText += delta;
      rawUsage = streamUsage(data) || rawUsage;

      const now = Date.now();
      if (delta && now - lastEmit > 250) {
        lastEmit = now;
        onProgress?.({ type: "progress", ...progressStats(repairMojibake(fullText), startTime) });
      }
    }
  }

  fullText = repairMojibake(fullText);
  if (!fullText) throw new Error("stream finished without translated content");

  const usage = await normalizeUsage(rawUsage, userPrompt, fullText);
  const stats = progressStats(fullText, startTime, usage);
  onProgress?.({ type: "progress", ...stats, usage });
  onProgress?.({ type: "done", ...stats, usage, text: fullText });
  return fullText;
}

export function parseResponse(text) {
  const files = {};
  let compileCmds = null;
  const re = /---FILE:\s*(.+?)\s*---\n([\s\S]*?)---END FILE---/g;
  let m;
  while ((m = re.exec(text)) !== null) files[m[1].trim()] = m[2].trim();
  const cc = /---COMPILE---(.*?)---END COMPILE---/s.exec(text);
  if (cc) compileCmds = cc[1].trim();
  return { files, compileCmds };
}
