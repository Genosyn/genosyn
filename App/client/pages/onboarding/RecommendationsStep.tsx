import React from "react";
import { Link } from "react-router-dom";
import {
  AlertCircle,
  Antenna,
  ArrowLeft,
  ArrowRight,
  BarChart3,
  BookOpen,
  Building2,
  CalendarClock,
  Check,
  CheckCircle2,
  Clock3,
  CreditCard,
  Database,
  Github,
  Layers,
  Linkedin,
  Mail,
  Megaphone,
  MessageCircle,
  Plug,
  RefreshCw,
  Search,
  Send,
  Server,
  Sparkles,
  Table2,
  Target,
  Twitter,
  Workflow,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  api,
  Company,
  CreateRecommendedRoutinesResponse,
  Employee,
  OnboardingIntegrationRecommendation,
  OnboardingRecommendations,
  OnboardingRoutineRecommendation,
} from "../../lib/api";
import { cronHuman } from "../../lib/cron";
import {
  defaultOnboardingRoutineIds,
  healthyGrantedConnection,
  healthyUngrantedConnection,
  MAX_ONBOARDING_ROUTINE_SELECTION,
  refreshedContextDraft,
} from "../../lib/onboardingRecommendations";
import { Button } from "../../components/ui/Button";
import { Card, CardBody } from "../../components/ui/Card";
import { FormError } from "../../components/ui/FormError";
import { Spinner } from "../../components/ui/Spinner";
import { Textarea } from "../../components/ui/Textarea";
import { clsx } from "../../components/ui/clsx";
import { useToast } from "../../components/ui/Toast";
import { ApiKeyModal, OauthOrServiceAccountModal } from "../SettingsIntegrations";

const INTEGRATION_ICONS: Record<string, LucideIcon> = {
  Antenna,
  BarChart3,
  BookOpen,
  Building2,
  CreditCard,
  Database,
  Github,
  Layers,
  Linkedin,
  Mail,
  Megaphone,
  MessageCircle,
  Plug,
  Search,
  Send,
  Server,
  Table2,
  Twitter,
  Workflow,
  Zap,
};

type RecommendationsStepProps = {
  company: Company;
  employee: Employee;
  templateId?: string | null;
  onBack?: () => void;
  onContinue: () => void;
  continueLabel: string;
};

/**
 * Shared post-hire launch plan. Both the first-company guide and the regular
 * hiring wizard use this surface, so a newly hired AI Employee gets the same
 * useful first Routines and Connections regardless of where they were hired.
 */
