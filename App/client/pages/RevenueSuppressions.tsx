import React from "react";
import { useOutletContext } from "react-router-dom";
import { ShieldOff, Trash2, UserMinus } from "lucide-react";
import { api } from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Button } from "../components/ui/Button";
import { useDialog } from "../components/ui/Dialog";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";
import { RevenueOutletCtx } from "./RevenueLayout";

/**
 * Revenue → Suppressions. The do-not-mail list, enforced at the single outbound
 * choke-point so it covers a human pressing Send, a bulk send, a sequence step
 * and an AI employee calling `send_mail` equally.
 *
 * The destructive direction here is *removing* a row, not adding one: taking an
 * address off this list is what makes it mailable again, and the cheapest way to
 * get a sending domain blocklisted is to mail somebody who already said no.
 */

type SuppressionReason = "unsubscribe" | "bounce" | "complaint" | "manual" | "imported";

const SUPPRESSION_REASONS: SuppressionReason[] = [
  "unsubscribe",
  "bounce",
  "complaint",
  "manual",
  "imported",
];

type Suppression = {
  id: string;
  companyId: string;
  email: string;
  reason: SuppressionReason;
  source: string;
  contactId: string | null;
  notes: string;
  createdById: string | null;
  createdAt: string;
};

const REASON_LABEL: Record<SuppressionReason, string> = {
  unsubscribe: "Unsubscribed",
  bounce: "Bounced",
  complaint: "Complaint",
  manual: "Manual",
  imported: "Imported",
};

const REASON_HINT: Record<SuppressionReason, string> = {
  unsubscribe: "They asked to stop hearing from us.",
  bounce: "The address is dead — mailing it again costs sender reputation.",
  complaint: "Marked as spam. The most expensive signal there is.",
  manual: "Somebody added it deliberately.",
  imported: "Carried in from another system's opt-out list.",
};

const REASON_PILL: Record<SuppressionReason, string> = {
  unsubscribe: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
  bounce: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  complaint: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
  manual: "bg-slate-100 text-slate-700 dark:bg-slate-700/40 dark:text-slate-200",
  imported: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
};

const PILL =
  "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider";

const PAGE_SIZE = 50;

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

