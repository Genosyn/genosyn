import React from "react";
import { Plus, Trash2 } from "lucide-react";

import { api, type Company, type DecisionPolicyRule, type Employee } from "@/lib/api";
import { hasRetiredRoutingRules, routingRuleLabel } from "@/lib/decisionRouting";
import { errorMessage } from "@/lib/errors";
import { EnabledToggle } from "@/pages/RevenueSignals";
import { Button } from "../ui/Button";
import { clsx } from "../ui/clsx";
import { FormError } from "../ui/FormError";
import { Select } from "../ui/Select";
import { ButtonSpinner, Spinner } from "../ui/Spinner";

/**
 * The decision-rights matrix: which AI decider a question is routed to before
 * people are asked. It configures the Decision stack, so it lives on Decision
 * stack → Settings, under Advanced — it used to be a modal behind a button on
 * the stack itself, away from the stack's other settings.
 *
 * Reads are member-level — every Member can see who answers for whom — but the
 * controls are admin-only, because a rule redirects questions away from
 * people. Server 400s (self-answer, a missing decider) surface inline. Every
 * rule names its decider; a "their manager" rule saved before reporting lines
 * were removed still lists, marked retired, so an admin can see why it no
 * longer routes.
 *
 * The page owns the rules (`rules`, `onChanged`) because its closed Advanced
 * line reports them, and a setting must stay visible while it is tucked away.
 */
export function DecisionRoutingRules({
  company,
  rules,
  loadError,
  employees,
  onChanged,
}: {
  company: Company;
  /** `null` while the first load is in flight. */
  rules: DecisionPolicyRule[] | null;
  loadError: string | null;
  employees: Employee[];
  onChanged: () => Promise<void>;
}) {
  const [rowError, setRowError] = React.useState<string | null>(null);
  const [busyRuleId, setBusyRuleId] = React.useState<string | null>(null);
  const [removingRuleId, setRemovingRuleId] = React.useState<string | null>(null);

  const canManage = company.role === "owner" || company.role === "admin";
  const base = `/api/companies/${company.id}/decision-policies`;
  const employeesById = React.useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);

  async function toggle(rule: DecisionPolicyRule, enabled: boolean) {
    setBusyRuleId(rule.id);
    setRowError(null);
    try {
      await api.patch(`${base}/${rule.id}`, { enabled });
      await onChanged();
    } catch (err) {
      setRowError(errorMessage(err, "Could not update the rule"));
    } finally {
      setBusyRuleId(null);
    }
  }

  async function remove(rule: DecisionPolicyRule) {
    setBusyRuleId(rule.id);
    setRemovingRuleId(rule.id);
    setRowError(null);
    try {
      await api.del(`${base}/${rule.id}`);
      await onChanged();
    } catch (err) {
      setRowError(errorMessage(err, "Could not delete the rule"));
    } finally {
      setBusyRuleId(null);
      setRemovingRuleId(null);
    }
  }

  return (
    <section aria-labelledby="decision-routing-title" className="flex flex-col gap-4">
      <div>
        <h3
          id="decision-routing-title"
          className="text-sm font-semibold text-slate-900 dark:text-slate-100"
        >
          Routing
        </h3>
        <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
          Let an AI Employee answer another one&apos;s questions before anyone is asked. A routed
          question skips the bell; if the AI decider declines, or says nothing for 4 hours, it
          comes to people as before.
        </p>
      </div>
      {loadError ? (
        <FormError message={loadError} />
      ) : rules === null ? (
        <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          <Spinner size={14} /> Loading routing rules…
        </div>
      ) : (
        <>
          <FormError message={rowError} />
          {rules.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-200 p-4 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
              No routing rules yet — every question goes to people.
            </div>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
              {rules.map((rule) => {
                const { asking, decider, retired } = routingRuleLabel(rule, employeesById);
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
                      {retired && (
                        <span className="ml-2 whitespace-nowrap rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                          was their manager
                        </span>
                      )}
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
                          aria-busy={removingRuleId === rule.id || undefined}
                          aria-label={`Delete routing ${asking} → ${decider}`}
                          className="rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-red-600 disabled:opacity-50 dark:hover:bg-slate-800 dark:hover:text-red-400"
                        >
                          {removingRuleId === rule.id ? (
                            <ButtonSpinner size={14} />
                          ) : (
                            <Trash2 size={14} />
                          )}
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
          {hasRetiredRoutingRules(rules) && (
            <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              Rules that sent questions to “their manager” stopped routing when reporting lines
              were removed, so those questions page people. To route them again, delete the rule
              and add one that names the employee who answers.
            </p>
          )}
          {canManage ? (
            <AddRuleForm base={base} employees={employees} onAdded={onChanged} />
          ) : (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Only owners and admins can change routing.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function AddRuleForm({
  base,
  employees,
  onAdded,
}: {
  base: string;
  employees: Employee[];
  onAdded: () => Promise<void>;
}) {
  const [askingEmployeeId, setAskingEmployeeId] = React.useState("");
  const [deciderEmployeeId, setDeciderEmployeeId] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!deciderEmployeeId) {
      setError("Pick the employee who answers.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Every rule names its decider; there is no reporting line to follow.
      await api.post(base, {
        askingEmployeeId: askingEmployeeId || null,
        deciderKind: "employee",
        deciderEmployeeId,
      });
      setAskingEmployeeId("");
      setDeciderEmployeeId("");
      await onAdded();
    } catch (err) {
      setError(errorMessage(err, "Could not add the rule"));
    } finally {
      setSaving(false);
    }
  }

  return (
    // noValidate: the browser's own check on the required decider would only
    // move focus, silently; `save` says what is missing, inline, instead.
    <form noValidate onSubmit={save} className="flex flex-col gap-3">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Add a rule
      </div>
      <FormError message={error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label="Questions from"
          value={askingEmployeeId}
          onChange={(e) => {
            const next = e.target.value;
            setAskingEmployeeId(next);
            // An employee never answers its own questions, so the decider
            // list drops whoever now asks — clear a pick it no longer offers.
            if (next && next === deciderEmployeeId) setDeciderEmployeeId("");
          }}
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
      </div>
      <div>
        <Button type="submit" size="sm" loading={saving}>
          <Plus size={14} /> Add rule
        </Button>
      </div>
    </form>
  );
}
