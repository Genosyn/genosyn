import React from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import { Bot, Mail, Plus, Send, Zap } from "lucide-react";
import { api, Employee } from "../lib/api";
import { mailApi, MailAccount } from "../lib/mail";
import { Breadcrumbs } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Button } from "../components/ui/Button";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { Textarea } from "../components/ui/Textarea";
import { RevenueOutletCtx } from "./RevenueLayout";

/**
 * Revenue → Sequences. Every outbound campaign the company runs, with the AI
 * employee that writes each touch, the mailbox it goes out of, how long the
 * ladder is, and where the enrolled contacts have got to.
 *
 * The shapes below mirror `server/services/revenue/sequences.ts` — the list
 * endpoint is deliberately unpaginated (a company runs tens of campaigns), so
 * the search box filters what we already hold rather than refetching per
 * keystroke.
 */

// ── Wire shapes ────────────────────────────────────────────────────────────

export type SequenceStatus = "draft" | "active" | "paused" | "archived";

export const SEQUENCE_STATUSES: SequenceStatus[] = ["draft", "active", "paused", "archived"];

export type EnrollmentStatus =
  | "active"
  | "paused"
  | "completed"
  | "stopped_replied"
  | "stopped_bounced"
  | "stopped_unsubscribed"
  | "stopped_manual"
  | "failed";

export const ENROLLMENT_STATUSES: EnrollmentStatus[] = [
  "active",
  "paused",
  "completed",
  "stopped_replied",
  "stopped_bounced",
  "stopped_unsubscribed",
  "stopped_manual",
  "failed",
];

/** Server writes `sendWindow`; it reads back serialized as `sendWindowJson`. */
export type SendWindow = {
  days: number[];
  startHour: number;
  endHour: number;
  timezone: string;
};

