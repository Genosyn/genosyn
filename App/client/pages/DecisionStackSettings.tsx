import React from "react";
import { CheckCircle2, GitBranch, PauseCircle } from "lucide-react";
import { Link } from "react-router-dom";

import { TopBar } from "@/components/AppShell";
import { useLiveRefetch } from "@/components/CompanySocket";
import { InstructionsEditor } from "@/components/InstructionsEditor";
import { Button } from "@/components/ui/Button";
import { clsx } from "@/components/ui/clsx";
import { FormError } from "@/components/ui/FormError";
import { Spinner } from "@/components/ui/Spinner";
import { decisionStackApi, type Company, type DecisionStackSettings } from "@/lib/api";
import { decisionStackInstructionsEdit, decisionStackSwitchNote } from "@/lib/decisionStack";
import { errorMessage } from "@/lib/errors";
import { MAX_DECISION_STACK_INSTRUCTIONS_LENGTH } from "../../shared/decisionStackInstructions";

/**
 * Decision stack → Settings: the two things a company decides about its
 * Decision stack, in the order people think about them.
 *
 *  1. **Whether AI Employees may add questions at all.** On by default. Off
 *     says, right under the switch, what still happens — questions already
 *     waiting stay answerable, email and work reviews still arrive — because
 *     a switch that sounds like it silences every human gate would be a lie.
 *  2. **Which questions belong.** The instructions every new question is
 *     checked against before it is stacked, pre-filled with the default, in
 *     the same box as a mailbox's AI analysis instructions.
 *
 * Every Member can read both; only owners and admins can change them (the
 * server says which via `canManage`, so a role change shows up on reload).
 */
export default function DecisionStackSettingsPage({ company }: { company: Company }) {
  const [settings, setSettings] = React.useState<DecisionStackSettings | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [retrying, setRetrying] = React.useState(false);
  const [switching, setSwitching] = React.useState(false);
  const [switchError, setSwitchError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      setSettings(await decisionStackApi.settings(company.id));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the Decision stack settings"));
    }
  }, [company.id]);

  React.useEffect(() => {
    setSettings(null);
    setLoadError(null);
    void load();
  }, [load]);
  // Another admin's change, or a question arriving, updates this page live.
  useLiveRefetch("decision", load);

  async function retry() {
    setRetrying(true);
    try {
      await load();
    } finally {
      setRetrying(false);
    }
  }

  async function toggle() {
    if (!settings || !settings.canManage || switching) return;
    setSwitching(true);
    setSwitchError(null);
    try {
      setSettings(await decisionStackApi.update(company.id, { enabled: !settings.enabled }));
    } catch (err) {
      setSwitchError(
        errorMessage(
          err,
          settings.enabled
            ? "Couldn’t turn the Decision stack off"
            : "Couldn’t turn the Decision stack on",
        ),
      );
    } finally {
      setSwitching(false);
    }
  }

  return (
    <div className="page-shell p-4 sm:p-8">
      <TopBar title="Decision stack settings" />
      <p className="-mt-3 mb-6 max-w-2xl text-sm leading-relaxed text-slate-500 dark:text-slate-400">
        Choose whether your AI Employees can bring questions to the{" "}
        <Link
          to={`/c/${company.slug}/decisions`}
          className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
        >
          Decision stack
        </Link>
        , and which questions belong there.
      </p>

      {!settings ? (
        loadError ? (
          <div className="space-y-2">
            <FormError message={loadError} />
            <Button size="sm" variant="secondary" loading={retrying} onClick={() => void retry()}>
              Try again
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
            <Spinner size={14} /> Loading Decision stack settings…
          </div>
        )
      ) : (
        <div className="flex max-w-3xl flex-col gap-5">
          <StackSwitch
            settings={settings}
            switching={switching}
            error={switchError}
            onToggle={() => void toggle()}
          />
          <section
            aria-labelledby="decision-stack-instructions-title"
            className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950"
          >
            <h2
              id="decision-stack-instructions-title"
              className="text-sm font-semibold text-slate-900 dark:text-slate-100"
            >
              Which questions belong
            </h2>
            <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
              {settings.enabled
                ? "Before a question reaches the stack, it is checked against these instructions."
                : "These apply again as soon as the Decision stack is back on."}
            </p>
            <InstructionsEditor
              className="mt-4"
              saved={settings.instructions}
              usingDefault={settings.usingDefaultInstructions}
              edit={decisionStackInstructionsEdit}
              busyElsewhere={switching}
              readOnly={!settings.canManage}
              readOnlyNote="Only owners and admins can change these instructions."
              rows={8}
              maxLength={MAX_DECISION_STACK_INSTRUCTIONS_LENGTH}
              placeholder={"For example:\nOnly ask us about spending over $500."}
              description="Write in your own words which questions you want to see, one instruction per line. Your AI Employees read them too."
              hint={
                <>
                  A question your instructions keep off the stack is never created. The AI Employee
                  is told why, and handles it within the authority it already has — it can&apos;t
                  take a bigger step because of it. Approvals, email reviews and work reviews always
                  reach you. Questions kept off show in that employee&apos;s work timeline and in
                  the audit log. Leave the box empty to let every question through.
                </>
              }
              onSave={async (instructions) => {
                const next = await decisionStackApi.update(company.id, { instructions });
                setSettings(next);
                return { instructions: next.instructions, usingDefault: next.usingDefaultInstructions };
              }}
            />
          </section>
        </div>
      )}
    </div>
  );
}

