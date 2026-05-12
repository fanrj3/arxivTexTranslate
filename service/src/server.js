/**
 * arXiv Translation Service — Express HTTP server.
 */

import express from "express";
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync,
  statSync, createReadStream, rmSync, renameSync, cpSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { ProxyAgent, fetch as undiciFetch } from "undici";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT) || 3456;
const DATA_DIR = process.env.ARXIV_SERVICE_DATA_DIR || path.join(__dirname, "..");
const JOBS_DIR = path.join(DATA_DIR, "jobs");
const DIST_DIR = path.join(__dirname, "..", "dist");
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const ARXIV_FETCH_TIMEOUT_MS = 90000;
const TRANSLATION_PIPELINE_VERSION = "structured-block-v3";

import multer from "multer";
import { analyzeLatexProject, repairProtectedCommandArgs, stripLatexComments, validateTranslatedTex } from "./services/latex-structure.js";
const upload = multer({ dest: path.join(JOBS_DIR, "_uploads") });

mkdirSync(JOBS_DIR, { recursive: true });
mkdirSync(path.join(JOBS_DIR, "_uploads"), { recursive: true });

function readPersistedSettings() {
  let fileSettings = {};
  try { fileSettings = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8")); } catch {}
  return fileSettings;
}

function readEnvSettings() {
  return {
    apiKey: process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || process.env.API_KEY || "",
    apiEndpoint: process.env.API_ENDPOINT || "",
    model: process.env.MODEL || "",
    parallelism: process.env.PARALLELISM || "",
  };
}

function readServiceSettings() {
  const fileSettings = readPersistedSettings();
  const envSettings = readEnvSettings();
  return {
    apiKey: fileSettings.apiKey || envSettings.apiKey || "",
    apiEndpoint: fileSettings.apiEndpoint || envSettings.apiEndpoint || "https://api.deepseek.com/anthropic",
    model: fileSettings.model || envSettings.model || "deepseek-v4-flash",
    parallelism: Number(fileSettings.parallelism || envSettings.parallelism || 3),
    apiKeySource: fileSettings.apiKey ? "settings" : envSettings.apiKey ? "env" : "none",
  };
}

function writeServiceSettings(next) {
  const current = readPersistedSettings();
  const persisted = {
    apiKey: next.apiKey === undefined ? (current.apiKey || "") : String(next.apiKey || ""),
    apiEndpoint: String(next.apiEndpoint || current.apiEndpoint || "https://api.deepseek.com/anthropic"),
    model: String(next.model || current.model || "deepseek-v4-flash"),
    parallelism: clampParallelism(next.parallelism || current.parallelism || 3),
  };
  writeFileSync(SETTINGS_FILE, JSON.stringify(persisted, null, 2), "utf-8");
  return persisted;
}

// ── Task queue ──
const tasks = new Map(); // taskId → { jobId, status, phase, log:[], progress, startTime }

function createTask(jobId) {
  const taskId = randomUUID().slice(0, 8);
  const task = {
    taskId,
    jobId,
    status: "pending",
    phase: "",
    log: [],
    progress: 0,
    startTime: Date.now(),
    result: null,
    preview: "",
    stats: null,
    usage: null,
    files: [],
    activeFile: null,
    threads: [],
    structureManifest: null,
  };
  tasks.set(taskId, task);
  // Auto-clean old tasks (>1 hour)
  for (const [id, t] of tasks) { if (Date.now() - t.startTime > 3600000) tasks.delete(id); }
  return task;
}

function taskLog(task, msg) { task.log.push(`[${new Date().toISOString().slice(11,19)}] ${msg}`); }

function isTerminalTask(task) {
  return task.status === "done" || task.status === "error" || task.status === "partial_error";
}

function normalizeTranslatedLatex(content) {
  let normalized = content
    .replace(/\\textdegree(?!\{\})/g, "\\textdegree{}")
    .replace(/^\s*\\usepackage(?:\[[^\]]*\])?\{cite\}\s*$/gm, "")
    .replace(/(\\(?:textbf|textit|emph)\{\\underline\{[^{}\n]+\}\})\}([\u3400-\u9fffA-Za-z])/g, "$1$2")
    .replace(/(^|[^\\A-Za-z])(citep?|citet|ref|label|autoref|eqref)\{/g, "$1\\$2{")
    .replace(/(\\(?:sub)*section\*?\{[^{}\n]*?)\s*(\\label\{[^}]+\})/g, "$1}$2")
    .replace(/(\\paragraph\{[^{}\n]*?)\s*(\\label\{[^}]+\})/g, "$1}$2");
  return normalized;
}

const DEEPSEEK_PRICING_CNY = {
  flash: {
    modelName: "DeepSeek-V4-Flash",
    cachedInputPerMTokens: 0.02,
    uncachedInputPerMTokens: 1,
    outputPerMTokens: 2,
  },
  pro: {
    modelName: "DeepSeek-V4-Pro",
    cachedInputPerMTokens: 0.025,
    uncachedInputPerMTokens: 3,
    outputPerMTokens: 6,
    note: "DeepSeek-V4-Pro 2.5折优惠价，有效期至北京时间 2026-05-31 23:59",
  },
};

function deepseekModelTier(model = "") {
  const normalized = model.toLowerCase();
  if (normalized.includes("pro")) return "pro";
  return "flash";
}

function estimateDeepseekCost(model, usage = {}) {
  const tier = deepseekModelTier(model);
  const pricing = DEEPSEEK_PRICING_CNY[tier];
  const cachedInputTokens = Number(usage.cachedInputTokens || 0);
  const inputTokens = Number(usage.inputTokens || 0);
  const uncachedInputTokens = Number(usage.uncachedInputTokens ?? Math.max(inputTokens - cachedInputTokens, 0));
  const outputTokens = Number(usage.outputTokens || 0);
  const cachedInputCost = cachedInputTokens / 1_000_000 * pricing.cachedInputPerMTokens;
  const uncachedInputCost = uncachedInputTokens / 1_000_000 * pricing.uncachedInputPerMTokens;
  const outputCost = outputTokens / 1_000_000 * pricing.outputPerMTokens;

  return {
    currency: "CNY",
    modelTier: tier,
    modelName: pricing.modelName,
    cachedInputCost,
    uncachedInputCost,
    outputCost,
    totalCost: cachedInputCost + uncachedInputCost + outputCost,
    pricing,
  };
}

