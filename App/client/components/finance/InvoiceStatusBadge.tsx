import React from "react";
import type { displayInvoiceStatus } from "@/lib/api";

export type InvoiceDisplayStatus = ReturnType<typeof displayInvoiceStatus>;

const BADGE: Record<InvoiceDisplayStatus, string> = {
  draft: "bg-slate-100 text-slate-700 dark:bg-slate-700/40 dark:text-slate-200",
  sent: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
  overdue: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  paid: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  credited: "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
  written_off: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200",
  void: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
};

const LABEL: Partial<Record<InvoiceDisplayStatus, string>> = {
  written_off: "Written off",
};

/**
 * An invoice's displayed status — `displayInvoiceStatus`, so overdue, credited
 * and written off show as such — the same pill on every Finance page that
 * lists or opens invoices.
 */
export function InvoiceStatusBadge({ status }: { status: InvoiceDisplayStatus }) {
  return (
    <span
      className={
        "inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider " +
        BADGE[status]
      }
    >
      {LABEL[status] ?? status}
    </span>
  );
}
