/**
 * xelatex + bibtex compilation service.
 * Output goes to build/ subdirectory.
 */

import { spawn } from "child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "fs";
import path from "path";

export async function resolveXelatex(preferredPath = "") {
  if (preferredPath && existsSync(preferredPath)) return preferredPath;

  const whichCmd = process.platform === "win32" ? "where.exe" : "which";
  const name = process.platform === "win32" ? "xelatex.exe" : "xelatex";
  try {
    const { stdout } = await new Promise((resolve, reject) => {
      const p = spawn(whichCmd, [name], { shell: true });
      let out = ""; p.stdout.on("data", d => out += d);
      p.on("close", code => code === 0 ? resolve({ stdout: out }) : reject(new Error("not found")));
      p.on("error", reject);
    });
    return stdout.trim().split("\n")[0].trim();
  } catch {}
  const candidates = process.platform === "win32" ? [
    "C:\\texlive\\2024\\bin\\windows\\xelatex.exe",
    "C:\\Program Files\\MiKTeX\\miktex\\bin\\x64\\xelatex.exe",
  ] : ["/usr/bin/xelatex", "/Library/TeX/texbin/xelatex"];
  for (const c of candidates) { if (existsSync(c)) return c; }
  return name;
}

function runCmd(cmd, args, cwd) {
  return new Promise((resolve) => {
    let stdout = "", stderr = "";
    let proc;
    try {
      proc = spawn(cmd, args, { cwd, shell: true, timeout: 120000 });
    } catch (e) {
      resolve({ exitCode: 1, stdout, stderr: e.message });
      return;
    }
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => resolve({ exitCode: code, stdout, stderr }));
    proc.on("error", (e) => resolve({ exitCode: 1, stdout, stderr: e.message }));
  });
}

const MIKTEX_FILE_PACKAGES = {
  "algorithm.sty": "algorithms",
  "algorithmic.sty": "algorithms",
  "balance.sty": "balance",
  "booktabs.sty": "booktabs",
  "caption.sty": "caption",
  "dblfloatfix.sty": "dblfloatfix",
  "flushend.sty": "sttools",
  "multirow.sty": "multirow",
  "stfloats.sty": "sttools",
  "subfig.sty": "subfig",
};

const LOCAL_PACKAGE_SHIMS = {
  "stfloats.sty": `\\NeedsTeXFormat{LaTeX2e}
\\ProvidesPackage{stfloats}[2026/05/10 local compatibility shim]
\\providecommand{\\fnbelowfloat}{}
\\providecommand{\\fnunderfloat}{}
\\providecommand{\\setbaselinefloat}{}
\\providecommand{\\setbaselinefixed}{}
\\providecommand{\\setbaselineflexible}{}
\\endinput
`,
};

function packageCandidatesForMissingFile(fileName) {
  const normalized = fileName.replace(/\\/g, "/").split("/").pop();
  const fallback = normalized.replace(/\.(sty|cls|def|cfg)$/i, "");
  return [...new Set([MIKTEX_FILE_PACKAGES[normalized], fallback].filter(Boolean))];
}

function localPackageShim(fileName) {
  const normalized = fileName.replace(/\\/g, "/").split("/").pop();
  return normalized && LOCAL_PACKAGE_SHIMS[normalized]
    ? { fileName: normalized, content: LOCAL_PACKAGE_SHIMS[normalized] }
    : null;
}

function commandSucceeded(result) {
  const text = `${result.stdout}\n${result.stderr}`;
  return result.exitCode === 0 && !/(requested package is unknown|not found|failed|error)/i.test(text);
}