export type Sequence = {
  id: string;
  companyId: string;
  name: string;
  slug: string;
  description: string;
  status: SequenceStatus;
  mailAccountId: string;
  employeeId: string;
  brief: string;
  autoSend: boolean;
  stopOnReply: boolean;
  dailyCap: number;
  sendWindowJson: string | null;
  archivedAt: string | null;
  createdById: string | null;
  createdByEmployeeId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type HydratedSequence = Sequence & {
  enrollmentCounts: Record<EnrollmentStatus, number>;
  activeCount: number;
  totalEnrolled: number;
  stepCount: number;
};

export type SequenceStep = {
  id: string;
  companyId: string;
  sequenceId: string;
  sortOrder: number;
  name: string;
  delayDays: number;
  delayHours: number;
  instruction: string;
  threadWithPrevious: boolean;
};

export type SequenceEnrollment = {
  id: string;
  companyId: string;
  sequenceId: string;
  contactId: string;
  dealId: string | null;
  status: EnrollmentStatus;
  currentStepOrder: number;
  nextRunAt: string | null;
  lastStepAt: string | null;
  stoppedReason: string;
  mailThreadId: string | null;
  createdAt: string;
  updatedAt: string;
  contact: { id: string; name: string; email: string } | null;
};

// ── Shared presentation ────────────────────────────────────────────────────

export const SEQUENCE_STATUS_LABEL: Record<SequenceStatus, string> = {
  draft: "Draft",
  active: "Active",
  paused: "Paused",
  archived: "Archived",
};

export const SEQUENCE_STATUS_PILL: Record<SequenceStatus, string> = {
  draft: "bg-slate-100 text-slate-700 dark:bg-slate-700/40 dark:text-slate-200",
  active: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  paused: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  archived: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
};

export const ENROLLMENT_STATUS_LABEL: Record<EnrollmentStatus, string> = {
  active: "Active",
  paused: "Paused",
  completed: "Completed",
  stopped_replied: "Replied",
  stopped_bounced: "Bounced",
  stopped_unsubscribed: "Unsubscribed",
  stopped_manual: "Stopped",
  failed: "Failed",
};

export const ENROLLMENT_STATUS_PILL: Record<EnrollmentStatus, string> = {
  active: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  paused: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  completed: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
  stopped_replied: "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300",
  stopped_bounced: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
  stopped_unsubscribed: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
  stopped_manual: "bg-slate-100 text-slate-700 dark:bg-slate-700/40 dark:text-slate-200",
  failed: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
};

export const PILL_BASE =
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider";

/** Parse the serialized send window, falling back to the server's default. */
export function parseSendWindow(json: string | null): SendWindow {
  const fallback: SendWindow = {
    days: [1, 2, 3, 4, 5],
    startHour: 8,
    endHour: 17,
    timezone: "UTC",
  };
  if (!json) return fallback;
  try {
    const raw = JSON.parse(json) as Partial<SendWindow>;
    return {
      days: Array.isArray(raw.days)
        ? raw.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
        : fallback.days,
      startHour:
        typeof raw.startHour === "number" && raw.startHour >= 0 && raw.startHour <= 23
          ? raw.startHour
          : fallback.startHour,
      endHour:
        typeof raw.endHour === "number" && raw.endHour >= 0 && raw.endHour <= 23
          ? raw.endHour
          : fallback.endHour,
      timezone:
        typeof raw.timezone === "string" && raw.timezone.trim() ? raw.timezone : fallback.timezone,
    };
  } catch {
    return fallback;
  }
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function RevenueSequences() {
  const { company } = useOutletContext<RevenueOutletCtx>();
  const navigate = useNavigate();
  const [sequences, setSequences] = React.useState<HydratedSequence[] | null>(null);
  const [loadError, setLoadError] = React.useState(false);
  const [employees, setEmployees] = React.useState<Employee[]>([]);
  const [accounts, setAccounts] = React.useState<MailAccount[]>([]);
  const [statusFilter, setStatusFilter] = React.useState<SequenceStatus | "all">("all");
  const [query, setQuery] = React.useState("");
  const [creating, setCreating] = React.useState(false);

  const base = `/api/companies/${company.id}/revenue`;
  const sectionUrl = `/c/${company.slug}/revenue`;

  const reload = React.useCallback(async () => {
    const rows = await api.get<HydratedSequence[]>(`${base}/sequences`);
    setSequences(rows);
    setLoadError(false);
  }, [base]);

  React.useEffect(() => {
    reload().catch(() => {
      setSequences([]);
      setLoadError(true);
    });
  }, [reload]);

  // The pickers in the create modal. A failure here must not blank the list,
  // so they resolve independently and simply leave the select empty.
  React.useEffect(() => {
    let live = true;
    api
      .get<Employee[]>(`/api/companies/${company.id}/employees`)
      .then((rows) => {
        if (live) setEmployees(rows);
      })
      .catch(() => undefined);
    mailApi
      .accounts(company.id)
      .then((res) => {
        if (live) setAccounts(res.accounts);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [company.id]);

  useLiveRefetch(["sequence", "enrollment"], reload);

  const employeeById = React.useMemo(
    () => new Map(employees.map((e) => [e.id, e])),
    [employees],
  );
  const accountById = React.useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  const visible = React.useMemo(() => {
    if (!sequences) return null;
    const term = query.trim().toLowerCase();
    return sequences.filter((s) => {
      if (statusFilter !== "all" && s.status !== statusFilter) return false;
      if (!term) return true;
      return (
        s.name.toLowerCase().includes(term) || s.description.toLowerCase().includes(term)
      );
    });
  }, [sequences, statusFilter, query]);

  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="mb-6">
        <Breadcrumbs items={[{ label: "Revenue", to: sectionUrl }, { label: "Sequences" }]} />
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Sequences</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
            Multi-step outbound campaigns. Each touch is written individually by an AI employee
            from the contact&apos;s real context — not merged from a template.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus size={14} /> New sequence
        </Button>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="w-full sm:w-64">
          <Input
            placeholder="Search sequences…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search sequences"
          />
        </div>
        <div className="flex flex-wrap gap-1">
          <FilterTab
            label="All"
            active={statusFilter === "all"}
            onClick={() => setStatusFilter("all")}
          />
          {SEQUENCE_STATUSES.map((s) => (
            <FilterTab
              key={s}
              label={SEQUENCE_STATUS_LABEL[s]}
              active={statusFilter === s}
              onClick={() => setStatusFilter(s)}
            />
          ))}
        </div>
      </div>

      {loadError ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Couldn&apos;t load sequences
          </h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Something went wrong fetching this list.
          </p>
          <Button
            variant="secondary"
            className="mt-4"
            onClick={() =>
              reload().catch(() => {
                setSequences([]);
                setLoadError(true);
              })
            }
          >
            Try again
          </Button>
        </div>
      ) : visible === null ? (
        <div className="flex justify-center p-16">
          <Spinner size={20} />
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            {sequences && sequences.length > 0 ? "Nothing matches that" : "No sequences yet"}
          </h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {sequences && sequences.length > 0
              ? "Try a different search or status filter."
              : "Create one, hand it a brief and a ladder of steps, then enrol the contacts you want it to work."}
          </p>
          {(!sequences || sequences.length === 0) && (
            <div className="mt-4">
              <Button onClick={() => setCreating(true)}>
                <Plus size={14} /> New sequence
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Sequence</th>
                  <th className="px-4 py-2 text-left font-medium">Status</th>
                  <th className="px-4 py-2 text-left font-medium">Written by</th>
                  <th className="px-4 py-2 text-left font-medium">Mailbox</th>
                  <th className="px-4 py-2 text-right font-medium">Steps</th>
                  <th className="px-4 py-2 text-left font-medium">Enrolments</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {visible.map((s) => {
                  const employee = employeeById.get(s.employeeId) ?? null;
                  const account = accountById.get(s.mailAccountId) ?? null;
                  return (
                    <tr key={s.id} className={s.archivedAt ? "opacity-60" : ""}>
                      <td className="px-4 py-3">
                        <Link
                          to={`${sectionUrl}/sequences/${s.id}`}
                          className="font-medium text-slate-900 hover:text-indigo-600 hover:underline dark:text-slate-100 dark:hover:text-indigo-400"
                        >
                          {s.name}
                        </Link>
                        {s.autoSend && (
                          <span
                            className={
                              PILL_BASE +
                              " ml-2 bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300"
                            }
                            title="Touches go out with no human pressing Send"
                          >
                            <Zap size={10} /> Auto-send
                          </span>
                        )}
                        {s.description && (
                          <div className="mt-0.5 max-w-sm truncate text-xs text-slate-500 dark:text-slate-400">
                            {s.description}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={PILL_BASE + " " + SEQUENCE_STATUS_PILL[s.status]}>
                          {SEQUENCE_STATUS_LABEL[s.status]}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                        <span className="inline-flex items-center gap-1.5">
                          <Bot size={13} className="text-violet-500 dark:text-violet-400" />
                          {employee ? (
                            <Link
                              to={`/c/${company.slug}/employees/${employee.slug}/chat`}
                              className="hover:text-indigo-600 hover:underline dark:hover:text-indigo-400"
                            >
                              {employee.name}
                            </Link>
                          ) : (
                            <span className="text-slate-400 dark:text-slate-500">Unknown</span>
                          )}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                        <span className="inline-flex items-center gap-1.5 text-xs">
                          <Mail size={12} className="text-slate-400 dark:text-slate-500" />
                          {account ? (
                            account.address
                          ) : (
                            <span className="text-slate-400 dark:text-slate-500">—</span>
                          )}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-700 dark:text-slate-200">
                        {s.stepCount}
                      </td>
                      <td className="px-4 py-3">
                        <EnrollmentCounts counts={s.enrollmentCounts} total={s.totalEnrolled} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <CreateSequenceModal
        open={creating}
        onClose={() => setCreating(false)}
        base={base}
        employees={employees}
        accounts={accounts}
        onCreated={(sequence) => {
          setCreating(false);
          navigate(`${sectionUrl}/sequences/${sequence.id}`);
        }}
      />
    </div>
  );
}

function FilterTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors " +
        (active
          ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
          : "text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800")
      }
    >
      {label}
    </button>
  );
}

function EnrollmentCounts({
  counts,
  total,
}: {
  counts: Record<EnrollmentStatus, number>;
  total: number;
}) {
  const shown = ENROLLMENT_STATUSES.filter((s) => (counts?.[s] ?? 0) > 0);
  if (total === 0 || shown.length === 0) {
    return <span className="text-xs text-slate-400 dark:text-slate-500">Nobody enrolled</span>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((s) => (
        <span
          key={s}
          className={PILL_BASE + " " + ENROLLMENT_STATUS_PILL[s]}
          title={ENROLLMENT_STATUS_LABEL[s]}
        >
          {counts[s]} {ENROLLMENT_STATUS_LABEL[s]}
        </span>
      ))}
    </div>
  );
}

/**
 * Create modal. Both a mailbox and an AI employee are required by the API —
 * a sequence with no writer and no return address is not a thing that can
 * exist — so the submit stays disabled until both are chosen.
 */
function CreateSequenceModal({
  open,
  onClose,
  base,
  employees,
  accounts,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  base: string;
  employees: Employee[];
  accounts: MailAccount[];
  onCreated: (sequence: Sequence) => void;
}) {
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [employeeId, setEmployeeId] = React.useState("");
  const [mailAccountId, setMailAccountId] = React.useState("");
  const [brief, setBrief] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setEmployeeId("");
    setMailAccountId("");
    setBrief("");
    setError(null);
    setSaving(false);
  }, [open]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || !employeeId || !mailAccountId) return;
    setSaving(true);
    setError(null);
    try {
      const created = await api.post<Sequence>(`${base}/sequences`, {
        name: name.trim(),
        description: description.trim() || undefined,
        employeeId,
        mailAccountId,
        brief: brief.trim() || undefined,
      });
      onCreated(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="New sequence" size="lg">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Trial ending — nudge"
          maxLength={120}
          autoFocus
        />
        <Input
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional — what this campaign is for"
          maxLength={2000}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Written by"
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
          >
            <option value="">
              {employees.length === 0 ? "No AI employees yet" : "Choose an AI employee…"}
            </option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} — {e.role}
              </option>
            ))}
          </Select>
          <Select
            label="Send from"
            value={mailAccountId}
            onChange={(e) => setMailAccountId(e.target.value)}
          >
            <option value="">
              {accounts.length === 0 ? "No mailboxes connected" : "Choose a mailbox…"}
            </option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.address}
              </option>
            ))}
          </Select>
        </div>
        <Textarea
          label="Brief"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="Who this is for, what we sell, what good looks like, what never to say. Markdown."
          maxLength={20000}
          className="min-h-[140px]"
        />
        <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
          New sequences start as a draft with auto-send off, so every touch lands in the draft
          review queue for a human to send. You can add the step ladder next.
        </p>
        <FormError message={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving || !name.trim() || !employeeId || !mailAccountId}>
            {saving ? <Spinner size={14} /> : <Send size={14} />}
            Create sequence
          </Button>
        </div>
      </form>
    </Modal>
  );
}
