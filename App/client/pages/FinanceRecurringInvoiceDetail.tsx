import React from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Ban,
  ChevronDown,
  ChevronUp,
  Copy,
  FileText,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  PlayCircle,
  Repeat,
  Trash2,
} from "lucide-react";
import {
  api,
  displayInvoiceStatus,
  financeSubsidiaries,
  Subsidiary,
  formatMoney,
  Invoice,
  InvoiceListItem,
  RecurringInvoice,
  RecurringInvoiceBulkAction,
  RecurringInvoiceBulkResult,
  RecurringInvoiceRunSummary,
  RecurringInvoiceStatus,
} from "../lib/api";
import { errorMessage } from "../lib/errors";
import {
  formatScheduleTotal,
  hasScheduleTotal,
  summarizeScheduleInvoices,
  unlistedScheduleInvoices,
} from "../lib/recurringInvoiceHistory";
import { describeCron } from "../lib/schedule";
import { canWriteFinance } from "../lib/subpages";
import { Breadcrumbs } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Button } from "../components/ui/Button";
import { FormError } from "../components/ui/FormError";
import { Menu, MenuItem, MenuSeparator } from "../components/ui/Menu";
import { Spinner } from "../components/ui/Spinner";
import { useDialog } from "../components/ui/Dialog";
import { RecordHistory } from "@/components/RecordHistory";
import { ArchivedBadge, ArchivedBanner } from "@/components/finance/ArchiveControls";
import { InvoiceStatusBadge } from "@/components/finance/InvoiceStatusBadge";
import { recurringInvoiceArchiveBlocker } from "../../shared/invoiceArchive";
import { FinanceOutletCtx } from "./FinanceLayout";

const STATUS_BADGE: Record<RecurringInvoiceStatus, string> = {
  active: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  paused: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  ended: "bg-slate-100 text-slate-600 dark:bg-slate-700/40 dark:text-slate-300",
};