async function installMissingPackages(logPath, miktexDir, paperDir) {
  if (!existsSync(logPath)) return [];
  const log = readFileSync(logPath, "utf-8");
  const missing = new Set();
  const re = /! LaTeX Error: File `([^']+)' not found/g;
  let m;
  while ((m = re.exec(log)) !== null) missing.add(m[1]);
  if (missing.size === 0) return [];

  // Find mpm.exe
  const mpmCandidates = [
    path.join(miktexDir, "miktex\\bin\\x64\\mpm.exe"),
    path.join(miktexDir, "..\\miktex\\bin\\x64\\mpm.exe"),
    "C:\\Program Files\\MiKTeX\\miktex\\bin\\x64\\mpm.exe",
    "mpm",
  ];
  let mpm = null;
  for (const c of mpmCandidates) { if (existsSync(c) || c === "mpm") { mpm = c; break; } }
  if (!mpm) return [];

  const installed = [];
  for (const fileName of missing) {
    let resolved = false;
    for (const pkgName of packageCandidatesForMissingFile(fileName)) {
      const result = await runCmd(mpm, ["--install=" + pkgName], process.env.TEMP || ".");
      if (commandSucceeded(result)) {
        installed.push({ fileName, packageName: pkgName });
        resolved = true;
        break;
      }
    }
    if (!resolved) {
      const shim = localPackageShim(fileName);
      if (shim && !existsSync(path.join(paperDir, shim.fileName))) {
        writeFileSync(path.join(paperDir, shim.fileName), shim.content, "utf-8");
        installed.push({ fileName, packageName: `${shim.fileName} shim` });
      }
    }
  }
  return installed;
}

const XELATEX_SHIM_MARKER = "% xelatex compatibility shim (auto-injected)";
const XELATEX_SHIM = `\n${XELATEX_SHIM_MARKER}
\\makeatletter
\\@ifundefined{pdfglyphtounicode}{\\newcommand{\\pdfglyphtounicode}[2]{}}{}
\\@ifundefined{pdfgentounicode}{\\newcount\\pdfgentounicode}{}
\\@ifundefined{pdfcompresslevel}{\\newcount\\pdfcompresslevel}{}
\\@ifundefined{pdfoptionpdfminorversion}{\\newcount\\pdfoptionpdfminorversion}{}
\\makeatother
`;

const CJK_SHIM_MARKER = "% Chinese font support (auto-injected)";
const CJK_SHIM = `\n${CJK_SHIM_MARKER}
\\usepackage[fontset=windows]{ctex}
\\xeCJKsetup{AutoFakeBold=2}
\\setCJKmainfont{Noto Serif SC}[BoldFont={Noto Serif SC}, BoldFeatures={FakeBold=2}, ItalicFont=KaiTi]
\\setCJKsansfont{Noto Sans SC}[BoldFont={Noto Sans SC}, BoldFeatures={FakeBold=2}]
\\setCJKmonofont{FangSong}
`;

function stripOldShim(texContent) {
  return texContent
    .replace(/\n% xelatex compatibility shim \(auto-injected\)\n\\ifdefined\\pdfglyphtounicode\\else\\let\\pdfglyphtounicode\\@gobbletwo\\fi\n\\ifdefined\\pdfminorversion\\else\\let\\pdfminorversion\\@gobble\\fi\n/g, "\n")
    .replace(/\n% xelatex compatibility shim \(auto-injected\)\n(?=\\begin\{document\})/g, "\n")
    .replace(/\n% xelatex compatibility shim \(auto-injected\)\n\\makeatletter\n\\@ifundefined\{pdfglyphtounicode\}\{\\newcommand\{\\pdfglyphtounicode\}\[2\]\{\}\}\{\}\n\\@ifundefined\{pdfgentounicode\}\{\\newcount\\pdfgentounicode\}\{\}\n\\makeatother\n/g, "\n");
}

function stripCjkShim(texContent) {
  return texContent.replace(/\n?% Chinese font support \(auto-injected\)\n\\usepackage(?:\[[^\]]*\])?\{ctex\}\n\\xeCJKsetup\{AutoFakeBold=2\}\n\\setCJKmainfont\{Noto Serif SC\}\[BoldFont=\{Noto Serif SC\}, BoldFeatures=\{FakeBold=2\}, ItalicFont=KaiTi\]\n\\setCJKsansfont\{Noto Sans SC\}\[BoldFont=\{Noto Sans SC\}, BoldFeatures=\{FakeBold=2\}\]\n\\setCJKmonofont\{FangSong\}\n?/g, "\n");
}

function injectXelatexShim(texContent) {
  const cleaned = stripOldShim(texContent);
  if (cleaned.includes(XELATEX_SHIM_MARKER)) return cleaned;

  const docclass = cleaned.match(/\\documentclass(?:\[[^\]]*\])?\{[^}]+\}/);
  if (docclass?.index !== undefined) {
    const insertAt = docclass.index + docclass[0].length;
    return cleaned.slice(0, insertAt) + XELATEX_SHIM + cleaned.slice(insertAt);
  }

  return XELATEX_SHIM + cleaned;
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

function hasCjkText(content) {
  return /[\u3400-\u9fff]/.test(content);
}

function removePdfLatexEncodingPackages(content) {
  return content
    .replace(/^\s*\\usepackage(?:\[[^\]]*\])?\{inputenc\}\s*$/gm, "")
    .replace(/^\s*\\usepackage(?:\[[^\]]*\])?\{fontenc\}\s*$/gm, "");
}

function injectChineseSupport(texContent) {
  const withoutStaleShim = stripCjkShim(texContent);
  const docclass = withoutStaleShim.match(/\\documentclass(?:\[[^\]]*\])?\{[^}]+\}/);
  if (!docclass) {
    return withoutStaleShim;
  }

  if (!hasCjkText(withoutStaleShim) || /\\usepackage(?:\[[^\]]*\])?\{ctex\}|\\xeCJKsetup|\\setCJKmainfont/.test(withoutStaleShim)) {
    return withoutStaleShim;
  }

  const cleaned = removePdfLatexEncodingPackages(withoutStaleShim);
  const shimIndex = cleaned.indexOf(XELATEX_SHIM_MARKER);
  if (shimIndex !== -1) {
    const shimEnd = cleaned.indexOf("\\makeatother", shimIndex);
    if (shimEnd !== -1) {
      const insertAt = shimEnd + "\\makeatother".length;
      return cleaned.slice(0, insertAt) + CJK_SHIM + cleaned.slice(insertAt);
    }
  }

  const insertAt = docclass.index + docclass[0].length;
  return cleaned.slice(0, insertAt) + CJK_SHIM + cleaned.slice(insertAt);
}

function normalizeTranslatedSources(dir) {
  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    if (entry === "build") continue;
    if (statSync(fullPath).isDirectory()) {
      normalizeTranslatedSources(fullPath);
      continue;
    }
    if (!entry.endsWith("_cn.tex")) continue;
    const content = readFileSync(fullPath, "utf-8");
    const normalized = injectChineseSupport(normalizeTranslatedLatex(content));
    if (normalized !== content) writeFileSync(fullPath, normalized, "utf-8");
  }
}

export function analyzeLatexLog(logText = "") {
  const lines = String(logText || "").split(/\r?\n/);
  const hardErrors = [];
  const warnings = [];
  const missingFiles = [];
  const suspicious = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^! /.test(line)) {
      hardErrors.push({
        line: i + 1,
        message: line.trim(),
        context: lines.slice(i, Math.min(i + 5, lines.length)).join("\n").trim(),
      });
      const missing = /File `([^']+)' not found/.exec(line);
      if (missing) missingFiles.push(missing[1]);
    } else if (/Runaway argument|File ended while scanning|Emergency stop|Too many }|Missing } inserted|Undefined control sequence/.test(line)) {
      hardErrors.push({
        line: i + 1,
        message: line.trim(),
        context: lines.slice(i, Math.min(i + 5, lines.length)).join("\n").trim(),
      });
    } else if (/LaTeX Warning|Package .* Warning|Rerun to get|Citation .* undefined|Reference .* undefined/.test(line)) {
      warnings.push({ line: i + 1, message: line.trim() });
    } else if (/Missing character: There is no .* in font nullfont/.test(line)) {
      suspicious.push({ line: i + 1, message: line.trim() });
    }
  }

  return {
    hardErrorCount: hardErrors.length,
    warningCount: warnings.length,
    suspiciousCount: suspicious.length,
    missingFiles: [...new Set(missingFiles)],
    hardErrors: hardErrors.slice(0, 12),
    warnings: warnings.slice(0, 12),
    suspicious: suspicious.slice(0, 12),
  };
}

