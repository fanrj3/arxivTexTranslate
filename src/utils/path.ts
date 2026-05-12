/**
 * Path + File I/O utilities using IOUtils (Firefox 115+).
 * Avoids Zotero.File which internally calls nsIFile.exists().
 */

const IO = (globalThis as any).IOUtils;

export function norm(p: string): string {
  if (!p) return p;
  if (/^[A-Za-z]:/.test(p) || p.includes("\\")) return p.replace(/\//g, "\\");
  return p;
}

export const SEP = "\\";

export function pathStr(p: any): string {
  if (!p) return "";
  if (typeof p === "string") return norm(p);
  if (typeof p === "object" && typeof p.path === "string") return norm(p.path);
  if (typeof p === "object" && typeof p.dir === "string") return norm(p.dir);
  return "";
}

/** Read text file. */
export async function readText(path: string): Promise<string> {
  const bytes = await IO.read(path);
  return new TextDecoder().decode(bytes);
}

/** Write text file. */
export async function writeText(path: string, text: string): Promise<void> {
  const bytes = new TextEncoder().encode(text);
  await IO.write(path, bytes);
}

/** Write binary data. */
export async function writeBinary(path: string, data: Uint8Array): Promise<void> {
  await IO.write(path, data);
}

/** Check if file exists. */
export async function fileExists(path: string): Promise<boolean> {
  try { return await IO.exists(path); } catch { return false; }
}

/** List directory entries (names only). */
export async function listDir(path: string): Promise<string[]> {
  try { return await IO.getChildren(path); } catch { return []; }
}

/** Create directory with ancestors. */
export async function mkdir(path: string): Promise<void> {
  await IO.makeDirectory(path, { createAncestors: true });
}
