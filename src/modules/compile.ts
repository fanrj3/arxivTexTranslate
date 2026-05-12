/**
 * Compile LaTeX to PDF using xelatex + bibtex.
 * Falls back to generating compile.bat when subprocess not available.
 */

import { getPref } from "../utils/prefs";
import { SEP, fileExists, listDir, pathStr, writeText } from "../utils/path";

export async function detectXelatex(): Promise<string | null> {
  const configPath = getPref("xelatexPath");
  if (configPath && await fileExists(configPath)) return configPath;

  const candidates = [
    "C:\\texlive\\2024\\bin\\windows\\xelatex.exe",
    "C:\\texlive\\2023\\bin\\windows\\xelatex.exe",
    "C:\\Program Files\\MiKTeX\\miktex\\bin\\x64\\xelatex.exe",
  ];
  for (const c of candidates) { if (await fileExists(c)) return c; }

  const pathDirs = ((globalThis as any).Services?.env?.get("PATH") || "").split(";");
  for (const dir of pathDirs) {
    const c = pathStr(dir) + "\\xelatex.exe";
    if (await fileExists(c)) return c;
  }
  return null;
}

async function tryExec(cmd: string, args: string[], cwd: string): Promise<{ ok: boolean; stderr: string }> {
  // 1. Try Subprocess.sys.mjs
  try {
    const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
    const proc = await Subprocess.call({ command: cmd, arguments: args, workdir: cwd, environment: {}, stderr: "pipe" });
    const stdout = await proc.stdout.readString();
    const stderr = await proc.stderr.readString();
    await proc.stdin.close();
    const { exitCode } = await proc.wait();
    return { ok: exitCode === 0, stderr: stderr || stdout || "" };
  } catch {}
  // 2. Try Zotero.Internal.exec
  try {
    const r = await (Zotero as any).Utilities.Internal.exec(cmd, args, { cwd, timeout: 120_000 });
    return { ok: r.exitCode === 0, stderr: r.stderr || "" };
  } catch (e: any) {
    return { ok: false, stderr: e?.message || String(e) };
  }
}

export async function compilePaper(
  texFile: string, xelatexPath: string,
  onProgress?: (msg: string) => void,
): Promise<{ success: boolean; pdfPath: string | null }> {
  const paperDir = texFile.substring(0, texFile.lastIndexOf(SEP));
  const stem = texFile.split(SEP).pop()!.replace(".tex", "");
  const texName = texFile.split(SEP).pop()!;

  onProgress?.("xelatex (1/3)...");
  let r = await tryExec(xelatexPath, ["-interaction=nonstopmode", texName], paperDir);
  if (!r.ok) throw new Error("xelatex failed: " + (r.stderr?.slice(0, 400) || "unknown error"));

  const auxPath = `${paperDir}${SEP}${stem}.aux`;
  if (await fileExists(auxPath)) {
    onProgress?.("bibtex...");
    await tryExec(xelatexPath.replace(/xelatex(?=\.exe)?$/i, "bibtex$1"), [stem], paperDir);
  }

  onProgress?.("xelatex (2/3)...");
  r = await tryExec(xelatexPath, ["-interaction=nonstopmode", texName], paperDir);
  if (!r.ok) throw new Error("xelatex (2/3) failed: " + (r.stderr?.slice(0, 200) || ""));

  onProgress?.("xelatex (3/3)...");
  r = await tryExec(xelatexPath, ["-interaction=nonstopmode", texName], paperDir);
  if (!r.ok) throw new Error("xelatex (3/3) failed: " + (r.stderr?.slice(0, 200) || ""));

  const pdfPath = `${paperDir}${SEP}${stem}.pdf`;
  if (await fileExists(pdfPath)) return { success: true, pdfPath };
  return { success: false, pdfPath: null };
}

export async function findCompiledPdf(paperDir: string): Promise<string | null> {
  const entries = await listDir(paperDir);
  for (const entry of entries) {
    if (entry.endsWith("_cn.pdf")) return `${paperDir}${SEP}${entry}`;
  }
  return null;
}