function bblHasEntries(filePath) {
  if (!existsSync(filePath)) return false;
  return readFileSync(filePath, "utf-8").includes("\\bibitem");
}

function findBblSource(paperDir, stem, buildDir) {
  if (!stem.endsWith("_cn")) return;

  const sourceStem = stem.slice(0, -3);
  const candidates = [
    path.join(paperDir, `${sourceStem}.bbl`),
    path.join(buildDir, `${sourceStem}.bbl`),
    ...readdirSync(paperDir)
      .filter((file) => file.endsWith(".bbl") && !file.endsWith("_cn.bbl"))
      .map((file) => path.join(paperDir, file)),
  ];
  return candidates.find((candidate) => bblHasEntries(candidate));
}

function seedTranslatedBibliography(paperDir, stem, buildDir, force = false) {
  if (!stem.endsWith("_cn")) return false;
  const target = path.join(buildDir, `${stem}.bbl`);
  if (!force && bblHasEntries(target)) return true;

  const source = findBblSource(paperDir, stem, buildDir);
  if (!source) return false;
  copyFileSync(source, target);
  return true;
}

function auxBibDatabases(auxPath) {
  if (!existsSync(auxPath)) return [];
  const aux = readFileSync(auxPath, "utf-8");
  const databases = [];
  const re = /\\bibdata\{([^}]+)\}/g;
  let match;
  while ((match = re.exec(aux)) !== null) {
    databases.push(...match[1].split(",").map((name) => name.trim()).filter(Boolean));
  }
  return databases;
}

