import React from "react";
import { AlertTriangle, Info } from "lucide-react";

import { Select } from "@/components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import {
  marketingStatusLabel,
  marketingTargetTone,
  type MarketingAttention,
  type MarketingTargetStatus,
} from "../lib/marketing";

/**
 * The pieces every Marketing screen is built from.
 *
 * They live here rather than in `components/` because nothing outside the
 * section uses them, and beside each page because five screens repeating the
 * same twelve Tailwind classes is how a section stops looking like one section.
 */

export const inputClass =
  "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-indigo-500/25";
export const labelClass =
  "mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400";
export const cardClass =
  "rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";
export const primaryButton =
  "inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50";
export const secondaryButton =
  "inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800";

export const MARKETING_WINDOW_OPTIONS = [7, 30, 90] as const;

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
      <div>
        <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">
          {eyebrow}
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-950 dark:text-white">
          {title}
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-600 dark:text-slate-400">{description}</p>
      </div>
      {action}
    </div>
  );
}

export function StatusBadge({ value }: { value: string }) {
  const tone =
    value === "active" || value === "approved" || value === "running"
      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
      : value === "review" || value === "ready"
        ? "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"
        : value === "rejected" || value === "stopped"
          ? "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300"
          : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300";
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
      {marketingStatusLabel(value)}
    </span>
  );
}

export function LoadingPage() {
  return (
    <div className="flex min-h-64 items-center justify-center">
      <Spinner />
    </div>
  );
}

export function ErrorPage({ message }: { message: string }) {
  return (
    <div className="page-shell p-4 sm:p-6">
      <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
        {message}
      </div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className={`${cardClass} px-6 py-14 text-center`}>
      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-slate-500 dark:bg-slate-800">
        {icon}
      </div>
      <h2 className="font-medium text-slate-900 dark:text-white">{title}</h2>
      <p className="mx-auto mt-1 max-w-lg text-sm text-slate-500 dark:text-slate-400">{body}</p>
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function MetricTile({
  label,
  value,
  icon,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
  sub?: string;
  tone?: "neutral" | "good" | "bad";
}) {
  const valueTone =
    tone === "good"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "bad"
        ? "text-red-600 dark:text-red-400"
        : "text-slate-950 dark:text-white";
  return (
    <div className={`${cardClass} p-4`}>
      <div className="flex items-center justify-between text-slate-400">
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
        {icon}
      </div>
      <div className={`mt-3 text-2xl font-semibold tabular-nums ${valueTone}`}>{value}</div>
      {sub ? <div className="mt-1 text-xs text-slate-500">{sub}</div> : null}
    </div>
  );
}

/** Whether the Campaign is hitting the number it was set up to hit. */
export function TargetPill({
  target,
  summary,
}: {
  target: MarketingTargetStatus;
  summary: string;
}) {
  const tone = marketingTargetTone(target.state);
  const classes =
    tone === "good"
      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
      : tone === "bad"
        ? "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300"
        : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300";
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${classes}`}>
      {target.metricLabel}: {summary}
    </span>
  );
}

export function AttentionList({
  items,
  renderLink,
}: {
  items: Array<MarketingAttention & { campaignId?: string | null; campaignName?: string | null }>;
  renderLink?: (campaignId: string, campaignName: string) => React.ReactNode;
}) {
  return (
    <ul className="divide-y divide-slate-100 dark:divide-slate-800">
      {items.map((item, index) => (
        <li key={`${item.code}-${item.campaignId ?? "company"}-${index}`} className="flex gap-3 px-5 py-3">
          <span
            className={
              item.severity === "warn"
                ? "mt-0.5 shrink-0 text-amber-500"
                : "mt-0.5 shrink-0 text-slate-400"
            }
          >
            {item.severity === "warn" ? <AlertTriangle size={15} /> : <Info size={15} />}
          </span>
          <div className="min-w-0 text-sm">
            <p className="text-slate-700 dark:text-slate-300">{item.message}</p>
            {item.campaignId && item.campaignName ? (
              <div className="mt-0.5 text-xs text-slate-500">
                {renderLink ? renderLink(item.campaignId, item.campaignName) : item.campaignName}
              </div>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** How many days of readouts everything on the screen is measured over. */
export function WindowPicker({
  value,
  onChange,
}: {
  value: number;
  onChange: (days: number) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-slate-500">
      <span className="whitespace-nowrap">Measured over</span>
      <Select
        className={`${inputClass} w-32 py-1.5`}
        value={String(value)}
        onChange={(event) => onChange(Number(event.target.value))}
      >
        {MARKETING_WINDOW_OPTIONS.map((days) => (
          <option key={days} value={days}>
            {days} days
          </option>
        ))}
      </Select>
    </label>
  );
}
