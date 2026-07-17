import React from "react";
import {
  ArrowLeft,
  Braces,
  CheckCircle2,
  Clipboard,
  FileText,
  Play,
  RefreshCw,
  TerminalSquare,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { api, type Company, type PipelineRunDetail, type PipelineRunSummary } from "@/lib/api";
import { copyToClipboard } from "@/lib/clipboard";
import {
  RUN_STATUS_META,
  TRIGGER_KIND_LABEL,
  formatDuration,
  formatRelativeTime,
} from "@/pages/pipelines/pipelineUi";

export function PipelineRuns({
  company,
  pipelineId,
  onOpenBuilder,
}: {
  company: Company;
  pipelineId: string;
  onOpenBuilder: () => void;
}) {
  const [runs, setRuns] = React.useState<PipelineRunSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<PipelineRunDetail | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const { toast } = useToast();

  const loadRuns = React.useCallback(
    async (quiet = false) => {
      if (!quiet) setRefreshing(true);
      try {
        const list = await api.get<PipelineRunSummary[]>(
          `/api/companies/${company.id}/pipelines/${pipelineId}/runs`,
        );
        setRuns(list);
        setError(null);
        setSelectedId((current) => {
          if (current && list.some((run) => run.id === current)) return current;
          return list[0]?.id ?? null;
        });
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [company.id, pipelineId],
  );

  React.useEffect(() => {
    void loadRuns(true);
    const interval = window.setInterval(() => void loadRuns(true), 5_000);
    return () => window.clearInterval(interval);
  }, [loadRuns]);

  React.useEffect(() => {
    let cancelled = false;
    if (!selectedId) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    setDetail(null);
    api
      .get<PipelineRunDetail>(`/api/companies/${company.id}/pipeline-runs/${selectedId}`)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((err) => {
        if (!cancelled) toast((err as Error).message, "error");
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [company.id, selectedId, toast]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-slate-50 dark:bg-slate-900 lg:flex-row">
      <aside className="max-h-64 w-full shrink-0 overflow-y-auto border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950 lg:max-h-none lg:w-80 lg:border-b-0 lg:border-r">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-slate-100 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-950">
          <div>
            <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Run history
            </div>
            <div className="text-[11px] text-slate-500 dark:text-slate-400">Latest 50 runs</div>
          </div>
          <button
            type="button"
            onClick={() => void loadRuns()}
            disabled={refreshing}
            className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50 dark:hover:bg-slate-800 dark:hover:text-slate-100"
            title="Refresh run history"
            aria-label="Refresh run history"
          >
            <RefreshCw size={15} className={refreshing ? "animate-spin" : ""} />
          </button>
        </div>

        {loading ? (
          <div className="space-y-2 p-3" aria-label="Loading run history">
            {[0, 1, 2].map((item) => (
              <div
                key={item}
                className="h-16 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800"
              />
            ))}
          </div>
        ) : error ? (
          <div className="m-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-500/10 dark:text-rose-200">
            <p>Could not load run history.</p>
            <button
              type="button"
              onClick={() => void loadRuns()}
              className="mt-2 font-medium underline underline-offset-2"
            >
              Try again
            </button>
          </div>
        ) : runs.length === 0 ? (
          <div className="p-5 text-center">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
              <Play size={18} />
            </div>
            <div className="mt-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
              No runs yet
            </div>
            <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
              Save the pipeline, then use Run now to test it with an empty payload.
            </p>
            <Button variant="secondary" size="sm" className="mt-3" onClick={onOpenBuilder}>
              <ArrowLeft size={14} /> Open builder
            </Button>
          </div>
        ) : (
          <ul>
            {runs.map((run) => {
              const status = RUN_STATUS_META[run.status];
              return (
                <li key={run.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(run.id)}
                    className={
                      "block w-full border-b border-slate-100 px-4 py-3 text-left transition dark:border-slate-800 " +
                      (run.id === selectedId
                        ? "bg-indigo-50 dark:bg-indigo-500/10"
                        : "hover:bg-slate-50 dark:hover:bg-slate-900")
                    }
                  >
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${status.dot}`} />
                      <span className="text-sm font-medium text-slate-800 dark:text-slate-100">
                        {status.label}
                      </span>
                      <span className="ml-auto text-[11px] text-slate-500 dark:text-slate-400">
                        {formatDuration(run.startedAt, run.finishedAt)}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-3 text-[11px] text-slate-500 dark:text-slate-400">
                      <span>{run.triggerLabel ?? TRIGGER_KIND_LABEL[run.triggerKind]}</span>
                      <span title={new Date(run.startedAt).toLocaleString()}>
                        {formatRelativeTime(run.startedAt)}
                      </span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
        {detailLoading ? (
          <div className="flex h-full min-h-64 items-center justify-center">
            <Spinner size={22} />
          </div>
        ) : detail ? (
          <RunDetail detail={detail} />
        ) : runs.length > 0 ? (
          <div className="flex min-h-64 items-center justify-center text-sm text-slate-500 dark:text-slate-400">
            Choose a run to see what happened.
          </div>
        ) : (
          <div className="flex min-h-64 items-center justify-center text-center">
            <div>
              <CheckCircle2 size={22} className="mx-auto text-slate-300 dark:text-slate-600" />
              <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                Completed runs will appear here.
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function RunDetail({ detail }: { detail: PipelineRunDetail }) {
  const status = RUN_STATUS_META[detail.status];
  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${status.tone}`}
            >
              <span className={`h-2 w-2 rounded-full ${status.dot}`} />
              {status.label}
            </span>
            <h2 className="mt-3 text-lg font-semibold text-slate-950 dark:text-slate-50">
              {status.description}
            </h2>
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:text-right">
            <RunMeta label="Started" value={new Date(detail.startedAt).toLocaleString()} />
            <RunMeta label="Duration" value={formatDuration(detail.startedAt, detail.finishedAt)} />
            <RunMeta
              label="Trigger"
              value={detail.triggerLabel ?? TRIGGER_KIND_LABEL[detail.triggerKind]}
            />
            <RunMeta label="Run ID" value={detail.id.slice(0, 8)} mono />
          </div>
        </div>
      </section>

      {detail.errorMessage && (
        <section className="rounded-xl border border-rose-200 bg-rose-50 p-4 dark:border-rose-900 dark:bg-rose-500/10">
          <div className="text-xs font-semibold uppercase tracking-wide text-rose-700 dark:text-rose-300">
            Why it failed
          </div>
          <p className="mt-1.5 whitespace-pre-wrap text-sm leading-6 text-rose-900 dark:text-rose-100">
            {detail.errorMessage}
          </p>
        </section>
      )}

      <DataSection
        icon={TerminalSquare}
        title="Step log"
        description="A chronological record of the steps reached during this run."
        value={detail.logContent || "No log was captured for this run."}
        dark
        footer={detail.truncated ? "The oldest part of this log was truncated." : undefined}
      />
      <DataSection
        icon={Clipboard}
        title="Starting data"
        description="The payload supplied by the Member, schedule, webhook, or company event."
        value={prettyJson(detail.inputJson)}
      />
      <DataSection
        icon={Braces}
        title="Step outputs"
        description="The final data produced by each step, keyed by its reference id."
        value={prettyJson(detail.outputJson)}
      />
    </div>
  );
}

function DataSection({
  icon: Icon,
  title,
  description,
  value,
  dark = false,
  footer,
}: {
  icon: typeof FileText;
  title: string;
  description: string;
  value: string;
  dark?: boolean;
  footer?: string;
}) {
  const { toast } = useToast();
  return (
    <details
      className="group overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm open:pb-0 dark:border-slate-800 dark:bg-slate-950"
      open={title === "Step log"}
    >
      <summary className="flex cursor-pointer list-none items-start gap-3 p-4 marker:hidden">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          <Icon size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</div>
          <p className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">
            {description}
          </p>
        </div>
        <button
          type="button"
          onClick={async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const ok = await copyToClipboard(value);
            toast(ok ? `${title} copied` : "Could not access clipboard", ok ? "success" : "error");
          }}
          className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          title={`Copy ${title.toLowerCase()}`}
          aria-label={`Copy ${title.toLowerCase()}`}
        >
          <Clipboard size={14} />
        </button>
      </summary>
      <pre
        className={
          "max-h-[32rem] overflow-auto border-t border-slate-200 p-4 font-mono text-[12px] leading-relaxed dark:border-slate-800 " +
          (dark
            ? "bg-slate-950 text-slate-100"
            : "bg-slate-50 text-slate-700 dark:bg-slate-900 dark:text-slate-300")
        }
      >
        {value}
      </pre>
      {footer && (
        <div className="border-t border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
          {footer}
        </div>
      )}
    </details>
  );
}

function RunMeta({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
        {label}
      </div>
      <div className={`mt-0.5 text-slate-700 dark:text-slate-300 ${mono ? "font-mono" : ""}`}>
        {value}
      </div>
    </div>
  );
}

function prettyJson(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}
