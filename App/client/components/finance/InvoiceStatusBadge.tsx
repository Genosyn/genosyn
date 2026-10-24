import React from "react";
import type { displayInvoiceStatus } from "@/lib/api";
import { Badge, type BadgeTone } from "@/components/ui/Badge";

export type InvoiceDisplayStatus = ReturnType<typeof displayInvoiceStatus>;

const TONE: Record<InvoiceDisplayStatus, BadgeTone> = {
  draft: "neutral",
  sent: "info",
  overdue: "warning",
  paid: "success",
  credited: "ai",
  written_off: "warning",
  void: "danger",
};

const LABEL: Partial<Record<InvoiceDisplayStatus, string>> = {
  written_off: "Written off",
};

/**
 * An invoice's displayed status — `displayInvoiceStatus`, so overdue, credited
 * and written off show as such — the same badge on every Finance page that
 * lists or opens invoices.
 */
export function InvoiceStatusBadge({ status }: { status: InvoiceDisplayStatus }) {
  return <Badge tone={TONE[status]}>{LABEL[status] ?? status}</Badge>;
}