export function RecommendationsStep({
  company,
  employee,
  templateId,
  onBack,
  onContinue,
  continueLabel,
}: RecommendationsStepProps) {
  const [plan, setPlan] = React.useState<OnboardingRecommendations | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedRoutineIds, setSelectedRoutineIds] = React.useState<Set<string>>(new Set());
  const [addingRoutines, setAddingRoutines] = React.useState(false);
  const [grantingProvider, setGrantingProvider] = React.useState<string | null>(null);
  const [apiKeyEntry, setApiKeyEntry] = React.useState<OnboardingIntegrationRecommendation | null>(
    null,
  );
  const [oauthEntry, setOauthEntry] = React.useState<OnboardingIntegrationRecommendation | null>(
    null,
  );
  const [missionDraft, setMissionDraft] = React.useState(company.mission);
  const [visionDraft, setVisionDraft] = React.useState(company.vision);
  const [savingContext, setSavingContext] = React.useState(false);
  const [contextError, setContextError] = React.useState<string | null>(null);
  const seededSelection = React.useRef(false);
  const missionDirty = React.useRef(false);
  const visionDirty = React.useRef(false);
  const loadGeneration = React.useRef(0);
  const { toast } = useToast();

  const endpoint = React.useMemo(() => {
    const base = `/api/companies/${company.id}/employees/${employee.id}/onboarding-recommendations`;
    if (!templateId) return base;
    return `${base}?templateId=${encodeURIComponent(templateId)}`;
  }, [company.id, employee.id, templateId]);

  const load = React.useCallback(
    async (options: { resetContextDrafts?: boolean } = {}) => {
      const generation = ++loadGeneration.current;
      setError(null);
      let next: OnboardingRecommendations;
      try {
        next = await api.get<OnboardingRecommendations>(endpoint);
      } catch (error) {
        if (generation !== loadGeneration.current) return;
        throw error;
      }
      if (generation !== loadGeneration.current) return;
      setPlan(next);
      const reset = options.resetContextDrafts ?? false;
      setMissionDraft((currentDraft) =>
        refreshedContextDraft({
          serverValue: next.context.mission,
          currentDraft,
          dirty: missionDirty.current,
          reset,
        }),
      );
      setVisionDraft((currentDraft) =>
        refreshedContextDraft({
          serverValue: next.context.vision,
          currentDraft,
          dirty: visionDirty.current,
          reset,
        }),
      );
      const suggested = next.routines
        .filter((routine) => routine.status === "suggested")
        .map((routine) => routine.id);
      setSelectedRoutineIds((current) => {
        if (!seededSelection.current) {
          seededSelection.current = true;
          return new Set(defaultOnboardingRoutineIds(next.routines));
        }
        return new Set([...current].filter((id) => suggested.includes(id)));
      });
    },
    [endpoint],
  );

  React.useEffect(() => {
    let cancelled = false;
    seededSelection.current = false;
    missionDirty.current = false;
    visionDirty.current = false;
    setPlan(null);
    setLoading(true);
    load({ resetContextDrafts: true })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      loadGeneration.current += 1;
    };
  }, [load]);

  React.useEffect(() => {
    function handleOauthMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const data = event.data as {
        source?: string;
        ok?: boolean;
        title?: string;
        detail?: string;
      } | null;
      if (!data || data.source !== "genosyn-oauth") return;
      if (data.ok) {
        toast(data.title ?? "Connection added", "success");
        setOauthEntry(null);
        load().catch((err) => setError((err as Error).message));
      } else {
        toast(data.detail ?? data.title ?? "Connection failed", "error");
      }
    }
    window.addEventListener("message", handleOauthMessage);
    return () => window.removeEventListener("message", handleOauthMessage);
  }, [load, toast]);

  function toggleRoutine(id: string) {
    setSelectedRoutineIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < MAX_ONBOARDING_ROUTINE_SELECTION) {
        next.add(id);
      } else {
        toast(`Choose up to ${MAX_ONBOARDING_ROUTINE_SELECTION} Routines at a time`, "error");
      }
      return next;
    });
  }

  async function addSelectedRoutines() {
    if (selectedRoutineIds.size === 0) return;
    setAddingRoutines(true);
    setError(null);
    try {
      const result = await api.post<CreateRecommendedRoutinesResponse>(
        `/api/companies/${company.id}/employees/${employee.id}/onboarding-recommendations/routines`,
        { recommendationIds: [...selectedRoutineIds] },
      );
      const created = result.created?.length ?? 0;
      const existing = result.existing?.length ?? 0;
      const total = created + existing;
      toast(
        total === 1
          ? `1 Routine is ready for ${employee.name}`
          : `${total} Routines are ready for ${employee.name}`,
        "success",
      );
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAddingRoutines(false);
    }
  }

  async function saveCompanyContext() {
    const mission = missionDraft.trim();
    const vision = visionDraft.trim();
    const updates: Partial<Pick<Company, "mission" | "vision">> = {};
    if (mission && mission !== plan?.context.mission.trim()) updates.mission = mission;
    if (vision && vision !== plan?.context.vision.trim()) updates.vision = vision;
    if (Object.keys(updates).length === 0) return;
    setSavingContext(true);
    setContextError(null);
    try {
      await api.patch<Company>(`/api/companies/${company.id}`, updates);
      toast("Company direction saved", "success");
      missionDirty.current = false;
      visionDirty.current = false;
      await load({ resetContextDrafts: true });
    } catch (err) {
      setContextError((err as Error).message);
    } finally {
      setSavingContext(false);
    }
  }

  async function grantConnection(integration: OnboardingIntegrationRecommendation) {
    const connection = healthyUngrantedConnection(integration.connections);
    if (!connection) {
      await load().catch((err) => setError((err as Error).message));
      return;
    }
    setGrantingProvider(integration.provider);
    try {
      await api.post(`/api/companies/${company.id}/integrations/employees/${employee.id}/grants`, {
        connectionId: connection.id,
      });
      toast(`${connection.label} granted to ${employee.name}`, "success");
      await load();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setGrantingProvider(null);
    }
  }

  function connect(integration: OnboardingIntegrationRecommendation) {
    if (!integration.enabled) {
      toast(integration.disabledReason ?? "This Integration is unavailable", "error");
      return;
    }
    if (
      integration.oauth ||
      integration.serviceAccount ||
      integration.githubApp ||
      integration.browserLogin
    ) {
      setOauthEntry(integration);
    } else {
      setApiKeyEntry(integration);
    }
  }

  async function connectionSaved() {
    setApiKeyEntry(null);
    setOauthEntry(null);
    await load().catch((err) => setError((err as Error).message));
  }

  if (loading) {
    return (
      <div className="mx-auto w-full">
        <LaunchHero companyName={company.name} employee={employee} />
        <Card>
          <CardBody
            className="flex min-h-64 flex-col items-center justify-center gap-3 p-8 text-center"
            role="status"
            aria-live="polite"
          >
            <Spinner size={24} />
            <div>
              <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                Building {employee.name}&apos;s launch plan
              </div>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Matching the role with your company&apos;s direction.
              </p>
            </div>
          </CardBody>
        </Card>
      </div>
    );
  }

  if (!plan || error) {
    return (
      <div className="mx-auto w-full">
        <LaunchHero companyName={company.name} employee={employee} />
        <Card>
          <CardBody className="p-6">
            <FormError message={error ?? "The launch plan could not be loaded."} />
            <div className="mt-4 flex flex-wrap justify-between gap-2">
              {onBack ? (
                <Button variant="ghost" onClick={onBack}>
                  <ArrowLeft size={14} /> Back
                </Button>
              ) : (
                <span />
              )}
              <div className="flex gap-2">
                <Button variant="secondary" onClick={onContinue}>
                  Skip for now
                </Button>
                <Button
                  onClick={() => {
                    setLoading(true);
                    load()
                      .catch((err) => setError((err as Error).message))
                      .finally(() => setLoading(false));
                  }}
                >
                  <RefreshCw size={14} /> Try again
                </Button>
              </div>
            </div>
          </CardBody>
        </Card>
      </div>
    );
  }

  const missingContext = !plan.context.mission.trim() || !plan.context.vision.trim();
  const canSaveContext =
    (missionDraft.trim().length > 0 && missionDraft.trim() !== plan.context.mission.trim()) ||
    (visionDraft.trim().length > 0 && visionDraft.trim() !== plan.context.vision.trim());
  const suggested = plan.routines.filter((routine) => routine.status === "suggested");
  const ready = plan.routines.filter((routine) => routine.status === "ready");

  return (
    <div className="mx-auto w-full space-y-5">
      <LaunchHero companyName={plan.context.companyName} employee={employee} />

      {missingContext ? (
        <Card className="border-indigo-200 dark:border-indigo-800">
          <CardBody className="p-5 sm:p-6">
            <div className="flex items-start gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
                <Target size={18} />
              </div>
              <div>
                <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                  Give the recommendations your company&apos;s direction
                </h2>
                <p className="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">
                  A short mission and vision help Genosyn match recurring work and Integrations to
                  what {company.name} is actually building.
                </p>
              </div>
            </div>
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <Textarea
                label="Mission"
                value={missionDraft}
                onChange={(event) => {
                  const value = event.target.value;
                  missionDirty.current = value.trim() !== plan.context.mission.trim();
                  setMissionDraft(value);
                }}
                placeholder="What does the company do, for whom, and why?"
                rows={4}
                className="min-h-28"
                maxLength={2000}
              />
              <Textarea
                label="Vision"
                value={visionDraft}
                onChange={(event) => {
                  const value = event.target.value;
                  visionDirty.current = value.trim() !== plan.context.vision.trim();
                  setVisionDraft(value);
                }}
                placeholder="What should be true when the company succeeds?"
                rows={4}
                className="min-h-28"
                maxLength={2000}
              />
            </div>
            <FormError message={contextError} className="mt-4" />
            <div className="mt-4 flex justify-end">
              <Button onClick={saveCompanyContext} disabled={savingContext || !canSaveContext}>
                {savingContext ? "Refreshing plan…" : "Save and refresh plan"}
                {!savingContext && <Sparkles size={14} />}
              </Button>
            </div>
          </CardBody>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <ContextCard icon={Target} label="Mission" value={plan.context.mission} />
          <ContextCard icon={Sparkles} label="Vision" value={plan.context.vision} />
        </div>
      )}

      <section aria-labelledby="recommended-routines">
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-end">
          <div>
            <h2
              id="recommended-routines"
              className="flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-slate-100"
            >
              <CalendarClock size={17} className="text-indigo-600 dark:text-indigo-400" />
              Suggested Routines
            </h2>
            <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
              Selected for {plan.context.employeeName}&apos;s {plan.context.employeeRole} role and
              the outcomes {plan.context.companyName} cares about. You can edit every brief and
              schedule later.
            </p>
          </div>
          {suggested.length > 0 && (
            <div className="shrink-0 text-xs font-medium text-slate-500 sm:ml-auto dark:text-slate-400">
              {selectedRoutineIds.size} selected · up to {MAX_ONBOARDING_ROUTINE_SELECTION}
            </div>
          )}
        </div>

        {plan.routines.length === 0 ? (
          <EmptyPanel
            title="No Routine suggestions yet"
            description="Add company direction above or continue and create a Routine later."
          />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {plan.routines.map((routine) => (
              <RoutineCard
                key={routine.id}
                routine={routine}
                selected={selectedRoutineIds.has(routine.id)}
                onToggle={() => toggleRoutine(routine.id)}
              />
            ))}
          </div>
        )}

        {suggested.length > 0 && (
          <div className="mt-4 flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center dark:border-slate-800 dark:bg-slate-900">
            <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
              {ready.length > 0
                ? `${ready.length} ${ready.length === 1 ? "Routine is" : "Routines are"} already ready. Add only the ideas you want.`
                : "Add the selected briefs now, then refine them any time from Routines."}
            </p>
            <Button
              className="sm:ml-auto"
              onClick={addSelectedRoutines}
              disabled={addingRoutines || selectedRoutineIds.size === 0}
            >
              {addingRoutines ? "Adding Routines…" : "Add selected Routines"}
              {!addingRoutines && <ArrowRight size={14} />}
            </Button>
          </div>
        )}
      </section>

      <section aria-labelledby="recommended-integrations">
        <div className="mb-3">
          <h2
            id="recommended-integrations"
            className="flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-slate-100"
          >
            <Plug size={17} className="text-indigo-600 dark:text-indigo-400" />
            Recommended Integrations
          </h2>
          <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
            Connect the sources that make this role useful, then give {employee.name} a Grant to the
            specific Connection they should use.
          </p>
        </div>
        {plan.integrations.length === 0 ? (
          <EmptyPanel
            title="No Integration suggestions yet"
            description="This launch plan does not need an external Connection. You can add one later from AI Employees → Integrations."
          />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {plan.integrations.map((integration) => (
              <IntegrationCard
                key={integration.provider}
                company={company}
                employee={employee}
                integration={integration}
                granting={grantingProvider === integration.provider}
                onConnect={() => connect(integration)}
                onGrant={() => grantConnection(integration)}
              />
            ))}
          </div>
        )}
      </section>

      <FormError message={error} />

      <div className="flex flex-col gap-2 border-t border-slate-200 pt-5 sm:flex-row sm:items-center dark:border-slate-800">
        {onBack ? (
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft size={14} /> Back
          </Button>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={onContinue}
          className="text-sm font-medium text-slate-500 hover:text-slate-800 sm:ml-auto dark:text-slate-400 dark:hover:text-slate-200"
        >
          Skip for now
        </button>
        <Button onClick={onContinue}>
          {continueLabel} <ArrowRight size={14} />
        </Button>
      </div>

      <ApiKeyModal
        open={apiKeyEntry !== null}
        entry={apiKeyEntry}
        reconnect={null}
        companyId={company.id}
        onClose={() => setApiKeyEntry(null)}
        onSaved={connectionSaved}
      />
      <OauthOrServiceAccountModal
        open={oauthEntry !== null}
        entry={oauthEntry}
        reconnect={null}
        companyId={company.id}
        onClose={() => setOauthEntry(null)}
        onSaved={connectionSaved}
      />
    </div>
  );
}

function LaunchHero({ companyName, employee }: { companyName: string; employee: Employee }) {
  return (
    <div className="relative mb-5 overflow-hidden rounded-2xl border border-indigo-200 bg-indigo-50 px-5 py-6 shadow-sm sm:px-7 dark:border-indigo-900 dark:bg-indigo-950/40">
      <div className="absolute -right-10 -top-12 h-36 w-36 rounded-full bg-indigo-200/40 blur-2xl dark:bg-indigo-700/20" />
      <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-indigo-600 text-white shadow-sm dark:bg-indigo-500">
          <Check size={24} />
        </div>
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600 dark:text-indigo-300">
            AI Employee hired
          </div>
          <h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-950 dark:text-white sm:text-2xl">
            {employee.name} is ready. Let&apos;s put them to work.
          </h2>
          <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">
            Here is a focused launch plan for {employee.name}, your {employee.role} at {companyName}
            {" — "}recurring work to start and the Connections that unlock it.
          </p>
        </div>
      </div>
    </div>
  );
}

function ContextCard({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
        <Icon size={13} className="text-indigo-500" /> {label}
      </div>
      <p className="mt-2 line-clamp-3 text-sm leading-6 text-slate-700 dark:text-slate-300">
        {value}
      </p>
    </div>
  );
}

function RoutineCard({
  routine,
  selected,
  onToggle,
}: {
  routine: OnboardingRoutineRecommendation;
  selected: boolean;
  onToggle: () => void;
}) {
  const ready = routine.status === "ready";
  return (
    <div
      className={clsx(
        "relative flex min-h-48 flex-col rounded-xl border bg-white p-4 shadow-sm transition dark:bg-slate-900",
        ready
          ? "border-emerald-200 dark:border-emerald-900"
          : selected
            ? "border-indigo-400 ring-2 ring-indigo-100 focus-within:ring-indigo-400 dark:border-indigo-600 dark:ring-indigo-950 dark:focus-within:ring-indigo-600"
            : "border-slate-200 hover:border-indigo-300 focus-within:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-200 dark:border-slate-800 dark:hover:border-indigo-700 dark:focus-within:border-indigo-600 dark:focus-within:ring-indigo-900",
      )}
    >
      {!ready && (
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
          aria-label={`Select ${routine.name}`}
        />
      )}
      <div className="flex items-start gap-3">
        <div
          className={clsx(
            "grid h-9 w-9 shrink-0 place-items-center rounded-lg",
            ready
              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
              : "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
          )}
        >
          {ready ? <CheckCircle2 size={16} /> : <Clock3 size={16} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {routine.name}
            </h3>
            <span
              className={clsx(
                "ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold",
                ready
                  ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                  : selected
                    ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
                    : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
              )}
            >
              {ready ? "Ready" : selected ? "Selected" : "Suggested"}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400">
            <CalendarClock size={11} /> {cronHuman(routine.cronExpr)}
          </div>
        </div>
      </div>
      <p className="mt-3 text-xs leading-5 text-slate-600 dark:text-slate-300">{routine.summary}</p>
      {(routine.reasons ?? []).length > 0 && (
        <div className="mt-auto flex flex-wrap gap-1.5 pt-3">
          {routine.reasons.map((reason) => (
            <span
              key={reason}
              className="rounded-full bg-slate-100 px-2 py-1 text-[10px] text-slate-600 dark:bg-slate-800 dark:text-slate-300"
            >
              {reason}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function IntegrationCard({
  company,
  employee,
  integration,
  granting,
  onConnect,
  onGrant,
}: {
  company: Company;
  employee: Employee;
  integration: OnboardingIntegrationRecommendation;
  granting: boolean;
  onConnect: () => void;
  onGrant: () => void;
}) {
  const Icon = INTEGRATION_ICONS[integration.icon] ?? Plug;
  const readyConnection = healthyGrantedConnection(integration.connections);
  const grantConnection = healthyUngrantedConnection(integration.connections);

  return (
    <Card className="overflow-hidden">
      <CardBody className="flex h-full flex-col p-4">
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200">
            <Icon size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-2">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {integration.name}
              </h3>
              <IntegrationStatus status={integration.status} />
            </div>
            <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
              {integration.reason}
            </p>
          </div>
        </div>

        {integration.connections.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {integration.connections.map((connection) => (
              <span
                key={connection.id}
                className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-1 text-[10px] text-slate-600 dark:bg-slate-800 dark:text-slate-300"
              >
                <span
                  className={clsx(
                    "h-1.5 w-1.5 rounded-full",
                    connection.status === "connected" ? "bg-emerald-500" : "bg-amber-500",
                  )}
                />
                {connection.label}
                {connection.status === "connected"
                  ? " · connected"
                  : connection.status === "expired"
                    ? " · expired"
                    : " · error"}
                {connection.granted ? " · granted" : ""}
              </span>
            ))}
          </div>
        )}

        <div className="mt-auto pt-4">
          {integration.status === "ready" ? (
            <div className="flex items-center gap-2 text-xs font-medium text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 size={14} />
              {readyConnection
                ? `${readyConnection.label} is ready for ${employee.name}`
                : `Ready for ${employee.name}`}
            </div>
          ) : integration.status === "grant_needed" ? (
            <Button size="sm" onClick={onGrant} disabled={granting}>
              {granting ? "Granting…" : `Grant ${grantConnection?.label ?? "access"}`}
              {!granting && <ArrowRight size={12} />}
            </Button>
          ) : integration.status === "connection_attention" ? (
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                <AlertCircle size={13} /> Connection needs attention
              </div>
              <Link
                to={`/c/${company.slug}/employees/integrations`}
                className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
              >
                Review Connection →
              </Link>
            </div>
          ) : (
            <Button size="sm" onClick={onConnect} disabled={!integration.enabled}>
              <Plug size={12} />
              {integration.enabled ? `Connect ${integration.name}` : "Unavailable"}
            </Button>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function IntegrationStatus({ status }: { status: OnboardingIntegrationRecommendation["status"] }) {
  const ready = status === "ready";
  const attention = status === "connection_attention";
  const label = ready
    ? "Ready"
    : status === "grant_needed"
      ? "Grant needed"
      : attention
        ? "Attention"
        : "Connect";
  return (
    <span
      className={clsx(
        "ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold",
        ready
          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
          : attention
            ? "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
            : "bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
      )}
    >
      {label}
    </span>
  );
}

function EmptyPanel({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white p-7 text-center dark:border-slate-700 dark:bg-slate-900">
      <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{title}</div>
      <p className="mx-auto mt-1 max-w-lg text-xs leading-5 text-slate-500 dark:text-slate-400">
        {description}
      </p>
    </div>
  );
}