function buildTranslationUsage({ model, apiEndpoint, usage, durationSeconds }) {
  const normalizedUsage = {
    inputTokens: Number(usage?.inputTokens || 0),
    cachedInputTokens: Number(usage?.cachedInputTokens || 0),
    uncachedInputTokens: Number(usage?.uncachedInputTokens || 0),
    outputTokens: Number(usage?.outputTokens || usage?.tokens || 0),
    totalTokens: Number(usage?.totalTokens || 0),
    estimated: Boolean(usage?.estimated),
  };
  normalizedUsage.totalTokens ||= normalizedUsage.inputTokens + normalizedUsage.outputTokens;
  const cost = estimateDeepseekCost(model, normalizedUsage);
  return {
    model,
    modelName: cost.modelName,
    modelTier: cost.modelTier,
    apiFormat: apiEndpoint.includes("/anthropic") ? "Anthropic" : "OpenAI",
    durationSeconds,
    tokens: normalizedUsage,
    cost,
    updatedAt: new Date().toISOString(),
  };
}

function usageSummaryFromJobs() {
  const summary = { totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, byModel: {} };
  for (const entry of readdirSync(JOBS_DIR)) {
    if (entry.startsWith("_")) continue;
    const d = path.join(JOBS_DIR, entry);
    try { if (!statSync(d).isDirectory()) continue; } catch { continue; }
    const usage = readMeta(d).translationUsage;
    if (!usage) continue;
    const model = usage.model || "unknown";
    const bucket = summary.byModel[model] || { totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, count: 0 };
    const tokens = usage.tokens || {};
    const cost = usage.cost || {};
    bucket.count += 1;
    bucket.inputTokens += Number(tokens.inputTokens || 0);
    bucket.outputTokens += Number(tokens.outputTokens || 0);
    bucket.totalTokens += Number(tokens.totalTokens || 0);
    bucket.totalCost += Number(cost.totalCost || 0);
    summary.byModel[model] = bucket;
    summary.inputTokens += Number(tokens.inputTokens || 0);
    summary.outputTokens += Number(tokens.outputTokens || 0);
    summary.totalTokens += Number(tokens.totalTokens || 0);
    summary.totalCost += Number(cost.totalCost || 0);
  }
  return summary;
}

function noProxyMatches(targetUrl, noProxy = process.env.NO_PROXY || process.env.no_proxy || "") {
  if (!noProxy.trim()) return false;
  const host = new URL(targetUrl).hostname.toLowerCase();
  return noProxy.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean).some((rule) => {
    if (rule === "*") return true;
    if (rule.startsWith(".")) return host.endsWith(rule);
    return host === rule || host.endsWith(`.${rule}`);
  });
}

function resolveProxy(targetUrl, explicitProxy = "") {
  const proxy = explicitProxy.trim()
    || process.env.ARXIV_PROXY
    || process.env.HTTPS_PROXY
    || process.env.https_proxy
    || process.env.HTTP_PROXY
    || process.env.http_proxy
    || process.env.ALL_PROXY
    || process.env.all_proxy
    || "";
  if (!proxy || noProxyMatches(targetUrl)) return "";
  return proxy;
}

function printableProxy(proxyUrl) {
  if (!proxyUrl) return "未配置代理";
  try {
    const url = new URL(proxyUrl);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return proxyUrl;
  }
}

function collectNetworkCodes(error) {
  const errors = error?.cause?.errors || error?.errors || [error?.cause, error].filter(Boolean);
  return [...new Set(errors.map((item) => item?.code).filter(Boolean))];
}

function arxivFetchError(error, sourceUrl, proxyUrl) {
  const codes = collectNetworkCodes(error);
  const codeText = codes.length ? codes.join("/") : error?.code || error?.name || "NETWORK_ERROR";
  const proxyText = printableProxy(proxyUrl);
  let hint = "请检查本机网络、防火墙，或在设置里填写 arXiv 代理地址，例如 http://127.0.0.1:7890。";
  if (proxyUrl) hint = "当前已使用代理，请确认代理服务正在运行，且允许访问 arxiv.org:443。";
  if (codes.includes("EACCES")) hint = "连接被系统或网络策略拒绝。通常是防火墙、公司/校园网策略，或 Node 未走代理导致。";
  if (codes.includes("ETIMEDOUT") || codes.includes("UND_ERR_CONNECT_TIMEOUT")) hint = "连接 arXiv 超时。通常是网络不稳定或代理不可用。";
  const err = new Error(`无法下载 arXiv 源码包：${sourceUrl}。网络错误 ${codeText}；代理：${proxyText}。${hint}`);
  err.statusCode = 502;
  return err;
}

async function fetchArxivSource(sourceUrl, explicitProxy = "") {
  const proxyUrl = resolveProxy(sourceUrl, explicitProxy);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ARXIV_FETCH_TIMEOUT_MS);
  try {
    const options = {
      headers: { "User-Agent": "arxiv-translate/1.0" },
      signal: controller.signal,
    };
    if (proxyUrl) options.dispatcher = new ProxyAgent(proxyUrl);
    return await undiciFetch(sourceUrl, options);
  } catch (error) {
    throw arxivFetchError(error, sourceUrl, proxyUrl);
  } finally {
    clearTimeout(timer);
  }
}

app.use(express.json({ limit: "50mb" }));
const staticOptions = {
  etag: false,
  lastModified: false,
  setHeaders(res) {
    res.setHeader("Cache-Control", "no-store");
  },
};
if (existsSync(DIST_DIR)) app.use(express.static(DIST_DIR, staticOptions));
else app.use(express.static(PUBLIC_DIR, staticOptions));

// ── Helpers ──

async function getExtractor() { return import("./services/extractor.js"); }
async function getTranslator() { return import("./services/translator.js"); }
async function getCompiler() { return import("./services/compiler.js"); }
async function getFeedback() { return import("./services/feedback.js"); }

const MD = "metadata.json";

function readMeta(jobDir) {
  try { return JSON.parse(readFileSync(path.join(jobDir, MD), "utf-8")); }
  catch { return {}; }
}
function writeMeta(jobDir, obj) {
  const existing = readMeta(jobDir);
  const merged = { ...existing, ...obj, updatedAt: new Date().toISOString() };
  writeFileSync(path.join(jobDir, MD), JSON.stringify(merged, null, 2), "utf-8");
}

function readLatexBraceArg(source, commandIndex) {
  const openIndex = source.indexOf("{", commandIndex);
  if (openIndex < 0) return "";
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    const prev = source[i - 1];
    if (ch === "{" && prev !== "\\") depth++;
    if (ch === "}" && prev !== "\\") {
      depth--;
      if (depth === 0) return source.slice(openIndex + 1, i);
    }
  }
  return "";
}

