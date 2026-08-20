import React from "react";
import {
  AlertCircle,
  Bot,
  CalendarClock,
  Check,
  Clock3,
  Info,
  Save,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";

import { Breadcrumbs } from "@/components/AppShell";
import { useLiveRefetch } from "@/components/CompanySocket";
import { Avatar, employeeAvatarUrl } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { clsx } from "@/components/ui/clsx";
import { formatRelative } from "@/components/decisions/relative";
import {
  api,
  type Employee,
  type TldrCadence,
  type TldrGenerateResponse,
  type TldrSettings,
} from "@/lib/api";
import type { TldrsOutletContext } from "@/pages/TldrsLayout";

type Draft = Pick<TldrSettings, "enabled" | "cadence" | "employeeId">;

const CADENCES: Array<{
  value: TldrCadence;
  label: string;
  short: string;
  description: string;
}> = [
  {
    value: "four_hours",
    label: "Every 4 hours",
    short: "4h",
    description: "For fast-moving teams",
  },
  {
    value: "eight_hours",
    label: "Every 8 hours",
    short: "8h",
    description: "Across a working day",
  },
  {
    value: "twelve_hours",
    label: "Every 12 hours",
    short: "12h",
    description: "Morning and evening",
  },
  { value: "daily", label: "Daily", short: "1d", description: "One daily briefing" },
  { value: "weekly", label: "Weekly", short: "1w", description: "The bigger picture" },
];

function toDraft(settings: TldrSettings): Draft {
  return {
    enabled: settings.enabled,
    cadence: settings.cadence,
    employeeId: settings.employeeId,
  };
}

export default function TldrSettingsPage() {
  const { company } = useOutletContext<TldrsOutletContext>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [settings, setSettings] = React.useState<TldrSettings | null>(null);
  const [employees, setEmployees] = React.useState<Employee[] | null>(null);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [generating, setGenerating] = React.useState(false);
  const dirtyRef = React.useRef(false);

  const dirty = Boolean(
    settings &&
    draft &&
    (settings.enabled !== draft.enabled ||
      settings.cadence !== draft.cadence ||
      settings.employeeId !== draft.employeeId),
  );
  dirtyRef.current = dirty;

  const reload = React.useCallback(async () => {
    setLoadError(null);
    try {
      const [nextSettings, roster] = await Promise.all([
        api.get<TldrSettings>(`/api/companies/${company.id}/tldrs/settings`),
        api.get<Employee[]>(`/api/companies/${company.id}/employees`),
      ]);
      setSettings(nextSettings);
      setEmployees(roster);
      if (!dirtyRef.current) setDraft(toDraft(nextSettings));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load TLDR settings.");
    }
  }, [company.id]);

  React.useEffect(() => {
    setSettings(null);
    setEmployees(null);
    setDraft(null);
    void reload();
  }, [reload]);

  useLiveRefetch("tldr", reload);

  const connectedEmployees = (employees ?? []).filter(
    (employee) => employee.model?.status === "connected",
  );
  const selectedEmployee = employees?.find((employee) => employee.id === draft?.employeeId) ?? null;
  const canManage = company.role !== "member";
  const base = `/c/${company.slug}/tldrs`;

  async function persistDraft(showSuccess = true): Promise<boolean> {
    if (!draft || (draft.enabled && !draft.employeeId)) return false;
    setSaving(true);
    setSaveError(null);
    try {
      await api.put(`/api/companies/${company.id}/tldrs/settings`, draft);
      const fresh = await api.get<TldrSettings>(`/api/companies/${company.id}/tldrs/settings`);
      setSettings(fresh);
      setDraft(toDraft(fresh));
      if (showSuccess) toast("TLDR schedule saved", "success");
      return true;
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not save TLDR settings.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function generateNow() {
    if (!draft?.employeeId || !canManage) return;
    if (dirty && !(await persistDraft(false))) return;
    setGenerating(true);
    setSaveError(null);
    try {
      const result = await api.post<TldrGenerateResponse>(
        `/api/companies/${company.id}/tldrs/generate`,
      );
      if (result.status === "empty") {
        toast("There is no new company activity to summarize yet.", "info");
        await reload();
        return;
      }
      toast("TLDR created", "success");
      navigate(`${base}#tldr-${result.tldr.id}`);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not generate a TLDR.");
    } finally {
      setGenerating(false);
    }
  }

  if ((!settings || !employees || !draft) && !loadError) {
    return (
      <div className="flex min-h-[55vh] items-center justify-center">
        <Spinner size={22} />
      </div>
    );
  }

  return (
    <div className="page-shell px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      <Breadcrumbs items={[{ label: "TLDRs", to: base }, { label: "Settings" }]} />

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300">
            <CalendarClock size={19} />
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
              TLDR settings
            </h1>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500 dark:text-slate-400">
              Choose the AI Employee who writes your company briefings and how often a new one
              should land.
            </p>
          </div>
        </div>
        {!canManage && (
          <span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
            View only · owners and admins manage this schedule
          </span>
        )}
      </div>

      {loadError && (
        <div className="mt-5 flex flex-col gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 sm:flex-row sm:items-center dark:border-rose-500/25 dark:bg-rose-500/10">
          <AlertCircle size={18} className="shrink-0 text-rose-600 dark:text-rose-300" />
          <div className="min-w-0 flex-1 text-sm text-rose-800 dark:text-rose-200">{loadError}</div>
          <Button size="sm" variant="secondary" onClick={() => void reload()}>
            Try again
          </Button>
        </div>
      )}

      {settings && employees && draft && (
        <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_19rem]">
          <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
            <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4 dark:border-slate-800">
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Automatic briefings
                </h2>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  Pausing keeps the history and stops future scheduled TLDRs.
                </p>
              </div>
              <Switch
                checked={draft.enabled}
                disabled={!canManage}
                label="Automatic TLDRs"
                onChange={(enabled) =>
                  setDraft((current) => (current ? { ...current, enabled } : current))
                }
              />
            </div>

            <div className="space-y-7 p-5">
              <div>
                <div className="mb-2 flex items-center gap-2">
                  <Bot size={15} className="text-slate-400" />
                  <label className="text-sm font-medium text-slate-800 dark:text-slate-200">
                    Briefing AI Employee
                  </label>
                </div>
                <Select
                  value={draft.employeeId ?? ""}
                  onChange={(event) =>
                    setDraft((current) =>
                      current ? { ...current, employeeId: event.target.value || null } : current,
                    )
                  }
                  disabled={!canManage || connectedEmployees.length === 0}
                  aria-label="Briefing AI Employee"
                >
                  <option value="">Choose an AI Employee…</option>
                  {employees.map((employee) => {
                    const connected = employee.model?.status === "connected";
                    return (
                      <option key={employee.id} value={employee.id} disabled={!connected}>
                        {employee.name}
                        {employee.role ? ` — ${employee.role}` : ""}
                        {!connected ? " — connect an AI Model first" : ""}
                      </option>
                    );
                  })}
                </Select>

                {selectedEmployee && (
                  <div className="mt-3 flex items-center gap-3 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2.5 dark:border-slate-800 dark:bg-slate-900">
                    <Avatar
                      name={selectedEmployee.name}
                      src={employeeAvatarUrl(
                        company.id,
                        selectedEmployee.id,
                        selectedEmployee.avatarKey,
                      )}
                      kind="ai"
                      size="md"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                        {selectedEmployee.name}
                      </div>
                      <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                        {selectedEmployee.role || "AI Employee"}
                      </div>
                    </div>
                    <span
                      className={clsx(
                        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium",
                        selectedEmployee.model?.status === "connected"
                          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
                          : "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300",
                      )}
                    >
                      <span
                        className={clsx(
                          "h-1.5 w-1.5 rounded-full",
                          selectedEmployee.model?.status === "connected"
                            ? "bg-emerald-500"
                            : "bg-amber-500",
                        )}
                      />
                      {selectedEmployee.model?.status === "connected"
                        ? selectedEmployee.model.model
                        : "AI Model needed"}
                    </span>
                  </div>
                )}

                {connectedEmployees.length === 0 && (
                  <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200">
                    <Info size={14} className="mt-0.5 shrink-0" />
                    <span>
                      Connect an AI Model to an AI Employee before assigning the company briefing.{" "}
                      <Link
                        to={`/c/${company.slug}/employees`}
                        className="font-medium underline underline-offset-2"
                      >
                        Open AI Employees
                      </Link>
                    </span>
                  </div>
                )}
              </div>

              <div>
                <div className="mb-3 flex items-center gap-2">
                  <Clock3 size={15} className="text-slate-400" />
                  <div>
                    <div className="text-sm font-medium text-slate-800 dark:text-slate-200">
                      Cadence
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      Each TLDR covers activity since the previous successful briefing.
                    </div>
                  </div>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
                  {CADENCES.map((cadence) => {
                    const active = draft.cadence === cadence.value;
                    return (
                      <button
                        key={cadence.value}
                        type="button"
                        disabled={!canManage}
                        onClick={() =>
                          setDraft((current) =>
                            current ? { ...current, cadence: cadence.value } : current,
                          )
                        }
                        className={clsx(
                          "relative rounded-xl border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-60",
                          active
                            ? "border-violet-300 bg-violet-50 ring-1 ring-violet-200 dark:border-violet-500/40 dark:bg-violet-500/10 dark:ring-violet-500/20"
                            : "border-slate-200 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:hover:border-slate-600 dark:hover:bg-slate-900",
                        )}
                        aria-pressed={active}
                      >
                        <span className="block text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                          {cadence.short}
                        </span>
                        <span className="mt-1 block text-xs font-medium text-slate-700 dark:text-slate-300">
                          {cadence.label}
                        </span>
                        <span className="mt-0.5 block text-[10px] leading-4 text-slate-400 dark:text-slate-500">
                          {cadence.description}
                        </span>
                        {active && (
                          <span className="absolute right-2 top-2 flex h-4 w-4 items-center justify-center rounded-full bg-violet-600 text-white dark:bg-violet-500">
                            <Check size={10} />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              <FormError message={saveError} />

              {canManage && (
                <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
                  <Button
                    onClick={() => void persistDraft()}
                    disabled={saving || generating || !dirty || (draft.enabled && !draft.employeeId)}
                  >
                    {saving ? <Spinner size={14} /> : <Save size={14} />}
                    {saving ? "Saving…" : "Save changes"}
                  </Button>
                  {dirty && (
                    <span className="text-xs text-amber-600 dark:text-amber-400">
                      You have unsaved changes
                    </span>
                  )}
                </div>
              )}
            </div>
          </section>

          <aside className="space-y-4">
            <section className="rounded-xl border border-violet-200 bg-violet-50/60 p-4 shadow-sm dark:border-violet-500/25 dark:bg-violet-500/10">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-100 text-violet-600 dark:bg-violet-500/20 dark:text-violet-300">
                <Sparkles size={17} />
              </span>
              <h2 className="mt-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
                Need a briefing now?
              </h2>
              <p className="mt-1 text-xs leading-5 text-slate-600 dark:text-slate-400">
                Generate from activity since the last successful TLDR. Unsaved settings are saved
                first.
              </p>
              {canManage ? (
                <Button
                  className="mt-4 w-full"
                  onClick={() => void generateNow()}
                  disabled={saving || generating || !draft.employeeId}
                >
                  {generating ? <Spinner size={14} /> : <Sparkles size={14} />}
                  {generating ? "Generating…" : "Generate now"}
                </Button>
              ) : (
                <p className="mt-3 text-[11px] text-slate-500 dark:text-slate-400">
                  Ask a company owner or admin to generate one manually.
                </p>
              )}
            </section>

            <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                Schedule status
              </h2>
              <dl className="mt-3 space-y-3">
                <StatusRow
                  label="Next briefing"
                  value={
                    settings.enabled
                      ? settings.nextRunAt
                        ? formatStatusTime(settings.nextRunAt)
                        : "Being scheduled"
                      : "Paused"
                  }
                />
                <StatusRow
                  label="Last generated"
                  value={
                    settings.lastGeneratedAt
                      ? formatStatusTime(settings.lastGeneratedAt)
                      : "Not yet"
                  }
                />
                <StatusRow
                  label="Covered through"
                  value={
                    settings.lastCoveredAt
                      ? formatStatusTime(settings.lastCoveredAt)
                      : "No activity yet"
                  }
                />
              </dl>
            </section>

            <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950">
              <div className="flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-200">
                <ShieldCheck size={15} className="text-emerald-600 dark:text-emerald-400" />
                Private by design
              </div>
              <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
                TLDRs use only public Workspace channels and company-visible journal and Run
                activity. Private channels, DMs, and direct chats are never included.
              </p>
            </section>

            {settings.lastError && (
              <section className="rounded-xl border border-rose-200 bg-rose-50 p-4 dark:border-rose-500/25 dark:bg-rose-500/10">
                <div className="flex items-center gap-2 text-sm font-medium text-rose-800 dark:text-rose-200">
                  <AlertCircle size={15} /> Last attempt failed
                </div>
                <p className="mt-2 break-words text-xs leading-5 text-rose-700 dark:text-rose-300">
                  {settings.lastError}
                </p>
                {settings.lastAttemptAt && (
                  <p className="mt-2 text-[10px] text-rose-500 dark:text-rose-400">
                    Attempted {formatRelative(settings.lastAttemptAt)}
                  </p>
                )}
              </section>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        "relative h-6 w-11 shrink-0 rounded-full transition focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:focus:ring-offset-slate-950",
        checked ? "bg-indigo-600 dark:bg-indigo-500" : "bg-slate-300 dark:bg-slate-700",
      )}
    >
      <span
        className={clsx(
          "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform",
          checked ? "translate-x-5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-xs text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="text-right text-xs font-medium text-slate-800 dark:text-slate-200">{value}</dd>
    </div>
  );
}

function formatStatusTime(iso: string): string {
  const relative = formatRelative(iso);
  if (relative.startsWith("in ") || relative.endsWith("ago") || relative === "just now") {
    return relative;
  }
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
