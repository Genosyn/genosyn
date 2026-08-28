import React from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { api, Budget, Company, Employee, IntegrationConnection, Me } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { TopBar } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Button } from "../components/ui/Button";
import { useDialog } from "../components/ui/Dialog";
import { EmptyState } from "../components/ui/EmptyState";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { clsx } from "../components/ui/clsx";
import { EnabledToggle } from "./RevenueSignals";

/**
 * Budgets — monthly (UTC calendar) envelopes over authorized ad-spend
 * increases (M53b). Null scope = the whole company; a Connection and/or an
 * Employee narrows one. The tightest applicable budget binds: exhaustion
 * refuses the AI's mutation and pages owners once per month. Reads are
 * member-level; mutations admin-gated — this page just declines to offer
 * them to plain members.
 */

/** "1,250.00" — minor units rendered as major, always two decimals. */
function formatMinor(minor: number): string {
  return (minor / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default function Budgets({ company }: { company: Company; me: Me }) {
  const [rows, setRows] = React.useState<Budget[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [employees, setEmployees] = React.useState<Employee[]>([]);
  const [connections, setConnections] = React.useState<IntegrationConnection[]>([]);
  // `budget: null` is the create modal; a budget is the edit modal.
  const [modal, setModal] = React.useState<{ budget: Budget | null } | null>(null);

  const canManage = company.role === "owner" || company.role === "admin";

  const reload = React.useCallback(async () => {
    try {
      setRows(await api.get<Budget[]>(`/api/companies/${company.id}/budgets`));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the budgets"));
      setRows([]);
    }
  }, [company.id]);

  React.useEffect(() => {
    setRows(null);
    setLoadError(null);
    reload();
  }, [reload]);

  // Live: another admin's edits and the server's spend bookkeeping land on
  // this list without a manual reload.
  useLiveRefetch("budget", reload);

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
    api
      .get<IntegrationConnection[]>(`/api/companies/${company.id}/integrations/connections`)
      .then((list) => {
        if (!cancelled) setConnections(list);
      })
      .catch(() => {
        if (!cancelled) setConnections([]);
      });
    return () => {
      cancelled = true;
    };
  }, [company.id]);

  const employeesById = React.useMemo(
    () => new Map(employees.map((e) => [e.id, e])),
    [employees],
  );
  const connectionsById = React.useMemo(
    () => new Map(connections.map((c) => [c.id, c])),
    [connections],
  );

  /** "Whole company" / connection label / employee name — the envelope's reach. */
  function scopeLine(budget: Budget): string {
    const parts: string[] = [];
    if (budget.connectionId) {
      parts.push(connectionsById.get(budget.connectionId)?.label ?? "(deleted connection)");
    }
    if (budget.employeeId) {
      parts.push(employeesById.get(budget.employeeId)?.name ?? "(deleted employee)");
    }
    return parts.length > 0 ? parts.join(" · ") : "Whole company";
  }

  const newBudgetButton = (
    <Button onClick={() => setModal({ budget: null })}>
      <Plus size={14} /> New budget
    </Button>
  );

  return (
    <div className="page-shell p-8">
      <TopBar
        title="Budgets"
        right={
          <div className="flex items-center gap-3">
            {rows !== null && rows.length > 0 && (
              <span className="text-sm tabular-nums text-slate-500 dark:text-slate-400">
                {rows.length === 1 ? "1 budget" : `${rows.length} budgets`}
              </span>
            )}
            {canManage && newBudgetButton}
          </div>
        }
      />

      {loadError ? (
        <FormError message={loadError} />
      ) : rows === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No budgets yet"
          description="Budgets cap what AI employees can authorize in ad spend each month. The tightest applicable envelope binds."
          action={canManage ? newBudgetButton : undefined}
        />
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white shadow-sm dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
          {rows.map((budget) => (
            <BudgetRow
              key={budget.id}
              company={company}
              budget={budget}
              scope={scopeLine(budget)}
              canManage={canManage}
              onEdit={(b) => setModal({ budget: b })}
              onChanged={reload}
            />
          ))}
        </ul>
      )}

      {modal && (
        <BudgetModal
          key={modal.budget?.id ?? "new"}
          company={company}
          budget={modal.budget}
          employees={employees}
          connections={connections}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────── rows ────────────────────────────────────

function BudgetRow({
  company,
  budget,
  scope,
  canManage,
  onEdit,
  onChanged,
}: {
  company: Company;
  budget: Budget;
  scope: string;
  canManage: boolean;
  onEdit: (budget: Budget) => void;
  onChanged: () => void;
}) {
  const dialog = useDialog();
  const [busy, setBusy] = React.useState(false);

  const exhausted = budget.spentThisMonthMinor >= budget.amountMinor;
  const progress = Math.min(1, Math.max(0, budget.spentThisMonthMinor / budget.amountMinor));

  async function toggle(enabled: boolean) {
    setBusy(true);
    try {
      await api.patch(`/api/companies/${company.id}/budgets/${budget.id}`, { enabled });
      onChanged();
    } catch (err) {
      void dialog.error(err, { title: "Could not update the budget" });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const ok = await dialog.confirm({
      title: `Delete “${budget.name}”?`,
      message:
        "Ad-spend increases inside this envelope's scope will no longer be capped by it. Any wider budget still binds.",
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.del(`/api/companies/${company.id}/budgets/${budget.id}`);
      onChanged();
    } catch (err) {
      void dialog.error(err, { title: "Could not delete the budget" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div
            className={clsx(
              "truncate text-sm font-medium",
              budget.enabled
                ? "text-slate-900 dark:text-slate-100"
                : "text-slate-400 dark:text-slate-500",
            )}
          >
            {budget.name}
          </div>
          <div className="truncate text-xs text-slate-500 dark:text-slate-400">{scope}</div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2">
          <div className="w-44">
            <div className="h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
              <div
                className={clsx(
                  "h-full rounded-full",
                  exhausted ? "bg-rose-500 dark:bg-rose-400" : "bg-indigo-500 dark:bg-indigo-400",
                )}
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
            <div
              className={clsx(
                "mt-1 text-[11px] tabular-nums",
                exhausted
                  ? "text-rose-600 dark:text-rose-400"
                  : "text-slate-500 dark:text-slate-400",
              )}
            >
              {formatMinor(budget.spentThisMonthMinor)} / {formatMinor(budget.amountMinor)}{" "}
              {budget.currency}
            </div>
          </div>

          {canManage ? (
            <>
              <EnabledToggle
                enabled={budget.enabled}
                label={`${budget.enabled ? "Disable" : "Enable"} budget ${budget.name}`}
                disabled={busy}
                onChange={(next) => void toggle(next)}
              />
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => onEdit(budget)}
                  aria-label={`Edit ${budget.name}`}
                >
                  <Pencil size={14} />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void remove()}
                  aria-label={`Delete ${budget.name}`}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            </>
          ) : (
            !budget.enabled && (
              <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                off
              </span>
            )
          )}
        </div>
      </div>
    </li>
  );
}

// ───────────────────────── create / edit modal ───────────────────────────

function BudgetModal({
  company,
  budget,
  employees,
  connections,
  onClose,
  onSaved,
}: {
  company: Company;
  /** Null creates; a budget edits it. */
  budget: Budget | null;
  employees: Employee[];
  connections: IntegrationConnection[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = React.useState(budget?.name ?? "");
  // Edited in major units; converted back to minor on submit.
  const [amount, setAmount] = React.useState(budget ? String(budget.amountMinor / 100) : "");
  const [currency, setCurrency] = React.useState(budget?.currency ?? "USD");
  const [connectionId, setConnectionId] = React.useState(budget?.connectionId ?? "");
  const [employeeId, setEmployeeId] = React.useState(budget?.employeeId ?? "");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amountMinor = Math.round(Number(amount) * 100);
    if (amount.trim() === "" || !Number.isFinite(amountMinor) || amountMinor < 1) {
      setError("The monthly cap must be a positive amount.");
      return;
    }
    setSaving(true);
    setError(null);
    const body = {
      name: name.trim(),
      amountMinor,
      currency: currency.trim().toUpperCase(),
      connectionId: connectionId || null,
      employeeId: employeeId || null,
    };
    try {
      if (budget) {
        await api.patch(`/api/companies/${company.id}/budgets/${budget.id}`, body);
      } else {
        await api.post(`/api/companies/${company.id}/budgets`, body);
      }
      onSaved();
    } catch (err) {
      setError(errorMessage(err, "Could not save the budget"));
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={budget ? `Edit: ${budget.name}` : "New budget"}
      description="A monthly cap on the ad spend AI employees may authorize. Calendar months, UTC."
      size="lg"
      onSubmit={save}
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {budget ? "Save changes" : "Create budget"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormError message={error} />

        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Paid search"
          maxLength={80}
          required
          autoFocus
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Monthly cap"
            type="number"
            step="0.01"
            min="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="1000"
            required
          />
          <Input
            label="Currency"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            maxLength={3}
            required
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Connection"
            value={connectionId}
            onChange={(e) => setConnectionId(e.target.value)}
          >
            <option value="">Any connection</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
          <Select
            label="Employee"
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
          >
            <option value="">Any employee</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </Select>
        </div>

        <p className="text-xs text-slate-500 dark:text-slate-400">
          Leave both scopes open to cap the whole company. When several budgets apply to one spend,
          the tightest envelope binds.
        </p>
      </div>
    </Modal>
  );
}