function cleanLatexTitle(title) {
  return String(title || "")
    .replace(/%.*$/gm, " ")
    .replace(/\\vspace\s*\{[^{}]*\}/g, " ")
    .replace(/\\thanks\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, " ")
    .replace(/\\(textbf|textit|emph|mathrm|mathbf|texttt)\s*\{([^{}]*)\}/g, "$2")
    .replace(/\\\\/g, " ")
    .replace(/~/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isSuspiciousTitle(title) {
  const value = String(title || "").trim();
  return !value || /^\\[A-Za-z]+(?:\{|$)/.test(value) || value.length < 4;
}

function extractTitleFromTex(dir) {
  // Look through .tex files for a balanced \title{...}. Some arXiv sources put
  // layout commands such as \vspace{-1pt} before the real title.
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".tex")) continue;
      try {
        const c = readFileSync(path.join(dir, f), "utf-8");
        const m = c.match(/\\title\s*\{/);
        if (m) {
          const title = cleanLatexTitle(readLatexBraceArg(c, m.index));
          if (title) return title;
        }
      } catch {}
    }
  } catch {}
  return null;
}

function detectArxivId(dir) {
  // 1. Check metadata.json
  const meta = readMeta(dir);
  if (meta.arxivId) return meta.arxivId;

  // 2. 00README.json
  for (const f of readdirSync(dir)) {
    if (f.toLowerCase().includes("readme") || f === "00README.json") {
      try {
        const c = JSON.parse(readFileSync(path.join(dir, f), "utf-8"));
        if (c.sources?.[0]?.filename) {
          const m = c.sources[0].filename.match(/(\d{4}\.\d{4,5})/);
          if (m) return m[1];
        }
      } catch {}
    }
  }

  // 3. First .tex filename
  for (const f of readdirSync(dir)) {
    if (f.endsWith(".tex")) {
      const m = f.match(/(\d{4}\.\d{4,5})/);
      if (m) return m[1];
    }
  }
  return null;
}

