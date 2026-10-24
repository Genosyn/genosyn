import React from "react";
import { BrainCircuit, Check, KeyRound, Loader2, LogIn, Server } from "lucide-react";
import type { AIModel } from "@/lib/api";

/** Connected, or still waiting for its credential. */
export function ModelStatusBadge({ connected }: { connected: boolean }) {
  if (connected) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-900">
        <Check size={10} aria-hidden="true" /> Connected
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 ring-1 ring-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-900">
      <Loader2 size={10} className="animate-spin" aria-hidden="true" /> Waiting
    </span>
  );
}

/** The model chat and Routines use, when an employee has more than one. */
export function ModelActiveBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-indigo-700 ring-1 ring-indigo-200 dark:bg-indigo-500/10 dark:text-indigo-300 dark:ring-indigo-500/30">
      <BrainCircuit size={10} aria-hidden="true" /> Active
    </span>
  );
}

/**
 * How the model connects, at a glance: a key, a ChatGPT sign-in, or a server
 * of the company's own. Decorative — the card's text says the same thing.
 */
export function ModelKindIcon({ model }: { model: Pick<AIModel, "authMode"> }) {
  const Icon =
    model.authMode === "customEndpoint"
      ? Server
      : model.authMode === "subscription"
        ? LogIn
        : KeyRound;
  return (
    <span
      aria-hidden="true"
      className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
    >
      <Icon size={16} />
    </span>
  );
}
