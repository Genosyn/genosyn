import React from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import { AlertTriangle, Database, Plus, Radio } from "lucide-react";
import { api } from "../lib/api";
import { cronHuman, cronIsReadable } from "../lib/cron";
import { Breadcrumbs } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Button } from "../components/ui/Button";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";
import { RevenueOutletCtx } from "./RevenueLayout";

/**
 * Revenue → Signals. Saved queries over the company's own product database plus
 * a rule for what to do with the rows that come back — the piece that makes this
 * section specific to SaaS rather than generic CRM.
 *
 * `lastError` is rendered loudly rather than tucked into the detail page: a
 * signal that has been silently failing for a week is worse than one that never
 * existed, because somebody is relying on it.
 */

// ── Wire shapes ────────────────────────────────────────────────────────────

export type SignalSourceKind = "sql" | "stripe";

export const SIGNAL_SOURCE_KINDS: SignalSourceKind[] = ["sql", "stripe"];

export type SignalActionKind =
  | "activity"
  | "notify"
  | "create_deal"
  | "enroll_sequence"
  | "hand_to_employee";

export const SIGNAL_ACTION_KINDS: SignalActionKind[] = [
  "activity",
  "notify",
  "create_deal",
  "enroll_sequence",
  "hand_to_employee",
];

export type SignalEventStatus = "new" | "actioned" | "ignored" | "failed";

