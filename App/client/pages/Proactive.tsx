import React from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ClipboardCheck,
  Eye,
  Mail,
  MessageSquareText,
  PauseCircle,
  PlayCircle,
  Plus,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { api, type Company } from "@/lib/api";
import { TopBar } from "@/components/AppShell";
import { AskEmployeeModal } from "@/components/proactive/AskEmployeeModal";
import { StarterSetupModal } from "@/components/proactive/StarterSetupModal";
import { useCompanySocketSubscription, useLiveRefetch } from "@/components/CompanySocket";
import { Button, buttonClassName } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormError } from "@/components/ui/FormError";
import { clsx } from "@/components/ui/clsx";
import type {
  ProactiveInstallation,
  ProactiveOverview,
  ProactiveRecipe,
} from "../../shared/proactive";

type StarterFilter = "all" | "email" | "routine";

const STARTER_FILTERS: Array<{ value: StarterFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "email", label: "Email" },
  { value: "routine", label: "Scheduled" },
];

export default function Proactive({ company }: { company: Company }) {
  const [overview, setOverview] = React.useState<ProactiveOverview | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<ProactiveRecipe | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [savingDefaults, setSavingDefaults] = React.useState(false);
  const [askOpen, setAskOpen] = React.useState(false);
  const [libraryOpen, setLibraryOpen] = React.useState(false);
  const [starterFilter, setStarterFilter] = React.useState<StarterFilter>("all");
  const requestSequence = React.useRef(0);
  const admin = company.role === "owner" || company.role === "admin";

  const refresh = React.useCallback(async () => {
    const sequence = ++requestSequence.current;
    try {
      const next = await api.get<ProactiveOverview>(`/api/companies/${company.id}/proactive`);
      if (sequence !== requestSequence.current) return;
      setOverview(next);
      setError(null);
    } catch (err) {
      if (sequence !== requestSequence.current) return;
      setError((err as Error).message);
    }
  }, [company.id]);

  React.useEffect(() => {
    setOverview(null);
    void refresh();
  }, [refresh]);

  useLiveRefetch(["routine", "employee"], refresh);
  useCompanySocketSubscription((event) => {
    if (event.type === "mail.updated") void refresh();
  });

  async function toggle(installation: ProactiveInstallation) {
    setBusy(installation.id);
    setError(null);
    try {
      await api.patch(`/api/companies/${company.id}/proactive/${installation.id}`, {
        enabled: !installation.enabled,
      });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function toggleAutomaticSetup() {
    if (!overview || !admin || savingDefaults) return;
    const enabled = !overview.automaticSetup;
    setSavingDefaults(true);
    setError(null);
    try {
      await api.patch(`/api/companies/${company.id}/proactive/defaults`, { enabled });
      setOverview((current) => current && { ...current, automaticSetup: enabled });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingDefaults(false);
    }
  }

  return (
    <div className="page-shell space-y-7 p-4 sm:p-8">
      <header>
        <TopBar title="Proactive" />
        <div className="-mt-3 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-2xl text-sm leading-6 text-slate-500 dark:text-slate-400">
            Give AI Employees standing responsibilities, then review the work they discover before
            anything changes.
          </p>
          {admin && (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setAskOpen(true)}
                disabled={!overview}
              >
                <MessageSquareText size={16} aria-hidden="true" />
                Ask AI Employee
              </Button>
              <Link className={buttonClassName()} to={`/c/${company.slug}/routines/new`}>
                <Plus size={16} aria-hidden="true" />
                New Routine
              </Link>
            </div>
          )}
        </div>
      </header>

      <ReviewFlow company={company} />

      {error && (
        <div className="space-y-3">
          <FormError message={error} />
          <Button variant="secondary" onClick={() => void refresh()}>
            Retry
          </Button>
        </div>
      )}

      {!overview && !error && (
        <div
          role="status"
          className="rounded-xl border border-slate-200 p-5 text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400"
        >
          Loading proactive work…
        </div>
      )}

      {overview && (
        <>
          <AutomaticSetup
            enabled={overview.automaticSetup}
            saving={savingDefaults}
            canManage={admin}
            onToggle={() => void toggleAutomaticSetup()}
          />

          <StandingWork
            company={company}
            overview={overview}
            canManage={admin}
            busy={busy}
            onToggle={(installation) => void toggle(installation)}
            onBrowseStarters={() => {
              setLibraryOpen(true);
              window.setTimeout(
                () => document.getElementById("starter-library-title")?.scrollIntoView(),
                0,
              );
            }}
          />

          {!admin && (
            <p className="rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-500 dark:bg-slate-900 dark:text-slate-400">
              Standing work is read-only for Members. An owner or admin can create Routines, ask an
              AI Employee for an Initiative, change Automatic setup, and pause responsibilities.
            </p>
          )}

          <StarterLibrary
            overview={overview}
            canManage={admin}
            open={libraryOpen}
            filter={starterFilter}
            onOpenChange={setLibraryOpen}
            onFilterChange={setStarterFilter}
            onSelect={setSelected}
          />

          {selected && (
            <StarterSetupModal
              key={selected.id}
              recipe={selected}
              overview={overview}
              company={company}
              onClose={() => setSelected(null)}
              onSaved={async () => {
                setSelected(null);
                await refresh();
              }}
            />
          )}

          {askOpen && (
            <AskEmployeeModal
              companyId={company.id}
              companySlug={company.slug}
              employees={overview.employees}
              onClose={() => setAskOpen(false)}
            />
          )}
        </>
      )}
    </div>
  );
}

function ReviewFlow({ company }: { company: Company }) {
  const steps = [
    {
      icon: Eye,
      title: "Review evidence",
      copy: "A responsibility checks the records and messages its AI Employee can already read.",
    },
    {
      icon: ClipboardCheck,
      title: "Bring you the next action",
      copy: "Exact emails and work plans go to the Decision stack; new standing work and improvements go to their review lists.",
    },
    {
      icon: PlayCircle,
      title: "Carry out what you approve",
      copy: "Approved work starts with the same Grants, Policies, and delivery limits.",
    },
  ];

  return (
    <section
      aria-labelledby="proactive-flow-title"
      className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950"
    >
      <div className="flex flex-col gap-2 border-b border-slate-100 px-5 py-4 sm:flex-row sm:items-center sm:justify-between dark:border-slate-800">
        <div>
          <h2
            id="proactive-flow-title"
            className="font-semibold text-slate-900 dark:text-slate-100"
          >
            How proactive work moves
          </h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Built-in responsibilities route what they find to the right human review.
          </p>
        </div>
        <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
          <ShieldCheck size={14} aria-hidden="true" /> Human review stays in the loop
        </span>
      </div>

      <ol className="grid divide-y divide-slate-100 sm:grid-cols-3 sm:divide-x sm:divide-y-0 dark:divide-slate-800">
        {steps.map((step, index) => {
          const Icon = step.icon;
          return (
            <li key={step.title} className="flex gap-3 p-5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
                <Icon size={17} aria-hidden="true" />
              </span>
              <div>
                <p className="text-xs font-medium text-slate-400 dark:text-slate-500">
                  Step {index + 1}
                </p>
                <h3 className="mt-0.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {step.title}
                </h3>
                <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                  {step.copy}
                </p>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="flex flex-col gap-3 border-t border-slate-100 bg-slate-50/60 px-5 py-3 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-400">
        <p>
          A Routine you create yourself follows the Approval settings you choose on that Routine.
        </p>
        <nav aria-label="Proactive work destinations" className="flex flex-wrap gap-x-4 gap-y-2">
          <FlowLink to={`/c/${company.slug}/decisions`}>Decision stack</FlowLink>
          <FlowLink to={`/c/${company.slug}/initiatives`}>Initiatives</FlowLink>
          <FlowLink to={`/c/${company.slug}/revisions`}>Revisions</FlowLink>
          <FlowLink to={`/c/${company.slug}/routines`}>All Routines</FlowLink>
        </nav>
      </div>
    </section>
  );
}

function FlowLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      className="inline-flex items-center gap-1 font-medium text-indigo-600 hover:underline dark:text-indigo-400"
      to={to}
    >
      {children} <ArrowRight size={12} aria-hidden="true" />
    </Link>
  );
}

function AutomaticSetup({
  enabled,
  saving,
  canManage,
  onToggle,
}: {
  enabled: boolean;
  saving: boolean;
  canManage: boolean;
  onToggle: () => void;
}) {
  return (
    <section
      aria-labelledby="automatic-setup-title"
      className="rounded-xl border border-slate-200 p-5 dark:border-slate-800"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          <Settings2 size={17} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="automatic-setup-title" className="font-semibold">
                Automatic setup
              </h2>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Assign built-in responsibilities when an AI Employee has the AI Model and Grants
                they need.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-sm font-medium" aria-hidden="true">
                {saving ? "Saving…" : enabled ? "On" : "Off"}
              </span>
              <button
                type="button"
                role="switch"
                aria-label="Automatic setup"
                aria-describedby="automatic-setup-description"
                aria-checked={enabled}
                disabled={!canManage || saving}
                onClick={onToggle}
                className={clsx(
                  "h-6 w-11 shrink-0 rounded-full p-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                  enabled ? "bg-indigo-600" : "bg-slate-200 dark:bg-slate-700",
                )}
              >
                <span
                  className={clsx(
                    "block h-5 w-5 rounded-full bg-white transition-transform",
                    enabled && "translate-x-5",
                  )}
                />
              </button>
            </div>
          </div>
          <p
            id="automatic-setup-description"
            className="mt-3 text-xs leading-5 text-slate-500 dark:text-slate-400"
          >
            {enabled
              ? "New ready responsibilities are assigned automatically. Your custom and paused work is never replaced or resumed."
              : "No new automatic assignments will be made. Existing work keeps its current running or paused state."}
          </p>
        </div>
      </div>
    </section>
  );
}

function StandingWork({
  company,
  overview,
  canManage,
  busy,
  onToggle,
  onBrowseStarters,
}: {
  company: Company;
  overview: ProactiveOverview;
  canManage: boolean;
  busy: string | null;
  onToggle: (installation: ProactiveInstallation) => void;
  onBrowseStarters: () => void;
}) {
  const running = overview.installations.filter(
    (entry) => entry.enabled && !entry.configurationIssue,
  ).length;
  const paused = overview.installations.filter(
    (entry) => !entry.enabled && !entry.configurationIssue,
  ).length;
  const needsAttention = overview.installations.filter((entry) => entry.configurationIssue).length;

  return (
    <section aria-labelledby="standing-work-title" className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="standing-work-title" className="text-base font-semibold">
              Standing work
            </h2>
            {overview.installations.length > 0 && (
              <span className="text-xs tabular-nums text-slate-400 dark:text-slate-500">
                {running} running · {paused} paused
                {needsAttention > 0 ? ` · ${needsAttention} needs attention` : ""}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Built-in responsibilities assigned from this page. Custom work lives with your other
            Routines.
          </p>
        </div>
        <Link
          className="inline-flex items-center gap-1 text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          to={`/c/${company.slug}/routines`}
        >
          See all Routines <ArrowRight size={14} aria-hidden="true" />
        </Link>
      </div>

      {overview.installations.length === 0 ? (
        <EmptyState
          title={
            overview.automaticSetup ? "Waiting for ready AI Employees" : "No built-in work assigned"
          }
          description={
            overview.automaticSetup
              ? "Connect an AI Model and add the required Grants, or choose a starter yourself."
              : "Browse the starter library to assign a responsibility, or create a custom Routine."
          }
          action={
            canManage ? (
              <Button variant="secondary" size="sm" onClick={onBrowseStarters}>
                Browse starter library
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-950">
          {overview.installations.map((installation) => {
            const employee = overview.employees.find(
              (entry) => entry.id === installation.employeeId,
            );
            const mailbox = overview.mailboxes.find((entry) => entry.id === installation.accountId);
            const recipe = overview.recipes.find((entry) => entry.id === installation.recipeId);
            return (
              <div
                key={installation.id}
                className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 gap-3">
                  <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300">
                    {installation.kind === "email" ? (
                      <Mail size={17} aria-hidden="true" />
                    ) : (
                      <CalendarClock size={17} aria-hidden="true" />
                    )}
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link className="font-medium hover:underline" to={installation.href}>
                        {installation.name}
                      </Link>
                      <WorkStatus installation={installation} />
                    </div>
                    <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                      {employee?.name ?? "Former AI Employee"} ·{" "}
                      {installation.kind === "email"
                        ? "When matching email arrives"
                        : (recipe?.scheduleLabel ?? "On its Routine schedule")}
                      {mailbox ? ` · ${mailbox.address}` : ""}
                    </p>
                    {installation.configurationIssue && (
                      <p className="mt-1 text-xs leading-5 text-amber-700 dark:text-amber-400">
                        {installation.configurationIssue}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
                  <Link
                    className={buttonClassName({ variant: "ghost", size: "sm" })}
                    to={installation.href}
                  >
                    Open
                  </Link>
                  {canManage && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy === installation.id}
                      onClick={() => onToggle(installation)}
                    >
                      {busy === installation.id
                        ? "Saving…"
                        : installation.enabled
                          ? "Pause"
                          : "Resume"}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function WorkStatus({ installation }: { installation: ProactiveInstallation }) {
  if (installation.configurationIssue) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
        <PauseCircle size={11} aria-hidden="true" /> Needs attention
      </span>
    );
  }
  if (!installation.enabled) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
        <PauseCircle size={11} aria-hidden="true" /> Paused
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
      <CheckCircle2 size={11} aria-hidden="true" /> Running
    </span>
  );
}

function StarterLibrary({
  overview,
  canManage,
  open,
  filter,
  onOpenChange,
  onFilterChange,
  onSelect,
}: {
  overview: ProactiveOverview;
  canManage: boolean;
  open: boolean;
  filter: StarterFilter;
  onOpenChange: (open: boolean) => void;
  onFilterChange: (filter: StarterFilter) => void;
  onSelect: (recipe: ProactiveRecipe) => void;
}) {
  const recipes = overview.recipes.filter((recipe) => filter === "all" || recipe.kind === filter);

  return (
    <section
      aria-labelledby="starter-library-title"
      className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800"
    >
      <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 id="starter-library-title" className="font-semibold">
            Starter library
          </h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Ready-made review-first responsibilities. Setup checks existing Grants and never adds
            access.
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          aria-expanded={open}
          aria-controls="starter-library-content"
          onClick={() => onOpenChange(!open)}
        >
          {open ? "Hide starters" : `Browse ${overview.recipes.length} starters`}
          {open ? (
            <ChevronUp size={15} aria-hidden="true" />
          ) : (
            <ChevronDown size={15} aria-hidden="true" />
          )}
        </Button>
      </div>

      {open && (
        <div
          id="starter-library-content"
          className="border-t border-slate-200 p-5 dark:border-slate-800"
        >
          <div
            role="group"
            aria-label="Filter starter library"
            className="mb-4 flex w-fit max-w-full gap-1 rounded-lg border border-slate-200 p-1 dark:border-slate-700"
          >
            {STARTER_FILTERS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={filter === option.value}
                onClick={() => onFilterChange(option.value)}
                className={clsx(
                  "rounded-md px-3 py-1.5 text-sm font-medium transition",
                  filter === option.value
                    ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                    : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            {recipes.map((recipe) => {
              const assigned = overview.installations.filter(
                (installation) => installation.recipeId === recipe.id,
              ).length;
              return (
                <article
                  key={recipe.id}
                  className="flex flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950"
                >
                  <div className="flex items-start gap-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
                      {recipe.kind === "email" ? (
                        <Mail size={16} aria-hidden="true" />
                      ) : (
                        <CalendarClock size={16} aria-hidden="true" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-semibold">{recipe.name}</h3>
                        {recipe.id === "advance-responsibilities" && (
                          <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300">
                            Recommended
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                        {recipe.description}
                      </p>
                    </div>
                  </div>
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      {recipe.kind === "email" ? "When email arrives" : recipe.scheduleLabel}
                      {assigned > 0 ? ` · ${assigned} assigned` : ""}
                    </span>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!canManage}
                      onClick={() => onSelect(recipe)}
                    >
                      {assigned > 0 ? "Add another" : "Set up"}
                      <ArrowRight size={14} aria-hidden="true" />
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
