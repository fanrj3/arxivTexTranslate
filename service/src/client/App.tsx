import {
  ArrowLeft,
  ArrowRight,
  Bug,
  CheckCircle2,
  Columns2,
  ExternalLink,
  FileArchive,
  FileText,
  FolderOpen,
  Languages,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Trash2,
  Wand2,
} from "lucide-react";
import { type ChangeEvent, type DragEvent, type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge as UiBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Toaster } from "@/components/ui/sonner";
import { I18nProvider, type Locale, useI18n } from "./i18n";
import { cn } from "./lib/utils";

type JobStatus = "compiled" | "translated" | "extracted" | "empty" | string;

type TranslationUsage = {
  model?: string;
  modelName?: string;
  modelTier?: string;
  apiFormat?: string;
  durationSeconds?: number;
  updatedAt?: string;
  tokens?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    uncachedInputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    estimated?: boolean;
  };
  cost?: {
    currency?: string;
    totalCost?: number;
    cachedInputCost?: number;
    uncachedInputCost?: number;
    outputCost?: number;
  };
};

type Job = {
  id: string;
  title: string;
  status: JobStatus;
  fileCount: number;
  createdAt?: string;
  relativeTime?: string;
  hasPdf?: boolean;
  hasCnTex?: boolean;
  translationUsage?: TranslationUsage | null;
};

type JobMeta = {
  title?: string;
  createdAt?: string;
  fileCount?: number;
  status?: string;
  translationUsage?: TranslationUsage | null;
  fileTranslations?: FileTranslationStatus[];
  structureManifest?: StructureManifest;
  parallelism?: number;
};

type StructureManifest = {
  mainTex?: string;
  texFileCount?: number;
  totalTranslationUnits?: number;
  warnings?: string[];
  texFiles?: Array<{
    path: string;
    targetPath: string;
    role?: string;
    unitCount?: number;
    dependencies?: Array<{ type: string; target: string }>;
  }>;
};

type RunningTask = {
  taskId: string;
  jobId: string;
  status: string;
  phase: string;
  progress?: number;
  startTime?: number;
};

type ArxivSearchResult = {
  id: string;
  title: string;
  summary?: string;
  published?: string;
  updated?: string;
  authors?: string[];
  categories?: string[];
  absUrl?: string;
  pdfUrl?: string;
};

type PdfCompareInfo = {
  originalUrl: string;
  translatedUrl: string;
  originalPages: number;
  translatedPages: number;
  pageCount: number;
  renderer: boolean;
};

type PdfTextLine = {
  id: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cy: number;
};

type PdfTextBlock = PdfTextLine & {
  index: number;
  column?: string;
};

type PdfTextPage = {
  width: number;
  height: number;
  lines: PdfTextLine[];
  blocks?: PdfTextBlock[];
};

type PdfBlockMap = {
  page: number;
  originalToTranslated: Record<string, number[]>;
  translatedToOriginal: Record<string, number[]>;
};