function sanitizeJobId(value, fallback = "upload") {
  const cleaned = String(value || "")
    .replace(/\.tar\.gz$/i, "")
    .replace(/\.tgz$/i, "")
    .replace(/\.gz$/i, "")
    .replace(/\.zip$/i, "")
    .replace(/\.[^.]+$/i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const generic = new Set(["", "main", "paper", "article", "root", "source", "src"]);
  return generic.has(cleaned.toLowerCase()) ? fallback : cleaned;
}

function moveDirectory(src, dest) {
  try {
    renameSync(src, dest);
  } catch (e) {
    if (e.code !== "EPERM" && e.code !== "EXDEV") throw e;
    cpSync(src, dest, { recursive: true });
    rmSync(src, { recursive: true, force: true });
  }
}

function countFiles(dir) {
  let n = 0;
  try {
    for (const e of readdirSync(dir)) {
      if (e === "build" || e.startsWith(".")) continue;
      try { n += statSync(path.join(dir, e)).isDirectory() ? countFiles(path.join(dir, e)) : 1; }
      catch { n++; }
    }
  } catch {}
  return n;
}

function relativeTime(iso) {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return `${Math.floor(days / 30)} 月前`;
}

function relativeTimeLabel(iso) {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return `${Math.floor(days / 30)} 个月前`;
}

// ── Migrate old UUID dirs on startup ──
function migrateOldJobs() {
  for (const entry of readdirSync(JOBS_DIR)) {
    if (entry.startsWith("_")) continue;
    const d = path.join(JOBS_DIR, entry);
    try { if (!statSync(d).isDirectory()) continue; } catch { continue; }
    let meta = readMeta(d);
    if (isSuspiciousTitle(meta.title)) {
      const repairedTitle = extractTitleFromTex(d);
      if (repairedTitle && repairedTitle !== meta.title) {
        writeMeta(d, { title: repairedTitle });
        meta = readMeta(d);
      }
    }
    if (meta.title) continue; // already has metadata
    const title = extractTitleFromTex(d) || entry;
    const arxivId = detectArxivId(d) || entry;
    writeMeta(d, { arxivId, title, createdAt: meta.createdAt || new Date().toISOString() });
    console.log(`  migrated: ${entry} → ${title.slice(0, 50)}`);
  }
}
migrateOldJobs();

// ── Upload + Extract ──
app.post("/api/upload", upload.single("file"), async (req, res) => {
  let tmpDir = "";
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const { extractTarGz } = await getExtractor();

    tmpDir = path.join(JOBS_DIR, "_tmp_" + randomUUID().slice(0, 8));
    const result = extractTarGz(req.file.path, tmpDir);
    const detectedArxivId = detectArxivId(tmpDir);
    const fallbackBase = sanitizeJobId(req.file.originalname, "upload");
    const jobId = detectedArxivId || `${fallbackBase}-${randomUUID().slice(0, 8)}`;
    const jobDir = path.join(JOBS_DIR, jobId);

    if (existsSync(jobDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
      let meta = readMeta(jobDir);
      if (isSuspiciousTitle(meta.title)) {
        const repairedTitle = extractTitleFromTex(jobDir);
        if (repairedTitle) {
          writeMeta(jobDir, { title: repairedTitle });
          meta = readMeta(jobDir);
        }
      }
      return res.json({ jobId, title: meta.title, existing: true });
    }

    moveDirectory(tmpDir, jobDir);
    const title = extractTitleFromTex(jobDir) || jobId;
    const fileCount = countFiles(jobDir);
    writeMeta(jobDir, { arxivId: detectedArxivId || "", title, createdAt: new Date().toISOString(), fileCount });

    const mainTex = (await getExtractor()).findMainTex(jobDir);
    res.json({ jobId, title, fileCount, mainTex: mainTex ? path.basename(mainTex) : null });
  } catch (e) {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    res.status(500).json({ error: e.message });
  }
});

// ── List jobs ──
app.get("/api/jobs", (req, res) => {
  const jobs = [];
  for (const entry of readdirSync(JOBS_DIR)) {
    if (entry.startsWith("_")) continue;
    const d = path.join(JOBS_DIR, entry);
    try { if (!statSync(d).isDirectory()) continue; } catch { continue; }
    let meta = readMeta(d);
    if (isSuspiciousTitle(meta.title)) {
      const repairedTitle = extractTitleFromTex(d);
      if (repairedTitle && repairedTitle !== meta.title) {
        writeMeta(d, { title: repairedTitle });
        meta = readMeta(d);
      }
    }
    const files = readdirSync(d).filter(f => !f.startsWith(".") && f !== MD && f !== "build");
    const buildDir = path.join(d, "build");
    const hasPdf = existsSync(buildDir) && readdirSync(buildDir).some(f => f.endsWith(".pdf"));
    const hasCnTex = files.some(f => f.endsWith("_cn.tex")) || findTranslatedTexFiles(d).length > 0;
    const hasTex = files.some(f => f.endsWith(".tex"));
    let status = hasPdf ? "compiled" : hasCnTex ? "translated" : hasTex ? "extracted" : "empty";

    jobs.push({
      id: entry,
      title: meta.title || entry,
      status,
      fileCount: meta.fileCount || files.length,
      createdAt: meta.createdAt || "",
      relativeTime: relativeTimeLabel(meta.createdAt),
      hasPdf, hasCnTex,
      translationUsage: meta.translationUsage || null,
    });
  }
  jobs.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  res.json(jobs);
});

// ── Delete job ──
app.delete("/api/jobs/:id", (req, res) => {
  const d = path.join(JOBS_DIR, req.params.id);
  if (!existsSync(d)) return res.status(404).json({ error: "not found" });
  rmSync(d, { recursive: true, force: true });
  res.json({ ok: true });
});

// ── Update metadata ──
app.patch("/api/jobs/:id", (req, res) => {
  const d = path.join(JOBS_DIR, req.params.id);
  if (!existsSync(d)) return res.status(404).json({ error: "not found" });
  const { title } = req.body;
  if (title) writeMeta(d, { title });
  res.json(readMeta(d));
});

// ── Get metadata ──
app.get("/api/jobs/:id/metadata", (req, res) => {
  const d = path.join(JOBS_DIR, req.params.id);
  if (!existsSync(d)) return res.status(404).json({ error: "not found" });
  res.json(readMeta(d));
});

app.get("/api/usage-summary", (req, res) => {
  res.json(usageSummaryFromJobs());
});

app.post("/api/jobs/:id/feedback", async (req, res) => {
  try {
    const jobDir = path.join(JOBS_DIR, req.params.id);
    if (!existsSync(jobDir)) return res.status(404).json({ error: "job not found" });
    const { createFeedbackPackage } = await getFeedback();
    const meta = readMeta(jobDir);
    const result = createFeedbackPackage({
      jobDir,
      jobId: req.params.id,
      meta,
      serviceRoot: DATA_DIR,
      outputDir: path.join(JOBS_DIR, "_feedback"),
    });
    res.json({
      ok: true,
      title: result.title,
      issueUrl: result.issueUrl,
      zipName: result.zipName,
      downloadUrl: `/api/feedback/${encodeURIComponent(result.zipName)}`,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/settings", (_req, res) => {
  const settings = readServiceSettings();
  res.json({
    apiKeySet: Boolean(settings.apiKey),
    apiKeySource: settings.apiKeySource,
    apiEndpoint: settings.apiEndpoint,
    model: settings.model,
    parallelism: clampParallelism(settings.parallelism),
  });
});

app.post("/api/settings", (req, res) => {
  const saved = writeServiceSettings(req.body || {});
  res.json({
    ok: true,
    apiKeySet: Boolean(saved.apiKey),
    apiKeySource: saved.apiKey ? "settings" : "none",
    apiEndpoint: saved.apiEndpoint,
    model: saved.model,
    parallelism: saved.parallelism,
  });
});

// ── Translate (starts background task) ──
function clampParallelism(value) {
  const n = Number(value || 3);
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(8, Math.round(n)));
}

function isSourceTex(relPath) {
  return relPath.toLowerCase().endsWith(".tex") && !relPath.toLowerCase().endsWith("_cn.tex");
}

function texTargetPath(relPath) {
  return relPath.replace(/\.tex$/i, "_cn.tex");
}

function pickMainTex(texFiles) {
  return texFiles.find(f => /(^|\/)(main|paper|root)\.tex$/i.test(f))
    || texFiles.find(f => !/[\\/](sections?|tables?|figures?)[\\/]/i.test(f))
    || texFiles[0];
}

function isLikelyMainCnTex(fileName = "") {
  const base = path.posix.basename(fileName.replace(/\\/g, "/"));
  return /^(main|paper|root|ms)_cn\.tex$/i.test(base);
}

function resolveTexReference(currentFile, ref) {
  const normalized = ref.replace(/\\/g, "/");
  const withExt = normalized.toLowerCase().endsWith(".tex") ? normalized : `${normalized}.tex`;
  const baseDir = path.posix.dirname(currentFile);
  return path.posix.normalize(path.posix.join(baseDir === "." ? "" : baseDir, withExt));
}

function patchTranslatedInputs(content, currentFile, texMap) {
  return content.replace(/\\(input|include|subfile)\s*\{([^}]+)\}/g, (match, command, ref) => {
    const resolved = resolveTexReference(currentFile, ref);
    const target = texMap.get(resolved);
    if (!target) return match;
    let nextRef = path.posix.relative(path.posix.dirname(texTargetPath(currentFile)), target).replace(/\\/g, "/");
    if (!nextRef.startsWith(".")) nextRef = `./${nextRef}`;
    if (command === "include") nextRef = nextRef.replace(/\.tex$/i, "");
    return `\\${command}{${nextRef}}`;
  });
}

async function runLimited(items, limit, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async (_, threadIndex) => {
    while (index < items.length) {
      const item = items[index++];
      await worker(item, threadIndex + 1);
    }
  });
  await Promise.all(runners);
}

function findTranslatedTexFiles(dir, root = dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "build" || entry.startsWith(".")) continue;
    const fp = path.join(dir, entry);
    try {
      if (statSync(fp).isDirectory()) {
        files.push(...findTranslatedTexFiles(fp, root));
        continue;
      }
    } catch {
      continue;
    }
    if (entry.toLowerCase().endsWith("_cn.tex")) {
      files.push(path.relative(root, fp).replace(/\\/g, "/"));
    }
  }
  return files;
}

