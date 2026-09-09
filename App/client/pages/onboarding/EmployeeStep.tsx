import React from "react";
import {
  AlertCircle,
  ArrowRight,
  Bot,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  ScrollText,
} from "lucide-react";
import { AIModel, api, Company, Employee, EmployeeTemplate } from "../../lib/api";
import { Button } from "../../components/ui/Button";
import { FormError } from "../../components/ui/FormError";
import { Input } from "../../components/ui/Input";
import { Spinner } from "../../components/ui/Spinner";
import { clsx } from "../../components/ui/clsx";
import { EmployeeModelSection } from "../employeeTabs";
import { Note, StepCard, StepFooter, StepHeading } from "./OnboardingFrame";

const FEATURED_TEMPLATE_IDS = ["executive-assistant", "sdr", "research-analyst", "operations"];

export function EmployeeStep({
  company,
  employee,
  onCreated,
  onBack,
  onContinue,
}: {
  company: Company;
  employee: Employee | null;
  onCreated: (employee: Employee, templateId: string | null) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const [templates, setTemplates] = React.useState<EmployeeTemplate[] | null>(null);
  const [templatesError, setTemplatesError] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [name, setName] = React.useState("");
  const [role, setRole] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [checkingModel, setCheckingModel] = React.useState(false);
  const [modelMissing, setModelMissing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const loadTemplates = React.useCallback(() => {
    setTemplates(null);
    setTemplatesError(null);
    api
      .get<EmployeeTemplate[]>("/api/employee-templates")
      .then(setTemplates)
      .catch((err) => {
        // An empty picker after a failed request reads as "this instance has
        // no roles", which is a lie that costs the member a support ticket.
        setTemplates([]);
        setTemplatesError((err as Error).message);
      });
  }, []);

  React.useEffect(loadTemplates, [loadTemplates]);

  function selectTemplate(template: EmployeeTemplate) {
    setSelectedId(template.id);
    // Never clobber a name the member typed themselves.
    setName((current) => (current.trim() === "" ? template.name : current));
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
      onCreated(created, selectedId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function continueWithModelCheck() {
    if (!employee) return;
    setCheckingModel(true);
    setError(null);
    try {
      const models = await api.get<AIModel[]>(
        `/api/companies/${company.id}/employees/${employee.id}/models`,
      );
      if (!models.some((model) => model.isActive && model.status === "connected")) {
        setModelMissing(true);
        return;
      }
      onContinue();
    } catch (err) {
      // A failed request is not advice about AI Models — keep the two apart so
      // a transient 500 does not teach the wrong mental model.
      setError((err as Error).message);
    } finally {
      setCheckingModel(false);
    }
  }

  if (!employee) {
    const featured =
      templates?.filter((template) => FEATURED_TEMPLATE_IDS.includes(template.id)) ?? [];
    return (
      <StepCard>
        <StepHeading
          icon={Bot}
          title="Hire your first AI Employee"
          description="Choose a starting role or write your own. We prepare their Soul and Skills, then suggest Routines based on their role and your company’s direction."
        />

        <div className="mt-5">
          {templates === null ? (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          ) : templatesError !== null ? (
            <Note kind="warn" icon={AlertCircle} title="We could not load the starting roles">
              {templatesError} You can still hire someone by typing a name and role below.
              <button
                type="button"
                onClick={loadTemplates}
                className="ml-1 inline-flex items-center gap-1 font-medium underline underline-offset-2"
              >
                <RefreshCw size={12} /> Try again
              </button>
            </Note>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {featured.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => selectTemplate(template)}
                  aria-pressed={selectedId === template.id}
                  className={clsx(
                    "rounded-xl border p-4 text-left transition",
                    selectedId === template.id
                      ? "border-indigo-500 bg-indigo-50 ring-2 ring-indigo-100 dark:bg-indigo-500/10 dark:ring-indigo-500/30"
                      : "border-slate-200 hover:border-indigo-300 hover:bg-slate-50 dark:border-slate-700 dark:hover:border-indigo-500/60 dark:hover:bg-slate-800/50",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {template.role}
                    </span>
                    {selectedId === template.id && (
                      <CheckCircle2
                        size={14}
                        className="ml-auto shrink-0 text-indigo-600 dark:text-indigo-400"
                      />
                    )}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                    {template.tagline}
                  </p>
                </button>
              ))}
            </div>
          )}
        </div>

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
              onChange={(e) => {
                setRole(e.target.value);
                setSelectedId(null);
              }}
              placeholder="Executive Assistant"
              required
            />
          </div>
          <StepFooter onBack={onBack}>
            <Button type="submit" className="w-full sm:w-auto" disabled={creating}>
              {creating ? "Hiring…" : "Hire AI Employee"}
              {!creating && <ArrowRight size={15} />}
            </Button>
          </StepFooter>
        </form>
      </StepCard>
    );
  }

  return (
    <div className="space-y-4">
      <StepCard>
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300">
            <CheckCircle2 size={18} />
          </span>
          <div className="min-w-0">
            <div className="font-medium text-slate-900 dark:text-slate-100">
              {employee.name} is hired
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">{employee.role}</div>
          </div>
          {/* Deliberately only claims the Soul: hiring without a template
            creates no Skill rows at all. */}
          <span className="ml-auto hidden items-center gap-1.5 text-xs text-slate-500 sm:flex dark:text-slate-400">
            <ScrollText size={13} /> Soul ready to edit
          </span>
        </div>
      </StepCard>

      <StepCard>
        <StepHeading
          icon={Bot}
          title={`Connect ${employee.name}'s AI Model`}
          description="Connect Claude or OpenAI: we find available models and test the connection automatically. Custom endpoints are also available. API usage is billed by your model company."
        />

        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
          <a
            href="https://console.anthropic.com/settings/keys"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            Get an Anthropic key <ExternalLink size={11} />
          </a>
          <a
            href="https://platform.openai.com/api-keys"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            Get an OpenAI key <ExternalLink size={11} />
          </a>
        </div>

        <div className="mt-4">
          <EmployeeModelSection company={company} emp={employee} />
        </div>
      </StepCard>

      {error && <FormError message={error} />}

      {modelMissing && (
        <Note kind="warn" icon={AlertCircle} title="No AI Model is connected yet">
          {employee.name} cannot answer a request or run a Routine until one is. Finish the
          connection above, or connect it later from their Settings.
        </Note>
      )}

      <StepFooter
        onBack={onBack}
        secondary={
          modelMissing ? (
            <Button variant="secondary" className="w-full sm:w-auto" onClick={onContinue}>
              Continue without a model
            </Button>
          ) : undefined
        }
      >
        <Button
          className="w-full sm:w-auto"
          onClick={continueWithModelCheck}
          disabled={checkingModel}
        >
          {checkingModel ? "Checking…" : "Choose Routines"}
          {!checkingModel && <ArrowRight size={15} />}
        </Button>
      </StepFooter>
    </div>
  );
}