/** The switch, with the sentence that says what it does right now. */
function StackSwitch({
  settings,
  switching,
  error,
  onToggle,
}: {
  settings: DecisionStackSettings;
  switching: boolean;
  error: string | null;
  onToggle: () => void;
}) {
  const note = decisionStackSwitchNote(settings);
  return (
    <section
      aria-labelledby="decision-stack-switch-title"
      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950"
    >
      <div className="flex items-start gap-3">
        <span className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600 sm:flex dark:bg-slate-800 dark:text-slate-300">
          <GitBranch size={17} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2
                id="decision-stack-switch-title"
                className="text-sm font-semibold text-slate-900 dark:text-slate-100"
              >
                Let AI Employees add decisions
              </h2>
              <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                When an AI Employee reaches a big choice it shouldn&apos;t make alone, it can stop
                and ask you here.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-sm font-medium" aria-hidden="true">
                {switching ? "Saving…" : settings.enabled ? "On" : "Off"}
              </span>
              <button
                type="button"
                role="switch"
                aria-label="Let AI Employees add decisions"
                aria-describedby="decision-stack-switch-note"
                aria-checked={settings.enabled}
                aria-busy={switching || undefined}
                disabled={!settings.canManage || switching}
                onClick={onToggle}
                className={clsx(
                  "h-6 w-11 shrink-0 rounded-full p-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                  settings.enabled ? "bg-indigo-600" : "bg-slate-200 dark:bg-slate-700",
                )}
              >
                <span
                  className={clsx(
                    "block h-5 w-5 rounded-full bg-white transition-transform",
                    settings.enabled && "translate-x-5",
                  )}
                />
              </button>
            </div>
          </div>
          <div
            id="decision-stack-switch-note"
            className={clsx(
              "mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-5",
              note.tone === "ok"
                ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-300"
                : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200",
            )}
          >
            {note.tone === "ok" ? (
              <CheckCircle2 size={13} className="mt-1 shrink-0" aria-hidden="true" />
            ) : (
              <PauseCircle size={13} className="mt-1 shrink-0" aria-hidden="true" />
            )}
            <span>{note.text}</span>
          </div>
          {!settings.canManage && (
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              Only owners and admins can change this.
            </p>
          )}
          <FormError message={error} className="mt-3" />
        </div>
      </div>
    </section>
  );
}
