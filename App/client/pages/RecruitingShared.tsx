import React from "react";
import { AlertTriangle, Bot, Loader2 } from "lucide-react";

import { Breadcrumbs, type Crumb } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { clsx } from "../components/ui/clsx";
import {
  TONE_CLASSES,
  scoreBarClass,
  scoreLabelText,
  screenSummary,
  stageLabel,
  stageTone,
  type ApplicationSummary,
  type Tone,
} from "../lib/recruiting";
import type { RecruitingStage, ScoreLabel } from "../../shared/recruiting";

/**
 * The pieces every Recruiting screen is built from — kept beside the pages
 * because nothing outside the section uses them.
 */

export const cardClass =
  "rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";
export const inputClass =
  "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100";
export const labelClass =
  "mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400";

/** The frame every Recruiting page sits in: the padding Finance and Revenue pages use. */
export const pageClass = "page-shell p-4 sm:p-8";

/** A trail that starts at Recruiting's front page, the way Revenue's and Finance's do. */
export function recruitingCrumbs(base: string, ...rest: Crumb[]): Crumb[] {
  return [{ label: "Recruiting", to: base }, ...rest];
}

/** Breadcrumbs, then the page's title — the header every other section's pages carry. */
export function PageHeader({
  crumbs,
  title,
  description,
  action,
}: {
  crumbs: Crumb[];
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <>
      <div className="mb-6">
        <Breadcrumbs items={crumbs} />
      </div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl dark:text-slate-100">{title}</h1>
          {description ? (
            <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">{description}</p>
          ) : null}
        </div>
        {action ? <div className="flex flex-wrap items-center gap-2">{action}</div> : null}
      </div>
    </>
  );
}

export function TonePill({
  tone,
  children,
  title,
  wrap = false,
}: {
  tone: Tone;
  children: React.ReactNode;
  title?: string;
  /** Let long text (an email address) wrap inside the pill instead of running past its card. */
  wrap?: boolean;
}) {
  return (
    <span
      title={title}
      className={clsx(
        "inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        wrap ? "max-w-full rounded-lg [overflow-wrap:anywhere]" : "whitespace-nowrap rounded-full",
        TONE_CLASSES[tone],
      )}
    >
      {children}
    </span>
  );
}

export function StagePill({ stage }: { stage: RecruitingStage }) {
  return <TonePill tone={stageTone(stage)}>{stageLabel(stage)}</TonePill>;
}

/**
 * The AI screen's state as a pill: a number and a label when scored, and
 * plain words otherwise — never a zero for a screen that did not happen.
 */
export function ScreenPill({
  application,
}: {
  application: Pick<ApplicationSummary, "screenStatus" | "score" | "scoreLabel" | "injectionFlag">;
}) {
  const summary = screenSummary(application);
  return (
    <span className="inline-flex items-center gap-1.5">
      <TonePill tone={summary.tone}>
        {application.screenStatus === "running" ? <Loader2 size={11} className="animate-spin" /> : null}
        {summary.text}
      </TonePill>
      {application.injectionFlag ? (
        <span
          title="This application contains text trying to instruct an AI. It was flagged and judged on its evidence only."
          className="text-amber-500"
        >
          <AlertTriangle size={13} aria-label="Contains instructions aimed at AI" />
        </span>
      ) : null}
    </span>
  );
}

/** A horizontal 0–100 bar in the label's color. */
export function ScoreBar({ score, label, className = "" }: { score: number | null; label: ScoreLabel | null; className?: string }) {
  return (
    <div className={clsx("h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800", className)}>
      {score !== null ? (
        <div className={clsx("h-full rounded-full", scoreBarClass(label))} style={{ width: `${Math.max(3, score)}%` }} />
      ) : null}
    </div>
  );
}

/** The big score on an Application page: a ring with the number inside. */
export function ScoreRing({ score, label, size = 88 }: { score: number | null; label: ScoreLabel | null; size?: number }) {
  const radius = (size - 10) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = score === null ? 0 : (circumference * score) / 100;
  const stroke =
    label === "strong" ? "#10b981" : label === "good" ? "#6366f1" : label === "possible" ? "#f59e0b" : label === "weak" ? "#f43f5e" : "#cbd5e1";
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={8} className="stroke-slate-100 dark:stroke-slate-800" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={8}
          strokeLinecap="round"
          stroke={stroke}
          strokeDasharray={`${filled} ${circumference}`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-semibold tabular-nums text-slate-950 dark:text-white">{score ?? "—"}</span>
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">of 100</span>
      </div>
      <span className="sr-only">{scoreLabelText(label)}</span>
    </div>
  );
}

export function MetricTile({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className={clsx(cardClass, "p-4")}>
      <div className="flex items-center justify-between text-slate-400">
        <span className="text-xs font-medium">{label}</span>
        {icon}
      </div>
      <div className="mt-3 text-2xl font-semibold tabular-nums text-slate-950 dark:text-white">{value}</div>
      {sub ? <div className="mt-1 text-xs text-slate-500">{sub}</div> : null}
    </div>
  );
}

export function LoadingPage() {
  return (
    <div className="flex min-h-64 items-center justify-center">
      <Spinner size={20} />
    </div>
  );
}

export function ErrorPanel({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-xl border border-dashed border-rose-300 p-10 text-center dark:border-rose-500/40">
      <p className="text-sm text-rose-700 dark:text-rose-300">{message}</p>
      {onRetry ? (
        <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyPanel({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 px-6 py-14 text-center dark:border-slate-700">
      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-slate-500 dark:bg-slate-800">
        {icon}
      </div>
      <h2 className="font-medium text-slate-900 dark:text-white">{title}</h2>
      <p className="mx-auto mt-1 max-w-lg text-sm text-slate-500 dark:text-slate-400">{body}</p>
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </div>
  );
}

/** "By Ava (AI Employee)" — how an AI author is credited everywhere in Recruiting. */
export function AiByline({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-slate-500">
      <Bot size={12} /> {name}
    </span>
  );
}
