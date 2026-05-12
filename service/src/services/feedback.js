import { deflateRawSync } from "zlib";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import path from "path";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(date.getFullYear(), 1980);
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function shouldSkipJobFile(relPath) {
  const normalized = relPath.replace(/\\/g, "/");
  return normalized.includes("/.git/") || normalized.includes("__MACOSX/");
}

function collectFiles(rootDir, prefix = "") {
  const files = [];
  if (!existsSync(rootDir)) return files;
  for (const entry of readdirSync(rootDir)) {
    if (entry.startsWith(".DS_Store")) continue;
    const fullPath = path.join(rootDir, entry);
    const relPath = path.posix.join(prefix, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...collectFiles(fullPath, relPath));
      continue;
    }
    if (!shouldSkipJobFile(relPath)) files.push({ fullPath, zipPath: relPath, mtime: stat.mtime });
  }
  return files;
}

function makeZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const input = Buffer.isBuffer(file.data) ? file.data : readFileSync(file.fullPath);
    const compressed = deflateRawSync(input, { level: 6 });
    const name = Buffer.from(file.zipPath.replace(/\\/g, "/"), "utf8");
    const crc = crc32(input);
    const { dosTime, dosDate } = dosDateTime(file.mtime || new Date());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(input.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(input.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralOffset = offset;
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, central, end]);
}

function safeFileName(value) {
  return String(value || "job").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "job";
}

export function createFeedbackPackage({ jobDir, jobId, meta, serviceRoot, outputDir }) {
  mkdirSync(outputDir, { recursive: true });
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const zipName = `${safeFileName(jobId)}-${stamp}-log.zip`;
  const zipPath = path.join(outputDir, zipName);

  const files = collectFiles(jobDir, `job-${safeFileName(jobId)}`);
  const serverLogs = ["server.log", "server-out.log", "server-err.log"]
    .map((name) => path.join(serviceRoot, name))
    .filter((filePath) => existsSync(filePath))
    .map((filePath) => ({
      fullPath: filePath,
      zipPath: `service-logs/${path.basename(filePath)}`,
      mtime: statSync(filePath).mtime,
    }));

  const report = {
    jobId,
    title: meta?.title || jobId,
    arxivId: meta?.arxivId || "",
    status: meta?.status || "",
    generatedAt: now.toISOString(),
    app: "arxiv-service",
    translationPipelineVersion: meta?.translationPipelineVersion || "",
    translationUsage: meta?.translationUsage || null,
    compileAnalysis: meta?.compileAnalysis || null,
    note: "Attach this log.zip to the GitHub issue. It contains the paper source snapshot, translated LaTeX, build logs, PDFs, and service logs.",
  };

  const virtualFiles = [
    {
      data: Buffer.from(JSON.stringify(report, null, 2), "utf8"),
      zipPath: "feedback-report.json",
      mtime: now,
    },
  ];

  writeFileSync(zipPath, makeZip([...virtualFiles, ...files, ...serverLogs]));
  return {
    zipName,
    zipPath,
    title: `[Feedback] ${meta?.title || jobId} (${jobId})`,
    issueUrl: "https://github.com/fanrj3/arxivTexTranslate/issues/new",
  };
}