export default function RevenueSuppressions() {
  const { company } = useOutletContext<RevenueOutletCtx>();
  const { background, toast } = useToast();
  const dialog = useDialog();

  const [rows, setRows] = React.useState<Suppression[] | null>(null);
  const [total, setTotal] = React.useState(0);
  const [loadError, setLoadError] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [reasonFilter, setReasonFilter] = React.useState<SuppressionReason | "all">("all");
  const [offset, setOffset] = React.useState(0);

  const [newEmail, setNewEmail] = React.useState("");
  const [newReason, setNewReason] = React.useState<SuppressionReason>("manual");
  const [newNotes, setNewNotes] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  const [addError, setAddError] = React.useState<string | null>(null);

  const base = `/api/companies/${company.id}/revenue`;
  const sectionUrl = `/c/${company.slug}/revenue`;

  // Debounce the box so a search does not fire a request per keystroke.
  React.useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
      setOffset(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const reload = React.useCallback(async () => {
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });
    if (query) params.set("q", query);
    if (reasonFilter !== "all") params.set("reason", reasonFilter);
    const res = await api.get<{ rows: Suppression[]; total: number }>(
      `${base}/suppressions?${params.toString()}`,
    );
    setRows(res.rows);
    setTotal(res.total);
    setLoadError(false);
  }, [base, offset, query, reasonFilter]);

  React.useEffect(() => {
    reload().catch(() => {
      setRows([]);
      setLoadError(true);
    });
  }, [reload]);

  useLiveRefetch("suppression", reload);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const email = newEmail.trim();
    if (!email) return;
    setAdding(true);
    setAddError(null);
    try {
      await api.post<Suppression>(`${base}/suppressions`, {
        email,
        reason: newReason,
        notes: newNotes.trim() || undefined,
      });
      setNewEmail("");
      setNewNotes("");
      await reload();
      toast(`${email} will never be mailed again`, "success");
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  }

  async function remove(row: Suppression) {
    const confirmed = await dialog.confirm({
      title: `Remove ${row.email} from the suppression list?`,
      message: (
        <>
          This address <strong>can be mailed again</strong> the moment you remove it — by a
          sequence, a bulk send, or an AI employee. It is on the list because it{" "}
          {REASON_HINT[row.reason].toLowerCase().replace(/\.$/, "")}. Removal is recorded against
          your name.
        </>
      ),
      variant: "danger",
      confirmLabel: "Remove and allow mail",
    });
    if (!confirmed) return;

    const originalIndex = rows?.findIndex((item) => item.id === row.id) ?? -1;
    setRows((current) => current?.filter((item) => item.id !== row.id) ?? current);
    setTotal((current) => Math.max(0, current - 1));
    background(() => api.del(`${base}/suppressions/${row.id}`), {
      loading: "Removing from the suppression list…",
      success: "Removed — this address can be mailed again",
      error: (error) =>
        `Couldn’t remove it: ${
          error instanceof Error ? error.message : String(error)
        }. The address is still suppressed.`,
      onSuccess: () => void reload(),
      onError: () => {
        setTotal((current) => current + 1);
        setRows((current) => {
          if (!current || current.some((item) => item.id === row.id)) return current;
          const next = [...current];
          next.splice(Math.max(0, Math.min(originalIndex, next.length)), 0, row);
          return next;
        });
      },
    });
  }

  const showingFrom = total === 0 ? 0 : offset + 1;
  const showingTo = Math.min(offset + PAGE_SIZE, total);

  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="mb-6">
        <Breadcrumbs items={[{ label: "Revenue", to: sectionUrl }, { label: "Suppressions" }]} />
      </div>

      <div className="mb-4">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Suppressions</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
          Addresses this company must not email. Checked on every outbound path — there is no way
          to send that bypasses this list.
        </p>
      </div>

      {/* Add */}
      <form
        onSubmit={add}
        className="mb-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <Input
              label="Suppress an address"
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="someone@example.com"
              maxLength={320}
            />
          </div>
          <div className="w-full sm:w-48">
            <Select
              label="Reason"
              value={newReason}
              onChange={(e) => setNewReason(e.target.value as SuppressionReason)}
            >
              {SUPPRESSION_REASONS.map((r) => (
                <option key={r} value={r}>
                  {REASON_LABEL[r]}
                </option>
              ))}
            </Select>
          </div>
          <div className="min-w-0 flex-1">
            <Input
              label="Notes"
              value={newNotes}
              onChange={(e) => setNewNotes(e.target.value)}
              placeholder="Optional"
              maxLength={2000}
            />
          </div>
          <Button type="submit" disabled={adding || !newEmail.trim()} className="shrink-0">
            {adding ? <Spinner size={14} /> : <UserMinus size={14} />}
            Suppress
          </Button>
        </div>
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          {REASON_HINT[newReason]} Suppressing an address that is already on the list leaves the
          original reason alone.
        </p>
        <FormError message={addError} className="mt-3" />
      </form>

      {/* Filters */}
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <Input
            placeholder="Search addresses…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search suppressed addresses"
          />
        </div>
        <div className="w-full sm:w-52">
          <Select
            value={reasonFilter}
            aria-label="Filter by reason"
            onChange={(e) => {
              setReasonFilter(e.target.value as SuppressionReason | "all");
              setOffset(0);
            }}
          >
            <option value="all">All reasons</option>
            {SUPPRESSION_REASONS.map((r) => (
              <option key={r} value={r}>
                {REASON_LABEL[r]}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {loadError ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Couldn&apos;t load the suppression list
          </h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Something went wrong fetching this list.
          </p>
          <Button
            variant="secondary"
            className="mt-4"
            onClick={() =>
              reload().catch(() => {
                setRows([]);
                setLoadError(true);
              })
            }
          >
            Try again
          </Button>
        </div>
      ) : rows === null ? (
        <div className="flex justify-center p-16">
          <Spinner size={20} />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <ShieldOff size={22} className="mx-auto text-slate-300 dark:text-slate-600" />
          <h3 className="mt-3 text-base font-semibold text-slate-900 dark:text-slate-100">
            {query || reasonFilter !== "all" ? "Nothing matches that" : "Nobody is suppressed"}
          </h3>
          <p className="mx-auto mt-1 max-w-md text-sm text-slate-500 dark:text-slate-400">
            {query || reasonFilter !== "all"
              ? "Try a different search or reason."
              : "Unsubscribes and hard bounces land here on their own. Add an address by hand above when somebody asks you directly."}
          </p>
        </div>
      ) : (
        <>
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Address</th>
                    <th className="px-4 py-2 text-left font-medium">Reason</th>
                    <th className="px-4 py-2 text-left font-medium">Source</th>
                    <th className="px-4 py-2 text-left font-medium">Added</th>
                    <th className="px-4 py-2 text-right font-medium">&nbsp;</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-900 dark:text-slate-100">
                          {row.email}
                        </div>
                        {row.notes && (
                          <div className="mt-0.5 max-w-md truncate text-xs text-slate-500 dark:text-slate-400">
                            {row.notes}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={PILL + " " + REASON_PILL[row.reason]}
                          title={REASON_HINT[row.reason]}
                        >
                          {REASON_LABEL[row.reason]}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-500 dark:text-slate-400">
                        {row.source || "—"}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-600 dark:text-slate-300">
                        {fmtDate(row.createdAt)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => remove(row)}
                          aria-label={`Remove ${row.email} from the suppression list`}
                          title="Remove — this address can be mailed again"
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:text-slate-500 dark:hover:bg-rose-500/10 dark:hover:text-rose-300"
                        >
                          <Trash2 size={15} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-3 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span className="tabular-nums">
              {showingFrom}–{showingTo} of {total}
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
