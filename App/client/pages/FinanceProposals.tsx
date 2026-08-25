import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import { AlertTriangle, Check, ChevronDown, ChevronRight, X } from "lucide-react";
import {
  Account,
  api,
  CompanyFinanceSettings,
  FinanceProposal,
  FinanceProposalStatus,
  formatMoney,
  JournalProposalPayload,
} from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { useDialog } from "../components/ui/Dialog";
import { FinanceOutletCtx } from "./FinanceLayout";

const STATUS_BADGE: Record<FinanceProposalStatus, { label: string; className: string }> = {
  pending: {
    label: "Pending",
    className:
      "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  },
  applied: {
    label: "Applied",
    className:
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  },
  rejected: {
    label: "Rejected",
    className: "bg-slate-100 text-slate-600 dark:bg-slate-700/50 dark:text-slate-300",
  },
  superseded: {
    label: "Superseded",
    className: "bg-slate-100 text-slate-600 dark:bg-slate-700/50 dark:text-slate-300",
  },
};

export default function FinanceProposals() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const [proposals, setProposals] = React.useState<FinanceProposal[] | null>(null);
  const [accounts, setAccounts] = React.useState<Account[]>([]);
  const [homeCurrency, setHomeCurrency] = React.useState("USD");
  const [filter, setFilter] = React.useState<"pending" | "all">("pending");
  const [loadError, setLoadError] = React.useState(false);

  const reload = React.useCallback(async () => {
    const [ps, as, settings] = await Promise.all([
      api.get<FinanceProposal[]>(`/api/companies/${company.id}/finance-proposals`),
      api.get<Account[]>(`/api/companies/${company.id}/accounts`),
      api.get<CompanyFinanceSettings>(`/api/companies/${company.id}/finance-settings`),
    ]);
    setProposals(ps);
    setAccounts(as);
    setHomeCurrency(settings.homeCurrency);
    setLoadError(false);
  }, [company.id]);

  React.useEffect(() => {
    reload().catch(() => {
      setProposals([]);
      setLoadError(true);
    });
  }, [reload]);

  const accountsById = React.useMemo(
    () => new Map(accounts.map((a) => [a.id, a])),
    [accounts],
  );

  const shown = React.useMemo(() => {
    if (!proposals) return [];
    return filter === "pending" ? proposals.filter((p) => p.status === "pending") : proposals;
  }, [proposals, filter]);

  const pendingCount = proposals?.filter((p) => p.status === "pending").length ?? 0;

  return (
    <div className="space-y-5">
      <Breadcrumbs items={[{ label: "Finance", to: `/c/${company.slug}/finance` }, { label: "Proposals" }]} />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Proposals</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
            Staged journal entries awaiting review. One member proposes an entry from the Journal
            page; another applies it here. Nothing touches the ledger until it&apos;s applied.
          </p>
        </div>
        <div className="inline-flex overflow-hidden rounded-md border border-slate-200 text-sm dark:border-slate-700">
          <button
            onClick={() => setFilter("pending")}
            className={
              "px-3 py-1.5 " +
              (filter === "pending"
                ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                : "bg-white text-slate-600 dark:bg-slate-900 dark:text-slate-300")
            }
          >
            Pending{pendingCount > 0 ? ` (${pendingCount})` : ""}
          </button>
          <button
            onClick={() => setFilter("all")}
            className={
              "px-3 py-1.5 " +
              (filter === "all"
                ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                : "bg-white text-slate-600 dark:bg-slate-900 dark:text-slate-300")
            }
          >
            All
          </button>
        </div>
      </div>

      {proposals === null ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : loadError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          Couldn&apos;t load proposals. Refresh to try again.
        </div>
      ) : shown.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-200 py-16 text-center dark:border-slate-700">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {filter === "pending" ? "Nothing awaiting review." : "No proposals yet."}
          </p>
          <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
            Open the Journal page and use <span className="font-medium">Propose for review</span> to
            stage an entry.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {shown.map((p) => (
            <ProposalCard
              key={p.id}
              proposal={p}
              companyId={company.id}
              companySlug={company.slug}
              accountsById={accountsById}
              homeCurrency={homeCurrency}
              onChanged={reload}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ProposalCard({
  proposal,
  companyId,
  companySlug,
  accountsById,
  homeCurrency,
  onChanged,
}: {
  proposal: FinanceProposal;
  companyId: string;
  companySlug: string;
  accountsById: Map<string, Account>;
  homeCurrency: string;
  onChanged: () => Promise<void> | void;
}) {
  const dialog = useDialog();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const payload = React.useMemo<JournalProposalPayload | null>(() => {
    try {
      return JSON.parse(proposal.payloadJson) as JournalProposalPayload;
    } catch {
      return null;
    }
  }, [proposal.payloadJson]);

  const badge = STATUS_BADGE[proposal.status];
  const isPending = proposal.status === "pending";

  async function apply() {
    if (
      !(await dialog.confirm({
        title: "Apply this proposal?",
        message: "It posts the balanced entry to the ledger. This can't be undone from here.",
        confirmLabel: "Apply",
      }))
    ) {
      return;
    }
    setBusy(true);
    try {
      await api.post(`/api/companies/${companyId}/finance-proposals/${proposal.id}/apply`, {});
      await onChanged();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t apply the proposal" });
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    const note = await dialog.prompt({
      title: "Reject this proposal?",
      message: "Add an optional note for the proposer.",
      confirmLabel: "Reject",
    });
    if (note === null) return;
    setBusy(true);
    try {
      await api.post(`/api/companies/${companyId}/finance-proposals/${proposal.id}/reject`, {
        note: note || undefined,
      });
      await onChanged();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t reject the proposal" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-start gap-3 p-3">
        <button
          onClick={() => setOpen((o) => !o)}
          className="mt-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
          aria-label={open ? "Collapse" : "Expand"}
        >
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium text-slate-900 dark:text-slate-100">
              {proposal.title}
            </span>
            <span
              className={
                "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider " +
                badge.className
              }
            >
              {badge.label}
            </span>
            {proposal.proposedByType === "ai" && (
              <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-violet-700 dark:bg-violet-500/15 dark:text-violet-300">
                AI
              </span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {proposal.summary}
            {" · "}
            {proposal.proposedByLabel ?? "Unknown"}
            {" · "}
            {proposal.createdAt.slice(0, 10)}
          </div>
          {proposal.errorMessage && (
            <div className="mt-1.5 flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400">
              <AlertTriangle size={13} className="mt-px shrink-0" />
              <span>Last apply failed: {proposal.errorMessage}</span>
            </div>
          )}
        </div>
        {isPending && (
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="secondary" onClick={reject} disabled={busy}>
              <X size={14} className="mr-1" /> Reject
            </Button>
            <Button size="sm" onClick={apply} disabled={busy}>
              <Check size={14} className="mr-1" /> Apply
            </Button>
          </div>
        )}
        {proposal.status === "applied" && proposal.appliedEntryId && (
          <Link
            to={`/c/${companySlug}/finance/journal`}
            className="shrink-0 self-center text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            View entry
          </Link>
        )}
      </div>

      {open && (
        <div className="border-t border-slate-100 px-3 py-3 dark:border-slate-800">
          {payload === null ? (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Couldn&apos;t read this proposal&apos;s lines.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wider text-slate-400 dark:text-slate-500">
                <tr>
                  <th className="py-1 text-left font-medium">Account</th>
                  <th className="py-1 text-right font-medium">Debit</th>
                  <th className="py-1 text-right font-medium">Credit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {payload.lines.map((l, i) => {
                  const acct = accountsById.get(l.accountId);
                  return (
                    <tr key={i}>
                      <td className="py-1.5 pr-2">
                        <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
                          {acct?.code ?? "????"}
                        </span>{" "}
                        <span className="text-slate-800 dark:text-slate-200">
                          {acct?.name ?? "Unknown account"}
                        </span>
                        {l.description && (
                          <span className="text-slate-400 dark:text-slate-500"> — {l.description}</span>
                        )}
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-slate-800 dark:text-slate-200">
                        {l.debitCents > 0 ? formatMoney(l.debitCents, homeCurrency) : ""}
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-slate-800 dark:text-slate-200">
                        {l.creditCents > 0 ? formatMoney(l.creditCents, homeCurrency) : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {proposal.reviewNote && (
            <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
              <span className="font-medium text-slate-600 dark:text-slate-300">Review note:</span>{" "}
              {proposal.reviewNote}
            </p>
          )}
        </div>
      )}
    </li>
  );
}
