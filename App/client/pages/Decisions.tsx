import React from "react";
import { Plus, Settings2, Trash2 } from "lucide-react";
import {
  api,
  Company,
  Decision,
  DecisionPolicyDeciderKind,
  DecisionPolicyRule,
  Employee,
  Me,
} from "../lib/api";
import { errorMessage } from "../lib/errors";
import { DecisionCard } from "../components/decisions/DecisionCard";
import { DecisionOutcome } from "../components/decisions/DecisionOutcome";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { FormError } from "../components/ui/FormError";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { TopBar } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { clsx } from "../components/ui/clsx";
import { EnabledToggle } from "./RevenueSignals";

/**
 * The Decision Stack in full — every question an AI employee raised for a
 * human, what is still waiting, and what happened to the ones already answered.
 *
 * The Home page shows the top of this stack; this page is where you come to
 * work through it. The split that matters is **assigned to you** versus
 * **anyone can answer**: an employee that named a Member did so because that
 * person holds the context, and burying those in one long list is how a
 * question addressed to somebody specific sits for three days.
 *
 * History is kept on the same page rather than behind a tab because the most
 * common question about a decided row — "did it actually go out?" — is now
 * answerable here: answering starts the employee's work session, and its report
 * comes back onto the row.
 */

type Filter = "all" | "decided" | "cancelled" | "expired";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "decided", label: "Answered" },
  { id: "cancelled", label: "Dismissed" },
  { id: "expired", label: "Expired" },
];

