const TEXT_COMMANDS = [
  "title",
  "section",
  "subsection",
  "subsubsection",
  "paragraph",
  "subparagraph",
  "caption",
  "captionof",
];

const TRANSLATABLE_ENVS = new Set(["abstract", "acknowledgments", "acknowledgements"]);
const PROTECTED_ENVS = [
  "equation", "equation*", "align", "align*", "aligned", "gather", "gather*",
  "multline", "multline*", "split", "cases", "matrix", "pmatrix", "bmatrix",
  "vmatrix", "Vmatrix", "tabular", "tabularx", "array", "tikzpicture",
  "algorithm", "algorithmic", "lstlisting", "verbatim",
];

const PROTECTED_COMMANDS = [
  "cite", "cites", "citep", "citet", "citealp", "citeauthor", "citeyear",
  "ref", "cref", "Cref", "autoref", "eqref", "label", "url", "href",
  "includegraphics", "input", "include", "bibliography", "bibliographystyle",
  "footnote", "thanks",
];

export function stripLatexComments(source) {
  return String(source || "")
    .split(/\r?\n/)
    .map((line) => {
      let commentAt = -1;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === "%" && !isEscaped(line, i)) {
          commentAt = i;
          break;
        }
      }
      if (commentAt < 0) return line;
      const before = line.slice(0, commentAt).trimEnd();
      return before.trim() ? before : "";
    })
    .filter((line, index, lines) => line.trim() || lines[index - 1]?.trim() || lines[index + 1]?.trim())
    .join("\n");
}

function isEscaped(source, index) {
  let count = 0;
  for (let i = index - 1; i >= 0 && source[i] === "\\"; i--) count++;
  return count % 2 === 1;
}

export function readBraceRange(source, openIndex) {
  if (openIndex < 0 || source[openIndex] !== "{") return null;
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{" && !isEscaped(source, i)) depth++;
    if (ch === "}" && !isEscaped(source, i)) {
      depth--;
      if (depth === 0) {
        return { open: openIndex, close: i, start: openIndex + 1, end: i };
      }
    }
  }
  return null;
}

function findCommandBraceRange(source, commandIndex) {
  let i = commandIndex;
  while (i < source.length && source[i] !== "\\") i++;
  i++;
  while (/[A-Za-z@]/.test(source[i] || "")) i++;
  if (source[i] === "*") i++;
  while (/\s/.test(source[i] || "")) i++;
  while (source[i] === "[") {
    const close = source.indexOf("]", i + 1);
    if (close < 0) return null;
    i = close + 1;
    while (/\s/.test(source[i] || "")) i++;
  }
  return readBraceRange(source, i);
}

function addRange(ranges, start, end, kind = "protected") {
  if (start >= 0 && end > start) ranges.push({ start, end, kind });
}

function overlaps(ranges, start, end) {
  return ranges.some((range) => start < range.end && end > range.start);
}

function normalizeKeyList(raw) {
  return String(raw || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .sort();
}

function collectCommandArgs(source, commandNames) {
  const results = [];
  const pattern = new RegExp(`\\\\(${commandNames.join("|")})\\*?(?:\\s|\\[|\\{)`, "g");
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const range = findCommandBraceRange(source, match.index);
    if (!range) continue;
    results.push({
      command: match[1],
      fullStart: match.index,
      fullEnd: range.close + 1,
      start: range.start,
      end: range.end,
      text: source.slice(range.start, range.end),
    });
  }
  return results;
}

