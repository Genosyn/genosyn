import React from "react";
import { Button } from "@/components/ui/Button";
import { Card, CardBody } from "@/components/ui/Card";
import { FormError, FormSuccess } from "@/components/ui/FormError";
import { Archive } from "lucide-react";
import { type BackupHistoryItem } from "@/lib/api";
import { type BackupSummary, type Tone } from "@/lib/backupStatus";
import { Spinner } from "@/components/ui/Spinner";
import { clsx } from "@/components/ui/clsx";
import { TONE_TEXT, ToneIcon, SectionError } from "./ui";

/** Admin → Backups, first: are we backed up, and Back up now. */

const SUMMARY_ICON: Record<BackupSummary["tone"], Tone> = {
  ok: "ok",
  warn: "warn",
  error: "error",
  working: "working",
};

export function StatusCard({
  summary,
  error,
  onRetry,
  run,
  starting,
  onBackUpNow,
  startError,
  startNote,
}: {
  summary: BackupSummary | null;
  error: string | null;
  onRetry: () => void;
  run: BackupHistoryItem | null;
  starting: boolean;
  onBackUpNow: () => void;
  startError: string | null;
  startNote: string | null;
}) {
  const tone: Tone = summary ? SUMMARY_ICON[summary.tone] : error ? "error" : "muted";
  const headline =
    summary?.headline ?? (error ? "Couldn't check your backups" : "Checking your backups…");
  const label = run
    ? run.status === "running"
      ? "Backing up…"
      : "Copying off-box…"
    : starting
      ? "Starting…"
      : "Back up now";
  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span
              className={clsx(
                "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
                tone === "ok" && "bg-emerald-50 dark:bg-emerald-950/50",
                tone === "warn" && "bg-amber-50 dark:bg-amber-950/50",
                tone === "error" && "bg-rose-50 dark:bg-rose-950/50",
                tone === "working" && "bg-indigo-50 dark:bg-indigo-950/50",
                tone === "muted" && "bg-slate-100 dark:bg-slate-800",
                TONE_TEXT[tone],
              )}
            >
              {summary || error ? <ToneIcon tone={tone} size={18} /> : <Spinner size={18} />}
            </span>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                {headline}
              </h2>
              <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
                {summary?.activity ??
                  "A backup is a copy of everything on this install: every company's data, files and settings."}
              </p>
            </div>
          </div>
          <Button
            onClick={onBackUpNow}
            loading={starting || run !== null}
            className="w-full sm:w-auto sm:shrink-0"
          >
            <Archive size={14} />
            {label}
          </Button>
        </div>
        <FormError message={startError} />
        <FormSuccess message={startNote} />
        {error && !summary && <SectionError message={error} onRetry={onRetry} />}
        {summary && (
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
            <Fact term="Last good backup">{summary.lastGoodText}</Fact>
            <Fact term="Where it is">{summary.whereText}</Fact>
            <Fact term="Automatic backups">
              {summary.scheduleText}
              {summary.nextText ? ` · Next: ${summary.nextText}` : ""}
            </Fact>
            <Fact term="Last verified">{summary.verifiedText}</Fact>
          </dl>
        )}
        {summary && summary.issues.length > 0 && <Issues issues={summary.issues} />}
      </CardBody>
    </Card>
  );
}

function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-slate-500 dark:text-slate-400">{term}</dt>
      <dd className="min-w-0 break-words text-slate-900 dark:text-slate-100">{children}</dd>
    </>
  );
}

function Issues({ issues }: { issues: BackupSummary["issues"] }) {
  const worst = issues.some((issue) => issue.tone === "error") ? "error" : "warn";
  return (
    <section
      aria-labelledby="backup-issues"
      className={clsx(
        "rounded-lg border px-3 py-2.5",
        worst === "error"
          ? "border-rose-200 bg-rose-50/60 dark:border-rose-900 dark:bg-rose-950/30"
          : "border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30",
      )}
    >
      <h3
        id="backup-issues"
        className="text-xs font-medium text-slate-600 dark:text-slate-300"
      >
        Needs attention
      </h3>
      <ul className="mt-1.5 flex flex-col gap-1">
        {issues.map((issue) => (
          <li key={issue.key} className="flex items-start gap-2 text-sm">
            <ToneIcon tone={issue.tone} className={clsx("mt-0.5", TONE_TEXT[issue.tone])} />
            <span className="min-w-0 break-words text-slate-800 dark:text-slate-100">
              {issue.text}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
