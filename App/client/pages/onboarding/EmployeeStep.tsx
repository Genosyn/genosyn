import React from "react";
import { ArrowRight, Bot, CheckCircle2 } from "lucide-react";
import {
  AIModel,
  api,
  Company,
  Employee,
  EmployeeTemplate,
} from "../../lib/api";
import { Button } from "../../components/ui/Button";
import { Card, CardBody } from "../../components/ui/Card";
import { FormError } from "../../components/ui/FormError";
import { Input } from "../../components/ui/Input";
import { Spinner } from "../../components/ui/Spinner";
import { clsx } from "../../components/ui/clsx";
import { EmployeeModelSection } from "../employeeTabs";

const FEATURED_TEMPLATE_IDS = [
  "executive-assistant",
  "sdr",
  "research-analyst",
  "operations",
];

export function EmployeeStep({
  company,
  employee,
  onCreated,
  onContinue,
}: {
  company: Company;
  employee: Employee | null;
  onCreated: (employee: Employee) => void;
  onContinue: () => void;
}) {
  const [templates, setTemplates] = React.useState<EmployeeTemplate[] | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [name, setName] = React.useState("");
  const [role, setRole] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [checkingModel, setCheckingModel] = React.useState(false);
  const [modelWarning, setModelWarning] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    api
      .get<EmployeeTemplate[]>("/api/employee-templates")
      .then(setTemplates)
      .catch(() => setTemplates([]));
  }, []);

  function selectTemplate(template: EmployeeTemplate) {
    setSelectedId(template.id);
    setName(template.name);
    setRole(template.role);
  }

  async function createEmployee(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const created = await api.post<Employee>(`/api/companies/${company.id}/employees`, {
        name,
        role,
        ...(selectedId ? { templateId: selectedId } : {}),
      });
      onCreated(created);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function continueWithModelCheck() {
    if (!employee) return;
    setCheckingModel(true);
    try {
      const models = await api.get<AIModel[]>(
        `/api/companies/${company.id}/employees/${employee.id}/models`,
      );
      if (!models.some((model) => model.isActive && model.status === "connected")) {
        setModelWarning(
          `Connect an active AI Model so ${employee.name} can answer your first request, or continue and finish it later.`,
        );
        return;
      }
      onContinue();
    } catch (err) {
      setModelWarning((err as Error).message);
    } finally {
      setCheckingModel(false);
    }
  }

  if (!employee) {
    const featured =
      templates?.filter((template) => FEATURED_TEMPLATE_IDS.includes(template.id)) ?? [];
    return (
      <Card className="mx-auto max-w-3xl">
        <CardBody className="p-5 sm:p-7">
          <div className="mb-5">
            <div className="flex items-center gap-2">
              <Bot size={18} className="text-indigo-600 dark:text-indigo-400" />
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                Who should join the team?
              </h2>
            </div>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Pick a starting role. The template brings a ready-made Soul, Skills, and Routines
              that you can edit any time.
            </p>
          </div>

          {templates === null ? (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {featured.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => selectTemplate(template)}
                  className={clsx(
                    "rounded-xl border p-4 text-left transition",
                    selectedId === template.id
                      ? "border-indigo-500 bg-indigo-50 ring-2 ring-indigo-100 dark:bg-indigo-950/40 dark:ring-indigo-950"
                      : "border-slate-200 hover:border-indigo-300 hover:bg-slate-50 dark:border-slate-700 dark:hover:border-indigo-700 dark:hover:bg-slate-800/50",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {template.role}
                    </span>
                    {selectedId === template.id && (
                      <CheckCircle2 size={14} className="ml-auto text-indigo-600" />
                    )}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                    {template.tagline}
                  </p>
                </button>
              ))}
            </div>
          )}

          <form className="mt-6 space-y-4" onSubmit={createEmployee}>
            <FormError message={error} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="Name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Avery"
                required
              />
              <Input
                label="Role"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder="Executive Assistant"
                required
              />
            </div>
            <div className="flex justify-end">
              <Button type="submit" disabled={creating}>
                {creating ? "Hiring…" : "Hire AI Employee"}
                {!creating && <ArrowRight size={15} />}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Card>
        <CardBody className="flex items-center gap-3 p-4">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
            <Bot size={18} />
          </div>
          <div className="min-w-0">
            <div className="font-medium text-slate-900 dark:text-slate-100">{employee.name}</div>
            <div className="text-xs text-slate-500 dark:text-slate-400">{employee.role}</div>
          </div>
          <span className="ml-auto flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 size={14} /> Hired
          </span>
        </CardBody>
      </Card>

      <div>
        <div className="mb-3">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Connect {employee.name}&apos;s AI Model
          </h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            The active model is the default for chat and powers Routines. Credentials are encrypted
            at rest.
          </p>
        </div>
        <EmployeeModelSection company={company} emp={employee} />
      </div>

      {modelWarning && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          {modelWarning}
          <button
            type="button"
            onClick={onContinue}
            className="ml-1 font-medium underline underline-offset-2"
          >
            Continue without a model
          </button>
        </div>
      )}

      <div className="flex justify-end">
        <Button onClick={continueWithModelCheck} disabled={checkingModel}>
          {checkingModel ? "Checking…" : "Continue to email"}
          {!checkingModel && <ArrowRight size={15} />}
        </Button>
      </div>
    </div>
  );
}
