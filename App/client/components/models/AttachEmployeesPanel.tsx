import React from "react";
import { api, type AIModel, type Company, type Employee } from "@/lib/api";
import { attachCandidates, companyModelPath, nameList } from "@/lib/companyModels";
import { errorMessage } from "@/lib/errors";
import { describeModel } from "@/lib/modelSummary";
import { Avatar, employeeAvatarUrl } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { FormError } from "@/components/ui/FormError";
import { Spinner } from "@/components/ui/Spinner";

/**
 * Attaching one company AI Model to AI Employees, from its card in Settings →
 * AI Models: every employee not on it yet, each with what it runs on now, and
 * one button for all the ticked ones. Whoever is attached switches to this
 * model; Make active on their own Model page switches back. The keys stay
 * where they are — nothing is copied, so there is one set to rotate.
 */
export function AttachEmployeesPanel({
  company,
  model,
  onCancel,
  onAttached,
}: {
  company: Pick<Company, "id">;
  model: AIModel;
  onCancel: () => void;
  onAttached: () => void;
}) {
  const [employees, setEmployees] = React.useState<Employee[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [chosen, setChosen] = React.useState<Set<string>>(new Set());
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    api
      .get<Employee[]>(`/api/companies/${company.id}/employees`)
      .then((list) => {
        if (!cancelled) setEmployees([...list].sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [company.id]);

  const candidates = employees ? attachCandidates(employees, model) : [];
  const picked = candidates.filter((employee) => chosen.has(employee.id));

  function toggle(id: string) {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function attach() {
    setError(null);
    setSaving(true);
    try {
      await api.post(companyModelPath(company.id, model.id, "/attach"), {
        employeeIds: picked.map((employee) => employee.id),
      });
      onAttached();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-medium text-slate-700 dark:text-slate-200">
            Attach to AI Employees
          </div>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Each one you pick switches to this AI Model, with the same keys — nothing is copied.
            Make active on their Model page switches back.
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
      {loadError ? (
        <FormError message={loadError} />
      ) : employees === null ? (
        <div className="flex justify-center py-2">
          <Spinner size={16} />
        </div>
      ) : candidates.length === 0 ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {employees.length === 0
            ? "Your company has no AI Employees yet."
            : "Every AI Employee already uses this AI Model."}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-slate-100 dark:divide-slate-800">
          {candidates.map((employee) => (
            <li key={employee.id}>
              <label className="flex cursor-pointer items-center gap-3 py-2">
                <Checkbox
                  checked={chosen.has(employee.id)}
                  label={`Attach to ${employee.name}`}
                  onChange={() => toggle(employee.id)}
                  disabled={saving}
                />
                <Avatar
                  name={employee.name}
                  kind="ai"
                  size="sm"
                  src={employeeAvatarUrl(company.id, employee.id, employee.avatarKey)}
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm text-slate-900 dark:text-slate-100">
                    {employee.name}
                  </span>
                  <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                    {employee.model
                      ? `Now on ${describeModel({
                          provider: employee.model.provider,
                          authMode: employee.model.authMode ?? "apikey",
                          model: employee.model.model,
                        })}`
                      : "No AI Model yet"}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <FormError message={error} />
      {candidates.length > 0 && (
        <div>
          <Button onClick={attach} loading={saving} disabled={picked.length === 0}>
            {picked.length === 0
              ? "Attach"
              : picked.length === 1
                ? `Attach to ${picked[0].name}`
                : picked.length === 2
                  ? `Attach to ${nameList(picked.map((employee) => employee.name))}`
                  : `Attach to ${picked.length} AI Employees`}
          </Button>
        </div>
      )}
    </div>
  );
}
