import {
  ArrowLeft,
  ArrowRight,
  Bug,
  CheckCircle2,
  ExternalLink,
  FileArchive,
  FileText,
  FolderOpen,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Trash2,
  Wand2,
} from "lucide-react";
import { type ChangeEvent, type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  compiled: "已编译",
  translated: "已翻译",
  extracted: "已解包",
  empty: "待处理",
  running: "运行中",
};

function formatTokens(value?: number) {
  const n = Number(value || 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCny(value?: number) {
  return `¥${Number(value || 0).toFixed(4)}`;
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
  const { path, navigate } = usePath();
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
      {path === "/settings" || path === "/settings.html" ? (
        <SettingsPage navigate={navigate} notify={notify} />
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
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-border/80 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-[68px] max-w-7xl items-center justify-between gap-4 px-6 max-sm:px-4">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-lg bg-brand font-black text-primary-foreground shadow-primary">A</div>
            <div>
              <h1 className="text-lg font-black leading-none tracking-normal">arXiv Translate</h1>
              <p className="mt-1 text-xs text-muted-foreground">论文翻译、编译与本地管理</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => refreshJobs().catch((error) => notify(error.message))}>
              <RefreshCw className="h-4 w-4" />
              刷新
            </Button>
            <Button variant="secondary" size="icon" title="设置" onClick={() => navigate("/settings")}>
              <Settings className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-6 max-sm:px-4">
        {selectedJobId ? (
          <JobDetail jobId={selectedJobId} backToList={backToList} deleteJob={deleteJob} refreshJobs={refreshJobs} notify={notify} />
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-6 max-lg:grid-cols-1">
            <section className="min-w-0">
              <div className="mb-5 flex items-end justify-between gap-5 max-md:flex-col max-md:items-stretch">
                <div>
                  <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-border bg-card/80 px-3 py-1 text-xs font-bold text-muted-foreground shadow-sm backdrop-blur">
                    <Sparkles className="h-3.5 w-3.5 text-primary" />
                    React + Tailwind + shadcn/ui
                  </div>
                  <h2 className="text-3xl font-black tracking-normal max-sm:text-2xl">论文工作台</h2>
                  <p className="mt-2 text-sm text-muted-foreground">把源码拉取、翻译、编译和结果管理放在一个现代化控制台里。</p>
                </div>
                <div className="relative w-80 max-md:w-full">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input className="bg-card/80 pl-9" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="搜索标题或 arXiv ID" />
                </div>
              </div>

              <div className="mb-4 grid grid-cols-5 gap-3 max-lg:grid-cols-3 max-sm:grid-cols-1">
                <MetricCard label="全部论文" value={jobs.length} />
                <MetricCard label="已翻译" value={translatedCount} />
                <MetricCard label="已编译" value={compiledCount} />
                <MetricCard label="Tokens" value={formatTokens(usageSummary.totalTokens)} />
                <MetricCard label="预估费用" value={formatCny(usageSummary.totalCost)} />
              </div>

              <div className="grid gap-3">
                {filteredJobs.length ? (
                  filteredJobs.map((job, index) => (
                    <JobCard key={job.id} job={job} runningTask={runningTasks[job.id]} openDetail={openDetail} deleteJob={deleteJob} index={index} />
                  ))
                ) : (
                  <Card className="grid min-h-72 place-items-center border-dashed bg-card/70 text-center animate-in">
                    <CardContent>
                      <FileText className="mx-auto mb-3 h-8 w-8 text-primary" />
                      <b className="block">还没有论文任务</b>
                      <span className="mt-2 block max-w-sm text-sm leading-6 text-muted-foreground">输入 arXiv ID 或上传源码包开始。任务会出现在这里。</span>
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
                    快速开始
                  </CardTitle>
                  <CardDescription>拉取 arXiv 源码或导入本地源码包。</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="arxiv-input">arXiv ID 或 URL</Label>
                    <div className="flex gap-2">
                      <Input
                        id="arxiv-input"
                        value={arxivInput}
                        onChange={(event) => setArxivInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") searchArxiv();
                        }}
                        placeholder="arXiv ID、URL 或关键词"
                        spellCheck={false}
                      />
                      <Button size="icon" disabled={isFetching || isSearchingArxiv || isUploading} onClick={searchArxiv} aria-label="搜索或拉取源码">
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
                    <strong className="text-sm">{isUploading ? "正在导入源码包" : "选择或拖入 .tar.gz"}</strong>
                    <span className="max-w-64 text-xs leading-6 text-muted-foreground">{isUploading ? "正在解包并识别主 tex 文件..." : "自动解包、识别主 tex 文件，并保存为一个本地任务。"}</span>
                    <input ref={fileRef} type="file" accept=".tar.gz,.gz" hidden onChange={(event: ChangeEvent<HTMLInputElement>) => uploadFile(event.target.files?.[0])} />
                  </button>
                </CardContent>
              </Card>

              <Card className="bg-card/70">
                <CardHeader>
                  <CardTitle>运行状态</CardTitle>
                  <CardDescription>当前后台任务和编译完成度。</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">后台任务</span>
                    <StatusBadge status={runningCount ? "running" : "compiled"}>{runningCount ? `${runningCount} 个运行中` : "空闲"}</StatusBadge>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">PDF 产出</span>
                    <span className="font-bold">{compiledCount}/{jobs.length}</span>
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
    <Card className="bg-card/75 transition hover:-translate-y-0.5 hover:shadow-soft">
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
  deleteJob,
  index,
}: {
  job: Job;
  runningTask?: RunningTask;
  openDetail: (id: string) => void;
  deleteJob: (job: Pick<Job, "id" | "title">) => void;
  index: number;
}) {
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
          <StatusBadge status={status}>{statusLabels[status] || status}</StatusBadge>
          <span>{job.fileCount || 0} 个文件</span>
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
          <Button variant="secondary" onClick={() => window.open(`/api/download-pdf/${job.id}`, "_blank")}>
            <FileText className="h-4 w-4" />
            打开 PDF
          </Button>
        ) : job.hasCnTex ? (
          <Button onClick={() => openDetail(job.id)}>
            <Play className="h-4 w-4" />
            编译
          </Button>
        ) : (
          <Button onClick={() => openDetail(job.id)}>
            <Wand2 className="h-4 w-4" />
            翻译
          </Button>
        )}
        <Button variant="secondary" onClick={() => fetch(`/api/open/${job.id}`)}>
          <FolderOpen className="h-4 w-4" />
          目录
        </Button>
        <Button variant="destructive" size="icon" aria-label="删除任务" onClick={() => deleteJob(job)}>
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
  notify,
}: {
  jobId: string;
  backToList: () => void;
  deleteJob: (job: Pick<Job, "id" | "title">, afterDelete?: () => void) => void;
  refreshJobs: () => Promise<void>;
  notify: (message: string) => void;
}) {
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
      window.open(data.floatingUrl, "_blank", "width=390,height=280");
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
          返回列表
        </Button>
        <Input
          className="h-auto border-x-0 border-t-0 bg-transparent px-0 pb-3 text-2xl font-black shadow-none focus-visible:ring-0"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => saveTitle().catch((error) => notify(error.message))}
        />
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <StatusBadge status="id">{jobId}</StatusBadge>
          <span>{meta?.fileCount || "?"} 个文件</span>
          <span>{meta?.createdAt ? new Date(meta.createdAt).toLocaleString("zh-CN") : "未知时间"}</span>
        </div>
      </CardHeader>
      <CardContent className="grid gap-5">
        {taskStatus && <StatusBadge status={taskStatus.status}>{taskStatus.text}</StatusBadge>}

        {meta?.translationUsage && (
          <div className="grid grid-cols-4 gap-3 rounded-lg border bg-muted/25 p-3 text-sm max-lg:grid-cols-2 max-sm:grid-cols-1">
            <div>
              <div className="text-xs text-muted-foreground">模型</div>
              <div className="mt-1 font-semibold">{meta.translationUsage.model || meta.translationUsage.modelName}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Tokens</div>
              <div className="mt-1 font-semibold">{formatTokens(meta.translationUsage.tokens?.totalTokens)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">输出 Tokens</div>
              <div className="mt-1 font-semibold">{formatTokens(meta.translationUsage.tokens?.outputTokens)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">预估费用</div>
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
                <div className="text-sm font-semibold">Tex 并行翻译</div>
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
                <div className="text-sm font-semibold">实时翻译输出</div>
                <div className="text-xs text-muted-foreground">正在显示模型返回的最新内容</div>
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
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-muted-foreground">查看原始日志</summary>
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
            {isStartingTranslate ? "启动中" : "翻译中文"}
          </Button>
          <Button onClick={runCompile} disabled={isCompiling}>
            {isCompiling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {isCompiling ? "编译中" : "编译 PDF"}
          </Button>
          <Button variant="secondary" onClick={() => fetch(`/api/open/${jobId}`)}>
            <FolderOpen className="h-4 w-4" />
            打开目录
          </Button>
          <Button variant="secondary" onClick={runFeedback} disabled={isPackagingFeedback}>
            {isPackagingFeedback ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bug className="h-4 w-4" />}
            {isPackagingFeedback ? "打包中" : "一键反馈"}
          </Button>
          <Button variant="secondary" onClick={() => fetch("/api/open-feedback-folder")}>
            <FolderOpen className="h-4 w-4" />
            查看反馈文件夹
          </Button>
          <Button variant="destructive" onClick={() => deleteJob({ id: jobId, title }, backToList)}>
            <Trash2 className="h-4 w-4" />
            删除任务
          </Button>
        </div>

        {result === "pdf" && (
          <Button asChild variant="secondary" className="w-fit">
            <a href={`/api/download-pdf/${jobId}`} target="_blank" rel="noreferrer">
              <FileText className="h-4 w-4" />
              打开 PDF
            </a>
          </Button>
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

function SettingsPage({ navigate, notify }: { navigate: (path: string) => void; notify: (message: string) => void }) {
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
              <h1 className="text-lg font-black tracking-normal">设置</h1>
              <p className="text-xs text-muted-foreground">API 配置与 LaTeX 编译器路径</p>
            </div>
          </div>
          <Button variant="secondary" onClick={() => navigate("/")}>
            返回任务
          </Button>
        </div>
      </header>

      <main className="mx-auto grid w-[min(860px,calc(100%_-_2rem))] gap-4 py-7">
        <Card className="bg-card/85 animate-in">
          <CardHeader>
            <CardTitle>翻译 API</CardTitle>
            <CardDescription>配置会保存在本机 localStorage 中，仅用于当前应用发起翻译请求。</CardDescription>
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
              保存设置
            </Button>
              <Button variant="secondary" onClick={verifyApiKey} disabled={isVerifyingApi}>
                {isVerifyingApi ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                验证 API Key
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card/85 animate-in [animation-delay:80ms]">
          <CardHeader>
            <CardTitle>LaTeX 编译器</CardTitle>
            <CardDescription>默认自动查找 xelatex；也可以指定 MiKTeX 或 TeX Live 的完整路径。</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <Field label="xelatex 路径">
              <Input value={xelatexPath} onChange={(event) => setXelatexPath(event.target.value)} placeholder="C:\Program Files\MiKTeX\miktex\bin\x64\xelatex.exe" />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button onClick={detectXelatex}>
                <Search className="h-4 w-4" />
                自动检测
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setXelatexPath("");
                  localStorage.removeItem("xelatexPath");
                  setStatus({ text: "已清空自定义路径，编译时会回到自动查找。", tone: "neutral" });
                }}
              >
                清空自定义路径
              </Button>
              <Button variant="outline" asChild>
                <a href="https://miktex.org/" target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" />
                  下载 MiKTeX
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
            <CardTitle>应用更新</CardTitle>
            <CardDescription>通过 GitHub Releases 检查桌面应用的新版本。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={checkUpdates} disabled={isCheckingUpdate}>
              {isCheckingUpdate ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              检查更新
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