function collectEnvRanges(source, envNames = PROTECTED_ENVS) {
  const ranges = [];
  for (const envName of envNames) {
    const escaped = envName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\\\begin\\{${escaped}\\}[\\s\\S]*?\\\\end\\{${escaped}\\}`, "g");
    let match;
    while ((match = re.exec(source)) !== null) addRange(ranges, match.index, match.index + match[0].length, `env:${envName}`);
  }
  return ranges;
}

function collectMathRanges(source) {
  const ranges = [];
  const patterns = [
    /\\\[[\s\S]*?\\\]/g,
    /\\\([\s\S]*?\\\)/g,
    /\$\$[\s\S]*?\$\$/g,
    /(?<!\\)\$(?!\$)[\s\S]*?(?<!\\)\$/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) addRange(ranges, match.index, match.index + match[0].length, "math");
  }
  return ranges;
}

function commandWithArgumentsEnd(source, commandIndex) {
  let i = commandIndex + 1;
  while (/[A-Za-z@]/.test(source[i] || "")) i++;
  if (source[i] === "*") i++;
  while (/\s/.test(source[i] || "")) i++;
  let consumed = false;
  while (i < source.length) {
    if (source[i] === "[") {
      const close = source.indexOf("]", i + 1);
      if (close < 0) break;
      i = close + 1;
      consumed = true;
    } else if (source[i] === "{") {
      const range = readBraceRange(source, i);
      if (!range) break;
      i = range.close + 1;
      consumed = true;
    } else {
      break;
    }
    while (/\s/.test(source[i] || "")) i++;
  }
  return consumed ? i : commandIndex;
}

function protectLatexSpans(text) {
  const ranges = [
    ...collectEnvRanges(text),
    ...collectMathRanges(text),
  ];

  const commandPattern = new RegExp(`\\\\(${PROTECTED_COMMANDS.join("|")})\\*?\\b`, "g");
  let match;
  while ((match = commandPattern.exec(text)) !== null) {
    const end = commandWithArgumentsEnd(text, match.index);
    if (end > match.index) addRange(ranges, match.index, end, `cmd:${match[1]}`);
  }

  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const compact = [];
  for (const range of ranges) {
    if (!compact.some((existing) => range.start >= existing.start && range.end <= existing.end)) {
      compact.push(range);
    }
  }

  let protectedText = "";
  let cursor = 0;
  const placeholders = [];
  compact.sort((a, b) => a.start - b.start);
  for (const range of compact) {
    if (range.start < cursor) continue;
    const token = `@@LATEX_${placeholders.length}@@`;
    protectedText += text.slice(cursor, range.start) + token;
    placeholders.push(text.slice(range.start, range.end));
    cursor = range.end;
  }
  protectedText += text.slice(cursor);
  return { text: protectedText, placeholders };
}

function restoreLatexSpans(text, placeholders) {
  let restored = String(text || "");
  placeholders.forEach((value, index) => {
    restored = restored.replaceAll(`@@LATEX_${index}@@`, value);
  });
  return restored;
}

function hasNaturalLanguage(text) {
  return /[A-Za-z]{3,}/.test(text) || /[\u3400-\u9fff]/.test(text);
}

function isCommandOnlyChunk(text) {
  const cleaned = text
    .replace(/%.*$/gm, "")
    .replace(/\\[A-Za-z@]+\*?(?:\[[^\]]*\])?(?:\{[^{}]*\})?/g, "")
    .replace(/[{}\\_\^&~$#]/g, "")
    .trim();
  return cleaned.length < 24 || !hasNaturalLanguage(cleaned);
}

function classifyTexFile(relPath, content, mainTex) {
  const lower = relPath.toLowerCase();
  if (relPath === mainTex) return "main";
  if (/\\documentclass/.test(content)) return "standalone";
  if (lower.includes("appendix") || /\\appendix/.test(content)) return "appendix";
  if (/\\(?:sub)*section\*?\{/.test(content)) return "section";
  if (lower.includes("table") || /\\begin\{tabular/.test(content)) return "table";
  if (lower.includes("fig") || /\\includegraphics/.test(content)) return "figure";
  if (/\\newcommand|\\def\\|\\DeclareMathOperator|\\usepackage/.test(content)) return "preamble";
  return "fragment";
}

function dependencyCommands(content) {
  const deps = [];
  const re = /\\(input|include|subfile|includegraphics|bibliography|addbibresource)(?:\[[^\]]*\])?\{([^}]+)\}/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    deps.push({ type: match[1], target: match[2].trim() });
  }
  return deps;
}

function extractParagraphUnits(source, occupiedRanges, unitPrefix) {
  const units = [];
  const beginDoc = source.search(/\\begin\{document\}/);
  const bodyStart = beginDoc >= 0 ? beginDoc : 0;
  const blockRe = /(?:^|\n)([^\S\r\n]*[^\n][\s\S]*?)(?=\n\s*\n|$)/g;
  let match;
  while ((match = blockRe.exec(source.slice(bodyStart))) !== null) {
    const start = bodyStart + match.index + (match[0].startsWith("\n") ? 1 : 0);
    const text = match[1] || match[0];
    const end = start + text.length;
    const blockers = occupiedRanges
      .filter((range) => start < range.end && end > range.start)
      .sort((a, b) => a.start - b.start);
    let cursor = start;
    const segments = [];
    for (const range of blockers) {
      const segStart = cursor;
      const segEnd = Math.max(segStart, Math.min(range.start, end));
      if (segEnd > segStart) segments.push({ start: segStart, end: segEnd, text: source.slice(segStart, segEnd) });
      cursor = Math.max(cursor, Math.min(range.end, end));
    }
    if (cursor < end) segments.push({ start: cursor, end, text: source.slice(cursor, end) });

    for (const segment of segments.length ? segments : [{ start, end, text }]) {
      if (isCommandOnlyChunk(segment.text)) continue;
      const protectedUnit = protectLatexSpans(segment.text);
      if (!hasNaturalLanguage(protectedUnit.text)) continue;
      units.push({
        id: `${unitPrefix}-p-${units.length + 1}`,
        type: "paragraph",
        start: segment.start,
        end: segment.end,
        text: segment.text,
        protectedText: protectedUnit.text,
        placeholders: protectedUnit.placeholders,
      });
    }
  }
  return units;
}

export function extractTranslationUnits(content, relPath = "file.tex") {
  const units = [];
  const occupied = [
    ...collectEnvRanges(content),
  ];
  const beginDoc = content.search(/\\begin\{document\}/);

  for (const item of collectCommandArgs(content, TEXT_COMMANDS)) {
    if (!hasNaturalLanguage(item.text)) continue;
    const protectedUnit = protectLatexSpans(item.text);
    units.push({
      id: `${relPath.replace(/[^A-Za-z0-9]+/g, "_")}-cmd-${units.length + 1}`,
      type: item.command,
      start: item.start,
      end: item.end,
      text: item.text,
      protectedText: protectedUnit.text,
      placeholders: protectedUnit.placeholders,
    });
    addRange(occupied, item.fullStart, item.fullEnd, `cmd:${item.command}`);
  }

  for (const envName of TRANSLATABLE_ENVS) {
    const re = new RegExp(`\\\\begin\\{${envName}\\}([\\s\\S]*?)\\\\end\\{${envName}\\}`, "g");
    let match;
    while ((match = re.exec(content)) !== null) {
      const text = match[1];
      const start = match.index + match[0].indexOf(text);
      const protectedUnit = protectLatexSpans(text);
      if (!hasNaturalLanguage(protectedUnit.text)) continue;
      units.push({
        id: `${relPath.replace(/[^A-Za-z0-9]+/g, "_")}-env-${units.length + 1}`,
        type: envName,
        start,
        end: start + text.length,
        text,
        protectedText: protectedUnit.text,
        placeholders: protectedUnit.placeholders,
      });
      addRange(occupied, match.index, match.index + match[0].length, `env:${envName}`);
    }
  }

  if (beginDoc >= 0 || !/\\documentclass/.test(content)) {
    units.push(...extractParagraphUnits(content, occupied, relPath.replace(/[^A-Za-z0-9]+/g, "_")));
  }

  units.sort((a, b) => a.start - b.start);
  return units.filter((unit, index, all) => !all.some((other, otherIndex) => otherIndex !== index && unit.start >= other.start && unit.end <= other.end));
}

export function applyUnitTranslations(content, units, translationsById) {
  let next = content;
  for (const unit of [...units].sort((a, b) => b.start - a.start)) {
    const translated = translationsById.get(unit.id);
    if (!translated) continue;
    next = next.slice(0, unit.start) + restoreLatexSpans(translated, unit.placeholders) + next.slice(unit.end);
  }
  return next;
}

export function detectEnglishResiduals(text, limit = 8) {
  const cleaned = String(text || "")
    .replace(/^\s*%.*$/gm, " ")
    .replace(/@@LATEX_\d+@@/g, " ")
    .replace(/\\[A-Za-z@]+\*?(?:\[[^\]]*\])?(?:\{[^{}]*\})?/g, " ")
    .replace(/https?:\/\/\S+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, " ");
  const residuals = [];
  for (const line of cleaned.split(/\r?\n/)) {
    const words = line.match(/[A-Za-z][A-Za-z-]{2,}/g) || [];
    const cjkCount = (line.match(/[\u3400-\u9fff]/g) || []).length;
    if (words.length >= 12 && cjkCount < 6) residuals.push(line.trim().slice(0, 240));
    if (residuals.length >= limit) break;
  }
  return residuals;
}

function commandArgValues(content, commandNames) {
  return collectCommandArgs(content, commandNames).flatMap((item) => normalizeKeyList(item.text));
}

export function repairProtectedCommandArgs(source, translated) {
  const commands = [
    "label", "ref", "eqref", "autoref", "cref", "Cref",
    "cite", "cites", "citep", "citet", "citealp", "citeauthor", "citeyear",
    "includegraphics", "bibliography", "bibliographystyle",
  ];
  let next = translated;
  for (const command of commands) {
    const sourceArgs = collectCommandArgs(source, [command]);
    const targetArgs = collectCommandArgs(next, [command]);
    if (sourceArgs.length === 0 || sourceArgs.length !== targetArgs.length) continue;
    for (let i = targetArgs.length - 1; i >= 0; i--) {
      const sourceText = sourceArgs[i].text;
      const target = targetArgs[i];
      if (target.text === sourceText) continue;
      next = next.slice(0, target.start) + sourceText + next.slice(target.end);
    }
  }
  return next;
}

function envCounts(content) {
  const counts = new Map();
  const re = /\\(begin|end)\{([^}]+)\}/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    const key = `${match[1]}:${match[2]}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function regexCount(content, pattern) {
  return (String(content || "").match(pattern) || []).length;
}

function diffCounts(sourceCounts, targetCounts, label) {
  const issues = [];
  const keys = new Set([...sourceCounts.keys(), ...targetCounts.keys()]);
  for (const key of keys) {
    const sourceValue = sourceCounts.get(key) || 0;
    const targetValue = targetCounts.get(key) || 0;
    if (sourceValue !== targetValue) issues.push(`${label} count changed for ${key}: ${sourceValue} -> ${targetValue}`);
  }
  return issues;
}

export function validateTranslatedTex(source, translated, relPath = "file.tex") {
  const issues = [];
  const warnings = [];

  for (const command of ["label", "ref", "eqref", "autoref", "cref", "Cref", "includegraphics", "bibliography"]) {
    const before = commandArgValues(source, [command]).join("|");
    const after = commandArgValues(translated, [command]).join("|");
    if (before !== after) issues.push(`${command} keys changed in ${relPath}`);
  }
  const sourceCites = commandArgValues(source, ["cite", "cites", "citep", "citet", "citealp", "citeauthor", "citeyear"]).join("|");
  const targetCites = commandArgValues(translated, ["cite", "cites", "citep", "citet", "citealp", "citeauthor", "citeyear"]).join("|");
  if (sourceCites !== targetCites) issues.push(`citation keys changed in ${relPath}`);

  issues.push(...diffCounts(envCounts(source), envCounts(translated), "environment"));

  const sourceBeginCount = (source.match(/\\begin\{/g) || []).length;
  const targetBeginCount = (translated.match(/\\begin\{/g) || []).length;
  if (sourceBeginCount !== targetBeginCount) issues.push(`begin environment count changed in ${relPath}: ${sourceBeginCount} -> ${targetBeginCount}`);

  const sourceLabels = commandArgValues(source, ["label"]).length;
  if (sourceLabels > 0 && !/\\label\{/.test(translated)) issues.push(`all labels disappeared in ${relPath}`);

  for (const [label, pattern] of [
    ["inline math", /(?<!\\)\$(?!\$)/g],
    ["display math", /\\\[|\\\]|\$\$/g],
  ]) {
    const before = regexCount(source, pattern);
    const after = regexCount(translated, pattern);
    if (before !== after) issues.push(`${label} delimiter count changed in ${relPath}: ${before} -> ${after}`);
  }

  if (/\\usepackage(?:\[[^\]]*\])?\{cite\}/.test(translated) && !/\\usepackage(?:\[[^\]]*\])?\{cite\}/.test(source)) {
    issues.push(`unexpected cite package added in ${relPath}`);
  }
  if (/@@LATEX_\d+@@/.test(translated)) issues.push(`unresolved LaTeX placeholder remains in ${relPath}`);
  if ((translated.match(/\{/g) || []).length !== (translated.match(/\}/g) || []).length) {
    issues.push(`brace count is unbalanced in ${relPath}`);
  }
  if (!/[\u3400-\u9fff]/.test(translated) && /[A-Za-z]{20,}/.test(source)) {
    warnings.push(`no Chinese text detected in ${relPath}`);
  }
  for (const residual of detectEnglishResiduals(translated, 5)) {
    warnings.push(`possible untranslated English in ${relPath}: ${residual}`);
  }

  return {
    ok: issues.length === 0,
    issues,
    warnings,
  };
}

export function analyzeLatexProject(files, mainTex) {
  const texFiles = Object.entries(files)
    .filter(([relPath]) => relPath.toLowerCase().endsWith(".tex") && !relPath.toLowerCase().endsWith("_cn.tex"))
    .map(([relPath, content]) => {
      const units = extractTranslationUnits(content, relPath);
      return {
        path: relPath,
        targetPath: relPath.replace(/\.tex$/i, "_cn.tex"),
        role: classifyTexFile(relPath, content, mainTex),
        bytes: Buffer.byteLength(content, "utf-8"),
        chars: content.length,
        unitCount: units.length,
        dependencies: dependencyCommands(content),
        hasDocumentClass: /\\documentclass/.test(content),
        hasBeginDocument: /\\begin\{document\}/.test(content),
      };
    });

  const warnings = [];
  if (!mainTex) warnings.push("No main tex file detected.");
  if (texFiles.filter((file) => file.hasDocumentClass).length > 1) warnings.push("Multiple tex files contain \\documentclass.");
  const totalUnits = texFiles.reduce((sum, file) => sum + file.unitCount, 0);
  if (totalUnits === 0) warnings.push("No translatable text units detected.");

  return {
    createdAt: new Date().toISOString(),
    mainTex,
    texFileCount: texFiles.length,
    totalTranslationUnits: totalUnits,
    texFiles,
    bibliographyFiles: Object.keys(files).filter((relPath) => /\.(bib|bbl)$/i.test(relPath)),
    styleFiles: Object.keys(files).filter((relPath) => /\.(sty|cls|bst|cfg|def|clo)$/i.test(relPath)),
    warnings,
  };
}

export function buildStructureNote(manifest) {
  const lines = [
    `Main tex: ${manifest.mainTex || "unknown"}`,
    `Tex files: ${manifest.texFileCount}`,
    `Translation units: ${manifest.totalTranslationUnits}`,
    "Files:",
    ...manifest.texFiles.map((file) => `- ${file.path} -> ${file.targetPath}; role=${file.role}; units=${file.unitCount}; deps=${file.dependencies.length}`),
  ];
  if (manifest.warnings.length) lines.push("Warnings:", ...manifest.warnings.map((warning) => `- ${warning}`));
  return lines.join("\n").slice(0, 12000);
}
