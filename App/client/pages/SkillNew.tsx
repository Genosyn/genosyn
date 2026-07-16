import React from "react";
import { useNavigate, useOutletContext, useSearchParams } from "react-router-dom";
import { api, Company, Skill } from "../lib/api";
import { Breadcrumbs, TopBar } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Card, CardBody } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { SkillsContext } from "./SkillsLayout";

/**
 * Create a skill from the company-level section. The employee-scoped modal
 * this replaces could assume its target; here the employee is a field, since
 * a skill is always *somebody's* playbook.
 */
export default function SkillNew({ company }: { company: Company }) {
  const { employees, refresh } = useOutletContext<SkillsContext>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  // Coming from an employee filter, pre-select that employee.
  const preset = searchParams.get("employee");
  const [employeeId, setEmployeeId] = React.useState("");
  const [name, setName] = React.useState("");
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
      const created = await api.post<Skill>(
        `/api/companies/${company.id}/employees/${employeeId}/skills`,
        { name: name.trim() },
      );
      await refresh();
      const emp = employees.find((x) => x.id === employeeId);
      navigate(
        emp
          ? `/c/${company.slug}/skills/${emp.slug}/${created.slug}`
          : `/c/${company.slug}/skills`,
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
          items={[{ label: "Skills", to: `/c/${company.slug}/skills` }, { label: "New" }]}
        />
        <TopBar title="New skill" />
        <EmptyState
          title="No AI employees yet"
          description="A skill is a playbook an AI employee follows, so you need an employee to teach it to first."
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
        items={[{ label: "Skills", to: `/c/${company.slug}/skills` }, { label: "New" }]}
      />
      <TopBar title="New skill" />
      <Card>
        <CardBody>
          <form className="flex flex-col gap-4" onSubmit={submit}>
            <Input
              label="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Qualify an inbound lead"
              required
              autoFocus
            />

            <Select
              label="Known by"
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

            <p className="text-xs text-slate-500 dark:text-slate-400">
              You&apos;ll write the playbook — the procedure the employee actually
              follows — on the next screen.
            </p>

            {error && <FormError message={error} />}

            <div className="flex gap-2">
              <Button type="submit" disabled={saving || !name.trim()}>
                {saving ? "Creating…" : "Create skill"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => navigate(`/c/${company.slug}/skills`)}
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
