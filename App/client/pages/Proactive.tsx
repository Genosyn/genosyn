import React from "react";
import { Link } from "react-router-dom";
import { ArrowRight, CalendarClock, Mail, Sparkles } from "lucide-react";
import { api, type Company } from "@/lib/api";
import { TopBar } from "@/components/AppShell";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { FormError } from "@/components/ui/FormError";
import { EmptyState } from "@/components/ui/EmptyState";
import { useCompanySocketSubscription, useLiveRefetch } from "@/components/CompanySocket";
import {
  proactiveReadiness,
  type ProactiveOverview,
  type ProactiveRecipe,
  type ProactiveInstallation,
} from "../../shared/proactive";

export default function Proactive({ company }: { company: Company }) {
  const [overview, setOverview] = React.useState<ProactiveOverview | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<ProactiveRecipe | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [savingDefaults, setSavingDefaults] = React.useState(false);
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
    <div className="page-shell space-y-8 p-4 sm:p-8">
      <div>
        <TopBar title="Proactive" />
        <p className="mt-2 text-sm text-slate-500">
          Your AI Employees move work forward, follow through on commitments, and suggest better
          ways to run your company.
        </p>
      </div>
      <div className="rounded-xl border border-indigo-100 bg-indigo-50 p-5 text-sm text-indigo-950 dark:border-indigo-900 dark:bg-indigo-950/30 dark:text-indigo-100">
        Proactive review is on by default. AI Employees read what happened and propose a plan in
        the Decision stack. An owner or admin must approve that plan before they change records,
        prepare replies, or start Repository work. Genosyn assigns ready work as AI Employees get a connected
        AI Model and the required resources and Grants, with one automatic assignment for each
        shared responsibility. Every ready employee also gets a daily review of its responsibilities
        and a weekly review of its work. The Soul guides their judgement; Grants and company
        Policies control what they can do.
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 font-medium">
          <Link to={`/c/${company.slug}/decisions`}>
            Review proposed work <span aria-hidden="true">→</span>
          </Link>
          <Link to={`/c/${company.slug}/employees`}>
            AI Employees <span aria-hidden="true">→</span>
          </Link>
          <Link to={`/c/${company.slug}/initiatives`}>
            Proposed Initiatives <span aria-hidden="true">→</span>
          </Link>
          <Link to={`/c/${company.slug}/routines`}>
            Routines and Runs <span aria-hidden="true">→</span>
          </Link>
        </div>
      </div>
      {error && (
        <div>
          <FormError message={error} />
          <Button variant="secondary" onClick={() => void refresh()}>
            Retry
          </Button>
        </div>
      )}
      {!overview && !error && (
        <p role="status" className="text-sm text-slate-500">
          Loading proactive work…
        </p>
      )}
      {overview && (
        <>
          <section
            aria-labelledby="automatic-setup-title"
            className="rounded-xl border border-slate-200 p-5 dark:border-slate-800"
          >
            <div className="flex items-center justify-between gap-4">
              <h2 id="automatic-setup-title" className="text-base font-semibold">
                Automatic setup
              </h2>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-sm font-medium" aria-hidden="true">
                  {savingDefaults ? "Saving…" : overview.automaticSetup ? "On" : "Off"}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-label="Automatic setup"
                  aria-describedby="automatic-setup-description"
                  aria-checked={overview.automaticSetup}
                  disabled={!admin || savingDefaults}
                  onClick={() => void toggleAutomaticSetup()}
                  className={`h-6 w-11 shrink-0 rounded-full p-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-60 ${overview.automaticSetup ? "bg-indigo-600" : "bg-slate-200 dark:bg-slate-700"}`}
                >
                  <span
                    className={`block h-5 w-5 rounded-full bg-white transition-transform ${overview.automaticSetup ? "translate-x-5" : ""}`}
                  />
                </button>
              </div>
            </div>
            <p id="automatic-setup-description" className="mt-1 text-sm leading-6 text-slate-500">
              {overview.automaticSetup
                ? "On: ready responsibilities are assigned automatically, even before you visit this page."
                : "Off: Genosyn will not make new automatic assignments. You can still customize work below."}{" "}
              Turning this off only affects future assignments. Existing work keeps running; use
              Pause on each responsibility to stop future starts.
            </p>
          </section>
          <section
            aria-labelledby="daily-ownership-title"
            className="rounded-xl border border-slate-200 p-5 dark:border-slate-800"
          >
            <h2 id="daily-ownership-title" className="text-base font-semibold">
              A useful next step, every day
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-500">
              Advance my responsibilities reviews assigned work, deadlines, resolved blockers,
              commercial follow-ups, and changes in granted company knowledge. AI Employees inspect
              the evidence, complete useful authorized steps, and track what needs to happen next.
              They also suggest improvements to Routines they help with and new Routines for
              recurring gaps.
            </p>
            <p className="mt-2 text-sm leading-6 text-slate-500">
              New Routine suggestions appear in Proposed Initiatives. Changes to existing work
              appear in Review suggestions. Previous feedback and existing work guide the next
              suggestion; unchanged checks stay quiet.
            </p>
          </section>
          <section aria-labelledby="active-work-title" className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="active-work-title" className="text-base font-semibold">
                Your standing work
              </h2>
              <Link
                className="inline-flex items-center gap-1 text-sm text-indigo-600 hover:underline"
                to={`/c/${company.slug}/revisions`}
              >
                Review suggestions <ArrowRight size={14} aria-hidden="true" />
              </Link>
            </div>
            {overview.installations.length === 0 ? (
              <EmptyState
                title={
                  overview.automaticSetup ? "Waiting for ready AI Employees" : "No standing work"
                }
                description={
                  overview.automaticSetup
                    ? "Connect an AI Model and grant the resources an AI Employee needs. Ready responsibilities will appear here automatically. You can review requirements and customize work below."
                    : "Turn on Automatic setup to assign ready responsibilities, or customize work below."
                }
              />
            ) : (
              <div className="divide-y divide-slate-200 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
                {overview.installations.map((installation) => (
                  <div
                    key={installation.id}
                    className="flex flex-wrap items-center justify-between gap-3 p-4"
                  >
                    <div className="min-w-0">
                      <Link className="font-medium hover:underline" to={installation.href}>
                        {installation.name}
                      </Link>
                      <p className="mt-1 text-sm text-slate-500">
                        {overview.employees.find((e) => e.id === installation.employeeId)?.name} ·{" "}
                        {installation.enabled ? "Enabled" : "Paused"}
                        {installation.accountId
                          ? ` · ${overview.mailboxes.find((m) => m.id === installation.accountId)?.address}`
                          : ""}
                      </p>
                      {installation.configurationIssue && (
                        <p className="mt-1 text-sm text-amber-700 dark:text-amber-400">
                          {installation.configurationIssue}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <Link
                        className="text-sm text-indigo-600 hover:underline"
                        to={installation.href}
                      >
                        Review work
                      </Link>
                      {admin && (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy === installation.id}
                          onClick={() => void toggle(installation)}
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
                ))}
              </div>
            )}
          </section>
          {!admin && (
            <p className="text-sm text-slate-500">
              An owner or admin can change Automatic setup, customize work, and pause
              responsibilities.
            </p>
          )}
          {(["email", "routine"] as const).map((kind) => (
            <section
              key={kind}
              aria-label={kind === "email" ? "When email arrives" : "Keep work moving"}
              className="space-y-4"
            >
              <div>
                <h2 className="text-base font-semibold">
                  {kind === "email" ? "When email arrives" : "Keep work moving"}
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  {kind === "email"
                    ? "New incoming messages start the right work. Existing mail is never replayed on setup."
                    : "Scheduled checks catch overdue work; relevant changes also wake selected Routines. Times use the server’s timezone."}
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {overview.recipes
                  .filter((recipe) => recipe.kind === kind)
                  .map((recipe) => (
                    <article
                      key={recipe.id}
                      className="flex flex-col rounded-xl border border-slate-200 p-5 shadow-sm dark:border-slate-800"
                    >
                      {kind === "email" ? (
                        <Mail size={19} className="mb-4 text-indigo-500" />
                      ) : (
                        <CalendarClock size={19} className="mb-4 text-indigo-500" />
                      )}
                      <h3 className="font-medium">{recipe.name}</h3>
                      <p className="mb-5 mt-2 flex-1 text-sm leading-6 text-slate-500">
                        {recipe.description}
                      </p>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs text-slate-500">
                          {kind === "email" ? "On incoming email" : recipe.scheduleLabel}
                        </span>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={!admin}
                          onClick={() => setSelected(recipe)}
                        >
                          Customize <ArrowRight size={14} />
                        </Button>
                      </div>
                    </article>
                  ))}
              </div>
            </section>
          ))}
          {selected && (
            <Setup
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
        </>
      )}
    </div>
  );
}

function Setup({
  recipe,
  overview,
  company,
  onClose,
  onSaved,
}: {
  recipe: ProactiveRecipe;
  overview: ProactiveOverview;
  company: Company;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [employeeId, setEmployeeId] = React.useState("");
  const [accountId, setAccountId] = React.useState("");
  const [delivery, setDelivery] = React.useState<"draft" | "soul">("draft");
  const [instruction, setInstruction] = React.useState(recipe.brief);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const employee = overview.employees.find((entry) => entry.id === employeeId);
  const mailbox = overview.mailboxes.find((entry) => entry.id === accountId);
  const needs = proactiveReadiness(recipe, employee, mailbox, delivery);
  const already = overview.installations.find(
    (entry) =>
      entry.recipeId === recipe.id &&
      entry.employeeId === employeeId &&
      entry.accountId === (accountId || null),
  );
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.post(`/api/companies/${company.id}/proactive`, {
        recipeId: recipe.id,
        employeeId,
        accountId: accountId || null,
        delivery,
        instruction,
      });
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }
  return (
    <Modal
      open
      onClose={() => {
        if (!saving) onClose();
      }}
      title={recipe.name}
      description={recipe.description}
      size="lg"
      onSubmit={submit}
      footer={
        <>
          <Button variant="secondary" type="button" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={saving || needs.length > 0 || !instruction.trim() || Boolean(already)}
          >
            <Sparkles size={16} />
            {saving ? "Assigning…" : "Assign work"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Select
          label="AI Employee"
          value={employeeId}
          onChange={(event) => setEmployeeId(event.target.value)}
          required
        >
          <option value="">Choose an AI Employee</option>
          {overview.employees.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </Select>
        {recipe.requirements.includes("mail") && (
          <Select
            label="Mailbox"
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            required
          >
            <option value="">Choose a mailbox</option>
            {overview.mailboxes.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.address}
              </option>
            ))}
          </Select>
        )}
        {recipe.kind === "email" && (
          <div>
            <Select
              label="Customer communication"
              value={delivery}
              onChange={(event) => setDelivery(event.target.value as "draft" | "soul")}
            >
              <option value="draft">Prepare drafts for review</option>
              <option value="soul">May send when the Soul permits</option>
            </Select>
            <p className="mt-2 text-xs leading-5 text-slate-500">
              Draft mode blocks sending from this email handover. Sending requires both this choice
              and a Send Grant; company Policies still apply. Inbox cleanup never needs to reply.
            </p>
          </div>
        )}
        {recipe.kind === "routine" && (
          <p className="text-sm text-slate-500">
            {recipe.scheduleLabel}
            {recipe.triggerKind ? ", and on relevant changes (at most once an hour)." : "."} You can
            edit the schedule and require Approval on the Routine after setup.
          </p>
        )}
        <label className="block text-sm font-medium">
          Instructions
          <textarea
            className="mt-2 block min-h-64 w-full rounded-lg border border-slate-300 bg-transparent p-3 text-sm font-normal leading-6 focus:border-indigo-500 focus:outline-none dark:border-slate-700"
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            maxLength={20_000}
            required
          />
        </label>
        <p className="text-xs text-slate-500">
          Choose who owns this responsibility and how they work. Existing Grants are checked here;
          setup never adds access. Scheduled starters draft customer communication and preserve
          source restrictions.
        </p>
        {already && (
          <p className="text-sm text-indigo-600">
            This responsibility is already assigned to this AI Employee and mailbox.{" "}
            <Link className="underline" to={already.href}>
              Review existing work
            </Link>
            .
          </p>
        )}
        {needs.length > 0 && (
          <div className="rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-900">
            <p className="font-medium">Before assigning</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {needs.map((need) => (
                <li key={need}>{need}</li>
              ))}
            </ul>
          </div>
        )}
        <FormError message={error} />
      </div>
    </Modal>
  );
}