function repairStrayTranslatedTex(jobDir) {
  const cnFiles = findTranslatedTexFiles(jobDir);
  const rootCnFiles = cnFiles.filter(file => !file.includes("/"));
  if (rootCnFiles.length > 0) return rootCnFiles;

  const byDir = new Map();
  for (const file of cnFiles) {
    const dir = path.posix.dirname(file);
    const list = byDir.get(dir) || [];
    list.push(file);
    byDir.set(dir, list);
  }
  const candidate = [...byDir.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .find(([dir]) => dir !== ".");
  if (!candidate) return [];

  const copied = [];
  for (const relPath of candidate[1]) {
    const fileName = path.posix.basename(relPath);
    const target = path.join(jobDir, fileName);
    if (!existsSync(target)) {
      cpSync(path.join(jobDir, ...relPath.split("/")), target);
    }
    copied.push(fileName);
  }
  return copied;
}

app.post("/api/translate", async (req, res) => {
  const persistedSettings = readPersistedSettings();
  const envSettings = readEnvSettings();
  const { jobId } = req.body;
  const apiKey = persistedSettings.apiKey || req.body.apiKey || envSettings.apiKey || "";
  const apiEndpoint = persistedSettings.apiEndpoint || req.body.apiEndpoint || envSettings.apiEndpoint || "https://api.deepseek.com/anthropic";
  const model = persistedSettings.model || req.body.model || envSettings.model || "deepseek-v4-flash";
  if (!jobId || !apiKey) return res.status(400).json({ error: "jobId required and service API key is not configured" });
  const jobDir = path.join(JOBS_DIR, jobId);
  if (!existsSync(jobDir)) return res.status(404).json({ error: "job not found" });

  const task = createTask(jobId);
  task.phase = "collecting";
  taskLog(task, "Task created");

  // Return taskId immediately, run in background
  res.json({ taskId: task.taskId });

  // Background execution
  (async () => {
    try {
      // Clean old translated files if force
      const existingCn = findTranslatedTexFiles(jobDir);
      const existingMeta = readMeta(jobDir);
      if (req.body.force) {
        for (const f of existingCn) rmSync(path.join(jobDir, ...f.split("/")), { force: true });
        taskLog(task, "Cleared old translated files");
      } else if (existingCn.length > 0 && existingMeta.translationPipelineVersion === TRANSLATION_PIPELINE_VERSION) {
        task.phase = "done";
        task.status = "done";
        task.result = { cached: true, mainCnTex: existingCn[0] };
        return;
      } else if (existingCn.length > 0) {
        for (const f of existingCn) rmSync(path.join(jobDir, ...f.split("/")), { force: true });
        taskLog(task, "Cleared translated files from older pipeline");
      }

      // Collect files
      task.phase = "collecting";
      const files = {};
      const textExts = [".tex", ".bib", ".sty", ".cls", ".bst", ".cfg", ".def", ".clo"];
      function collect(dir) {
        for (const entry of readdirSync(dir)) {
          if (entry === "build" || entry.startsWith(".")) continue;
          const fp = path.join(dir, entry);
          try { if (statSync(fp).isDirectory()) { collect(fp); continue; } } catch { continue; }
          if (textExts.includes(path.extname(entry).toLowerCase())) {
            try { files[path.relative(jobDir, fp).replace(/\\/g, "/")] = readFileSync(fp, "utf-8"); } catch {}
          }
        }
      }
      collect(jobDir);
      taskLog(task, `Collected ${Object.keys(files).length} source files`);
      task.progress = 10;

      const unsortedTexFiles = Object.keys(files).filter(isSourceTex);
      const detectedMainTex = pickMainTex(unsortedTexFiles);
      const sourceTexFiles = unsortedTexFiles.sort((a, b) => {
        if (a === detectedMainTex) return -1;
        if (b === detectedMainTex) return 1;
        return a.localeCompare(b);
      });
      if (sourceTexFiles.length === 0) throw new Error("No source .tex files found");
      const translationFiles = { ...files };
      let removedCommentChars = 0;
      for (const relPath of sourceTexFiles) {
        const stripped = stripLatexComments(files[relPath]);
        removedCommentChars += Math.max(0, files[relPath].length - stripped.length);
        translationFiles[relPath] = stripped;
      }
      if (removedCommentChars > 0) taskLog(task, `Removed LaTeX comments before translation (${removedCommentChars} chars)`);

      const parallelism = clampParallelism(req.body.parallelism);
      const activeModel = model || "deepseek-v4-pro";
      const activeEndpoint = apiEndpoint || "https://api.deepseek.com/anthropic";
      const texMap = new Map(sourceTexFiles.map(relPath => [relPath, texTargetPath(relPath)]));
      const texFileMap = sourceTexFiles.map(source => ({ source, target: texTargetPath(source) }));
      const mainSourceTex = detectedMainTex || pickMainTex(sourceTexFiles);
      const mainCnTex = texTargetPath(mainSourceTex);
      const structureManifest = analyzeLatexProject(translationFiles, mainSourceTex);
      task.structureManifest = structureManifest;
      taskLog(task, `Structure analysis: main=${mainSourceTex}, tex=${structureManifest.texFileCount}, units=${structureManifest.totalTranslationUnits}`);
      for (const warning of structureManifest.warnings) taskLog(task, `Structure warning: ${warning}`);

      task.files = sourceTexFiles.map(relPath => ({
        ...(structureManifest.texFiles.find(file => file.path === relPath) || {}),
        path: relPath,
        targetPath: texTargetPath(relPath),
        status: "pending",
        progress: 0,
        chars: 0,
        tokens: 0,
        tps: 0,
        thread: null,
        preview: "",
      }));
      task.threads = Array.from({ length: parallelism }, (_, index) => ({
        id: index + 1,
        status: "idle",
        activeFile: null,
        tokens: 0,
        chars: 0,
        tps: 0,
        completed: 0,
      }));

      // Build shared context, then translate each tex file independently.
      task.phase = "context";
      const { buildPaperContext, translateStructuredTexFile, parseResponse, mergeUsage } = await getTranslator();
      const apiStart = Date.now();
      const usageParts = [];
      taskLog(task, `Building paper context from ${sourceTexFiles.length} tex files...`);
      task.progress = 20;

      const contextResult = await buildPaperContext(translationFiles, apiKey, activeEndpoint, activeModel, (evt) => {
          if (evt.type === "progress") {
            task.progress = 20 + Math.min(evt.chars / 120, 15);
            task.preview = evt.preview || task.preview;
            task.stats = { chars: evt.chars, tokens: evt.tokens, cps: evt.cps, tps: evt.tps };
            task.usage = evt.usage || task.usage;
          } else if (evt.type === "fallback") {
            taskLog(task, `Context streaming fallback: ${evt.message}`);
          }
        });
      usageParts.push(contextResult.usage);
      task.preview = contextResult.text;
      task.progress = 35;
      taskLog(task, `Context ready (${contextResult.text.length} chars). Translating with parallelism ${parallelism}...`);

      const XELATEX_SHIM = "\n% xelatex compatibility shim (auto-injected)\n\\makeatletter\n\\@ifundefined{pdfglyphtounicode}{\\newcommand{\\pdfglyphtounicode}[2]{}}{}\n\\@ifundefined{pdfgentounicode}{\\newcount\\pdfgentounicode}{}\n\\@ifundefined{pdfcompresslevel}{\\newcount\\pdfcompresslevel}{}\n\\@ifundefined{pdfoptionpdfminorversion}{\\newcount\\pdfoptionpdfminorversion}{}\n\\makeatother\n";
      const writtenFiles = [];
      const failedFiles = [];

      task.phase = "translating_files";
      await runLimited(sourceTexFiles, parallelism, async (relPath, threadId) => {
        const fileState = task.files.find(item => item.path === relPath);
        const threadState = task.threads.find(item => item.id === threadId);
        const startedAt = Date.now();
        Object.assign(fileState, { status: "running", progress: 3, startedAt, error: null, thread: threadId });
        Object.assign(threadState, { status: "running", activeFile: relPath });
        task.activeFile = relPath;
        taskLog(task, `Thread ${threadId}: translating ${relPath}`);

        try {
          const result = await translateStructuredTexFile(
            relPath,
            translationFiles[relPath],
            contextResult.text,
            texFileMap,
            structureManifest,
            apiKey,
            activeEndpoint,
            activeModel,
            (evt) => {
              if (evt.type === "progress") {
                const contentLength = Math.max(translationFiles[relPath].length, 1);
                const structuredProgress = evt.progressRatio ? Math.round(evt.progressRatio * 82) + 8 : Math.round((evt.chars || 0) / contentLength * 75) + 10;
                fileState.progress = Math.min(95, Math.max(fileState.progress || 0, structuredProgress));
                fileState.chars = evt.chars || fileState.chars || 0;
                fileState.tokens = evt.tokens || fileState.tokens || 0;
                fileState.tps = evt.tps || fileState.tps || 0;
                fileState.preview = evt.preview || fileState.preview || "";
                fileState.batchIndex = evt.batchIndex;
                fileState.batchCount = evt.batchCount;
                fileState.unitCount = evt.unitCount || fileState.unitCount;
                threadState.chars = evt.chars || threadState.chars || 0;
                threadState.tokens = evt.tokens || threadState.tokens || 0;
                threadState.tps = evt.tps || threadState.tps || 0;
                task.preview = evt.preview || task.preview;
                task.stats = { chars: evt.chars, tokens: evt.tokens, cps: evt.cps, tps: evt.tps };
                if (evt.usage) task.usage = mergeUsage([...usageParts, evt.usage]);
              } else if (evt.type === "fallback") {
                taskLog(task, `${relPath} streaming fallback: ${evt.message}`);
              }
              const doneCount = task.files.filter(item => item.status === "done").length;
              task.progress = 35 + Math.min(60, Math.round(((doneCount + (fileState.progress || 0) / 100) / sourceTexFiles.length) * 60));
            },
          );

          const parsed = parseResponse(result.text);
          const targetRelPath = texTargetPath(relPath);
          let translated = parsed.files[targetRelPath] || parsed.files[Object.keys(parsed.files)[0]];
          if (!translated) throw new Error(`No translated file block for ${targetRelPath}`);

          translated = patchTranslatedInputs(normalizeTranslatedLatex(translated), relPath, texMap);
          translated = repairProtectedCommandArgs(translationFiles[relPath], translated);
          if (relPath === mainSourceTex) {
            translated = translated.replace(/(\\documentclass(?:\[[^\]]*\])?\{[^}]+\})/, `$1${XELATEX_SHIM}`);
          }
          const validation = validateTranslatedTex(translationFiles[relPath], translated, relPath);
          if (!validation.ok) {
            throw new Error(`Structure validation failed: ${validation.issues.slice(0, 4).join("; ")}`);
          }

          const target = path.join(jobDir, ...targetRelPath.replace(/\\/g, "/").split("/"));
          const dir = path.dirname(target);
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          writeFileSync(target, translated, "utf-8");

          usageParts.push(result.usage);
          writtenFiles.push(targetRelPath);
          Object.assign(fileState, {
            status: "done",
            progress: 100,
            chars: result.text.length,
            tokens: result.usage?.outputTokens || fileState.tokens || 0,
            tps: result.stats?.tps || fileState.tps || 0,
            unitCount: result.unitCount ?? fileState.unitCount ?? 0,
            batchCount: result.batchCount ?? fileState.batchCount ?? 0,
            validation,
            finishedAt: Date.now(),
            durationSeconds: Math.round((Date.now() - startedAt) / 1000),
          });
          Object.assign(threadState, {
            status: "idle",
            activeFile: null,
            tokens: result.usage?.outputTokens || threadState.tokens || 0,
            chars: result.text.length,
            tps: result.stats?.tps || threadState.tps || 0,
            completed: (threadState.completed || 0) + 1,
          });
          taskLog(task, `Thread ${threadId}: done ${relPath} -> ${targetRelPath}`);
        } catch (error) {
          failedFiles.push({ path: relPath, error: error.message });
          Object.assign(fileState, {
            status: "error",
            progress: 100,
            error: error.message,
            finishedAt: Date.now(),
          });
          Object.assign(threadState, { status: "idle", activeFile: null });
          taskLog(task, `Thread ${threadId} ERROR ${relPath}: ${error.message}`);
        }
      });

      if (writtenFiles.length === 0) throw new Error("All tex file translations failed");
      taskLog(task, `Wrote ${writtenFiles.length}/${sourceTexFiles.length} translated tex files`);

      const translationUsage = buildTranslationUsage({
        model: activeModel,
        apiEndpoint: activeEndpoint,
        usage: mergeUsage(usageParts),
        durationSeconds: Math.round((Date.now() - apiStart) / 1000),
      });
      writeMeta(jobDir, {
        cnTex: existsSync(path.join(jobDir, ...mainCnTex.split("/"))) ? mainCnTex : writtenFiles[0],
        translationUsage,
        translationPipelineVersion: TRANSLATION_PIPELINE_VERSION,
        fileTranslations: task.files,
        structureManifest,
        translationQuality: {
          failedFiles,
          validatedFiles: task.files.filter(file => file.validation?.ok).length,
          warnings: task.files.flatMap(file => (file.validation?.warnings || []).map(warning => ({ path: file.path, warning }))),
        },
        parallelism,
      });
      task.phase = failedFiles.length ? "partial_error" : "done";
      task.status = failedFiles.length ? "partial_error" : "done";
      task.progress = 100;
      task.activeFile = null;
      task.usage = translationUsage.tokens;
      task.result = { filesWritten: writtenFiles.length, failedFiles, mainCnTex, translationUsage, structureManifest };
      taskLog(task, failedFiles.length ? `Translation partially complete (${failedFiles.length} failed)` : "Translation complete");
    } catch (e) {
      task.phase = "error";
      task.status = "error";
      task.result = { error: e.message };
      taskLog(task, `ERROR: ${e.message}`);
    }
  })();
});

