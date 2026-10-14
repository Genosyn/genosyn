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
  Flag,
  GitFork,
  Github,
  Layers,
  Linkedin,
  Mail,
  Megaphone,
  MessageCircle,
  Plug,
  RefreshCw,
  Repeat,
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
  ProactiveDefaultsPreview,
} from "../../lib/api";
import { describeCronExpr } from "../../lib/scheduleBuilder";
import {
  defaultOnboardingRoutineIds,
  healthyGrantedConnection,
  healthyUngrantedConnection,
  MAX_ONBOARDING_ROUTINE_SELECTION,
  refreshedContextDraft,
} from "../../lib/onboardingRecommendations";
import { Button } from "../../components/ui/Button";
import { Card, CardBody } from "../../components/ui/Card";
import { useDialog } from "../../components/ui/Dialog";
import { FormError } from "../../components/ui/FormError";
import { Spinner } from "../../components/ui/Spinner";
import { Textarea } from "../../components/ui/Textarea";
import { clsx } from "../../components/ui/clsx";
import { StepHeading } from "./OnboardingFrame";
import { ApiKeyModal, OauthOrServiceAccountModal } from "../SettingsIntegrations";

const INTEGRATION_ICONS: Record<string, LucideIcon> = {
  Antenna,
  BarChart3,
  BookOpen,
  Building2,
  CreditCard,
  Database,
  GitFork,
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
  const [selectionError, setSelectionError] = React.useState<string | null>(null);
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
  const dialog = useDialog();
  // What Automatic setup adds for this employee. Loaded apart from the plan:
  // the plan is the point of this step and must not wait on, or fail with, it.
  const [standing, setStanding] = React.useState<ProactiveDefaultsPreview | null>(null);
  const [standingError, setStandingError] = React.useState<string | null>(null);
  const [savingStanding, setSavingStanding] = React.useState(false);
  const [switchError, setSwitchError] = React.useState<string | null>(null);
  const canManageStanding = company.role === "owner" || company.role === "admin";

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
      // Decide *before* the updater runs. Writing the ref inside it made the
      // updater impure, and React re-invokes updaters to catch exactly that —
      // the second pass saw `seeded` already true and returned the empty set,
      // so the launch plan arrived with nothing preselected.
      const seeding = !seededSelection.current;
      seededSelection.current = true;
      setSelectedRoutineIds((current) =>
        seeding
          ? new Set(defaultOnboardingRoutineIds(next.routines))
          : new Set([...current].filter((id) => suggested.includes(id))),
      );
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
    let cancelled = false;
    setStanding(null);
    setStandingError(null);
    setSwitchError(null);
    api
      .get<ProactiveDefaultsPreview>(
        `/api/companies/${company.id}/proactive/preview?employeeId=${encodeURIComponent(employee.id)}`,
      )
      .then((next) => {
        if (!cancelled) setStanding(next);
      })
      .catch((err) => {
        if (!cancelled) setStandingError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [company.id, employee.id]);

  /** The same switch, and the same route, as Automatic setup on the Proactive page. */
  async function setAutomaticSetup(enabled: boolean) {
    if (!standing || savingStanding) return;
    setSavingStanding(true);
    setSwitchError(null);
    try {
      await api.patch(`/api/companies/${company.id}/proactive/defaults`, { enabled });
      setStanding((current) => current && { ...current, automaticSetup: enabled });
    } catch (err) {
      setSwitchError((err as Error).message);
    } finally {
      setSavingStanding(false);
    }
  }

  function toggleRoutine(id: string) {
    if (addingRoutines) return;
    const selected = selectedRoutineIds.has(id);
    if (!selected && selectedRoutineIds.size >= MAX_ONBOARDING_ROUTINE_SELECTION) {
      setSelectionError(
        `Add up to ${MAX_ONBOARDING_ROUTINE_SELECTION} Routines in one step. You can add more later from Routines.`,
      );
      return;
    }
    setSelectionError(null);
    setSelectedRoutineIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  /**
   * Create the selected Routines. Returns false when the write failed, so the
   * caller can keep the member on this step instead of advancing past an error.
   *
   * The reload afterwards is the confirmation: every card the member picked
   * flips to "Scheduled", which is what the server actually did — it creates
   * each Routine enabled with a live `nextRunAt`, and "ready" would read as
   * staged rather than armed. This is the moment the product starts acting on
   * its own.
   */
  async function addSelectedRoutines(): Promise<boolean> {
    if (selectedRoutineIds.size === 0) return true;
    setAddingRoutines(true);
    setError(null);
    setSelectionError(null);
    try {
      await api.post<CreateRecommendedRoutinesResponse>(
        `/api/companies/${company.id}/employees/${employee.id}/onboarding-recommendations/routines`,
        { recommendationIds: [...selectedRoutineIds] },
      );
      await load();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setAddingRoutines(false);
    }
  }

  /**
   * The forward action. It applies the selection first — the previous version
   * called `onContinue` directly, so the plan's whole point was thrown away by
   * the button most members press.
   */
  async function applyAndContinue() {
    if (await addSelectedRoutines()) onContinue();
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
      await load();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t grant the Connection" });
    } finally {
      setGrantingProvider(null);
    }
  }

  function connect(integration: OnboardingIntegrationRecommendation) {
    if (!integration.enabled) {
      void dialog.error(integration.disabledReason ?? "This Integration is unavailable", {
        title: `Couldn’t connect ${integration.name}`,
      });
      return;
    }
    if (integration.oauth || integration.serviceAccount || integration.githubApp) {
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
        <LaunchHero
          companyName={company.name}
          hasGoal={Boolean(company.hasGoal)}
          employee={employee}
        />
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
        <LaunchHero
          companyName={company.name}
          hasGoal={Boolean(company.hasGoal)}
          employee={employee}
        />
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
                  Continue without a plan
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

  const hasGoal = plan.context.goal.trim() !== "";
  const hasMission = plan.context.mission.trim() !== "";
  const hasVision = plan.context.vision.trim() !== "";
  const missingContext = !hasMission || !hasVision;
  const canSaveContext =
    (missionDraft.trim().length > 0 && missionDraft.trim() !== plan.context.mission.trim()) ||
    (visionDraft.trim().length > 0 && visionDraft.trim() !== plan.context.vision.trim());
  const suggested = plan.routines.filter((routine) => routine.status === "suggested");
  const ready = plan.routines.filter((routine) => routine.status === "ready");

  return (
    <div className="mx-auto w-full space-y-5">
      <LaunchHero
        companyName={plan.context.companyName}
        hasGoal={plan.context.goal !== ""}
        employee={employee}
      />

      <div className="space-y-3">
        {(hasGoal || hasMission || hasVision) && (
          <div className="grid gap-3 sm:grid-cols-2">
            {hasGoal && (
              <ContextCard
                icon={Flag}
                label="Goal"
                value={plan.context.goal}
                className="sm:col-span-2"
              />
            )}
            {hasMission && (
              <ContextCard icon={Target} label="Mission" value={plan.context.mission} />
            )}
            {hasVision && (
              <ContextCard icon={Sparkles} label="Vision" value={plan.context.vision} />
            )}
          </div>
        )}
        {missingContext && (
          <details className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <summary className="cursor-pointer text-sm font-medium text-slate-700 dark:text-slate-200">
              Add a mission and vision (optional)
            </summary>
            <p className="mt-3 text-sm leading-6 text-slate-500 dark:text-slate-400">
              They help Genosyn match recurring work and Integrations to what {company.name} is
              actually building.
            </p>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
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
              <Button
                onClick={saveCompanyContext}
                loading={savingContext}
                disabled={!canSaveContext}
              >
                {savingContext ? "Refreshing plan…" : "Save and refresh plan"}
                {!savingContext && <Sparkles size={14} />}
              </Button>
            </div>
          </details>
        )}
      </div>

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
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500 dark:text-slate-400">
              Routines run on a schedule. Every brief and schedule stays editable.
            </p>
          </div>
          {suggested.length > 0 && (
            <div className="shrink-0 text-xs font-medium text-slate-500 sm:ml-auto dark:text-slate-400">
              {selectedRoutineIds.size} selected
            </div>
          )}
        </div>

        <FormError message={selectionError} className="mb-3" />

        {plan.routines.length === 0 ? (
          <EmptyPanel
            title="No Routine suggestions yet"
            description="Continue and create a Routine later, or add a mission and vision above to get suggestions."
          />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {plan.routines.map((routine) => (
              <RoutineCard
                key={routine.id}
                routine={routine}
                selected={selectedRoutineIds.has(routine.id)}
                disabled={addingRoutines}
                onToggle={() => toggleRoutine(routine.id)}
              />
            ))}
          </div>
        )}

        {suggested.length > 0 && (
          <div className="mt-4 flex flex-col gap-3 rounded-xl border border-indigo-200 bg-indigo-50/70 p-4 sm:flex-row sm:items-center dark:border-indigo-500/30 dark:bg-indigo-500/10">
            <div className="flex items-start gap-2.5">
              <Clock3
                size={16}
                className="mt-0.5 shrink-0 text-indigo-600 dark:text-indigo-300"
                aria-hidden="true"
              />
              <p className="text-sm leading-6 text-indigo-900/80 dark:text-indigo-200/80">
                Selected Routines run on their schedules once an AI Model is connected, and each Run
                is graded against a short definition of done (Settings → Outcome check). You can
                edit or pause them any time from Routines.
                {ready.length > 0 &&
                  ` ${ready.length} matching ${ready.length === 1 ? "Routine already exists" : "Routines already exist"} for ${employee.name}.`}
              </p>
            </div>
          </div>
        )}
      </section>

      <StandingWork
        employee={employee}
        preview={standing}
        error={standingError}
        canManage={canManageStanding}
        saving={savingStanding}
        switchError={switchError}
        onToggle={(enabled) => void setAutomaticSetup(enabled)}
      />

      <details className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <summary className="cursor-pointer text-sm font-medium text-slate-700 dark:text-slate-200">
          Optional Integrations
        </summary>
        <section className="mt-4" aria-labelledby="recommended-integrations">
          <div className="mb-3">
            <h2
              id="recommended-integrations"
              className="flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-slate-100"
            >
              <Plug size={17} className="text-indigo-600 dark:text-indigo-400" />
              Recommended Integrations
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500 dark:text-slate-400">
              Connect the apps this role uses and grant {employee.name} access. You can do this
              later.
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
      </details>

      <FormError message={error} />

      <div className="flex flex-col-reverse gap-2 border-t border-slate-200 pt-5 sm:flex-row sm:items-center dark:border-slate-800">
        {onBack && (
          <Button
            type="button"
            variant="ghost"
            className="w-full sm:w-auto"
            onClick={onBack}
            disabled={addingRoutines}
          >
            <ArrowLeft size={14} /> Back
          </Button>
        )}
        <div className="flex flex-col-reverse gap-2 sm:ml-auto sm:flex-row sm:items-center">
          {selectedRoutineIds.size > 0 && (
            <button
              type="button"
              onClick={onContinue}
              disabled={addingRoutines}
              className="disabled:opacity-50 rounded-lg px-3 py-2 text-sm font-medium text-slate-500 hover:text-slate-800 sm:py-0 dark:text-slate-400 dark:hover:text-slate-200"
            >
              Continue without adding them
            </button>
          )}
          <Button className="w-full sm:w-auto" onClick={applyAndContinue} loading={addingRoutines}>
            {addingRoutines
              ? "Scheduling…"
              : selectedRoutineIds.size > 0
                ? `Schedule ${selectedRoutineIds.size} ${selectedRoutineIds.size === 1 ? "Routine" : "Routines"} and continue`
                : continueLabel}
            {!addingRoutines && <ArrowRight size={14} />}
          </Button>
        </div>
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

function LaunchHero({
  companyName,
  hasGoal,
  employee,
}: {
  companyName: string;
  hasGoal: boolean;
  employee: Employee;
}) {
  return (
    <StepHeading
      icon={CalendarClock}
      title={`Choose useful work for ${employee.name}`}
      description={`These Routines connect their ${employee.role} role with ${companyName}’s ${hasGoal ? "Goal" : "mission and vision"}. Choose what to schedule, or continue and add work later.`}
    />
  );
}

function ContextCard({
  icon: Icon,
  label,
  value,
  className,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div
      className={clsx(
        "rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900",
        className,
      )}
    >
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
  disabled,
  onToggle,
}: {
  routine: OnboardingRoutineRecommendation;
  selected: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const ready = routine.status === "ready";
  return (
    <div
      className={clsx(
        "relative flex min-h-48 flex-col rounded-xl border bg-white p-4 shadow-sm transition dark:bg-slate-900",
        ready
          ? "border-emerald-200 dark:border-emerald-500/30"
          : selected
            ? "border-indigo-400 ring-2 ring-indigo-100 focus-within:ring-indigo-400 dark:border-indigo-500 dark:ring-indigo-500/30 dark:focus-within:ring-indigo-500"
            : "border-slate-200 hover:border-indigo-300 focus-within:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-200 dark:border-slate-800 dark:hover:border-indigo-500/60 dark:focus-within:border-indigo-500 dark:focus-within:ring-indigo-500/30",
      )}
    >
      {!ready && (
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          disabled={disabled}
          className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
          aria-label={`Select ${routine.name}`}
        />
      )}
      <div className="flex items-start gap-3">
        {/* For a selectable card the leading tile IS the checkbox — four
          uniform tiles read as a list of facts, and members did not learn
          they were choosing until they mis-clicked. */}
        <div
          aria-hidden="true"
          className={clsx(
            "grid h-9 w-9 shrink-0 place-items-center transition-colors",
            ready
              ? "rounded-lg bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300"
              : selected
                ? "rounded-md border border-indigo-600 bg-indigo-600 text-white dark:border-indigo-500 dark:bg-indigo-500"
                : "rounded-md border border-slate-300 bg-white text-transparent dark:border-slate-600 dark:bg-slate-900",
          )}
        >
          {ready ? <CheckCircle2 size={16} /> : <Check size={16} />}
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
                  ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
                  : selected
                    ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300"
                    : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
              )}
            >
              {ready ? "Scheduled" : selected ? "Selected" : "Suggested"}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400">
            <CalendarClock size={11} /> {describeCronExpr(routine.cronExpr)}
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
            <Button size="sm" onClick={onGrant} loading={granting}>
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

/**
 * "Also set up for {name}": the standing work and the briefing that arrive
 * without being picked above. Automatic setup assigns the first within a minute
 * of an AI Model connecting, and hiring starts the second, so the guide says so
 * here rather than leaving them to be found later on the Routines page.
 */
function StandingWork({
  employee,
  preview,
  error,
  canManage,
  saving,
  switchError,
  onToggle,
}: {
  employee: Employee;
  preview: ProactiveDefaultsPreview | null;
  error: string | null;
  canManage: boolean;
  saving: boolean;
  switchError: string | null;
  onToggle: (enabled: boolean) => void;
}) {
  const titleId = React.useId();
  const labelId = React.useId();
  const descriptionId = React.useId();
  const heading = (
    <h2
      id={titleId}
      className="flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-slate-100"
    >
      <Repeat size={17} className="text-indigo-600 dark:text-indigo-400" />
      Also set up for {employee.name}
    </h2>
  );

  if (error) {
    return (
      <section aria-labelledby={titleId} className="space-y-3">
        {heading}
        <FormError message={`We could not load what is set up automatically. ${error}`} />
      </section>
    );
  }
  if (!preview) return null;

  const { automaticSetup, employeeReady, starters, briefing } = preview;
  const hasRows = starters.length > 0 || briefing !== null;
  const intro = !hasRows
    ? `Nothing else is set up automatically for ${employee.name}.`
    : !automaticSetup
      ? `Automatic setup is off, so Genosyn will not add standing work for ${employee.name}.`
      : employeeReady
        ? "Genosyn adds this standing work automatically."
        : `Genosyn adds this standing work automatically once ${employee.name} has a connected AI Model.`;

  return (
    <section aria-labelledby={titleId} className="space-y-3">
      <div>
        {heading}
        <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500 dark:text-slate-400">
          {intro}
        </p>
      </div>

      {hasRows && (
        <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
          {starters.map((row) => {
            const skipped = !automaticSetup && !row.installed;
            return (
              <li
                key={row.recipeId}
                className={clsx(
                  "flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between",
                  skipped && "opacity-60",
                )}
              >
                <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  {row.name}
                </span>
                <span className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                  <CalendarClock size={12} aria-hidden="true" />
                  {row.schedule}
                  {row.installed && <StatePill>Added</StatePill>}
                  {skipped && <StatePill>Not added</StatePill>}
                </span>
              </li>
            );
          })}
          {briefing && (
            <li className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                TLDR briefing
              </span>
              <span className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                <CalendarClock size={12} aria-hidden="true" />
                {briefing.schedule}
                {briefing.writerName ? ` · written by ${briefing.writerName}` : ""}
              </span>
            </li>
          )}
        </ul>
      )}

      {hasRows && (
        <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
          You can change or pause any of these later in Proactive and TLDRs.
        </p>
      )}

      {canManage ? (
        <div className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="min-w-0">
            <div id={labelId} className="text-sm font-medium text-slate-900 dark:text-slate-100">
              Set up standing work automatically
            </div>
            <p
              id={descriptionId}
              className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400"
            >
              {automaticSetup
                ? "On for every AI Employee in your company. Your own and paused work is never replaced or resumed."
                : "Off. No new standing work will be added; work that already exists keeps its current state."}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span
              aria-hidden="true"
              className="text-sm font-medium text-slate-700 dark:text-slate-200"
            >
              {saving ? "Saving…" : automaticSetup ? "On" : "Off"}
            </span>
            <Switch
              checked={automaticSetup}
              disabled={saving}
              label="Set up standing work automatically"
              describedBy={descriptionId}
              onChange={onToggle}
            />
          </div>
        </div>
      ) : (
        <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
          {automaticSetup
            ? "Owners and admins can switch automatic setup off in Proactive."
            : "Owners and admins can switch automatic setup on in Proactive."}
        </p>
      )}
      <FormError message={switchError} />
    </section>
  );
}

function StatePill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400">
      {children}
    </span>
  );
}

function Switch({
  checked,
  disabled,
  label,
  describedBy,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  describedBy?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-describedby={describedBy}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:focus:ring-offset-slate-950",
        checked ? "bg-indigo-600 dark:bg-indigo-500" : "bg-slate-300 dark:bg-slate-700",
      )}
    >
      <span
        className={clsx(
          "inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform",
          checked ? "translate-x-5" : "translate-x-0.5",
        )}
      />
    </button>
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