export default function Decisions({ company, me }: { company: Company; me: Me }) {
  const [rows, setRows] = React.useState<Decision[] | null>(null);
  const [filter, setFilter] = React.useState<Filter>("all");
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [routingOpen, setRoutingOpen] = React.useState(false);

  const reload = React.useCallback(async () => {
    try {
      setRows(await api.get<Decision[]>(`/api/companies/${company.id}/decisions`));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the decisions"));
      setRows([]);
    }
  }, [company.id]);

  React.useEffect(() => {
    setRows(null);
    setLoadError(null);
    reload();
  }, [reload]);

  // Live: the pickup session writes its progress to the same rows, so a
  // decision answered on this page fills in its own outcome without a refresh.
  useLiveRefetch("decision", reload);

  const pending = rows?.filter((r) => r.status === "pending") ?? [];
  const mine = pending.filter((r) => r.assignee?.id === me.id);
  const anyone = pending.filter((r) => r.assignee?.id !== me.id);
  const history = rows?.filter((r) => r.status !== "pending") ?? [];
  const shown = history.filter((r) => filter === "all" || r.status === filter);
  const working = history.filter((r) => r.pickupStatus === "running").length;

  return (
    <div className="page-shell p-8">
      <TopBar
        title="Decisions"
        right={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setRoutingOpen(true)}
            title="Which AI decider answers whose questions before humans are paged"
          >
            <Settings2 size={14} /> Routing
          </Button>
        }
      />
      {routingOpen && <RoutingModal company={company} onClose={() => setRoutingOpen(false)} />}
      {loadError ? (
        <FormError message={loadError} />
      ) : rows === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No decisions waiting"
          description="When an AI employee reaches a fork it shouldn't take alone — a reply it could send, a post it could publish — it stacks the question here with the options it will act on. Answering one starts them working again straight away."
        />
      ) : (
        <div className="flex flex-col gap-6">
          {pending.length > 0 && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {pending.length === 1
                ? "One AI employee is blocked on you."
                : `${pending.length} questions are blocking your AI employees.`}{" "}
              Answering starts them working again immediately — nothing waits for their next
              routine.
            </p>
          )}

          {mine.length > 0 && (
            <Section title={`Assigned to you (${mine.length})`}>
              <Stack>
                {mine.map((d) => (
                  <DecisionCard key={d.id} company={company} decision={d} onResolved={reload} />
                ))}
              </Stack>
            </Section>
          )}

          <Section
            title={
              mine.length > 0
                ? `Anyone can answer (${anyone.length})`
                : `Waiting on you (${anyone.length})`
            }
          >
            {anyone.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-200 p-4 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                {mine.length > 0
                  ? "Nothing else open to the whole company."
                  : "Nothing waiting — your AI employees are unblocked."}
              </div>
            ) : (
              <Stack>
                {anyone.map((d) => (
                  <DecisionCard key={d.id} company={company} decision={d} onResolved={reload} />
                ))}
              </Stack>
            )}
          </Section>

          {history.length > 0 && (
            <section>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <div className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Already answered
                </div>
                {working > 0 && (
                  <span className="rounded-full bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
                    {working} being worked on now
                  </span>
                )}
                <div className="ml-auto flex items-center gap-1">
                  {FILTERS.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setFilter(f.id)}
                      className={clsx(
                        "rounded-md px-2 py-0.5 text-[11px] font-medium transition",
                        filter === f.id
                          ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                          : "text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800",
                      )}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
              {shown.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-200 p-4 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                  Nothing in this state yet.
                </div>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {shown.map((d) => (
                    <DecisionOutcome key={d.id} company={company} decision={d} />
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {title}
      </div>
      {children}
    </section>
  );
}

function Stack({ children }: { children: React.ReactNode }) {
  return (
    <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white shadow-sm dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
      {children}
    </ul>
  );
}

// ───────────────────────── routing rules (M53a) ──────────────────────────

/**
 * The decision-rights matrix behind the header gear: which AI decider a
 * question is routed to before the human bell rings. Reads are member-level —
 * every Member can see who answers for whom — but the controls are admin-only,
 * because a rule redirects questions away from human inboxes. Server 400s
 * (self-answer, decider/kind mismatches) surface inline.
 */
function RoutingModal({ company, onClose }: { company: Company; onClose: () => void }) {
  const [rules, setRules] = React.useState<DecisionPolicyRule[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [rowError, setRowError] = React.useState<string | null>(null);
  const [busyRuleId, setBusyRuleId] = React.useState<string | null>(null);
  const [employees, setEmployees] = React.useState<Employee[]>([]);

  const canManage = company.role === "owner" || company.role === "admin";
  const base = `/api/companies/${company.id}/decision-policies`;

  const reload = React.useCallback(async () => {
    try {
      setRules(await api.get<DecisionPolicyRule[]>(base));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the routing rules"));
      setRules([]);
    }
  }, [base]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  // Policy edits ride the "decision" live-sync kind, so another admin's change
  // lands here without a reopen.
  useLiveRefetch("decision", reload);

  React.useEffect(() => {
    let cancelled = false;
    api
      .get<Employee[]>(`/api/companies/${company.id}/employees`)
      .then((list) => {
        if (!cancelled) setEmployees(list);
      })
      .catch(() => {
        if (!cancelled) setEmployees([]);
      });
    return () => {
      cancelled = true;
    };
  }, [company.id]);

  const employeesById = React.useMemo(
    () => new Map(employees.map((e) => [e.id, e])),
    [employees],
  );

  async function toggle(rule: DecisionPolicyRule, enabled: boolean) {
    setBusyRuleId(rule.id);
    setRowError(null);
    try {
      await api.patch(`${base}/${rule.id}`, { enabled });
      await reload();
    } catch (err) {
      setRowError(errorMessage(err, "Could not update the rule"));
    } finally {
      setBusyRuleId(null);
    }
  }

  async function remove(rule: DecisionPolicyRule) {
    setBusyRuleId(rule.id);
    setRowError(null);
    try {
      await api.del(`${base}/${rule.id}`);
      await reload();
    } catch (err) {
      setRowError(errorMessage(err, "Could not delete the rule"));
    } finally {
      setBusyRuleId(null);
    }
  }

  function ruleLabel(rule: DecisionPolicyRule): { asking: string; decider: string } {
    const asking = rule.askingEmployeeId
      ? (employeesById.get(rule.askingEmployeeId)?.name ?? "(deleted employee)")
      : "Any employee";
    const decider =
      rule.deciderKind === "manager"
        ? "their manager"
        : (employeesById.get(rule.deciderEmployeeId ?? "")?.name ?? "(deleted employee)");
    return { asking, decider };
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Routing"
      description="Routed questions skip the human bell; a decline or 4 hours of silence pages humans as before."
      size="lg"
      footer={
        <Button variant="secondary" type="button" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {loadError ? (
          <FormError message={loadError} />
        ) : rules === null ? (
          <Spinner />
        ) : (
          <>
            <FormError message={rowError} />
            {rules.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-200 p-4 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                No routing rules yet — every question pages humans directly.
              </div>
            ) : (
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
                {rules.map((rule) => {
                  const { asking, decider } = ruleLabel(rule);
                  return (
                    <li key={rule.id} className="flex items-center gap-3 px-3 py-2">
                      <div
                        className={clsx(
                          "min-w-0 flex-1 text-sm",
                          rule.enabled
                            ? "text-slate-700 dark:text-slate-200"
                            : "text-slate-400 dark:text-slate-500",
                        )}
                      >
                        <span className="font-medium">{asking}</span>
                        <span className="mx-1.5 text-slate-400 dark:text-slate-500">→</span>
                        <span>{decider}</span>
                      </div>
                      {canManage ? (
                        <>
                          <EnabledToggle
                            enabled={rule.enabled}
                            label={`${rule.enabled ? "Disable" : "Enable"} routing ${asking} → ${decider}`}
                            disabled={busyRuleId !== null}
                            onChange={(next) => void toggle(rule, next)}
                          />
                          <button
                            type="button"
                            onClick={() => void remove(rule)}
                            disabled={busyRuleId !== null}
                            aria-label={`Delete routing ${asking} → ${decider}`}
                            className="rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-red-600 disabled:opacity-50 dark:hover:bg-slate-800 dark:hover:text-red-400"
                          >
                            <Trash2 size={14} />
                          </button>
                        </>
                      ) : (
                        !rule.enabled && (
                          <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                            off
                          </span>
                        )
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {canManage && (
              <AddRuleForm
                base={base}
                employees={employees}
                onAdded={() => void reload()}
              />
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function AddRuleForm({
  base,
  employees,
  onAdded,
}: {
  base: string;
  employees: Employee[];
  onAdded: () => void;
}) {
  const [askingEmployeeId, setAskingEmployeeId] = React.useState("");
  const [deciderKind, setDeciderKind] = React.useState<DecisionPolicyDeciderKind>("manager");
  const [deciderEmployeeId, setDeciderEmployeeId] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (deciderKind === "employee" && !deciderEmployeeId) {
      setError("Pick the employee who answers.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.post(base, {
        askingEmployeeId: askingEmployeeId || null,
        deciderKind,
        // A manager rule must not name a decider — the server refuses it.
        deciderEmployeeId: deciderKind === "employee" ? deciderEmployeeId : null,
      });
      setAskingEmployeeId("");
      setDeciderKind("manager");
      setDeciderEmployeeId("");
      onAdded();
    } catch (err) {
      setError(errorMessage(err, "Could not add the rule"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-3">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Add a rule
      </div>
      <FormError message={error} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Select
          label="Questions from"
          value={askingEmployeeId}
          onChange={(e) => setAskingEmployeeId(e.target.value)}
        >
          <option value="">Any employee</option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </Select>
        <Select
          label="Are answered by"
          value={deciderKind}
          onChange={(e) => setDeciderKind(e.target.value as DecisionPolicyDeciderKind)}
        >
          <option value="manager">Their manager</option>
          <option value="employee">A named employee</option>
        </Select>
        {deciderKind === "employee" && (
          <Select
            label="Decider"
            value={deciderEmployeeId}
            onChange={(e) => setDeciderEmployeeId(e.target.value)}
            required
          >
            <option value="">Choose an employee…</option>
            {employees
              .filter((e) => e.id !== askingEmployeeId)
              .map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
          </Select>
        )}
      </div>
      <div>
        <Button type="submit" size="sm" disabled={saving}>
          <Plus size={14} /> Add rule
        </Button>
      </div>
    </form>
  );
}