// ── Stream task progress (SSE) ──
app.get("/api/tasks/:id/stream", (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: "task not found" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let lastLogIdx = -1;

  // First send: full state + all existing logs
  res.write(`data: ${JSON.stringify({
    jobId: task.jobId, status: task.status, phase: task.phase,
    progress: task.progress, result: task.result,
    preview: task.preview, stats: task.stats, usage: task.usage,
    files: task.files, activeFile: task.activeFile, threads: task.threads,
    structureManifest: task.structureManifest,
    log: task.log, // full log for catch-up
  })}\n\n`);
  lastLogIdx = task.log.length - 1;

  if (isTerminalTask(task)) { res.end(); return; }

  // Subsequent sends: only new log entries
  const interval = setInterval(() => {
    if (isTerminalTask(task)) {
      const newLogs = task.log.slice(lastLogIdx + 1);
      res.write(`data: ${JSON.stringify({
        status: task.status, phase: task.phase, progress: task.progress,
        preview: task.preview, stats: task.stats, usage: task.usage,
        files: task.files, activeFile: task.activeFile, threads: task.threads,
        structureManifest: task.structureManifest,
        result: task.result, log: newLogs,
      })}\n\n`);
      res.end();
      clearInterval(interval);
      return;
    }
    const newLogs = task.log.slice(lastLogIdx + 1);
    if (newLogs.length > 0) {
      lastLogIdx = task.log.length - 1;
    }
    res.write(`data: ${JSON.stringify({
      status: task.status, phase: task.phase, progress: task.progress,
      preview: task.preview, stats: task.stats, usage: task.usage,
      files: task.files, activeFile: task.activeFile, threads: task.threads,
      structureManifest: task.structureManifest,
      log: newLogs,
    })}\n\n`);
  }, 1000);

  req.on("close", () => clearInterval(interval));
});