function formatStamp(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

/**
 * Recurring-invoice detail. Shows the schedule, what it has billed so far and
 * every invoice it has created, the template line items, and, to Members who
 * may change finances, the lifecycle controls
 * (pause / resume / end / run-now / delete), plus Archive / Restore, which
 * files a paused or ended schedule in or out of the lists. Resuming an
 * archived schedule restores it, so nothing bills from out of sight.
 */
export default function FinanceRecurringInvoiceDetail() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const canWrite = canWriteFinance(company);
  const { recurringSlug } = useParams();
  const navigate = useNavigate();
  const dialog = useDialog();
  const [ri, setRi] = React.useState<RecurringInvoice | null>(null);
  const [subsidiaries, setSubsidiaries] = React.useState<Subsidiary[]>([]);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<
    null | "status" | "run" | "retry" | "duplicate" | "delete" | RecurringInvoiceBulkAction
  >(null);

  const reload = React.useCallback(async () => {
    if (!recurringSlug) return;
    try {
      const [fresh, issuers] = await Promise.all([
        api.get<RecurringInvoice>(
          `/api/companies/${company.id}/recurring-invoices/${recurringSlug}`,
        ),
        financeSubsidiaries.list(company.id),
      ]);
      setRi(fresh);
      setSubsidiaries(issuers);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the recurring invoice"));
    }
  }, [company.id, recurringSlug]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  useLiveRefetch("recurringinvoice", reload);

  // Every invoice this schedule created, archived and void ones too: this is
  // its history, not a worklist. Newest first, as the server lists them.
  const [invoices, setInvoices] = React.useState<InvoiceListItem[] | null>(null);
  const [invoicesError, setInvoicesError] = React.useState<string | null>(null);
  const scheduleId = ri?.id ?? null;
  const reloadInvoices = React.useCallback(async () => {
    if (!scheduleId) return;
    try {
      const list = await api.get<InvoiceListItem[]>(
        `/api/companies/${company.id}/invoices?recurringInvoiceId=${scheduleId}&archived=true`,
      );
      setInvoices(list);
      setInvoicesError(null);
    } catch (err) {
      setInvoicesError(errorMessage(err, "Could not load the invoices this schedule created"));
    }
  }, [company.id, scheduleId]);

  React.useEffect(() => {
    void reloadInvoices();
  }, [reloadInvoices]);

  // A payment, an issue, or a void elsewhere moves a row; so does a new run.
  useLiveRefetch(["invoice", "recurringinvoice"], reloadInvoices);

  async function patchStatus(next: RecurringInvoiceStatus) {
    if (!ri) return;
    setBusy("status");
    try {
      const updated = await api.patch<RecurringInvoice>(
        `/api/companies/${company.id}/recurring-invoices/${ri.slug}`,
        { status: next },
      );
      setRi(updated);
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t update the schedule" });
    } finally {
      setBusy(null);
    }
  }

  async function runNow(from: "run" | "retry") {
    if (!ri) return;
    setBusy(from);
    try {
      const result = await api.post<{
        recurringInvoice: RecurringInvoice;
        invoice: Invoice;
        emailStatus: "sent" | "skipped" | "failed" | "not_attempted";
        emailError: string;
      }>(`/api/companies/${company.id}/recurring-invoices/${ri.slug}/run-now`);
      // The header, the schedule rows, and the invoice list all move when a
      // run lands — only the email half needs saying out loud.
      setRi(result.recurringInvoice);
      void reloadInvoices();
      if (result.emailStatus === "failed") {
        void dialog.error(result.emailError, {
          title: "Invoice generated, but the email failed",
        });
      }
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t run the schedule" });
      void reload();
      void reloadInvoices();
    } finally {
      setBusy(null);
    }
  }

  async function duplicate() {
    if (!ri) return;
    setBusy("duplicate");
    try {
      const copy = await api.post<RecurringInvoice>(
        `/api/companies/${company.id}/recurring-invoices/${ri.slug}/duplicate`,
      );
      navigate(`/c/${company.slug}/finance/recurring-invoices/${copy.slug}`);
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t duplicate the schedule" });
      setBusy(null);
    }
  }

  // Archiving is undone by restoring, so neither direction asks to confirm.
  async function setArchived(action: RecurringInvoiceBulkAction) {
    if (!ri) return;
    const title =
      action === "archive" ? "Couldn’t archive the schedule" : "Couldn’t restore the schedule";
    setBusy(action);
    try {
      const result = await api.post<RecurringInvoiceBulkResult>(
        `/api/companies/${company.id}/recurring-invoices/bulk`,
        { action, ids: [ri.id] },
      );
      const refused = result.skipped.find((skip) => skip.id === ri.id);
      if (refused) void dialog.error(`${refused.reason}.`, { title });
      await reload();
    } catch (err) {
      void dialog.error(err, { title });
    } finally {
      setBusy(null);
    }
  }

  async function endSchedule() {
    if (!ri) return;
    const ok = await dialog.confirm({
      title: `End "${ri.name}"?`,
      message:
        "This stops all future runs and can't be undone. Invoices it already created stay in your records, and you can still duplicate it later.",
      variant: "danger",
      confirmLabel: "End schedule",
    });
    if (!ok) return;
    patchStatus("ended");
  }

  async function destroy() {
    if (!ri) return;
    const ok = await dialog.confirm({
      title: `Delete "${ri.name}"?`,
      message:
        "This removes the recurring schedule. Invoices it has already created stay in your records as ordinary invoices, no longer linked to it.",
      variant: "danger",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    setBusy("delete");
    try {
      await api.del(`/api/companies/${company.id}/recurring-invoices/${ri.slug}`);
      navigate(`/c/${company.slug}/finance/recurring-invoices`);
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t delete the schedule" });
      setBusy(null);
    }
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-3xl p-8">
        <Breadcrumbs
          items={[
            { label: "Finance", to: `/c/${company.slug}/finance` },
            {
              label: "Recurring invoices",
              to: `/c/${company.slug}/finance/recurring-invoices`,
            },
            { label: "Error" },
          ]}
        />
        <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          {loadError}
        </div>
      </div>
    );
  }

  if (!ri) {
    return (
      <div className="flex justify-center p-16">
        <Spinner size={20} />
      </div>
    );
  }

  const customerUrl = ri.customer ? `/c/${company.slug}/customers/${ri.customer.slug}` : null;
  const isArchived = !!ri.archivedAt;
  const archivedOn = ri.archivedAt ? new Date(ri.archivedAt).toISOString().slice(0, 10) : null;
  // Restore is always on offer; Archive only once the schedule bills nobody.
  const canArchive = isArchived || !recurringInvoiceArchiveBlocker(ri);
  const retrying = ri.status === "active" && ri.latestRun?.status === "pending";

  return (
    <div className="page-shell p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[
            { label: "Finance", to: `/c/${company.slug}/finance` },
            {
              label: "Recurring invoices",
              to: `/c/${company.slug}/finance/recurring-invoices`,
            },
            { label: ri.name },
          ]}
        />
      </div>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Link
            to={`/c/${company.slug}/finance/recurring-invoices`}
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <ArrowLeft size={18} />
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
                {ri.name}
              </h1>
              <span
                className={
                  "inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider " +
                  STATUS_BADGE[ri.status]
                }
              >
                {ri.status}
              </span>
              {isArchived && <ArchivedBadge />}
            </div>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              <Repeat size={12} className="mr-1 inline" />
              {describeCron(ri.cronExpr, ri.intervalCount)}
              {" — billing "}
              {customerUrl ? (
                <Link
                  to={customerUrl}
                  className="font-medium text-slate-700 hover:text-indigo-600 hover:underline dark:text-slate-300 dark:hover:text-indigo-400"
                >
                  {ri.customer?.name}
                </Link>
              ) : (
                <span className="font-medium text-slate-700 dark:text-slate-300">—</span>
              )}
            </p>
          </div>
        </div>
        {canWrite && (
          <div className="flex flex-wrap items-center gap-2">
            {ri.status !== "ended" && (
              <Button
                onClick={() => void runNow("run")}
                loading={busy === "run"}
                disabled={busy !== null}
              >
                <PlayCircle size={14} /> {retrying ? "Retry now" : "Run now"}
              </Button>
            )}
            <Link to={`/c/${company.slug}/finance/recurring-invoices/${ri.slug}/edit`}>
              <Button variant="secondary" disabled={busy !== null}>
                <Pencil size={14} /> Edit
              </Button>
            </Link>
            <Menu
              align="right"
              width={208}
              trigger={({ ref, onClick }) => (
                <Button
                  ref={ref}
                  variant="secondary"
                  onClick={onClick}
                  disabled={busy !== null}
                  aria-label="More actions"
                >
                  <MoreHorizontal size={14} />
                </Button>
              )}
            >
              {(close) => (
                <>
                  {ri.status === "active" && (
                    <MenuItem
                      icon={<Pause size={14} />}
                      label="Pause schedule"
                      onSelect={() => {
                        close();
                        patchStatus("paused");
                      }}
                    />
                  )}
                  {ri.status === "paused" && (
                    <MenuItem
                      icon={<Play size={14} />}
                      label="Resume schedule"
                      onSelect={() => {
                        close();
                        patchStatus("active");
                      }}
                    />
                  )}
                  <MenuItem
                    icon={<Copy size={14} />}
                    label="Duplicate"
                    onSelect={() => {
                      close();
                      duplicate();
                    }}
                  />
                  {canArchive && (
                    <MenuItem
                      icon={isArchived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                      label={isArchived ? "Restore" : "Archive"}
                      onSelect={() => {
                        close();
                        void setArchived(isArchived ? "restore" : "archive");
                      }}
                    />
                  )}
                  {ri.status !== "ended" && (
                    <MenuItem
                      icon={<Ban size={14} />}
                      label="End schedule"
                      onSelect={() => {
                        close();
                        endSchedule();
                      }}
                    />
                  )}
                  <MenuSeparator />
                  <MenuItem
                    icon={<Trash2 size={14} className="text-red-500" />}
                    label={<span className="text-red-600 dark:text-red-400">Delete</span>}
                    onSelect={() => {
                      close();
                      destroy();
                    }}
                  />
                </>
              )}
            </Menu>
          </div>
        )}
      </div>

      {archivedOn && (
        <ArchivedBanner
          onRestore={canWrite ? () => void setArchived("restore") : undefined}
          restoring={busy === "restore"}
          disabled={busy !== null}
        >
          Archived on {archivedOn}. It is listed under Recurring invoices → Archived instead of the
          status tabs and the customer&apos;s page; its cadence, lines, and run history are
          unchanged.{ri.status === "paused" && " Resuming it brings it back to the lists."}
        </ArchivedBanner>
      )}

      {subsidiaries.find((item) => item.id === ri.subsidiaryId)?.archived && (
        <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          This schedule uses an archived subsidiary and cannot create new invoices. Edit the
          schedule to choose an active issuer, or reactivate the subsidiary.
        </div>
      )}

      {ri.latestRun && (
        <RunAttention
          run={ri.latestRun}
          active={ri.status === "active"}
          invoiceUrl={
            ri.latestRun.invoiceSlug
              ? `/c/${company.slug}/finance/invoices/${ri.latestRun.invoiceSlug}`
              : null
          }
          busy={busy !== null}
          retryLoading={busy === "retry"}
          onRetry={canWrite ? () => void runNow("retry") : null}
        />
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Schedule
          </h3>
          <dl className="space-y-2 text-sm">
            <Row label="Repeats" value={describeCron(ri.cronExpr, ri.intervalCount)} />
            <Row
              label="Next run"
              value={ri.status === "active" ? formatStamp(ri.nextRunAt) : "—"}
            />
            <Row label="Last run" value={formatStamp(ri.lastRunAt)} />
            <Row
              label="Runs created"
              value={ri.maxRuns ? `${ri.runsCreated} / ${ri.maxRuns}` : String(ri.runsCreated)}
            />
            {ri.endsOn && (
              <Row label="Ends on" value={new Date(ri.endsOn).toISOString().slice(0, 10)} />
            )}
          </dl>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Billing
          </h3>
          <dl className="space-y-2 text-sm">
            <Row
              label="Issued by"
              value={
                ri.subsidiaryId
                  ? (subsidiaries.find((item) => item.id === ri.subsidiaryId)?.name ??
                    "Subsidiary unavailable")
                  : company.name
              }
            />
            <Row
              label="Customer"
              value={
                customerUrl ? (
                  <Link
                    to={customerUrl}
                    className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                  >
                    {ri.customer?.name}
                  </Link>
                ) : (
                  "—"
                )
              }
            />
            <Row label="Email" value={ri.customer?.email || "—"} />
            <Row label="Currency" value={ri.currency} />
            <Row label="Days until due" value={`${ri.daysUntilDue} days`} />
            <Row
              label="Auto-send"
              value={ri.autoSend ? "Issue + email each tick" : "Create draft only"}
            />
            {(ri.discountPercent > 0 || ri.discountAmountCents > 0) && (
              <Row
                label="Discount"
                value={`${
                  ri.discountPercent > 0 ? `${Number(ri.discountPercent.toFixed(2))}% · ` : ""
                }-${formatMoney(ri.discountCents, ri.currency)}`}
              />
            )}
            <Row label="Total per invoice" value={formatMoney(ri.totalCents, ri.currency)} />
          </dl>
        </div>

        <InvoicesSoFar
          ri={ri}
          invoices={invoices}
          failed={invoicesError !== null}
          companySlug={company.slug}
        />
      </div>

      <ScheduleInvoices
        ri={ri}
        invoices={invoices}
        error={invoicesError}
        companySlug={company.slug}
        onRunNow={canWrite && ri.status !== "ended" ? () => void runNow("run") : null}
        running={busy === "run"}
        busy={busy !== null}
      />

      <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <div className="border-b border-slate-100 px-5 py-3 dark:border-slate-800">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
            Line items template
          </h3>
        </div>
        {ri.lines.length === 0 ? (
          <p className="p-6 text-sm text-slate-500 dark:text-slate-400">
            No line items yet — edit this schedule to add some.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50/80 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-400">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Description</th>
                <th className="w-24 px-4 py-2 text-right font-medium">Qty</th>
                <th className="w-32 px-4 py-2 text-right font-medium">Unit price</th>
                <th className="w-32 px-4 py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {ri.lines.map((l) => (
                <tr key={l.id}>
                  <td className="px-4 py-3 text-slate-700 dark:text-slate-200">{l.description}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{l.quantity}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatMoney(l.unitPriceCents, ri.currency)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium">
                    {formatMoney(Math.round(l.quantity * l.unitPriceCents), ri.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {(ri.notes || ri.footer) && (
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {ri.notes && (
            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Notes
              </h3>
              <p className="whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-200">
                {ri.notes}
              </p>
            </div>
          )}
          {ri.footer && (
            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Footer
              </h3>
              <p className="whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-200">
                {ri.footer}
              </p>
            </div>
          )}
        </div>
      )}

      <RecordHistory
        className="mt-6"
        companyId={company.id}
        companySlug={company.slug}
        targetType="recurring_invoice"
        targetId={ri.id}
        noun="this recurring invoice"
        currency={ri.currency}
        milestones={[
          { label: "Recurring invoice created", at: ri.createdAt, covers: ["create"] },
          { label: "Recurring invoice archived", at: ri.archivedAt, covers: ["archive"] },
        ]}
      />
    </div>
  );
}

/** How many of a schedule's invoices its list shows before "Show all". */
const INVOICES_SHOWN = 10;

function isoDay(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/**
 * The third card: what the schedule has billed so far, from the invoices it
 * created. Drafts are counted but not billed; void invoices bill nothing.
 */
function InvoicesSoFar({
  ri,
  invoices,
  failed,
  companySlug,
}: {
  ri: RecurringInvoice;
  invoices: InvoiceListItem[] | null;
  failed: boolean;
  companySlug: string;
}) {
  const summary = React.useMemo(
    () => (invoices ? summarizeScheduleInvoices(invoices, ri.currency) : null),
    [invoices, ri.currency],
  );
  const latest = invoices?.[0] ?? null;
  const owed = summary ? hasScheduleTotal(summary.totals, "outstandingCents") : false;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
        Invoices so far
      </h3>
      {summary === null ? (
        failed ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">Couldn&apos;t load them.</p>
        ) : (
          <div className="flex justify-center py-6">
            <Spinner size={16} />
          </div>
        )
      ) : (
        <dl className="space-y-2 text-sm">
          <Row
            label="Created"
            value={
              <span className="tabular-nums">
                {summary.count}
                {summary.drafts > 0 && (
                  <span className="text-slate-400 dark:text-slate-500">
                    {" · "}
                    {summary.drafts} {summary.drafts === 1 ? "draft" : "drafts"}
                  </span>
                )}
              </span>
            }
          />
          <Row
            label="Invoiced"
            value={
              <span className="tabular-nums">
                {formatScheduleTotal(summary.totals, "invoicedCents", ri.currency)}
              </span>
            }
          />
          <Row
            label="Paid"
            value={
              <span className="tabular-nums">
                {formatScheduleTotal(summary.totals, "paidCents", ri.currency)}
              </span>
            }
          />
          <Row
            label="Outstanding"
            value={
              <span
                className={"tabular-nums" + (owed ? " text-amber-700 dark:text-amber-400" : "")}
              >
                {formatScheduleTotal(summary.totals, "outstandingCents", ri.currency)}
                {summary.overdue > 0 && (
                  <span className="text-red-600 dark:text-red-400">
                    {" · "}
                    {summary.overdue} overdue
                  </span>
                )}
              </span>
            }
          />
          {latest && (
            <Row
              label="Latest"
              value={
                <Link
                  to={`/c/${companySlug}/finance/invoices/${latest.slug}`}
                  className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  {latest.number || "Draft"} · {isoDay(latest.issueDate)}
                </Link>
              }
            />
          )}
        </dl>
      )}
    </div>
  );
}

/**
 * Every invoice the schedule has created, newest first: drafts, issued,
 * paid, void, and archived alike, each opening its invoice. The run count can
 * include invoices the list cannot show — drafts deleted since, and ones made
 * before invoices were linked to their schedule — and a note says so.
 */
function ScheduleInvoices({
  ri,
  invoices,
  error,
  companySlug,
  onRunNow,
  running,
  busy,
}: {
  ri: RecurringInvoice;
  invoices: InvoiceListItem[] | null;
  error: string | null;
  companySlug: string;
  /** Omitted for a read-only Member, and once the schedule has ended. */
  onRunNow: (() => void) | null;
  running: boolean;
  busy: boolean;
}) {
  const navigate = useNavigate();
  const [showAll, setShowAll] = React.useState(false);
  const shown = invoices ? (showAll ? invoices : invoices.slice(0, INVOICES_SHOWN)) : [];
  const unlisted = invoices ? unlistedScheduleInvoices(ri.runsCreated, invoices.length) : 0;
  const billingTab = ri.customer ? `/c/${companySlug}/customers/${ri.customer.slug}?tab=billing` : null;

  return (
    <section className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3 dark:border-slate-800">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          Invoices
          {invoices && invoices.length > 0 && (
            <span className="ml-2 text-xs font-normal tabular-nums text-slate-400 dark:text-slate-500">
              {invoices.length}
            </span>
          )}
        </h3>
        <span className="hidden text-xs text-slate-400 sm:inline dark:text-slate-500">
          Created by this schedule, newest first
        </span>
      </div>

      {error ? (
        <div className="p-5">
          <FormError message={error} />
        </div>
      ) : invoices === null ? (
        <div className="flex justify-center p-10">
          <Spinner size={18} />
        </div>
      ) : invoices.length === 0 ? (
        <div className="px-6 py-10 text-center">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500">
            <FileText size={18} />
          </div>
          <h4 className="mt-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
            {ri.runsCreated > 0
              ? "No invoices to list"
              : ri.status === "ended"
                ? "No invoices"
                : "No invoices yet"}
          </h4>
          <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500 dark:text-slate-400">
            {ri.status === "ended"
              ? ri.runsCreated > 0
                ? "This schedule has ended."
                : "This schedule ended without creating an invoice."
              : ri.status === "paused"
                ? "Each invoice it creates will be listed here. Resume the schedule to start billing."
                : ri.nextRunAt
                  ? `Each invoice it creates will be listed here. The next run is ${formatStamp(ri.nextRunAt)}.`
                  : "Each invoice it creates will be listed here."}
          </p>
          {onRunNow && (
            <div className="mt-4">
              <Button
                variant="secondary"
                size="sm"
                onClick={onRunNow}
                loading={running}
                disabled={busy}
              >
                <PlayCircle size={14} /> Run now
              </Button>
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Below lg — phones, and tablets beside the section rail — the six
              columns don't fit, so each invoice is one stacked row rather than
              a table that hides its totals off to the side. */}
          <ul className="divide-y divide-slate-100 lg:hidden dark:divide-slate-800">
            {shown.map((inv) => {
              const isVoid = inv.status === "void";
              const owed = inv.status === "sent" && inv.balanceCents > 0;
              return (
                <li key={inv.id}>
                  <Link
                    to={`/c/${companySlug}/finance/invoices/${inv.slug}`}
                    className="block px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/40"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span
                        className={
                          "truncate font-mono text-xs font-semibold " +
                          (isVoid
                            ? "text-slate-400 dark:text-slate-500"
                            : "text-indigo-600 dark:text-indigo-400")
                        }
                      >
                        {inv.number || "DRAFT"}
                      </span>
                      <span
                        className={
                          "whitespace-nowrap text-sm tabular-nums " +
                          (isVoid
                            ? "text-slate-400 line-through dark:text-slate-500"
                            : "text-slate-900 dark:text-slate-100")
                        }
                      >
                        {formatMoney(inv.totalCents, inv.currency)}
                      </span>
                    </div>
                    <div className="mt-1.5 flex items-center justify-between gap-3">
                      <span className="inline-flex items-center gap-1.5">
                        <InvoiceStatusBadge status={displayInvoiceStatus(inv)} />
                        {inv.archivedAt && <ArchivedBadge />}
                      </span>
                      <span className="whitespace-nowrap text-xs tabular-nums text-slate-500 dark:text-slate-400">
                        {isoDay(inv.issueDate)}
                        {owed && (
                          <span className="text-amber-700 dark:text-amber-400">
                            {" · "}
                            {formatMoney(inv.balanceCents, inv.currency)} due
                          </span>
                        )}
                      </span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
          <div className="hidden overflow-x-auto lg:block">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50/80 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Number</th>
                  <th className="px-4 py-2 text-left font-medium">Status</th>
                  <th className="px-4 py-2 text-left font-medium">Issued</th>
                  <th className="px-4 py-2 text-left font-medium">Due</th>
                  <th className="px-4 py-2 text-right font-medium">Total</th>
                  <th className="px-4 py-2 text-right font-medium">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {shown.map((inv) => {
                  const to = `/c/${companySlug}/finance/invoices/${inv.slug}`;
                  const isVoid = inv.status === "void";
                  // Only an issued invoice is owed anything.
                  const billed = inv.status === "sent" || inv.status === "paid";
                  return (
                    <tr
                      key={inv.id}
                      onClick={() => navigate(to)}
                      className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40"
                    >
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-xs">
                        <Link
                          to={to}
                          onClick={(event) => event.stopPropagation()}
                          className={
                            "font-semibold hover:underline " +
                            (isVoid
                              ? "text-slate-400 dark:text-slate-500"
                              : "text-indigo-600 dark:text-indigo-400")
                          }
                        >
                          {inv.number || "DRAFT"}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1.5">
                          <InvoiceStatusBadge status={displayInvoiceStatus(inv)} />
                          {inv.archivedAt && <ArchivedBadge />}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-600 dark:text-slate-300">
                        {isoDay(inv.issueDate)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-600 dark:text-slate-300">
                        {isoDay(inv.dueDate)}
                      </td>
                      <td
                        className={
                          "whitespace-nowrap px-4 py-3 text-right tabular-nums " +
                          (isVoid
                            ? "text-slate-400 line-through dark:text-slate-500"
                            : "text-slate-900 dark:text-slate-100")
                        }
                      >
                        {formatMoney(inv.totalCents, inv.currency)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                        {billed ? (
                          <span
                            className={
                              inv.balanceCents > 0
                                ? "text-amber-700 dark:text-amber-400"
                                : "text-slate-400 dark:text-slate-500"
                            }
                          >
                            {formatMoney(inv.balanceCents, inv.currency)}
                          </span>
                        ) : (
                          <span className="text-slate-300 dark:text-slate-600">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {invoices.length > INVOICES_SHOWN && (
            <div className="border-t border-slate-100 px-5 py-2.5 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setShowAll((value) => !value)}
                className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
              >
                {showAll ? (
                  <>
                    Show the latest {INVOICES_SHOWN} <ChevronUp size={12} />
                  </>
                ) : (
                  <>
                    Show all {invoices.length} invoices <ChevronDown size={12} />
                  </>
                )}
              </button>
            </div>
          )}
        </>
      )}

      {invoices && unlisted > 0 && (
        <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
          {unlisted === 1
            ? "1 more invoice this schedule created isn’t listed: a draft that was deleted, or one made before invoices were linked to their schedule."
            : `${unlisted} more invoices this schedule created aren’t listed: drafts that were deleted, or ones made before invoices were linked to their schedule.`}
          {billingTab && (
            <>
              {" "}
              <Link
                to={billingTab}
                className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
              >
                See all of {ri.customer?.name}&apos;s invoices
              </Link>
            </>
          )}
        </p>
      )}
    </section>
  );
}

/**
 * Surfaces a scheduled run that needs a person's eye: one still retrying
 * after a failed attempt, or one that issued its invoice but could not
 * email it. A run that is simply in progress, or that finished cleanly,
 * shows nothing. Without `onRetry` — a read-only Member — it only reports.
 */
function RunAttention({
  run,
  active,
  invoiceUrl,
  busy,
  retryLoading,
  onRetry,
}: {
  run: RecurringInvoiceRunSummary;
  active: boolean;
  invoiceUrl: string | null;
  busy: boolean;
  retryLoading: boolean;
  onRetry: (() => void) | null;
}) {
  const retrying = active && run.status === "pending" && run.lastError !== "";
  if (!retrying && run.status !== "failed") return null;
  return (
    <div className="mb-6 flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 sm:flex-row sm:items-start sm:justify-between dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
      <div className="flex gap-2">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <div>
          <p className="font-medium">
            {retrying
              ? `The run scheduled for ${formatStamp(run.scheduledFor)} hasn’t finished yet`
              : `The run scheduled for ${formatStamp(run.scheduledFor)} needs attention`}
          </p>
          <p className="mt-0.5">{run.lastError}</p>
          {retrying && (
            <p className="mt-0.5 text-xs opacity-80">
              Genosyn retries automatically
              {run.retryAt ? ` — next attempt ${formatStamp(run.retryAt)}` : ""}. Retrying finishes
              this run; it never bills the customer a second time.
            </p>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {invoiceUrl && (
          <Link to={invoiceUrl}>
            <Button variant="secondary" size="sm">
              Open invoice
            </Button>
          </Link>
        )}
        {retrying && onRetry && (
          <Button size="sm" onClick={onRetry} loading={retryLoading} disabled={busy}>
            Retry now
          </Button>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {label}
      </dt>
      <dd className="text-right text-sm text-slate-800 dark:text-slate-100">{value}</dd>
    </div>
  );
}