export type Signal = {
  id: string;
  companyId: string;
  name: string;
  slug: string;
  description: string;
  sourceKind: SignalSourceKind;
  connectionId: string | null;
  sql: string;
  cron: string;
  enabled: boolean;
  dedupeKeyColumn: string;
  emailColumn: string;
  domainColumn: string;
  amountColumn: string;
  actionKind: SignalActionKind;
  actionConfigJson: string | null;
  employeeId: string | null;
  lastRunAt: string | null;
  lastError: string;
  lastEventCount: number;
  archivedAt: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SignalEvent = {
  id: string;
  companyId: string;
  signalId: string;
  dedupeKey: string;
  payloadJson: string | null;
  contactId: string | null;
  customerId: string | null;
  dealId: string | null;
  status: SignalEventStatus;
  detail: string;
  occurredAt: string;
  createdAt: string;
};

export type SignalConnection = {
  id: string;
  provider: string;
  label: string;
  accountHint: string;
  status: string;
};

export type TestSignalResult = {
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
  error?: string;
};

// ── Shared presentation ────────────────────────────────────────────────────

export const SIGNAL_SOURCE_LABEL: Record<SignalSourceKind, string> = {
  sql: "SQL query",
  stripe: "Stripe",
};

export const SIGNAL_ACTION_LABEL: Record<SignalActionKind, string> = {
  activity: "Log an activity",
  notify: "Notify owners & admins",
  create_deal: "Open a deal",
  enroll_sequence: "Enrol in a sequence",
  hand_to_employee: "Hand to an AI employee",
};

export const SIGNAL_ACTION_HINT: Record<SignalActionKind, string> = {
  activity: "Writes a row on the contact timeline. The safe default while you tune the query.",
  notify: "Bell and push to every owner and admin, unless the config names specific people.",
  create_deal: "Opens a deal in the board's default stage, or the stage named below.",
  enroll_sequence: "Adds the resolved contact to a sequence, subject to the suppression list.",
  hand_to_employee: "Wakes an AI employee with the row and lets it decide what to do.",
};

export const SIGNAL_EVENT_LABEL: Record<SignalEventStatus, string> = {
  new: "New",
  actioned: "Actioned",
  ignored: "Ignored",
  failed: "Failed",
};

export const SIGNAL_EVENT_PILL: Record<SignalEventStatus, string> = {
  new: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
  actioned: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  ignored: "bg-slate-100 text-slate-600 dark:bg-slate-700/40 dark:text-slate-300",
  failed: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
};

export const SIGNAL_PILL_BASE =
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider";

export const DEFAULT_SIGNAL_CRON = "0 * * * *";

export function fmtSignalDate(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/**
 * Read-only SQL is not enforced by the executor. Repeated verbatim on the
 * detail page — this is the sentence that stops somebody pointing a signal at a
 * connection with write credentials.
 */
export const LEAST_PRIVILEGE_NOTE =
  "Read-only SQL is not enforced. Whatever this query says will run against the connected database with that connection's credentials — connect with a least-privileged, read-only role.";

// ── Page ───────────────────────────────────────────────────────────────────

export default function RevenueSignals() {
  const { company } = useOutletContext<RevenueOutletCtx>();
  const navigate = useNavigate();
  const { background } = useToast();
  const [signals, setSignals] = React.useState<Signal[] | null>(null);
  const [connections, setConnections] = React.useState<SignalConnection[]>([]);
  const [loadError, setLoadError] = React.useState(false);
  const [creating, setCreating] = React.useState(false);

  const base = `/api/companies/${company.id}/revenue`;
  const sectionUrl = `/c/${company.slug}/revenue`;

  const reload = React.useCallback(async () => {
    const rows = await api.get<Signal[]>(`${base}/signals`);
    setSignals(rows);
    setLoadError(false);
  }, [base]);

  React.useEffect(() => {
    reload().catch(() => {
      setSignals([]);
      setLoadError(true);
    });
  }, [reload]);

  React.useEffect(() => {
    let live = true;
    api
      .get<SignalConnection[]>(`/api/companies/${company.id}/explore/connections`)
      .then((rows) => {
        if (live) setConnections(rows);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [company.id]);

  useLiveRefetch(["signal", "signalevent"], reload);

  const connectionById = React.useMemo(
    () => new Map(connections.map((c) => [c.id, c])),
    [connections],
  );

  function toggleEnabled(signal: Signal, enabled: boolean) {
    setSignals(
      (current) =>
        current?.map((item) => (item.id === signal.id ? { ...item, enabled } : item)) ?? current,
    );
    background(() => api.patch<Signal>(`${base}/signals/${signal.id}`, { enabled }), {
      loading: enabled ? "Enabling signal…" : "Disabling signal…",
      success: enabled ? "Signal enabled" : "Signal disabled",
      error: (error) =>
        `Couldn’t change the signal: ${
          error instanceof Error ? error.message : String(error)
        }. The switch was put back.`,
      onSuccess: () => void reload(),
      onError: () => {
        setSignals(
          (current) =>
            current?.map((item) => (item.id === signal.id ? signal : item)) ?? current,
        );
      },
    });
  }

  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="mb-6">
        <Breadcrumbs items={[{ label: "Revenue", to: sectionUrl }, { label: "Signals" }]} />
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Signals</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
            Your product database already knows who is about to churn and whose trial ends on
            Thursday. A signal is a saved query on a schedule, plus a rule for what to do with the
            rows it returns.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus size={14} /> New signal
        </Button>
      </div>

      {loadError ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Couldn&apos;t load signals
          </h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Something went wrong fetching this list.
          </p>
          <Button
            variant="secondary"
            className="mt-4"
            onClick={() =>
              reload().catch(() => {
                setSignals([]);
                setLoadError(true);
              })
            }
          >
            Try again
          </Button>
        </div>
      ) : signals === null ? (
        <div className="flex justify-center p-16">
          <Spinner size={20} />
        </div>
      ) : signals.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            No signals yet
          </h3>
          <p className="mx-auto mt-1 max-w-md text-sm text-slate-500 dark:text-slate-400">
            Write a query that returns the accounts you want to hear about, pick what should happen
            when it does, and leave it disabled until a test run looks right.
          </p>
          <div className="mt-4">
            <Button onClick={() => setCreating(true)}>
              <Plus size={14} /> New signal
            </Button>
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">On</th>
                  <th className="px-4 py-2 text-left font-medium">Signal</th>
                  <th className="px-4 py-2 text-left font-medium">Source</th>
                  <th className="px-4 py-2 text-left font-medium">Schedule</th>
                  <th className="px-4 py-2 text-left font-medium">Last run</th>
                  <th className="px-4 py-2 text-right font-medium">Events</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {signals.map((s) => (
                  <tr key={s.id} className={s.archivedAt ? "opacity-60" : ""}>
                    <td className="px-4 py-3 align-top">
                      <EnabledToggle
                        enabled={s.enabled}
                        label={`Enable ${s.name}`}
                        onChange={(next) => toggleEnabled(s, next)}
                      />
                    </td>
                    <td className="px-4 py-3 align-top">
                      <Link
                        to={`${sectionUrl}/signals/${s.id}`}
                        className="font-medium text-slate-900 hover:text-indigo-600 hover:underline dark:text-slate-100 dark:hover:text-indigo-400"
                      >
                        {s.name}
                      </Link>
                      <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                        {SIGNAL_ACTION_LABEL[s.actionKind]}
                      </div>
                      {s.lastError && (
                        <div className="mt-1.5 flex max-w-md items-start gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-2 py-1.5 text-xs text-rose-800 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-200">
                          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                          <span className="min-w-0 flex-1 break-words">{s.lastError}</span>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 align-top text-slate-600 dark:text-slate-300">
                      <span className="inline-flex items-center gap-1.5 text-xs">
                        <Database size={12} className="text-slate-400 dark:text-slate-500" />
                        {SIGNAL_SOURCE_LABEL[s.sourceKind]}
                      </span>
                      {s.connectionId && (
                        <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                          {connectionById.get(s.connectionId)?.label ?? "Unknown connection"}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 align-top text-slate-600 dark:text-slate-300">
                      <div className="text-xs">{cronHuman(s.cron)}</div>
                      <div className="mt-0.5 font-mono text-[11px] text-slate-400 dark:text-slate-500">
                        {s.cron}
                      </div>
                    </td>
                    <td className="px-4 py-3 align-top text-xs text-slate-600 dark:text-slate-300">
                      {fmtSignalDate(s.lastRunAt)}
                    </td>
                    <td className="px-4 py-3 align-top text-right tabular-nums text-slate-700 dark:text-slate-200">
                      {s.lastEventCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
        <Radio size={13} className="mt-0.5 shrink-0" />
        <span>{LEAST_PRIVILEGE_NOTE}</span>
      </p>

      <CreateSignalModal
        open={creating}
        onClose={() => setCreating(false)}
        base={base}
        connections={connections}
        onCreated={(signal) => {
          setCreating(false);
          navigate(`${sectionUrl}/signals/${signal.id}`);
        }}
      />
    </div>
  );
}

/** Hand-rolled switch — there is no Toggle primitive in this codebase. */
export function EnabledToggle({
  enabled,
  label,
  onChange,
  disabled,
}: {
  enabled: boolean;
  label: string;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!enabled)}
      className={
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 " +
        (enabled
          ? "bg-emerald-500 dark:bg-emerald-600"
          : "bg-slate-200 dark:bg-slate-700")
      }
    >
      <span
        className={
          "inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform dark:bg-slate-100 " +
          (enabled ? "translate-x-4" : "translate-x-0.5")
        }
      />
    </button>
  );
}

function CreateSignalModal({
  open,
  onClose,
  base,
  connections,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  base: string;
  connections: SignalConnection[];
  onCreated: (signal: Signal) => void;
}) {
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [sourceKind, setSourceKind] = React.useState<SignalSourceKind>("sql");
  const [connectionId, setConnectionId] = React.useState("");
  const [cron, setCron] = React.useState(DEFAULT_SIGNAL_CRON);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setSourceKind("sql");
    setConnectionId("");
    setCron(DEFAULT_SIGNAL_CRON);
    setError(null);
    setSaving(false);
  }, [open]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const created = await api.post<Signal>(`${base}/signals`, {
        name: name.trim(),
        description: description.trim() || undefined,
        sourceKind,
        connectionId: connectionId || null,
        cron: cron.trim() || DEFAULT_SIGNAL_CRON,
      });
      onCreated(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="New signal" size="lg">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Trial ending in 3 days"
          maxLength={120}
          autoFocus
        />
        <Input
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional — what firing means"
          maxLength={2000}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Source"
            value={sourceKind}
            onChange={(e) => setSourceKind(e.target.value as SignalSourceKind)}
          >
            {SIGNAL_SOURCE_KINDS.map((k) => (
              <option key={k} value={k}>
                {SIGNAL_SOURCE_LABEL[k]}
              </option>
            ))}
          </Select>
          <Select
            label="Connection"
            value={connectionId}
            onChange={(e) => setConnectionId(e.target.value)}
            disabled={sourceKind !== "sql"}
          >
            <option value="">
              {connections.length === 0 ? "No database connections" : "Choose a connection…"}
            </option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label} ({c.provider})
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Input
            label="Schedule (cron)"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            placeholder={DEFAULT_SIGNAL_CRON}
            maxLength={120}
            className="font-mono"
          />
          <p
            className={
              "mt-1 text-xs " +
              (cronIsReadable(cron)
                ? "text-slate-500 dark:text-slate-400"
                : "text-rose-600 dark:text-rose-400")
            }
          >
            {cronIsReadable(cron)
              ? cronHuman(cron)
              : "That is not a cron expression this scheduler can read."}
          </p>
        </div>
        <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
          New signals start disabled. Add the SQL and the action on the next screen, run a test,
          then switch it on.
        </p>
        <FormError message={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving || !name.trim()}>
            {saving ? <Spinner size={14} /> : <Plus size={14} />}
            Create signal
          </Button>
        </div>
      </form>
    </Modal>
  );
}
