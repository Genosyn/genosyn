import React from "react";
import { useOutletContext } from "react-router-dom";
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleSlash,
  RefreshCw,
  Search,
} from "lucide-react";
import {
  api,
  EmailLog,
  EmailLogPage,
  EmailLogPurpose,
  EmailLogStatus,
  EmailLogTransport,
} from "../lib/api";
import { Button } from "../components/ui/Button";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { Spinner } from "../components/ui/Spinner";
import { EmptyState } from "../components/ui/EmptyState";
import { Modal } from "../components/ui/Modal";
import { useToast } from "../components/ui/Toast";
import type { SettingsOutletCtx } from "./SettingsLayout";

/**
 * Read-only Email Logs page. Lists every notification email Genosyn has
 * tried to deliver for this company (and system-level sends triggered by
 * a member's account, like signup welcome). Supports search, status +
 * purpose filtering, and a detail modal that shows the captured body
 * preview and upstream provider error.
 */

const PAGE_SIZE = 50;

const PURPOSE_LABELS: Record<EmailLogPurpose, string> = {
  invitation: "Invitation",
  password_reset: "Password reset",
  welcome: "Welcome",
  test: "Test",
  other: "Other",
};

const TRANSPORT_LABELS: Record<EmailLogTransport, string> = {
  smtp: "SMTP",
  sendgrid: "SendGrid",
  mailgun: "Mailgun",
  resend: "Resend",
  postmark: "Postmark",
  config_smtp: "Platform SMTP",
  console: "Console fallback",
};

function useCtx(): SettingsOutletCtx {
  return useOutletContext<SettingsOutletCtx>();
}

export function SettingsEmailLogs() {
  const { company } = useCtx();
  const { toast } = useToast();
  const [page, setPage] = React.useState<EmailLogPage | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [offset, setOffset] = React.useState(0);
  const [status, setStatus] = React.useState<EmailLogStatus | "">("");
  const [purpose, setPurpose] = React.useState<EmailLogPurpose | "">("");
  const [search, setSearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const [detail, setDetail] = React.useState<EmailLog | null>(null);

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const reload = React.useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(offset));
      if (status) params.set("status", status);
      if (purpose) params.set("purpose", purpose);
      if (debouncedSearch) params.set("search", debouncedSearch);
      const data = await api.get<EmailLogPage>(
        `/api/companies/${company.id}/email/logs?${params.toString()}`,
      );
      setPage(data);
    } catch (err) {
      toast((err as Error).message, "error");
      setPage({ total: 0, limit: PAGE_SIZE, offset: 0, rows: [] });
    } finally {
      setLoading(false);
    }
  }, [company.id, offset, status, purpose, debouncedSearch, toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  // Reset to first page whenever a filter changes.
  React.useEffect(() => {
    setOffset(0);
  }, [status, purpose, debouncedSearch]);

  const total = page?.total ?? 0;
  const rows = page?.rows ?? [];
  const hasPrev = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;
  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + PAGE_SIZE, total);

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[220px] flex-1">
              <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                Search
              </label>
              <div className="relative">
                <Search
                  size={14}
                  className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400"
                />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Recipient, subject, or error"
                  className="h-9 w-full rounded-md border border-slate-300 bg-white pl-7 pr-3 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-900"
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                Status
              </label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as EmailLogStatus | "")}
                className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-900"
              >
                <option value="">All statuses</option>
                <option value="sent">Sent</option>
                <option value="failed">Failed</option>
                <option value="skipped">Skipped</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                Purpose
              </label>
              <select
                value={purpose}
                onChange={(e) =>
                  setPurpose(e.target.value as EmailLogPurpose | "")
                }
                className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-900"
              >
                <option value="">All purposes</option>
                <option value="invitation">Invitation</option>
                <option value="password_reset">Password reset</option>
                <option value="welcome">Welcome</option>
                <option value="test">Test</option>
                <option value="other">Other</option>
              </select>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => reload()}
              disabled={loading}
              title="Refresh"
            >
              <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardBody>
          {loading && rows.length === 0 ? (
            <Spinner />
          ) : rows.length === 0 ? (
            <EmptyState
              title="No email activity"
              description="Outgoing notification emails (invitations, alerts, tests) appear here once sent."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] table-fixed text-sm">
                <thead className="text-left text-xs text-slate-500 dark:text-slate-400">
                  <tr className="border-b border-slate-100 dark:border-slate-800">
                    <th className="w-32 px-2 py-2 font-medium">Sent at</th>
                    <th className="w-24 px-2 py-2 font-medium">Status</th>
                    <th className="px-2 py-2 font-medium">To · Subject</th>
                    <th className="w-32 px-2 py-2 font-medium">Purpose</th>
                    <th className="w-28 px-2 py-2 font-medium">Transport</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.id}
                      onClick={() => setDetail(row)}
                      className="cursor-pointer border-b border-slate-50 hover:bg-slate-50 dark:border-slate-900 dark:hover:bg-slate-800/40"
                    >
                      <td className="px-2 py-2 align-top text-xs text-slate-500 dark:text-slate-400">
                        {formatTimestamp(row.createdAt)}
                      </td>
                      <td className="px-2 py-2 align-top">
                        <StatusPill status={row.status} />
                      </td>
                      <td className="min-w-0 px-2 py-2 align-top">
                        <div className="truncate font-medium text-slate-900 dark:text-slate-100">
                          {row.toAddress}
                        </div>
                        <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                          {row.subject || "(no subject)"}
                        </div>
                      </td>
                      <td className="px-2 py-2 align-top text-xs text-slate-600 dark:text-slate-300">
                        {PURPOSE_LABELS[row.purpose]}
                      </td>
                      <td className="px-2 py-2 align-top text-xs text-slate-600 dark:text-slate-300">
                        {TRANSPORT_LABELS[row.transport]}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-4 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>
              {total === 0
                ? "0 results"
                : `Showing ${start}–${end} of ${total}`}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                disabled={!hasPrev || loading}
              >
                <ChevronLeft size={12} /> Prev
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setOffset(offset + PAGE_SIZE)}
                disabled={!hasNext || loading}
              >
                Next <ChevronRight size={12} />
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>

      <DetailModal
        open={detail !== null}
        log={detail}
        onClose={() => setDetail(null)}
      />
    </>
  );
}