// ── Find running task for a job (for reconnect) ──
app.get("/api/jobs/:id/running-task", (req, res) => {
  for (const t of tasks.values()) {
    if (t.jobId === req.params.id && !isTerminalTask(t)) {
      return res.json({ taskId: t.taskId, status: t.status, phase: t.phase });
    }
  }
  res.json(null);
});

// ── List tasks ──
app.get("/api/tasks", (req, res) => {
  const list = [];
  for (const t of tasks.values()) {
    list.push({ taskId: t.taskId, jobId: t.jobId, status: t.status, phase: t.phase, progress: t.progress, startTime: t.startTime });
  }
  list.sort((a, b) => b.startTime - a.startTime);
  res.json(list);
});

// ── Compile (SSE progress) ──
app.post("/api/compile", async (req, res) => {
  try {
    const { jobId, texFile, xelatexPath: preferredXelatexPath } = req.body;
    const jobDir = path.join(JOBS_DIR, jobId);
    if (!existsSync(jobDir)) return res.status(404).json({ error: "job not found" });
    const meta = readMeta(jobDir);
    const repairedCnFiles = repairStrayTranslatedTex(jobDir);
    const rootCnFiles = readdirSync(jobDir).filter(f => f.endsWith("_cn.tex"));
    const mainCandidate = rootCnFiles.find(isLikelyMainCnTex) || repairedCnFiles.find(isLikelyMainCnTex);
    const metaCandidate = meta.cnTex && !meta.cnTex.includes("/") && existsSync(path.join(jobDir, meta.cnTex)) ? meta.cnTex : "";
    const mainTex = texFile
      || mainCandidate
      || metaCandidate
      || rootCnFiles[0]
      || repairedCnFiles[0];
    if (!mainTex) return res.status(400).json({ error: "no _cn.tex file found" });
    if (!meta.cnTex || meta.cnTex !== mainTex) writeMeta(jobDir, { cnTex: mainTex });

    const { compilePaper } = await getCompiler();
    const xelatexPath = await (await getCompiler()).resolveXelatex(preferredXelatexPath || "");

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    const send = (type, data) => res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

    send("start", { xelatexPath, mainTex });
    const result = await compilePaper(jobDir, mainTex, (step, exitCode, stderr) => {
      send("step", { step, exitCode, stderr: (stderr || "").slice(-200) });
    }, { xelatexPath: preferredXelatexPath || "" });

    writeMeta(jobDir, {
      ...(result.success ? { status: result.hasLatexErrors ? "translated" : "compiled" } : {}),
      cnTex: mainTex,
      compileAnalysis: result.logAnalysis || null,
      compileHasLatexErrors: Boolean(result.hasLatexErrors),
      compiledAt: new Date().toISOString(),
    });
    send("done", {
      success: result.success,
      hasLatexErrors: result.hasLatexErrors,
      pdfPath: result.pdfPath,
      log: result.log,
      logAnalysis: result.logAnalysis || null,
      xelatexPath,
    });
    res.end();
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
    else { res.write(`data: ${JSON.stringify({ type: "error", message: e.message })}\n\n`); res.end(); }
  }
});

// ── Detect xelatex ──
app.get("/api/detect-xelatex", async (req, res) => {
  try {
    const { resolveXelatex } = await import("./services/compiler.js");
    res.json({ path: await resolveXelatex() });
  } catch (e) { res.json({ path: null }); }
});

