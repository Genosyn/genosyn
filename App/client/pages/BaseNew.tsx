import React from "react";
import { useNavigate } from "react-router-dom";
import { Check } from "lucide-react";
import { api, Base, BaseTemplateSummary, Company } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { FormError } from "../components/ui/FormError";
import { Breadcrumbs } from "../components/AppShell";
import { Spinner } from "../components/ui/Spinner";
import { useBases } from "./BasesLayout";
import { BaseIcon, baseAccent } from "../components/BaseIcons";
import { clsx } from "../components/ui/clsx";

export default function BaseNew({ company }: { company: Company }) {
  const navigate = useNavigate();
  const { reload } = useBases();

  const [templates, setTemplates] = React.useState<BaseTemplateSummary[] | null>(
    null,
  );
  const [templateId, setTemplateId] = React.useState<string>("blank");
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const touched = React.useRef(false);

  React.useEffect(() => {
    api
      .get<BaseTemplateSummary[]>(`/api/companies/${company.id}/base-templates`)
      .then(setTemplates)
      .catch(() => setTemplates([]));
  }, [company.id]);

  // Default the name to the template name so the user can just click Create.
  React.useEffect(() => {
    if (touched.current || !templates) return;
    const t = templates.find((x) => x.id === templateId);
    if (t) setName(t.id === "blank" ? "" : t.name);
  }, [templateId, templates]);

  async function create() {
    const n = name.trim();
    if (!n) return;
    setError(null);
    setBusy(true);
    try {
      const b = await api.post<Base>(`/api/companies/${company.id}/bases`, {
        name: n,
        templateId: templateId === "blank" ? undefined : templateId,
      });
      await reload();
      navigate(`/c/${company.slug}/bases/${b.slug}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="border-b border-slate-200 bg-white px-6 py-4 dark:bg-slate-900 dark:border-slate-700">
        <Breadcrumbs
          items={[
            { label: "Bases", to: `/c/${company.slug}/bases` },
            { label: "New base" },
          ]}
        />
        <h1 className="mt-2 text-xl font-semibold text-slate-900 dark:text-slate-100">
          Create a base
        </h1>
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
          Pick a template to start with a familiar shape — you can edit everything after.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto w-full max-w-5xl">
          {templates === null ? (
            <div className="flex justify-center py-12">
              <Spinner />
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {templates.map((t) => (
                <button
                  key={t.id}
                  onClick={() => {
                    setTemplateId(t.id);
                  }}
                  className={clsx(
                    "group relative flex h-full flex-col rounded-xl border p-4 text-left transition",
                    templateId === t.id
                      ? "border-indigo-500 bg-indigo-50/40 ring-2 ring-indigo-200 dark:bg-indigo-500/10 dark:ring-indigo-800"
                      : "border-slate-200 bg-white hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-slate-600",
                  )}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={
                        "flex h-10 w-10 items-center justify-center rounded-lg " +
                        baseAccent(t.color, "tile")
                      }
                    >
                      <BaseIcon name={t.icon} size={18} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                          {t.name}
                        </span>
                        {templateId === t.id && (
                          <Check
                            size={14}
                            className="shrink-0 text-indigo-600 dark:text-indigo-400"
                          />
                        )}
                      </div>
                      <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                        {t.tableCount}{" "}
                        {t.tableCount === 1 ? "table" : "tables"}
                      </div>
                    </div>
                  </div>
                  <p className="mt-3 line-clamp-2 text-xs text-slate-600 dark:text-slate-300">
                    {t.tagline}
                  </p>
                  {t.tableNames.length > 1 && (
                    <div className="mt-3 flex flex-wrap gap-1">
                      {t.tableNames.map((tn) => (
                        <span
                          key={tn}
                          className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                        >
                          {tn}
                        </span>
                      ))}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}

          <div className="mt-6 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900">
            {error && (
              <div className="mb-3">
                <FormError message={error} />
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
              <Input
                label="Base name"
                value={name}
                onChange={(e) => {
                  touched.current = true;
                  setName(e.target.value);
                }}
                placeholder="e.g. Q3 CRM"
                onKeyDown={(e) => {
                  if (e.key === "Enter") create();
                }}
              />
              <div className="flex justify-end gap-2">
                <Button
                  variant="secondary"
                  onClick={() => navigate(`/c/${company.slug}/bases`)}
                  disabled={busy}
                >
                  Cancel
                </Button>
                <Button onClick={create} disabled={busy || !name.trim()}>
                  {busy ? "Creating…" : "Create base"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
