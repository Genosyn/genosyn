import React from "react";
import { useNavigate, useOutletContext, useSearchParams } from "react-router-dom";
import { api, Company, Routine } from "../lib/api";
import { Breadcrumbs, TopBar } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Card, CardBody } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { CRON_PRESETS, DEFAULT_CRON, cronHuman, cronIsReadable } from "../lib/cron";
import { RoutinesContext } from "./RoutinesLayout";

/**
 * Create a routine from the company-level section. The employee-scoped modal
 * this replaces could assume its target; here the employee is a field, since
 * a routine is always *somebody's* work.
 */
export default function RoutineNew({ company }: { company: Company }) {
  const { employees, refresh } = useOutletContext<RoutinesContext>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  // Coming from an employee filter, pre-select that employee.
  const preset = searchParams.get("employee");
  const [employeeId, setEmployeeId] = React.useState("");
  const [name, setName] = React.useState("");
  const [cronExpr, setCronExpr] = React.useState(DEFAULT_CRON);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // The roster arrives with the layout's fetch, so seed the picker once it
  // lands rather than in useState's initializer.
  React.useEffect(() => {
    if (employeeId || employees.length === 0) return;
    const match = preset ? employees.find((e) => e.slug === preset) : null;
    setEmployeeId(match?.id ?? employees[0].id);
  }, [employees, preset, employeeId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const created = await api.post<Routine>(
        `/api/companies/${company.id}/employees/${employeeId}/routines`,
        { name: name.trim(), cronExpr: cronExpr.trim() },
      );
      await refresh();
      const emp = employees.find((x) => x.id === employeeId);
      navigate(
        emp
          ? `/c/${company.slug}/routines/${emp.slug}/${created.slug}`
          : `/c/${company.slug}/routines`,
        { replace: true },
      );
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  if (employees.length === 0) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Breadcrumbs
          items={[{ label: "Routines", to: `/c/${company.slug}/routines` }, { label: "New" }]}
        />
        <TopBar title="New routine" />
        <EmptyState
          title="No AI employees yet"
          description="A routine is work an AI employee performs on a schedule, so you need an employee to assign it to first."
          action={
            <Button onClick={() => navigate(`/c/${company.slug}/employees/new`)}>
              New AI employee
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <Breadcrumbs
        items={[{ label: "Routines", to: `/c/${company.slug}/routines` }, { label: "New" }]}
      />
      <TopBar title="New routine" />
      <Card>
        <CardBody>
          <form className="flex flex-col gap-4" onSubmit={submit}>
            <Input
              label="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Morning inbox digest"
              required
              autoFocus
            />

            <Select
              label="Assigned to"
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              required
            >
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                  {e.role ? ` — ${e.role}` : ""}
                </option>
              ))}
            </Select>

            <div className="flex flex-col gap-1">
              <Input
                label="Schedule"
                value={cronExpr}
                onChange={(e) => setCronExpr(e.target.value)}
                className="font-mono"
                required
              />
              <div
                className={
                  "text-xs " +
                  (cronIsReadable(cronExpr)
                    ? "text-slate-500 dark:text-slate-400"
                    : "text-amber-600 dark:text-amber-400")
                }
              >
                {cronIsReadable(cronExpr)
                  ? cronHuman(cronExpr)
                  : "Not a schedule we can read — check the expression."}
              </div>
              <div className="mt-1 flex flex-wrap gap-2">
                {CRON_PRESETS.map((p) => (
                  <button
                    key={p.expr}
                    type="button"
                    onClick={() => setCronExpr(p.expr)}
                    className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <p className="text-xs text-slate-500 dark:text-slate-400">
              You&apos;ll write the brief — what the employee should actually do each
              time this fires — on the next screen.
            </p>

            {error && <FormError message={error} />}

            <div className="flex gap-2">
              <Button type="submit" disabled={saving || !name.trim()}>
                {saving ? "Creating…" : "Create routine"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => navigate(`/c/${company.slug}/routines`)}
              >
                Cancel
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
