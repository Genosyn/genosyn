import React from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Check, Sparkles } from "lucide-react";
import { api, Company, Employee, EmployeeTemplate } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { Spinner } from "../components/ui/Spinner";
import { Breadcrumbs, TopBar } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";
import { clsx } from "../components/ui/clsx";

/**
 * Hiring flow. Two steps, same page:
 *  1. Pick a template (or "blank") — previews the soul + skills + routines
 *     that will be scaffolded on create.
 *  2. Name + role. Defaults come from the template so the operator can
 *     usually hit "Hire" without typing.
 *
 * The template catalogue is global and static (see server/services/templates.ts),
 * so we fetch it once on mount.
 */
export default function EmployeeNew({ company }: { company: Company }) {
  const [templates, setTemplates] = React.useState<EmployeeTemplate[] | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [name, setName] = React.useState("");
  const [role, setRole] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const navigate = useNavigate();
  const { companySlug } = useParams();
  const { toast } = useToast();

  React.useEffect(() => {
    api
      .get<EmployeeTemplate[]>(`/api/employee-templates`)
      .then(setTemplates)
      .catch(() => setTemplates([]));
  }, []);

  function pick(t: EmployeeTemplate | null) {
    setSelected(t?.id ?? null);
    if (t) {
      if (!name) setName(t.name);
      if (!role) setRole(t.role);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const emp = await api.post<Employee>(`/api/companies/${company.id}/employees`, {
        name,
        role,
        templateId: selected ?? undefined,
      });
      navigate(`/c/${companySlug}/employees/${emp.slug}/settings`);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }

  const selectedTemplate = templates?.find((t) => t.id === selected) ?? null;

  return (
    <>
      <div className="mb-3">
        <Breadcrumbs
          items={[
            { label: "Employees", to: `/c/${companySlug}` },
            { label: "New" },
          ]}
        />
      </div>
      <TopBar title="Hire an AI Employee" />
      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <div>
              <h2 className="text-sm font-semibold">Pick a template</h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Templates come with a pre-written Soul, starter skills, and sometimes a routine.
                Start blank if you'd rather author everything yourself.
              </p>
            </div>
          </CardHeader>
          <CardBody>
            {templates === null ? (
              <Spinner />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <TemplateCard
                  selected={selected === null}
                  onPick={() => pick(null)}
                  title="Blank employee"
                  tagline="Start with an empty Soul and add skills yourself."
                  subtitle="No skills · No routines"
                  icon={<Sparkles size={14} />}
                />
                {templates.map((t) => (
                  <TemplateCard
                    key={t.id}
                    selected={selected === t.id}
                    onPick={() => pick(t)}
                    title={`${t.name} · ${t.role}`}
                    tagline={t.tagline}
                    subtitle={`${t.skills.length} ${
                      t.skills.length === 1 ? "skill" : "skills"
                    } · ${t.routines.length} ${
                      t.routines.length === 1 ? "routine" : "routines"
                    }`}
                  />
                ))}
              </div>
            )}
            {selectedTemplate && (
              <div className="mt-4 rounded-lg border border-slate-100 bg-slate-50 p-3 text-xs text-slate-600">
                <div className="mb-1 font-medium text-slate-800">
                  You'll get:
                </div>
                <ul className="list-inside list-disc space-y-0.5">
                  <li>A fully-written SOUL.md — you can edit it after.</li>
                  {selectedTemplate.skills.map((s) => (
                    <li key={s}>
                      Skill · <span className="font-medium text-slate-800">{s}</span>
                    </li>
                  ))}
                  {selectedTemplate.routines.map((r) => (
                    <li key={r.name}>
                      Routine · <span className="font-medium text-slate-800">{r.name}</span>{" "}
                      <code className="rounded bg-white px-1 py-0.5 text-[11px]">
                        {r.cronExpr}
                      </code>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <p className="text-sm text-slate-500">
              Name and role — you can change these later.
            </p>
          </CardHeader>
          <CardBody>
            <form className="flex flex-col gap-4" onSubmit={submit}>
              <Input
                label="Name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ada"
                required
              />
              <Input
                label="Role"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder="Research Analyst"
                required
              />
              <div className="flex gap-2">
                <Button type="submit" disabled={loading}>
                  {loading ? "Creating…" : "Hire employee"}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => navigate(`/c/${companySlug}`)}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>
      </div>
    </>
  );
}

function TemplateCard({
  selected,
  onPick,
  title,
  tagline,
  subtitle,
  icon,
}: {
  selected: boolean;
  onPick: () => void;
  title: string;
  tagline: string;
  subtitle: string;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={clsx(
        "relative rounded-lg border p-4 text-left transition",
        selected
          ? "border-indigo-300 bg-indigo-50 shadow-sm"
          : "border-slate-200 bg-white hover:border-slate-300",
      )}
    >
      {selected && (
        <span className="absolute right-3 top-3 rounded-full bg-indigo-600 p-1 text-white">
          <Check size={12} />
        </span>
      )}
      <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
        {icon}
        {title}
      </div>
      <div className="mt-1 text-xs text-slate-600">{tagline}</div>
      <div className="mt-2 text-[11px] uppercase tracking-wide text-slate-400">
        {subtitle}
      </div>
    </button>
  );
}