type PdfSyncRect = {
  id: string;
  unitId: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

type PdfSyncMap = {
  page: number;
  source: "synctex";
  originalRects: PdfSyncRect[];
  translatedRects: PdfSyncRect[];
  originalToTranslated: Record<string, string[]>;
  translatedToOriginal: Record<string, string[]>;
};

type HoverTarget = {
  page: number;
  side: "original" | "translated";
  source: "synctex" | "block";
  id?: string;
  blockIndex?: number;
} | null;

type FileTranslationStatus = {
  path: string;
  targetPath: string;
  status: "pending" | "running" | "done" | "error" | string;
  role?: string;
  unitCount?: number;
  batchIndex?: number;
  batchCount?: number;
  progress?: number;
  chars?: number;
  tokens?: number;
  tps?: number;
  thread?: number | null;
  preview?: string;
  error?: string | null;
  durationSeconds?: number;
  validation?: {
    ok?: boolean;
    issues?: string[];
    warnings?: string[];
  };
};

type ThreadStatus = {
  id: number;
  status: string;
  activeFile?: string | null;
  chars?: number;
  tokens?: number;
  tps?: number;
  completed?: number;
};

type ConfirmState = {
  message: string;
  onConfirm: () => void | Promise<void>;
} | null;

const statusLabels: Record<string, string> = {
  compiled: "\u5df2\u7f16\u8bd1",
  translated: "\u5df2\u7ffb\u8bd1",
  extracted: "\u5df2\u89e3\u5305",
  empty: "\u7a7a\u4efb\u52a1",
  running: "\u8fd0\u884c\u4e2d",
};
function formatTokens(value?: number) {
  const n = Number(value || 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCny(value?: number) {
  return `\u00a5${Number(value || 0).toFixed(4)}`;
}
async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || (data && typeof data === "object" && "error" in data)) {
    throw new Error((data && typeof data === "object" && "error" in data ? String(data.error) : "") || `HTTP ${response.status}`);
  }
  return data as T;
}

function usePath() {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((next: string) => {
    window.history.pushState({}, "", next);
    setPath(next);
  }, []);

  return { path, navigate };
}

function StatusBadge({ status, children }: { status?: string; children: React.ReactNode }) {
  return (
    <UiBadge
      variant="secondary"
      className={cn(
        "min-h-6 gap-1.5 px-2.5 py-1 font-bold",
        status === "id" && "bg-info/10 font-mono text-info",
        status === "compiled" && "bg-ok/10 text-ok",
        status === "translated" && "bg-warn/10 text-warn",
        status === "extracted" && "bg-info/10 text-info",
        status === "empty" && "bg-destructive/10 text-destructive",
        status === "running" && "bg-primary/10 text-primary",
      )}
    >
      {status === "running" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {children}
    </UiBadge>
  );
}

export default function App() {
  return (
    <I18nProvider>
      <AppShell />
    </I18nProvider>
  );
}

function LanguageToggle() {
  const { locale, setLocale, t } = useI18n();
  const next: Locale = locale === "zh-CN" ? "en-US" : "zh-CN";

  return (
    <Button variant="secondary" size="sm" title={t("app.language")} onClick={() => setLocale(next)}>
      <Languages className="h-4 w-4" />
      {locale === "zh-CN" ? "EN" : "\u4e2d"}
    </Button>
  );
}

function AppShell() {
  const { path, navigate } = usePath();
  const compareJobId = path.startsWith("/compare/") ? decodeURIComponent(path.slice("/compare/".length)) : "";
  const [jobs, setJobs] = useState<Job[]>([]);
  const [runningTasks, setRunningTasks] = useState<Record<string, RunningTask>>({});
  const [filter, setFilter] = useState("");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState>(null);

  const notify = useCallback((message: string) => toast(message), []);

  const refreshRunningTasks = useCallback(async () => {
    try {
      const tasks = await fetchJson<RunningTask[]>("/api/tasks");
      const next: Record<string, RunningTask> = {};
      for (const task of tasks) {
        if (task.status !== "done" && task.status !== "error") next[task.jobId] = task;
      }
      setRunningTasks(next);
    } catch {
      setRunningTasks({});
    }
  }, []);

  const refreshJobs = useCallback(async () => {
    await refreshRunningTasks();
    setJobs(await fetchJson<Job[]>("/api/jobs"));
  }, [refreshRunningTasks]);

  useEffect(() => {
    refreshJobs().catch((error) => notify(error.message));
    const interval = window.setInterval(() => {
      if (!selectedJobId) refreshJobs().catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(interval);
  }, [notify, refreshJobs, selectedJobId]);

  const openDetail = useCallback(
    (id: string) => {
      setSelectedJobId(id);
      navigate("/");
    },
    [navigate],
  );

  const backToList = useCallback(() => {
    setSelectedJobId(null);
    refreshJobs().catch(() => undefined);
  }, [refreshJobs]);

  const deleteJob = useCallback(
    (job: Pick<Job, "id" | "title">, afterDelete?: () => void) => {
      setConfirm({
        message: `确定删除“${job.title}”？这会移除本地源码、翻译文件和编译输出。`,
        onConfirm: async () => {
          await fetch(`/api/jobs/${job.id}`, { method: "DELETE" });
          afterDelete?.();
          await refreshJobs();
          notify("任务已删除");
        },
      });
    },
    [notify, refreshJobs],
  );

  return (
    <div className="min-h-screen text-foreground">
      <div key={`${path}:${selectedJobId || ""}`} className="animate-in">
        {path === "/settings" || path === "/settings.html" ? (
          <SettingsPage navigate={navigate} notify={notify} />
        ) : compareJobId ? (
          <PdfComparePage jobId={compareJobId} navigate={navigate} notify={notify} />
        ) : (
          <HomePage
            jobs={jobs}
            runningTasks={runningTasks}
            filter={filter}
            setFilter={setFilter}
            selectedJobId={selectedJobId}
            refreshJobs={refreshJobs}
            openDetail={openDetail}
            backToList={backToList}
            deleteJob={deleteJob}
            navigate={navigate}
            notify={notify}
          />
        )}
      </div>

      {confirm && <ConfirmDialog state={confirm} close={() => setConfirm(null)} notify={notify} />}
      <Toaster position="bottom-right" richColors closeButton />
    </div>
  );
}

function HomePage({
  jobs,
  runningTasks,
  filter,
  setFilter,
  selectedJobId,
  refreshJobs,
  openDetail,
  backToList,
  deleteJob,
  navigate,
  notify,
}: {
  jobs: Job[];
  runningTasks: Record<string, RunningTask>;
  filter: string;
  setFilter: (value: string) => void;
  selectedJobId: string | null;
  refreshJobs: () => Promise<void>;
  openDetail: (id: string) => void;
  backToList: () => void;
  deleteJob: (job: Pick<Job, "id" | "title">, afterDelete?: () => void) => void;
  navigate: (path: string) => void;
  notify: (message: string) => void;
}) {
  const { t } = useI18n();
  const [arxivInput, setArxivInput] = useState("");
  const [isFetching, setIsFetching] = useState(false);
  const [isSearchingArxiv, setIsSearchingArxiv] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [arxivResults, setArxivResults] = useState<ArxivSearchResult[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const filteredJobs = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return jobs;
    return jobs.filter((job) => `${job.id} ${job.title}`.toLowerCase().includes(query));
  }, [filter, jobs]);

  const compiledCount = jobs.filter((job) => job.status === "compiled").length;
  const translatedCount = jobs.filter((job) => job.status === "translated" || job.status === "compiled").length;
  const runningCount = Object.keys(runningTasks).length;
  const usageSummary = useMemo(() => jobs.reduce(
    (acc, job) => {
      const usage = job.translationUsage;
      const tokens = usage?.tokens;
      const cost = usage?.cost;
      if (!usage || !tokens) return acc;
      acc.totalTokens += tokens.totalTokens || 0;
      acc.totalCost += cost?.totalCost || 0;
      const model = usage.model || "unknown";
      acc.byModel[model] = (acc.byModel[model] || 0) + (tokens.totalTokens || 0);
      return acc;
    },
    { totalTokens: 0, totalCost: 0, byModel: {} as Record<string, number> },
  ), [jobs]);

  const looksLikeArxivId = (value: string) => /(\d{4}\.\d{4,5})(?:v\d+)?/.test(value);

  const fetchArxiv = async (value = arxivInput) => {
    const query = value.trim();
    if (!query) return;
    setIsFetching(true);
    const toastId = toast.loading(`正在拉取 ${query} 的 arXiv 源码...`);
    try {
      const data = await fetchJson<{ jobId: string }>("/api/fetch-arxiv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, proxy: localStorage.getItem("arxivProxy") || "" }),
      });
      setArxivInput("");
      setArxivResults([]);
      toast.success("源码已拉取，正在打开任务", { id: toastId });
      await refreshJobs();
      openDetail(data.jobId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "拉取失败", { id: toastId });
    } finally {
      setIsFetching(false);
    }
  };

  const searchArxiv = async () => {
    const query = arxivInput.trim();
    if (!query) return;
    if (looksLikeArxivId(query)) {
      await fetchArxiv(query);
      return;
    }
    setIsSearchingArxiv(true);
    const toastId = toast.loading("正在搜索 arXiv...");
    try {
      const params = new URLSearchParams({
        q: query,
        maxResults: "8",
        proxy: localStorage.getItem("arxivProxy") || "",
      });
      const data = await fetchJson<{ results: ArxivSearchResult[] }>(`/api/search-arxiv?${params.toString()}`);
      setArxivResults(data.results || []);
      if (data.results?.length) {
        toast.success(`找到 ${data.results.length} 篇候选论文`, { id: toastId });
      } else {
        toast.info("没有找到匹配的 arXiv 论文", { id: toastId });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "arXiv 搜索失败", { id: toastId });
    } finally {
      setIsSearchingArxiv(false);
    }
  };

  const uploadFile = async (file?: File) => {
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    setIsUploading(true);
    const toastId = toast.loading(`正在导入 ${file.name}...`);
    try {
      const response = await fetch("/api/upload", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || "上传失败");
      toast.success("源码包已导入，正在打开任务", { id: toastId });
      await refreshJobs();
      openDetail(data.jobId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "上传失败", { id: toastId });
    } finally {
      setIsUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="min-h-screen animate-in">
      <header className="sticky top-0 z-30 border-b border-border/80 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-[68px] max-w-7xl items-center justify-between gap-4 px-6 max-sm:px-4">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-lg bg-brand font-black text-primary-foreground shadow-primary">A</div>
            <div>
              <h1 className="text-lg font-black leading-none tracking-normal">arXiv Translate</h1>
              <p className="mt-1 text-xs text-muted-foreground">{t("app.subtitle")}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <LanguageToggle />
            <Button variant="outline" onClick={() => refreshJobs().catch((error) => notify(error.message))}>
              <RefreshCw className="h-4 w-4" />
              {t("app.refresh")}
            </Button>
            <Button variant="secondary" size="icon" title={t("app.settings")} onClick={() => navigate("/settings")}>
              <Settings className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-6 max-sm:px-4">
        {selectedJobId ? (
          <JobDetail jobId={selectedJobId} backToList={backToList} deleteJob={deleteJob} refreshJobs={refreshJobs} navigate={navigate} notify={notify} />
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-6 max-lg:grid-cols-1">
            <section className="min-w-0">
              <Card className="mb-5 overflow-hidden bg-card/85 shadow-soft backdrop-blur-xl">
                <CardContent className="grid gap-5 p-5">
                  <div className="flex items-end justify-between gap-5 max-md:flex-col max-md:items-stretch">
                    <div>
                      <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-border bg-background/80 px-3 py-1 text-xs font-bold text-muted-foreground shadow-sm backdrop-blur">
                        <Sparkles className="h-3.5 w-3.5 text-primary" />
                        React + Tailwind + shadcn/ui
                      </div>
                      <h2 className="text-3xl font-black tracking-normal max-sm:text-2xl">{t("home.title")}</h2>
                      <p className="mt-2 text-sm text-muted-foreground">{t("home.description")}</p>
                    </div>
                    <div className="relative w-80 max-md:w-full">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input className="bg-background/80 pl-9 shadow-sm" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={t("home.searchPlaceholder")} />
                    </div>
                  </div>

                  <div className="grid grid-cols-5 gap-3 max-lg:grid-cols-3 max-sm:grid-cols-1">
                    <MetricCard label={t("home.totalPapers")} value={jobs.length} />
                    <MetricCard label={t("home.translated")} value={translatedCount} />
                    <MetricCard label={t("home.compiled")} value={compiledCount} />
                    <MetricCard label="Tokens" value={formatTokens(usageSummary.totalTokens)} />
                    <MetricCard label={t("home.estimatedCost")} value={formatCny(usageSummary.totalCost)} />
                  </div>
                </CardContent>
              </Card>

              <div className="grid gap-3">
                {filteredJobs.length ? (
                  filteredJobs.map((job, index) => (
                    <JobCard key={job.id} job={job} runningTask={runningTasks[job.id]} openDetail={openDetail} comparePdf={(id) => navigate(`/compare/${encodeURIComponent(id)}`)} deleteJob={deleteJob} index={index} />
                  ))
                ) : (
                  <Card className="grid min-h-72 place-items-center border-dashed bg-card/70 text-center animate-in">
                    <CardContent>
                      <FileText className="mx-auto mb-3 h-8 w-8 text-primary" />
                      <b className="block">{t("home.emptyTitle")}</b>
                      <span className="mt-2 block max-w-sm text-sm leading-6 text-muted-foreground">{t("home.emptyDescription")}</span>
                    </CardContent>
                  </Card>
                )}
              </div>
            </section>

            <aside className="grid h-fit gap-4 lg:sticky lg:top-24">
              <Card className="overflow-hidden bg-card/85 backdrop-blur-xl">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Wand2 className="h-4 w-4 text-primary" />
                    {t("home.quickStart")}
                  </CardTitle>
                  <CardDescription>{t("home.quickStartDescription")}</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="arxiv-input">{t("home.arxivInput")}</Label>
                    <div className="flex gap-2">
                      <Input
                        id="arxiv-input"
                        value={arxivInput}
                        onChange={(event) => setArxivInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") searchArxiv();
                        }}
                        placeholder={t("home.arxivPlaceholder")}
                        spellCheck={false}
                      />
                      <Button size="icon" disabled={isFetching || isSearchingArxiv || isUploading} onClick={searchArxiv} aria-label={t("home.searchOrFetch")}>
                        {isFetching || isSearchingArxiv ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                      </Button>
                    </div>
                  </div>

                  {arxivResults.length > 0 && (
                    <div className="grid gap-2">
                      {arxivResults.map((paper) => (
                        <button
                          key={paper.id}
                          type="button"
                          className="group rounded-lg border bg-card/70 p-3 text-left transition hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-soft"
                          onClick={() => fetchArxiv(paper.id)}
                          disabled={isFetching}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="line-clamp-2 text-sm font-bold leading-5">{paper.title}</div>
                              <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                                <span className="font-mono text-info">{paper.id}</span>
                                {paper.authors?.slice(0, 2).join(", ")}
                                {paper.published && <span>{new Date(paper.published).getFullYear()}</span>}
                              </div>
                            </div>
                            <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition group-hover:text-primary" />
                          </div>
                        </button>
                      ))}
                    </div>
                  )}

                  <Separator />

                  <button
                    className={cn(
                      "scan-line relative grid min-h-36 gap-2 overflow-hidden rounded-lg border border-dashed border-border bg-gradient-to-br from-white/95 to-teal-50/75 p-4 text-left transition-all duration-200",
                      "hover:-translate-y-0.5 hover:border-primary/45 hover:shadow-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      dragging && "-translate-y-0.5 border-primary/50 shadow-primary",
                    )}
                    onClick={() => fileRef.current?.click()}
                    onDragOver={(event: DragEvent<HTMLButtonElement>) => {
                      event.preventDefault();
                      setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(event: DragEvent<HTMLButtonElement>) => {
                      event.preventDefault();
                      setDragging(false);
                      uploadFile(event.dataTransfer.files[0]);
                    }}
                  >
                    {isUploading ? <Loader2 className="h-5 w-5 animate-spin text-primary" /> : <FileArchive className="h-5 w-5 text-primary" />}
                    <strong className="text-sm">{isUploading ? t("home.uploading") : t("home.uploadTar")}</strong>
                    <span className="max-w-64 text-xs leading-6 text-muted-foreground">{isUploading ? t("home.uploadingHint") : t("home.uploadHint")}</span>
                    <input ref={fileRef} type="file" accept=".tar.gz,.gz" hidden onChange={(event: ChangeEvent<HTMLInputElement>) => uploadFile(event.target.files?.[0])} />
                  </button>
                </CardContent>
              </Card>

              <Card className="bg-card/80 shadow-soft">
                <CardHeader>
                  <CardTitle>{t("home.runtime")}</CardTitle>
                  <CardDescription>{t("home.runtimeDescription")}</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t("home.backgroundTasks")}</span>
                    <StatusBadge status={runningCount ? "running" : "compiled"}>{runningCount ? `${runningCount} ${t("status.running")}` : t("status.idle")}</StatusBadge>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t("home.pdfOutput")}</span>
                    <span className="font-bold">{compiledCount}/{jobs.length}</span>
                  </div>
                  <Separator />
                  <div className="grid gap-2 text-sm">
                    <span className="text-muted-foreground">{t("home.tokenTotal")}</span>
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-bold">{formatTokens(usageSummary.totalTokens)}</span>
                      <span className="font-bold">{formatCny(usageSummary.totalCost)}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </aside>
          </div>
        )}
      </main>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: number | string }) {
  return (
    <Card className="border-border/70 bg-background/75 transition hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-soft">
      <CardContent className="p-4">
        <b className="block text-2xl leading-none">{value}</b>
        <span className="mt-1 block text-xs text-muted-foreground">{label}</span>
      </CardContent>
    </Card>
  );
}

function JobCard({
  job,
  runningTask,
  openDetail,
  comparePdf,
  deleteJob,
  index,
}: {
  job: Job;
  runningTask?: RunningTask;
  openDetail: (id: string) => void;
  comparePdf: (id: string) => void;
  deleteJob: (job: Pick<Job, "id" | "title">) => void;
  index: number;
}) {
  const { t } = useI18n();
  const status = runningTask ? "running" : job.status;

  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={() => openDetail(job.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter") openDetail(job.id);
      }}
      className="grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] gap-4 bg-card/80 p-4 transition-all duration-200 hover:-translate-y-1 hover:border-primary/30 hover:bg-white/95 hover:shadow-lift max-xl:grid-cols-1 animate-in"
      style={{ animationDelay: `${Math.min(index * 35, 240)}ms` }}
    >
      <div className="min-w-0">
        <h3 className="truncate text-[15px] font-black leading-6">{job.title}</h3>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <StatusBadge status="id">{job.id}</StatusBadge>
          <StatusBadge status={status}>{t(`status.${status}`, statusLabels[status] || status)}</StatusBadge>
          <span>{job.fileCount || 0} {t("job.files")}</span>
          {job.relativeTime && <span>{job.relativeTime}</span>}
          {job.translationUsage && (
            <>
              <StatusBadge status="translated">{job.translationUsage.model || job.translationUsage.modelName}</StatusBadge>
              <span>{formatTokens(job.translationUsage.tokens?.totalTokens)} tokens</span>
              <span>{formatCny(job.translationUsage.cost?.totalCost)}</span>
            </>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 max-sm:flex-wrap" onClick={(event) => event.stopPropagation()}>
        {job.hasPdf ? (
          <>
            <Button variant="secondary" onClick={() => window.open(`/api/download-pdf/${job.id}`, "_blank")}>
              <FileText className="h-4 w-4" />
              {t("job.openPdf")}
            </Button>
            <Button variant="secondary" onClick={() => comparePdf(job.id)}>
              <Columns2 className="h-4 w-4" />
              {t("job.compare")}
            </Button>
          </>
        ) : job.hasCnTex ? (
          <Button onClick={() => openDetail(job.id)}>
            <Play className="h-4 w-4" />
            {t("job.compile")}
          </Button>
        ) : (
          <Button onClick={() => openDetail(job.id)}>
            <Wand2 className="h-4 w-4" />
            {t("job.translate")}
          </Button>
        )}
        <Button variant="secondary" onClick={() => fetch(`/api/open/${job.id}`)}>
          <FolderOpen className="h-4 w-4" />
          {t("job.folder")}
        </Button>
        <Button variant="destructive" size="icon" aria-label={t("job.delete")} onClick={() => deleteJob(job)}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </Card>
  );
}

function JobDetail({
  jobId,
  backToList,
  deleteJob,
  refreshJobs,
  navigate,
  notify,
}: {
  jobId: string;
  backToList: () => void;
  deleteJob: (job: Pick<Job, "id" | "title">, afterDelete?: () => void) => void;
  refreshJobs: () => Promise<void>;
  navigate: (path: string) => void;
  notify: (message: string) => void;
}) {
  const { t } = useI18n();
  const [meta, setMeta] = useState<JobMeta | null>(null);
  const [title, setTitle] = useState("");
  const [logs, setLogs] = useState<{ text: string; tone?: "phase" | "error" }[]>([]);
  const [taskStatus, setTaskStatus] = useState<{ text: string; status: string } | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [streamPreview, setStreamPreview] = useState("");
  const [streamStats, setStreamStats] = useState<{ chars?: number; tokens?: number; cps?: number; tps?: number } | null>(null);
  const [fileProgress, setFileProgress] = useState<FileTranslationStatus[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [threadProgress, setThreadProgress] = useState<ThreadStatus[]>([]);
  const [selectedFile, setSelectedFile] = useState<FileTranslationStatus | null>(null);
  const [isStartingTranslate, setIsStartingTranslate] = useState(false);
  const [isCompiling, setIsCompiling] = useState(false);
  const [isPackagingFeedback, setIsPackagingFeedback] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  const loadMeta = useCallback(async () => {
    const next = await fetchJson<JobMeta>(`/api/jobs/${jobId}/metadata`);
    setMeta(next);
    setTitle(next.title || jobId);
    setResult(next.status === "compiled" ? "pdf" : null);
    if (Array.isArray(next.fileTranslations)) setFileProgress(next.fileTranslations);
  }, [jobId]);

  useEffect(() => {
    loadMeta().catch((error) => notify(error.message));
  }, [loadMeta, notify]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [logs]);

  useEffect(() => () => eventSourceRef.current?.close(), []);

  const appendLog = (text: string, tone?: "phase" | "error") => {
    setLogs((current) => [...current, { text, tone }]);
  };

  const connectTask = useCallback(
    (taskId: string) => {
      setTaskStatus({ text: "翻译运行中", status: "running" });
      eventSourceRef.current?.close();
      const source = new EventSource(`/api/tasks/${taskId}/stream`);
      eventSourceRef.current = source;
      source.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (typeof data.preview === "string") setStreamPreview(data.preview);
        if (data.stats) setStreamStats(data.stats);
        if (Array.isArray(data.files)) setFileProgress(data.files);
        if (Array.isArray(data.threads)) setThreadProgress(data.threads);
        if (data.structureManifest) setMeta((current) => ({ ...(current || {}), structureManifest: data.structureManifest }));
        if ("activeFile" in data) setActiveFile(data.activeFile || null);
        for (const line of data.log || []) appendLog(line);
        if (data.status === "done") {
          if (data.result?.translationUsage) setMeta((current) => ({ ...(current || {}), translationUsage: data.result.translationUsage }));
          appendLog("翻译完成，可以继续编译 PDF。", "phase");
          setTaskStatus({ text: "翻译完成", status: "translated" });
          toast.success("翻译完成，可以继续编译 PDF");
          source.close();
          eventSourceRef.current = null;
          refreshJobs();
        } else if (data.status === "partial_error") {
          if (data.result?.translationUsage) setMeta((current) => ({ ...(current || {}), translationUsage: data.result.translationUsage }));
          appendLog("Translation partially completed. Check failed files below.", "error");
          setTaskStatus({ text: "部分文件翻译失败", status: "empty" });
          toast.error("部分文件翻译失败，请展开 Tex 状态查看详情");
          source.close();
          eventSourceRef.current = null;
          refreshJobs();
        } else if (data.status === "error") {
          appendLog(data.result?.error || "翻译失败", "error");
          setTaskStatus({ text: "翻译失败", status: "empty" });
          toast.error(data.result?.error || "翻译失败");
          source.close();
          eventSourceRef.current = null;
          refreshJobs();
        }
      };
      source.onerror = () => {
        setTaskStatus({ text: "正在等待任务状态", status: "running" });
        source.close();
        eventSourceRef.current = null;
      };
    },
    [refreshJobs],
  );

  useEffect(() => {
    fetchJson<{ taskId?: string } | null>(`/api/jobs/${jobId}/running-task`)
      .then((data) => {
        if (data?.taskId) connectTask(data.taskId);
      })
      .catch(() => undefined);
  }, [connectTask, jobId]);

  const saveTitle = async () => {
    const nextTitle = title.trim();
    if (!nextTitle || nextTitle === (meta?.title || jobId)) return;
    await fetch(`/api/jobs/${jobId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: nextTitle }),
    });
    await refreshJobs();
    notify("标题已更新");
  };

  const runTranslate = async () => {
    setIsStartingTranslate(true);
    const toastId = toast.loading("正在启动翻译任务...");
    try {
      const existing = await fetchJson<{ taskId?: string } | null>(`/api/jobs/${jobId}/running-task`);
      if (existing?.taskId) {
        connectTask(existing.taskId);
        toast.info("已有翻译任务正在运行，已连接进度", { id: toastId });
        return;
      }

      setLogs([]);
      setStreamPreview("");
      setStreamStats(null);
      setFileProgress([]);
      setActiveFile(null);
      setThreadProgress([]);
      setSelectedFile(null);
      appendLog("开始翻译源文件...", "phase");
      const data = await fetchJson<{ taskId: string }>("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId,
        }),
      });
      connectTask(data.taskId);
      toast.success("翻译任务已启动", { id: toastId });
    } catch (error) {
      appendLog(error instanceof Error ? error.message : "翻译失败", "error");
      toast.error(error instanceof Error ? error.message : "翻译失败", { id: toastId });
    } finally {
      setIsStartingTranslate(false);
    }
  };

  const runCompile = async () => {
    setIsCompiling(true);
    const toastId = toast.loading("正在编译 PDF...");
    setLogs([]);
    setResult(null);
    appendLog("开始编译 PDF...", "phase");

    try {
      const response = await fetch("/api/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId,
          xelatexPath: localStorage.getItem("xelatexPath") || "",
        }),
      });

      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const data = await response.json();
        appendLog(data.error || "编译失败", "error");
        toast.error(data.error || "编译失败", { id: toastId });
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        toast.error("编译失败：没有收到服务端输出", { id: toastId });
        return;
      }
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() || "";
        for (const chunk of chunks) {
          const line = chunk.split("\n").find((item) => item.startsWith("data: "));
          if (!line) continue;
          const data = JSON.parse(line.slice(6));
          if (data.type === "start") {
            appendLog(`使用 xelatex: ${data.xelatexPath || "xelatex"}`, "phase");
            if (data.mainTex) appendLog(`主文件: ${data.mainTex}`, "phase");
          } else if (data.type === "step") {
            if (data.step === "bibliography from source .bbl") {
              appendLog("参考文献: 使用 arXiv 原始 .bbl 文件。", "phase");
            } else if (data.step === "bibliography fallback") {
              appendLog("参考文献: BibTeX 失败，已回退到原始 .bbl 文件。", "phase");
            } else if (data.step === "bibtex" && data.exitCode !== 0) {
              appendLog("继续: BibTeX 未完成，后续会尝试参考文献回退。", "phase");
            } else if (typeof data.step === "string" && data.step.startsWith("xelatex") && data.exitCode !== 0) {
              appendLog(`继续: ${data.step} 返回非零，正在检查 PDF 输出。`, "phase");
            } else {
              appendLog(`${data.exitCode === 0 ? "成功" : "失败"}: ${data.step}`, data.exitCode === 0 ? undefined : "error");
            }
          } else if (data.type === "done") {
            if (data.success) {
              appendLog(data.hasLatexErrors ? "PDF 已生成，但日志中仍有 LaTeX 可恢复错误/警告。" : "编译完成。", "phase");
              setResult("pdf");
              toast.success(data.hasLatexErrors ? "PDF 已生成（有警告）" : "PDF 编译完成", { id: toastId });
            } else {
              appendLog("编译失败，下面是日志末尾。", "error");
              setResult(data.log || "");
              toast.error("编译失败，请查看原始日志", { id: toastId });
            }
          } else if (data.type === "error") {
            appendLog(data.message, "error");
            toast.error(data.message || "编译失败", { id: toastId });
          }
        }
      }
      await refreshJobs();
    } catch (error) {
      appendLog(error instanceof Error ? error.message : "编译失败", "error");
      toast.error(error instanceof Error ? error.message : "编译失败", { id: toastId });
    } finally {
      setIsCompiling(false);
    }
  };

  const runFeedback = async () => {
    setIsPackagingFeedback(true);
    const toastId = toast.loading("正在打包反馈文件...");
    try {
      const data = await fetchJson<{ title: string; issueUrl: string; floatingUrl: string; zipName: string }>(`/api/jobs/${jobId}/feedback`, {
        method: "POST",
      });
      await navigator.clipboard?.writeText(data.title).catch(() => undefined);
      window.open(data.floatingUrl, "_blank", "width=420,height=330");
      window.open(data.issueUrl, "_blank", "noopener,noreferrer");
      toast.success(`已生成 ${data.zipName || "log.zip"}，Issue 标题已复制`, { id: toastId });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "生成反馈包失败", { id: toastId });
    } finally {
      setIsPackagingFeedback(false);
    }
  };

  const selectedFileLive = selectedFile
    ? fileProgress.find((file) => file.path === selectedFile.path) || selectedFile
    : null;

  return (
    <Card className="mx-auto max-w-6xl bg-card/85 shadow-soft backdrop-blur-xl animate-in">
      <CardHeader>
        <Button variant="ghost" className="mb-2 w-fit px-0 text-primary hover:bg-transparent" onClick={backToList}>
          <ArrowLeft className="h-4 w-4" />
          {t("app.backList")}
        </Button>
        <Input
          className="h-auto border-x-0 border-t-0 bg-transparent px-0 pb-3 text-2xl font-black shadow-none focus-visible:ring-0"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => saveTitle().catch((error) => notify(error.message))}
        />
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <StatusBadge status="id">{jobId}</StatusBadge>
          <span>{meta?.fileCount || "?"} {t("job.files")}</span>
          <span>{meta?.createdAt ? new Date(meta.createdAt).toLocaleString("zh-CN") : "未知时间"}</span>
        </div>
      </CardHeader>
      <CardContent className="grid gap-5">
        {taskStatus && <StatusBadge status={taskStatus.status}>{taskStatus.text}</StatusBadge>}

        {meta?.translationUsage && (
          <div className="grid grid-cols-4 gap-3 rounded-lg border bg-muted/25 p-3 text-sm max-lg:grid-cols-2 max-sm:grid-cols-1">
            <div>
              <div className="text-xs text-muted-foreground">{t("job.model")}</div>
              <div className="mt-1 font-semibold">{meta.translationUsage.model || meta.translationUsage.modelName}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Tokens</div>
              <div className="mt-1 font-semibold">{formatTokens(meta.translationUsage.tokens?.totalTokens)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">{t("job.outputTokens")}</div>
              <div className="mt-1 font-semibold">{formatTokens(meta.translationUsage.tokens?.outputTokens)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">{t("home.estimatedCost")}</div>
              <div className="mt-1 font-semibold">{formatCny(meta.translationUsage.cost?.totalCost)}</div>
            </div>
          </div>
        )}

        {meta?.structureManifest && (
          <div className="rounded-lg border bg-background/70 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold">Structure analysis</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Main: {meta.structureManifest.mainTex || "-"} · Tex files: {meta.structureManifest.texFileCount || 0} · Units: {meta.structureManifest.totalTranslationUnits || 0}
                </div>
              </div>
              <StatusBadge status={meta.structureManifest.warnings?.length ? "translated" : "compiled"}>
                {meta.structureManifest.warnings?.length ? `${meta.structureManifest.warnings.length} warnings` : "validated scope"}
              </StatusBadge>
            </div>
            {(meta.structureManifest.warnings || []).length > 0 && (
              <div className="mt-3 grid gap-1 text-xs text-warn">
                {meta.structureManifest.warnings?.map((warning) => <div key={warning}>{warning}</div>)}
              </div>
            )}
          </div>
        )}

        {fileProgress.length > 0 && (
          <div className="rounded-lg border bg-background/70">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
              <div>
                <div className="text-sm font-semibold">{t("job.parallelTranslation")}</div>
                <div className="text-xs text-muted-foreground">
                  当前 {threadProgress.length || Number(localStorage.getItem("parallelism") || 3)} 线程并发，
                  已完成 {fileProgress.filter((file) => file.status === "done").length}/{fileProgress.length}
                  {activeFile ? `，正在处理 ${activeFile}` : ""}
                </div>
              </div>
              <StatusBadge status="running">
                {fileProgress.filter((file) => file.status === "running").length} running
              </StatusBadge>
            </div>
            {threadProgress.length > 0 && (
              <div className="grid gap-2 border-b bg-muted/20 p-3 sm:grid-cols-2 lg:grid-cols-3">
                {threadProgress.map((thread) => (
                  <button
                    key={thread.id}
                    type="button"
                    className="rounded-md border bg-background/80 p-3 text-left transition hover:border-primary/50"
                    onClick={() => {
                      const file = thread.activeFile ? fileProgress.find((item) => item.path === thread.activeFile) : null;
                      if (file) setSelectedFile(file);
                    }}
                  >
                    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span>Thread {thread.id}</span>
                      <span>{thread.status}</span>
                    </div>
                    <div className="mt-1 truncate text-sm font-medium">{thread.activeFile || "idle"}</div>
                    <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                      <span>{formatTokens(thread.tokens)} tokens</span>
                      <span>{Number(thread.tps || 0).toFixed(1)} tok/s</span>
                      <span>{thread.completed || 0} done</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
            <div className="grid divide-y">
              {fileProgress.map((file) => {
                const progress = Math.max(0, Math.min(100, Number(file.progress || 0)));
                const isActive = file.path === activeFile;
                return (
                  <button
                    key={file.path}
                    type="button"
                    onClick={() => setSelectedFile(file)}
                    className={cn("grid gap-2 px-4 py-3 text-left text-sm transition hover:bg-muted/40", isActive && "bg-primary/5")}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate font-medium">{file.path}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {file.targetPath}
                          {file.thread ? ` · thread ${file.thread}` : ""}
                          {file.role ? ` · ${file.role}` : ""}
                          {typeof file.unitCount === "number" ? ` · ${file.unitCount} units` : ""}
                          {file.batchCount ? ` · batch ${Math.min((file.batchIndex ?? -1) + 1, file.batchCount)}/${file.batchCount}` : ""}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 text-xs">
                        {file.status === "done" && <CheckCircle2 className="h-4 w-4 text-ok" />}
                        {file.status === "running" && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
                        {file.status === "error" && <span className="font-semibold text-destructive">!</span>}
                        <span className="text-muted-foreground">{file.status}</span>
                        <span>{file.chars || 0} chars</span>
                        <span>{formatTokens(file.tokens)} tokens</span>
                        <span>{Number(file.tps || 0).toFixed(1)} tok/s</span>
                      </div>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn("h-full rounded-full transition-all duration-500", file.status === "error" ? "bg-destructive" : "bg-primary")}
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                    {file.validation?.warnings?.length ? <div className="text-xs text-warn">{file.validation.warnings[0]}</div> : null}
                    {file.error && <div className="text-xs text-destructive">{file.error}</div>}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {fileProgress.length === 0 && (streamPreview || streamStats) && (
          <div className="overflow-hidden rounded-lg border bg-background/70">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
              <div>
                <div className="text-sm font-semibold">{t("job.streamingOutput")}</div>
                <div className="text-xs text-muted-foreground">{t("job.streamingOutputDesc")}</div>
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                <StatusBadge status="id">{streamStats?.tokens || 0} tokens</StatusBadge>
                <StatusBadge status="running">{streamStats?.tps || 0} tok/s</StatusBadge>
                <StatusBadge status="translated">{streamStats?.chars || 0} chars</StatusBadge>
              </div>
            </div>
            <ScrollArea className="max-h-72 bg-muted/20">
              <pre className="max-w-full whitespace-pre-wrap break-words p-4 font-mono text-xs leading-6 text-foreground [overflow-wrap:anywhere]">{streamPreview}</pre>
            </ScrollArea>
          </div>
        )}

        {logs.length > 0 && (
          <details className="overflow-hidden rounded-lg border bg-background/80">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-muted-foreground">{t("job.rawLogs")}</summary>
            <ScrollArea className="max-h-60 border-t bg-muted/20">
              <div className="max-w-full p-4 font-mono text-xs leading-6 text-foreground">
                {logs.map((log, index) => (
                  <div key={`${log.text}-${index}`} className={cn("break-words [overflow-wrap:anywhere]", log.tone === "phase" && "text-info", log.tone === "error" && "text-destructive")}>
                    {log.text}
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            </ScrollArea>
          </details>
        )}

        <div className="flex flex-wrap gap-2">
          <Button onClick={runTranslate} disabled={isStartingTranslate}>
            {isStartingTranslate ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
            {isStartingTranslate ? t("job.starting") : t("job.translate")}
          </Button>
          <Button onClick={runCompile} disabled={isCompiling}>
            {isCompiling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {isCompiling ? t("job.compiling") : t("job.compile")}
          </Button>
          <Button variant="secondary" onClick={() => fetch(`/api/open/${jobId}`)}>
            <FolderOpen className="h-4 w-4" />
            {t("job.openFolder")}
          </Button>
          <Button variant="secondary" onClick={runFeedback} disabled={isPackagingFeedback}>
            {isPackagingFeedback ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bug className="h-4 w-4" />}
            {isPackagingFeedback ? t("job.packaging") : t("job.feedback")}
          </Button>
          <Button variant="secondary" onClick={() => fetch("/api/open-feedback-folder")}>
            <FolderOpen className="h-4 w-4" />
            {t("job.openFeedbackFolder")}
          </Button>
          <Button variant="destructive" onClick={() => deleteJob({ id: jobId, title }, backToList)}>
            <Trash2 className="h-4 w-4" />
            {t("job.delete")}
          </Button>
        </div>

        {result === "pdf" && (
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="secondary" className="w-fit">
              <a href={`/api/download-pdf/${jobId}`} target="_blank" rel="noreferrer">
                <FileText className="h-4 w-4" />
                {t("job.openPdf")}
              </a>
            </Button>
            <Button variant="secondary" onClick={() => navigate(`/compare/${encodeURIComponent(jobId)}`)}>
              <Columns2 className="h-4 w-4" />
              {t("job.compare")}
            </Button>
          </div>
        )}
        {result && result !== "pdf" && (
          <ScrollArea className="max-h-80 rounded-lg border bg-muted/20">
            <pre className="max-w-full whitespace-pre-wrap break-words p-4 font-mono text-xs leading-6 text-foreground [overflow-wrap:anywhere]">{result}</pre>
          </ScrollArea>
        )}
        {selectedFileLive && (
          <div className="fixed inset-0 z-50 bg-background/45 backdrop-blur-sm" onClick={() => setSelectedFile(null)}>
            <aside
              className="ml-auto flex h-full w-[min(560px,100%)] min-w-0 flex-col overflow-hidden border-l bg-card shadow-2xl animate-in"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-4 border-b p-5">
                <div className="min-w-0">
                  <div className="truncate text-lg font-bold">{selectedFileLive.path}</div>
                  <div className="mt-1 truncate text-sm text-muted-foreground">{selectedFileLive.targetPath}</div>
                </div>
                <Button variant="ghost" size="icon" onClick={() => setSelectedFile(null)}>
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-3 border-b p-5 text-sm">
                <div className="rounded-md border bg-muted/25 p-3">
                  <div className="text-xs text-muted-foreground">Status</div>
                  <div className="mt-1 font-semibold">{selectedFileLive.status}</div>
                </div>
                <div className="rounded-md border bg-muted/25 p-3">
                  <div className="text-xs text-muted-foreground">Thread</div>
                  <div className="mt-1 font-semibold">{selectedFileLive.thread || "-"}</div>
                </div>
                <div className="rounded-md border bg-muted/25 p-3">
                  <div className="text-xs text-muted-foreground">Chars</div>
                  <div className="mt-1 font-semibold">{selectedFileLive.chars || 0}</div>
                </div>
                <div className="rounded-md border bg-muted/25 p-3">
                  <div className="text-xs text-muted-foreground">Tokens / speed</div>
                  <div className="mt-1 font-semibold">
                    {formatTokens(selectedFileLive.tokens)} / {Number(selectedFileLive.tps || 0).toFixed(1)} tok/s
                  </div>
                </div>
                <div className="rounded-md border bg-muted/25 p-3">
                  <div className="text-xs text-muted-foreground">Role / units</div>
                  <div className="mt-1 font-semibold">{selectedFileLive.role || "-"} / {selectedFileLive.unitCount ?? 0}</div>
                </div>
                <div className="rounded-md border bg-muted/25 p-3">
                  <div className="text-xs text-muted-foreground">Batches</div>
                  <div className="mt-1 font-semibold">
                    {selectedFileLive.batchCount ? `${Math.min((selectedFileLive.batchIndex ?? -1) + 1, selectedFileLive.batchCount)}/${selectedFileLive.batchCount}` : "-"}
                  </div>
                </div>
              </div>
              <div className="p-5">
                <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                  <span>Progress</span>
                  <span>{Math.round(Number(selectedFileLive.progress || 0))}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn("h-full rounded-full transition-all duration-500", selectedFileLive.status === "error" ? "bg-destructive" : "bg-primary")}
                    style={{ width: `${Math.max(0, Math.min(100, Number(selectedFileLive.progress || 0)))}%` }}
                  />
                </div>
              </div>
              {(selectedFileLive.validation?.issues?.length || selectedFileLive.validation?.warnings?.length) ? (
                <div className="mx-5 grid gap-2 rounded-md border bg-muted/20 p-3 text-xs">
                  {selectedFileLive.validation?.issues?.map((issue) => <div key={issue} className="text-destructive">{issue}</div>)}
                  {selectedFileLive.validation?.warnings?.map((warning) => <div key={warning} className="text-warn">{warning}</div>)}
                </div>
              ) : null}
              {selectedFileLive.error && <div className="mx-5 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{selectedFileLive.error}</div>}
              <div className="grid min-h-0 min-w-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-2 p-5 pt-3">
                <div className="text-sm font-semibold">Streaming preview</div>
                <ScrollArea className="h-full min-h-0 rounded-lg border bg-muted/20">
                  <pre className="max-w-full whitespace-pre-wrap break-words p-4 font-mono text-xs leading-6 text-foreground [overflow-wrap:anywhere]">{selectedFileLive.preview || "No preview yet."}</pre>
                </ScrollArea>
              </div>
            </aside>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PdfComparePage({ jobId, navigate, notify }: { jobId: string; navigate: (path: string) => void; notify: (message: string) => void }) {
  const { t } = useI18n();
  const [info, setInfo] = useState<PdfCompareInfo | null>(null);
  const [title, setTitle] = useState(jobId);
  const [isPreparing, setIsPreparing] = useState(true);
  const [error, setError] = useState("");
  const [hoverTarget, setHoverTarget] = useState<HoverTarget>(null);
  const leftRef = useRef<HTMLDivElement | null>(null);
  const rightRef = useRef<HTMLDivElement | null>(null);
  const syncingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const toastId = toast.loading(t("compare.preparing"));
    setIsPreparing(true);
    setError("");
    Promise.all([
      fetchJson<JobMeta>(`/api/jobs/${jobId}/metadata`).catch(() => null),
      fetchJson<PdfCompareInfo>(`/api/pdf-compare/${jobId}/prepare`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ xelatexPath: localStorage.getItem("xelatexPath") || "" }),
      }),
    ])
      .then(([meta, prepared]) => {
        if (cancelled) return;
        if (meta?.title) setTitle(meta.title);
        setInfo(prepared);
        toast.success(t("compare.readyToast"), { id: toastId });
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : t("compare.error");
        setError(message);
        toast.error(message, { id: toastId });
      })
      .finally(() => {
        if (!cancelled) setIsPreparing(false);
      });
    return () => {
      cancelled = true;
      toast.dismiss(toastId);
    };
  }, [jobId, t]);

  const syncScroll = (source: HTMLDivElement | null, target: HTMLDivElement | null) => {
    if (!source || !target || syncingRef.current) return;
    syncingRef.current = true;
    const denominator = Math.max(1, source.scrollHeight - source.clientHeight);
    const ratio = source.scrollTop / denominator;
    target.scrollTop = ratio * Math.max(1, target.scrollHeight - target.clientHeight);
    window.requestAnimationFrame(() => {
      syncingRef.current = false;
    });
  };

  const pages = Array.from({ length: Math.max(0, info?.pageCount || 0) }, (_, index) => index + 1);

  return (
    <div className="min-h-screen animate-in">
      <header className="sticky top-0 z-30 border-b border-border/80 bg-background/85 backdrop-blur-xl">
        <div className="mx-auto flex h-[68px] max-w-[1800px] items-center justify-between gap-4 px-6 max-sm:px-4">
          <div className="min-w-0">
            <Button variant="ghost" className="mb-1 h-auto px-0 py-0 text-primary hover:bg-transparent" onClick={() => navigate("/")}>
              <ArrowLeft className="h-4 w-4" />
              {t("app.backHome")}
            </Button>
            <div className="truncate text-sm font-bold">{title}</div>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status={isPreparing ? "running" : error ? "empty" : "compiled"}>
              {isPreparing ? t("compare.preparingShort") : error ? t("compare.failed") : `${info?.pageCount || 0} ${t("compare.ready")}`}
            </StatusBadge>
            <Button asChild variant="secondary">
              <a href={`/api/download-pdf/${jobId}`} target="_blank" rel="noreferrer">
                <FileText className="h-4 w-4" />
                {t("compare.openTranslated")}
              </a>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1800px] gap-4 px-6 py-5 max-sm:px-3">
        {error && (
          <Card className="border-destructive/30 bg-destructive/5">
            <CardContent className="p-4 text-sm text-destructive">{error}</CardContent>
          </Card>
        )}

        {isPreparing && <PdfCompareSkeleton />}

        {!isPreparing && info && info.renderer && pages.length > 0 && (
          <div className="grid h-[calc(100vh-112px)] grid-cols-2 overflow-hidden rounded-lg border bg-card shadow-soft animate-in max-lg:h-auto max-lg:grid-cols-1">
            <PdfPane
              title={t("compare.original")}
              side="original"
              jobId={jobId}
              pages={pages}
              paneRef={leftRef}
              hoverTarget={hoverTarget}
              setHoverTarget={setHoverTarget}
              onScroll={() => syncScroll(leftRef.current, rightRef.current)}
            />
            <PdfPane
              title={t("compare.translated")}
              side="translated"
              jobId={jobId}
              pages={pages}
              paneRef={rightRef}
              hoverTarget={hoverTarget}
              setHoverTarget={setHoverTarget}
              onScroll={() => syncScroll(rightRef.current, leftRef.current)}
            />
          </div>
        )}

        {!isPreparing && info && !info.renderer && (
          <div className="grid h-[calc(100vh-112px)] grid-cols-2 overflow-hidden rounded-lg border bg-card shadow-soft max-lg:grid-cols-1">
            <iframe title="English PDF" className="h-full w-full border-0" src={`${info.originalUrl}#view=FitH`} />
            <iframe title="Chinese PDF" className="h-full w-full border-0 border-l" src={`${info.translatedUrl}#view=FitH`} />
          </div>
        )}
      </main>
    </div>
  );
}

function PdfCompareSkeleton() {
  const { t } = useI18n();
  const pages = [1, 2, 3];
  return (
    <div className="grid h-[calc(100vh-112px)] grid-cols-2 overflow-hidden rounded-lg border bg-card shadow-soft animate-in max-lg:h-auto max-lg:grid-cols-1">
      {[t("compare.original"), t("compare.translated")].map((title) => (
        <section key={title} className="flex min-h-0 flex-col border-l first:border-l-0">
          <div className="flex h-11 shrink-0 items-center justify-between border-b bg-background/90 px-4">
            <div className="h-4 w-20 rounded bg-muted animate-pulse" />
            <div className="h-6 w-16 rounded-full bg-muted animate-pulse" />
          </div>
          <div className="min-h-0 flex-1 overflow-hidden bg-muted/20 p-4">
            <div className="mx-auto grid max-w-4xl gap-3">
              {pages.map((page) => (
                <div key={`${title}-${page}`} className="aspect-[0.72] w-full overflow-hidden rounded-md bg-background shadow-sm">
                  <div className="h-full w-full animate-pulse bg-[linear-gradient(110deg,hsl(var(--muted))_8%,hsl(var(--background))_18%,hsl(var(--muted))_33%)] bg-[length:200%_100%]" />
                </div>
              ))}
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}

function isMappedBlock(side: "original" | "translated", block: PdfTextBlock, target: HoverTarget, blockMap: PdfBlockMap | null) {
  if (!target || target.source !== "block" || target.page !== blockMap?.page || target.blockIndex === undefined) return false;
  if (target.side === side) return block.index === target.blockIndex;
  const map = target.side === "original" ? blockMap.originalToTranslated : blockMap.translatedToOriginal;
  return (map[String(target.blockIndex)] || []).includes(block.index);
}

function isMappedSyncRect(side: "original" | "translated", rect: PdfSyncRect, target: HoverTarget, syncMap: PdfSyncMap | null) {
  if (!target || target.source !== "synctex" || !target.id || target.page !== syncMap?.page) return false;
  if (target.side === side) return rect.id === target.id;
  const map = target.side === "original" ? syncMap.originalToTranslated : syncMap.translatedToOriginal;
  return (map[target.id] || []).includes(rect.id);
}

function PdfPageView({
  title,
  side,
  jobId,
  page,
  hoverTarget,
  setHoverTarget,
}: {
  title: string;
  side: "original" | "translated";
  jobId: string;
  page: number;
  hoverTarget: HoverTarget;
  setHoverTarget: (target: HoverTarget) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [textPage, setTextPage] = useState<PdfTextPage | null>(null);
  const [blockMap, setBlockMap] = useState<PdfBlockMap | null>(null);
  const [syncMap, setSyncMap] = useState<PdfSyncMap | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setTextPage(null);
    setBlockMap(null);
    setSyncMap(null);
    fetchJson<PdfTextPage>(`/api/pdf-text/${encodeURIComponent(jobId)}/${side}/${page}`)
      .then((data) => {
        if (!cancelled) setTextPage(data);
      })
      .catch(() => undefined);
    fetchJson<PdfBlockMap>(`/api/pdf-block-map/${encodeURIComponent(jobId)}/${page}`)
      .then((data) => {
        if (!cancelled) setBlockMap(data);
      })
      .catch(() => undefined);
    const syncParams = new URLSearchParams({ xelatexPath: localStorage.getItem("xelatexPath") || "" });
    fetchJson<PdfSyncMap>(`/api/pdf-sync-map/${encodeURIComponent(jobId)}/${page}?${syncParams.toString()}`)
      .then((data) => {
        if (!cancelled) setSyncMap(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [jobId, side, page]);

  const textBlocks = textPage?.blocks?.length ? textPage.blocks : textPage?.lines.map((line, index) => ({ ...line, index }));
  const syncRects = side === "original" ? syncMap?.originalRects : syncMap?.translatedRects;
  const useSyncRects = Boolean(syncRects?.length);
  const aspectRatio = textPage?.width && textPage?.height ? `${textPage.width} / ${textPage.height}` : "0.72";

  return (
    <div className="group relative bg-background shadow-sm transition first:rounded-t-md last:rounded-b-md">
      <div className="relative mx-auto overflow-hidden bg-white" style={{ aspectRatio }}>
        {!loaded && (
          <div className="absolute inset-0 animate-pulse bg-[linear-gradient(110deg,hsl(var(--muted))_8%,hsl(var(--background))_18%,hsl(var(--muted))_33%)] bg-[length:200%_100%]" />
        )}
        <img
          className={cn("absolute inset-0 h-full w-full object-contain transition-opacity duration-300", loaded ? "opacity-100" : "opacity-0")}
          loading="lazy"
          alt={`${title} page ${page}`}
          src={`/api/pdf-page/${encodeURIComponent(jobId)}/${side}/${page}.png`}
          onLoad={() => setLoaded(true)}
        />
        {useSyncRects && syncRects?.map((rect) => {
          const active = isMappedSyncRect(side, rect, hoverTarget, syncMap);
          return (
            <button
              key={rect.id}
              type="button"
              aria-label={rect.unitId}
              className={cn(
                "absolute rounded-sm border-0 bg-transparent p-0 transition-colors",
                active ? "bg-primary/20 ring-2 ring-primary/40" : "hover:bg-primary/10",
              )}
              style={{
                left: `${Math.max(0, rect.x * 100)}%`,
                top: `${Math.max(0, rect.y * 100)}%`,
                width: `${Math.min(100, Math.max(1, rect.w * 100))}%`,
                height: `${Math.min(100, Math.max(1.2, rect.h * 100))}%`,
              }}
              onMouseEnter={() => setHoverTarget({ page, side, source: "synctex", id: rect.id })}
              onMouseLeave={() => setHoverTarget(null)}
            />
          );
        })}
        {!useSyncRects && textBlocks?.map((block) => {
          const active = isMappedBlock(side, block, hoverTarget, blockMap);
          return (
            <button
              key={block.id}
              type="button"
              title={block.text}
              aria-label={block.text}
              className={cn(
                "absolute rounded-sm border-0 bg-transparent p-0 transition-colors",
                active ? "bg-primary/20 ring-2 ring-primary/40" : "hover:bg-primary/10",
              )}
              style={{
                left: `${Math.max(0, block.x * 100)}%`,
                top: `${Math.max(0, block.y * 100)}%`,
                width: `${Math.min(100, Math.max(1, block.w * 100))}%`,
                height: `${Math.min(100, Math.max(1.2, block.h * 100))}%`,
              }}
              onMouseEnter={() => setHoverTarget({ page, side, source: "block", blockIndex: block.index })}
              onMouseLeave={() => setHoverTarget(null)}
            />
          );
        })}
        <div className="pointer-events-none absolute right-3 top-3 rounded-full bg-background/85 px-2 py-1 text-[11px] font-bold text-muted-foreground opacity-0 shadow-sm backdrop-blur transition group-hover:opacity-100">
          Page {page}
        </div>
      </div>
    </div>
  );
}

function PdfPane({
  title,
  side,
  jobId,
  pages,
  paneRef,
  hoverTarget,
  setHoverTarget,
  onScroll,
}: {
  title: string;
  side: "original" | "translated";
  jobId: string;
  pages: number[];
  paneRef: MutableRefObject<HTMLDivElement | null>;
  hoverTarget: HoverTarget;
  setHoverTarget: (target: HoverTarget) => void;
  onScroll: () => void;
}) {
  return (
    <section className="flex min-h-0 flex-col border-l first:border-l-0">
      <div className="flex h-11 shrink-0 items-center justify-between border-b bg-background/90 px-4 backdrop-blur">
        <div className="font-bold">{title}</div>
        <StatusBadge status="id">{pages.length} pages</StatusBadge>
      </div>
      <div ref={paneRef} className="min-h-0 flex-1 overflow-auto bg-muted/20 p-4" onScroll={onScroll}>
        <div className="mx-auto grid max-w-4xl gap-3">
          {pages.map((page) => (
            <PdfPageView
              key={`${side}-${page}`}
              title={title}
              side={side}
              jobId={jobId}
              page={page}
              hoverTarget={hoverTarget}
              setHoverTarget={setHoverTarget}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function SettingsPage({ navigate, notify }: { navigate: (path: string) => void; notify: (message: string) => void }) {
  const { t } = useI18n();
  const [apiKey, setApiKey] = useState("");
  const [apiEndpoint, setApiEndpoint] = useState("https://api.deepseek.com/anthropic");
  const [model, setModel] = useState("deepseek-v4-pro");
  const [xelatexPath, setXelatexPath] = useState(() => localStorage.getItem("xelatexPath") || "");
  const [arxivProxy, setArxivProxy] = useState(() => localStorage.getItem("arxivProxy") || "");
  const [parallelism, setParallelism] = useState("3");
  const [status, setStatus] = useState<{ text: string; tone: "ok" | "error" | "neutral" } | null>(null);
  const [isVerifyingApi, setIsVerifyingApi] = useState(false);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);

  useEffect(() => {
    localStorage.removeItem("apiKey");
    fetchJson<{ apiKeySet: boolean; apiEndpoint: string; model: string; parallelism: number }>("/api/settings")
      .then((settings) => {
        if (settings.apiEndpoint) setApiEndpoint(settings.apiEndpoint);
        if (settings.model) setModel(settings.model);
        if (settings.parallelism) setParallelism(String(settings.parallelism));
        if (settings.apiKeySet) setStatus({ text: "服务端已配置 API Key；留空验证或保存时会继续使用服务端 Key。", tone: "ok" });
      })
      .catch(() => undefined);
  }, []);

  const save = async () => {
    localStorage.setItem("xelatexPath", xelatexPath.trim());
    localStorage.setItem("arxivProxy", arxivProxy.trim());
    const normalizedParallelism = String(Math.max(1, Math.min(8, Number(parallelism) || 3)));
    await fetchJson("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        apiEndpoint: apiEndpoint.trim(),
        model: model.trim(),
        parallelism: Number(normalizedParallelism),
      }),
    });
    notify("设置已保存");
  };

  const verifyApiKey = async () => {
    setIsVerifyingApi(true);
    setStatus({ text: "正在验证 API Key...", tone: "neutral" });
    try {
      const data = await fetchJson<{ ok: boolean; model: string; modelName: string; apiFormat: string; latencyMs: number }>("/api/verify-api-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          apiEndpoint: apiEndpoint.trim(),
          model: model.trim(),
        }),
      });
      setStatus({ text: `API Key 可用：${data.modelName || data.model} / ${data.apiFormat} / ${data.latencyMs}ms`, tone: "ok" });
    } catch (error) {
      setStatus({ text: error instanceof Error ? error.message : "API Key 验证失败", tone: "error" });
    } finally {
      setIsVerifyingApi(false);
    }
  };

  const detectXelatex = async () => {
    setStatus({ text: "正在检测 xelatex...", tone: "neutral" });
    try {
      const data = await fetchJson<{ path: string | null }>("/api/detect-xelatex");
      if (data.path) {
        setXelatexPath(data.path);
        localStorage.setItem("xelatexPath", data.path);
        setStatus({ text: `已找到：${data.path}`, tone: "ok" });
      } else {
        setStatus({ text: "没有找到 xelatex，请安装 MiKTeX/TeX Live 或手动填写完整路径。", tone: "error" });
      }
    } catch (error) {
      setStatus({ text: `检测失败：${error instanceof Error ? error.message : "未知错误"}`, tone: "error" });
    }
  };

  const checkUpdates = async () => {
    setIsCheckingUpdate(true);
    setStatus({ text: "正在检查 GitHub Release...", tone: "neutral" });
    try {
      const data = await fetchJson<{
        currentVersion: string;
        latestVersion: string;
        hasUpdate: boolean;
        htmlUrl: string;
        name?: string;
        noRelease?: boolean;
      }>("/api/check-updates");
      if (data.noRelease) {
        setStatus({ text: `当前版本 ${data.currentVersion}。GitHub 暂无 Release，已打开 Releases 页面。`, tone: "neutral" });
        window.open(data.htmlUrl, "_blank", "noopener,noreferrer");
      } else if (data.hasUpdate) {
        setStatus({ text: `发现新版本 ${data.latestVersion}（当前 ${data.currentVersion}），已打开 Release 页面。`, tone: "ok" });
        window.open(data.htmlUrl, "_blank", "noopener,noreferrer");
      } else {
        setStatus({ text: `当前已是最新版本：${data.currentVersion}`, tone: "ok" });
      }
    } catch (error) {
      setStatus({ text: error instanceof Error ? error.message : "检查更新失败", tone: "error" });
    } finally {
      setIsCheckingUpdate(false);
    }
  };

  return (
    <>
      <header className="sticky top-0 z-20 border-b border-border/80 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-[68px] max-w-5xl items-center justify-between px-6 max-sm:px-4">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-lg bg-brand font-black text-primary-foreground shadow-primary">A</div>
            <div>
              <h1 className="text-lg font-black tracking-normal">{t("settings.title")}</h1>
              <p className="text-xs text-muted-foreground">{t("settings.description")}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <LanguageToggle />
            <Button variant="secondary" onClick={() => navigate("/")}>
              {t("app.backHome")}
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid w-[min(860px,calc(100%_-_2rem))] gap-4 py-7">
        <Card className="bg-card/85 animate-in">
          <CardHeader>
            <CardTitle>{t("settings.translationApi")}</CardTitle>
            <CardDescription>{t("settings.translationApiDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <Field label="API Key">
              <Input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="留空则使用服务端已保存的 Key" />
            </Field>
            <Field label="API Endpoint">
              <Input value={apiEndpoint} onChange={(event) => setApiEndpoint(event.target.value)} />
            </Field>
            <Field label="Model">
              <Input value={model} onChange={(event) => setModel(event.target.value)} />
            </Field>
            <Field label="Parallel tex requests">
              <Input
                type="number"
                min={1}
                max={8}
                value={parallelism}
                onChange={(event) => setParallelism(event.target.value)}
              />
            </Field>
            <Field label="arXiv Proxy">
              <Input value={arxivProxy} onChange={(event) => setArxivProxy(event.target.value)} placeholder="http://127.0.0.1:7890" />
            </Field>
            <div className="rounded-lg border bg-muted/25 p-3 text-xs leading-6 text-muted-foreground">
              <div className="font-semibold text-foreground">DeepSeek 模型计费估算</div>
              <div>deepseek-v4-flash: 缓存输入 ¥0.02/M，未缓存输入 ¥1/M，输出 ¥2/M</div>
              <div>deepseek-v4-pro: 缓存输入 ¥0.025/M，未缓存输入 ¥3/M，输出 ¥6/M（2.5折至 2026-05-31 23:59）</div>
            </div>
            <div className="flex flex-wrap gap-2">
            <Button onClick={save}>
              <CheckCircle2 className="h-4 w-4" />
              {t("settings.save")}
            </Button>
              <Button variant="secondary" onClick={verifyApiKey} disabled={isVerifyingApi}>
                {isVerifyingApi ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                {t("settings.verifyApi")}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card/85 animate-in [animation-delay:80ms]">
          <CardHeader>
            <CardTitle>{t("settings.latexCompiler")}</CardTitle>
            <CardDescription>{t("settings.latexCompilerDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <Field label={t("settings.xelatexPath")}>
              <Input value={xelatexPath} onChange={(event) => setXelatexPath(event.target.value)} placeholder="C:\Program Files\MiKTeX\miktex\bin\x64\xelatex.exe" />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button onClick={detectXelatex}>
                <Search className="h-4 w-4" />
                {t("settings.autoDetect")}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setXelatexPath("");
                  localStorage.removeItem("xelatexPath");
                  setStatus({ text: "已清空自定义路径，编译时会回到自动查找。", tone: "neutral" });
                }}
              >
                {t("settings.clearPath")}
              </Button>
              <Button variant="outline" asChild>
                <a href="https://miktex.org/" target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" />
                  {t("settings.downloadMiktex")}
                </a>
              </Button>
            </div>
            {status && (
              <div
                className={cn(
                  "rounded-md px-3 py-2 text-sm animate-in",
                  status.tone === "ok" && "bg-ok/10 text-ok",
                  status.tone === "error" && "bg-destructive/10 text-destructive",
                  status.tone === "neutral" && "bg-primary/10 text-primary",
                )}
              >
                {status.text}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="bg-card/85 animate-in [animation-delay:120ms]">
          <CardHeader>
            <CardTitle>{t("settings.update")}</CardTitle>
            <CardDescription>{t("settings.updateDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={checkUpdates} disabled={isCheckingUpdate}>
              {isCheckingUpdate ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {t("settings.update")}
            </Button>
            <Button variant="outline" asChild>
              <a href="https://github.com/fanrj3/arxivTexTranslate/releases" target="_blank" rel="noreferrer">
                <ExternalLink className="h-4 w-4" />
                打开 Releases
              </a>
            </Button>
          </CardContent>
        </Card>
      </main>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function ConfirmDialog({ state, close, notify }: { state: ConfirmState; close: () => void; notify: (message: string) => void }) {
  if (!state) return null;
  return (
    <AlertDialog open onOpenChange={(open) => !open && close()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除任务</AlertDialogTitle>
          <AlertDialogDescription>{state.message}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={async () => {
              try {
                await state.onConfirm();
              } catch (error) {
                notify(error instanceof Error ? error.message : "操作失败");
              } finally {
                close();
              }
            }}
          >
            删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
