import { getPref } from "../utils/prefs";

export type ServiceTaskEvent = {
  jobId?: string;
  taskId?: string;
  status?: string;
  phase?: string;
  progress?: number;
  preview?: string;
  stats?: {
    tokens?: number;
    tps?: number;
    chars?: number;
  };
  activeFile?: string | null;
  result?: {
    error?: string;
    translationUsage?: unknown;
  };
  log?: string[];
};

export type CompileEvent = {
  type?: "start" | "step" | "done" | "error";
  mainTex?: string;
  step?: string;
  exitCode?: number;
  success?: boolean;
  hasLatexErrors?: boolean;
  message?: string;
  log?: string;
};

type FetchArxivResult = {
  jobId: string;
  title?: string;
  existing?: boolean;
  fileCount?: number;
  mainTex?: string | null;
};

type TranslateStartResult = {
  taskId: string;
};

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function getServiceUrl(): string {
  const url = String(getPref("serviceUrl") || "http://localhost:3456").trim();
  return trimTrailingSlash(url || "http://localhost:3456");
}

function getParallelism(): number {
  const value = Number(getPref("parallelism") || 3);
  if (!Number.isFinite(value)) return 3;
  return Math.max(1, Math.min(8, Math.round(value)));
}

async function readJsonError(resp: Response): Promise<string> {
  try {
    const data = (await resp.json()) as any;
    return data?.error || data?.message || `${resp.status} ${resp.statusText}`;
  } catch {
    return `${resp.status} ${resp.statusText}`;
  }
}

async function requestJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const resp = await fetch(`${getServiceUrl()}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  if (!resp.ok) throw new Error(await readJsonError(resp));
  return (await resp.json()) as T;
}

async function readSse<T>(
  resp: Response,
  onEvent?: (event: T) => void,
): Promise<T | null> {
  if (!resp.ok) throw new Error(await readJsonError(resp));
  const reader = resp.body?.getReader() as any;
  if (!reader) return null;

  const decoder = new TextDecoder();
  let buffer = "";
  let lastEvent: T | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    buffer += decoder.decode(value, { stream: true });

    let splitAt = buffer.indexOf("\n\n");
    while (splitAt >= 0) {
      const chunk = buffer.slice(0, splitAt).trim();
      buffer = buffer.slice(splitAt + 2);
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw) continue;
        const event = JSON.parse(raw) as T;
        lastEvent = event;
        onEvent?.(event);
      }
      splitAt = buffer.indexOf("\n\n");
    }
  }

  return lastEvent;
}

export class ArxivServiceClient {
  get baseUrl(): string {
    return getServiceUrl();
  }

  async verifyService(): Promise<void> {
    await requestJson<unknown[]>("/api/jobs");
  }

  async fetchArxiv(arxivId: string): Promise<FetchArxivResult> {
    return requestJson<FetchArxivResult>("/api/fetch-arxiv", {
      method: "POST",
      body: JSON.stringify({ query: arxivId }),
    });
  }

  async startTranslation(jobId: string): Promise<TranslateStartResult> {
    return requestJson<TranslateStartResult>("/api/translate", {
      method: "POST",
      body: JSON.stringify({
        jobId,
        parallelism: getParallelism(),
      }),
    });
  }

  async streamTranslation(
    taskId: string,
    onEvent?: (event: ServiceTaskEvent) => void,
  ): Promise<ServiceTaskEvent | null> {
    const resp = await fetch(`${this.baseUrl}/api/tasks/${taskId}/stream`);
    return readSse<ServiceTaskEvent>(resp, onEvent);
  }

  async compile(
    jobId: string,
    onEvent?: (event: CompileEvent) => void,
  ): Promise<CompileEvent | null> {
    const resp = await fetch(`${this.baseUrl}/api/compile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId }),
    });
    return readSse<CompileEvent>(resp, onEvent);
  }

  async downloadPdf(jobId: string): Promise<Uint8Array> {
    const resp = await fetch(`${this.baseUrl}/api/download-pdf/${encodeURIComponent(jobId)}`);
    if (!resp.ok) throw new Error(await readJsonError(resp));
    return new Uint8Array(await resp.arrayBuffer());
  }

  openJobUrl(jobId: string): string {
    return `${this.baseUrl}/jobs/${encodeURIComponent(jobId)}`;
  }
}