function StatusPill({ status }: { status: EmailLogStatus }) {
  if (status === "sent") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
        <CheckCircle2 size={10} /> Sent
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-medium text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
        <AlertCircle size={10} /> Failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
      <CircleSlash size={10} /> Skipped
    </span>
  );
}

function DetailModal({
  open,
  log,
  onClose,
}: {
  open: boolean;
  log: EmailLog | null;
  onClose: () => void;
}) {
  if (!log) return null;
  return (
    <Modal open={open} onClose={onClose} title="Email details" size="lg">
      <dl className="grid grid-cols-3 gap-x-4 gap-y-2 text-xs">
        <Row label="To" value={log.toAddress} />
        <Row label="From" value={log.fromAddress || "—"} />
        <Row label="Subject" value={log.subject || "(no subject)"} />
        <Row label="Status" value={<StatusPill status={log.status} />} />
        <Row label="Purpose" value={PURPOSE_LABELS[log.purpose]} />
        <Row label="Transport" value={TRANSPORT_LABELS[log.transport]} />
        <Row label="Sent at" value={formatTimestamp(log.createdAt)} />
        <Row label="Message id" value={log.messageId || "—"} mono />
        <Row
          label="Provider id"
          value={log.providerId || "(inline / fallback)"}
          mono
        />
      </dl>
      {log.errorMessage && (
        <div className="mt-3 rounded-md bg-rose-50 p-3 text-xs text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
          <div className="font-semibold">Upstream error</div>
          <div className="mt-0.5 whitespace-pre-wrap break-words font-mono">
            {log.errorMessage}
          </div>
        </div>
      )}
      {log.bodyPreview && (
        <div className="mt-3">
          <div className="mb-1 text-xs font-semibold text-slate-700 dark:text-slate-200">
            Body preview
          </div>
          <pre className="max-h-72 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-100">
            {log.bodyPreview}
          </pre>
        </div>
      )}
      <div className="mt-3 flex justify-end">
        <Button type="button" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </Modal>
  );
}

function Row({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <>
      <dt className="col-span-1 text-slate-500 dark:text-slate-400">{label}</dt>
      <dd
        className={
          "col-span-2 break-all text-slate-900 dark:text-slate-100 " +
          (mono ? "font-mono" : "")
        }
      >
        {value}
      </dd>
    </>
  );
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}