function hasBibDatabaseFiles(paperDir, auxPath) {
  const databases = auxBibDatabases(auxPath);
  return databases.some((name) => {
    const normalized = name.endsWith(".bib") ? name : `${name}.bib`;
    return existsSync(path.join(paperDir, normalized));
  });
}

export async function compilePaper(paperDir, texFile, onProgress, options = {}) {
  const xelatexPath = await resolveXelatex(options.xelatexPath || "");
  const stem = path.basename(texFile, ".tex");
  const texName = path.basename(texFile);
  const buildDir = path.join(paperDir, "build");
  if (!existsSync(buildDir)) mkdirSync(buildDir, { recursive: true });
  normalizeTranslatedSources(paperDir);
  seedTranslatedBibliography(paperDir, stem, buildDir);

  // Define pdfTeX glyph mapping commands before conference styles load glyphtounicode.
  const texPath = path.join(paperDir, texFile);
  let texContent = readFileSync(texPath, "utf-8");
  const patchedTexContent = injectXelatexShim(texContent);
  if (patchedTexContent !== texContent) writeFileSync(texPath, patchedTexContent, "utf-8");

  const miktexDir = xelatexPath.includes("MiKTeX")
    ? xelatexPath.split("MiKTeX")[0] + "MiKTeX" : "";

  const results = [];

  // 1. xelatex. Missing packages can surface one at a time, so retry a few
  // rounds after MiKTeX installs anything reported by the latest log.
  let r1 = await runCmd(xelatexPath, ["-interaction=nonstopmode", "-output-directory=build", "--enable-installer", texName], paperDir);
  for (let attempt = 0; r1.exitCode !== 0 && attempt < 3; attempt += 1) {
    const logPath = path.join(buildDir, stem + ".log");
    const installed = await installMissingPackages(logPath, miktexDir || path.dirname(xelatexPath), paperDir);
    if (installed.length === 0) break;
    for (const item of installed) {
      results.push({ step: `install ${item.packageName}`, exitCode: 0, stdout: "", stderr: `${item.fileName} -> ${item.packageName}` });
      onProgress?.(`install ${item.packageName}`, 0, `${item.fileName} -> ${item.packageName}`);
    }
    r1 = await runCmd(xelatexPath, ["-interaction=nonstopmode", "-output-directory=build", "--enable-installer", texName], paperDir);
  }

  results.push({ step: "xelatex (1/3)", ...r1 });
  onProgress?.("xelatex (1/3)", r1.exitCode, r1.stderr);
  if (r1.exitCode !== 0 && !existsSync(path.join(buildDir, stem + ".aux"))) {
    const logPath = path.join(buildDir, stem + ".log");
    const log = r1.stderr ? r1.stderr.slice(-3000)
      : existsSync(logPath) ? readFileSync(logPath, "utf-8").slice(-3000) : "";
    const fullLog = existsSync(logPath) ? readFileSync(logPath, "utf-8") : log;
    return { success: false, pdfPath: null, xelatexPath, log,
      logAnalysis: analyzeLatexLog(fullLog),
      results };
  }

  // 2. bibtex
  const auxPath = path.join(buildDir, stem + ".aux");
  if (existsSync(auxPath)) {
    const hasBibFiles = hasBibDatabaseFiles(paperDir, auxPath);
    const hasSourceBbl = Boolean(findBblSource(paperDir, stem, buildDir));

    if (hasBibFiles) {
      const r2 = await runCmd(xelatexPath.replace(/xelatex(\.exe)?$/i, "bibtex$1"), [path.join("build", stem)], paperDir);
      results.push({ step: "bibtex", ...r2 });
      onProgress?.("bibtex", r2.exitCode, r2.stderr);
      if (r2.exitCode !== 0 && hasSourceBbl) {
        seedTranslatedBibliography(paperDir, stem, buildDir, true);
        results.push({ step: "bibliography fallback", exitCode: 0, stdout: "", stderr: "" });
        onProgress?.("bibliography fallback", 0, "");
      }
    } else if (hasSourceBbl) {
      seedTranslatedBibliography(paperDir, stem, buildDir, true);
      results.push({ step: "bibliography from source .bbl", exitCode: 0, stdout: "", stderr: "" });
      onProgress?.("bibliography from source .bbl", 0, "");
    }
  }

  // 3-4. xelatex
  const r3 = await runCmd(xelatexPath, ["-interaction=nonstopmode", "-output-directory=build", "--enable-installer", texName], paperDir);
  results.push({ step: "xelatex (2/3)", ...r3 });
  onProgress?.("xelatex (2/3)", r3.exitCode, r3.stderr);

  const r4 = await runCmd(xelatexPath, ["-interaction=nonstopmode", "-output-directory=build", "--enable-installer", texName], paperDir);
  results.push({ step: "xelatex (3/3)", ...r4 });
  onProgress?.("xelatex (3/3)", r4.exitCode, r4.stderr);

  const pdfPath = path.join(buildDir, stem + ".pdf");
  const logText = existsSync(path.join(buildDir, stem + ".log"))
    ? readFileSync(path.join(buildDir, stem + ".log"), "utf-8") : "";
  const pdfExists = existsSync(pdfPath);
  const logAnalysis = analyzeLatexLog(logText);
  const hasLatexErrors = logAnalysis.hardErrorCount > 0;
  return {
    success: pdfExists,
    hasLatexErrors,
    pdfPath: pdfExists ? pdfPath : null,
    xelatexPath,
    log: logText.slice(-3000),
    logAnalysis,
    results,
  };
}