app.post("/api/verify-api-key", async (req, res) => {
  const started = Date.now();
  try {
    const settings = readServiceSettings();
    const {
      apiKey = settings.apiKey,
      apiEndpoint = settings.apiEndpoint,
      model = settings.model,
    } = req.body || {};
    if (!apiKey) return res.status(400).json({ error: "API Key is required" });

    const base = String(apiEndpoint).replace(/\/+$/, "");
    const isAnthropic = base.endsWith("/anthropic");
    const url = isAnthropic ? `${base}/messages` : `${base}/chat/completions`;
    const headers = isAnthropic
      ? { "Content-Type": "application/json", "x-api-key": apiKey }
      : { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` };
    const body = isAnthropic ? {
      model,
      max_tokens: 8,
      system: "Reply with ok.",
      messages: [{ role: "user", content: "ping" }],
      temperature: 0,
    } : {
      model,
      max_tokens: 8,
      messages: [{ role: "user", content: "Reply with ok." }],
      temperature: 0,
    };

    const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const text = await resp.text();
    if (!resp.ok) return res.status(resp.status).json({ error: `API ${resp.status}: ${text.slice(0, 300)}` });
    const data = JSON.parse(text);
    if (data.error) return res.status(400).json({ error: data.error.message || JSON.stringify(data.error) });

    if (req.body?.apiKey) {
      writeServiceSettings({ apiKey, apiEndpoint, model, parallelism: settings.parallelism });
    }

    res.json({
      ok: true,
      model,
      modelName: DEEPSEEK_PRICING_CNY[deepseekModelTier(model)].modelName,
      apiFormat: isAnthropic ? "Anthropic" : "OpenAI",
      latencyMs: Date.now() - started,
      usage: rawUsageForVerify(data),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function rawUsageForVerify(data) {
  const usage = data?.usage || data?.message?.usage || null;
  if (!usage) return null;
  return {
    inputTokens: usage.input_tokens || usage.prompt_tokens || 0,
    outputTokens: usage.output_tokens || usage.completion_tokens || 0,
    cachedInputTokens: usage.prompt_cache_hit_tokens || usage.cache_read_input_tokens || 0,
  };
}

// ── Download PDF (auto-detect in build/ or root) ──
app.get("/api/download-pdf/:jobId", (req, res) => {
  const jobDir = path.join(JOBS_DIR, req.params.jobId);
  // Look in build/ first, then job root
  const candDirs = [path.join(jobDir, "build"), jobDir];
  for (const dir of candDirs) {
    if (!existsSync(dir)) continue;
    const pdf = readdirSync(dir).find(f => f.endsWith(".pdf"));
    if (pdf) {
      res.setHeader("Content-Type", "application/pdf");
      return createReadStream(path.join(dir, pdf)).pipe(res);
    }
  }
  res.status(404).send("No PDF found");
});

// ── Download specific file ──
app.get("/api/download/:jobId/:file", (req, res) => {
  const jobDir = path.join(JOBS_DIR, req.params.jobId);
  let fp = path.join(jobDir, "build", req.params.file);
  if (!existsSync(fp)) fp = path.join(jobDir, req.params.file);
  if (!existsSync(fp)) return res.status(404).send("Not found");
  const ext = path.extname(req.params.file).toLowerCase();
  res.setHeader("Content-Type", ext === ".pdf" ? "application/pdf" : "text/plain");
  createReadStream(fp).pipe(res);
});

app.get("/api/feedback/:file", (req, res) => {
  const fileName = path.basename(req.params.file);
  const fp = path.join(JOBS_DIR, "_feedback", fileName);
  if (!existsSync(fp) || !fileName.endsWith(".zip")) return res.status(404).send("Not found");
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  createReadStream(fp).pipe(res);
});

// ── Fetch arXiv source by ID/URL ──
app.post("/api/fetch-arxiv", async (req, res) => {
  try {
    const { query, proxy } = req.body;
    if (!query) return res.status(400).json({ error: "No query" });
    // Extract arXiv ID
    let arxivId = query.trim();
    const m = arxivId.match(/(\d{4}\.\d{4,5})/);
    if (m) arxivId = m[1];
    else return res.status(400).json({ error: "Could not detect arXiv ID. Use format: 2412.17007 or https://arxiv.org/abs/2412.17007" });

    const jobDir = path.join(JOBS_DIR, arxivId);
    if (existsSync(jobDir) && readdirSync(jobDir).some(f => f.endsWith(".tex"))) {
      let meta = readMeta(jobDir);
      if (isSuspiciousTitle(meta.title)) {
        const repairedTitle = extractTitleFromTex(jobDir);
        if (repairedTitle) {
          writeMeta(jobDir, { title: repairedTitle });
          meta = readMeta(jobDir);
        }
      }
      return res.json({ jobId: arxivId, title: meta.title, existing: true });
    }

    // Download from arXiv
    const url = `https://arxiv.org/src/${arxivId}`;
    const resp = await fetchArxivSource(url, proxy || "");
    if (resp.status === 404) return res.status(404).json({ error: `arXiv ${arxivId} has no source package` });
    if (!resp.ok) return res.status(502).json({ error: `arXiv returned HTTP ${resp.status}` });

    const buf = new Uint8Array(await resp.arrayBuffer());
    const tmpPath = path.join(JOBS_DIR, "_uploads", arxivId + ".tar.gz");
    writeFileSync(tmpPath, buf);

    const { extractTarGz } = await getExtractor();
    mkdirSync(jobDir, { recursive: true });
    const result = extractTarGz(tmpPath, jobDir);
    const title = extractTitleFromTex(jobDir) || arxivId;
    const fileCount = countFiles(jobDir);
    writeMeta(jobDir, { arxivId, title, createdAt: new Date().toISOString(), fileCount });
    const mainTex = (await getExtractor()).findMainTex(jobDir);

    res.json({ jobId: arxivId, title, fileCount, mainTex: mainTex ? path.basename(mainTex) : null });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

// ── Open folder ──
app.get("/api/open/:jobId", async (req, res) => {
  const jobDir = path.join(JOBS_DIR, req.params.jobId);
  if (!existsSync(jobDir)) return res.status(404).json({ error: "not found" });
  const { exec } = await import("child_process");
  exec(`start "" "${jobDir}"`);
  res.json({ ok: true });
});

// ── Start ──
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  const reactIndex = path.join(DIST_DIR, "index.html");
  const legacyIndex = path.join(PUBLIC_DIR, "index.html");
  if (existsSync(reactIndex)) return res.sendFile(reactIndex);
  if (existsSync(legacyIndex)) return res.sendFile(legacyIndex);
  next();
});

(function start(port) {
  const s = app.listen(port, () => {
    console.log(`arXiv Translation Service: http://localhost:${port}`);
  });
  s.on("error", (e) => {
    if (e.code === "EADDRINUSE") { s.close(); start(port + 1); }
    else throw e;
  });
})(PORT);
