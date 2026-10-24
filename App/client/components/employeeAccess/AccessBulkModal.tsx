import React from "react";
import {
  ACCESS_KIND_META,
  accessLevelLabel,
  actionLabel,
  defaultLevels,
  kindCount,
  planBulk,
  reportBulk,
  type AccessBulkAction,
  type AccessBulkResponse,
  type AccessItem,
  type AccessKind,
  type BulkPlan,
  type BulkReport,
  type LevelChoice,
} from "@/lib/employeeAccess";
import { errorMessage } from "@/lib/errors";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { FormError } from "@/components/ui/FormError";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";

const TITLES: Record<AccessBulkAction, (name: string) => string> = {
  grant: (name) => `Grant access to ${name}`,
  set_level: (name) => `Change ${name}'s access level`,
  revoke: (name) => `Revoke ${name}'s access`,
};

/** The level each ticked kind starts at: its default for a Grant, the level held now for a change. */
function initialLevels(action: AccessBulkAction, items: readonly AccessItem[]): LevelChoice {
  const kinds = new Set(items.map((item) => item.kind));
  const levels = defaultLevels(kinds);
  if (action === "set_level") {
    for (const kind of kinds) {
      const held = items.find((item) => item.kind === kind && item.grant?.level)?.grant?.level;
      if (held) levels[kind] = held;
    }
  }
  return levels;
}

/**
 * The confirmation for a bulk change. It says before anything is sent what will
 * happen to each ticked row — which kinds change and to which level, which rows
 * are already as asked, which the viewer may not change — and after, inline,
 * which rows a kind's own rule refused and why. Success needs no announcement:
 * the dialog closes and the list behind it has already changed.
 */
export function AccessBulkModal({
  action,
  items,
  employeeName,
  onClose,
  onSubmit,
}: {
  action: AccessBulkAction;
  items: AccessItem[];
  employeeName: string;
  onClose: () => void;
  /** Sends the plan; resolves with every row's outcome. */
  onSubmit: (plan: BulkPlan, levels: LevelChoice) => Promise<AccessBulkResponse>;
}) {
  const [levels, setLevels] = React.useState<LevelChoice>(() => initialLevels(action, items));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [report, setReport] = React.useState<BulkReport | null>(null);
  const plan = React.useMemo(() => planBulk(action, items, levels), [action, items, levels]);

  async function submit() {
    if (busy || plan.apply.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const response = await onSubmit(plan, levels);
      const outcome = reportBulk(response, items);
      if (outcome.failures.length === 0) {
        onClose();
        return;
      }
      setReport(outcome);
    } catch (err) {
      setError(errorMessage(err, "The change could not be sent."));
    } finally {
      setBusy(false);
    }
  }

  const levelSummary = plan.levelKinds
    .map(({ kind }) => `${ACCESS_KIND_META[kind].plural}: ${accessLevelLabel(kind, levels[kind])}`)
    .join(" · ");

  const levelPickers = (
    <ul className="flex flex-col gap-3">
      {plan.levelKinds.map(({ kind, count }) => (
        <LevelPicker
          key={kind}
          kind={kind}
          count={count}
          value={levels[kind] ?? ACCESS_KIND_META[kind].defaultLevel ?? ""}
          onChange={(value) => setLevels((current) => ({ ...current, [kind]: value }))}
        />
      ))}
    </ul>
  );

  return (
    <Modal
      open
      onClose={busy ? () => undefined : onClose}
      title={TITLES[action](employeeName)}
      size="md"
      onSubmit={(event) => {
        event.preventDefault();
        if (report) onClose();
        else void submit();
      }}
      footer={
        report ? (
          <Button type="submit">Close</Button>
        ) : (
          <>
            <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={action === "revoke" ? "danger" : "primary"}
              loading={busy}
              disabled={plan.apply.length === 0}
            >
              {plan.apply.length === 0 ? "Nothing to change" : actionLabel(action, plan.apply.length)}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {report ? (
          <ResultSummary action={action} report={report} />
        ) : (
          <>
            <KindSummary action={action} plan={plan} levels={levels} />
            {action === "grant" && plan.levelKinds.length > 0 && (
              <Disclosure title="Advanced" summary={levelSummary}>
                <div className="flex flex-col gap-3 px-4 pb-4 pt-1">
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Each kind starts at its own default level. Choose another for everything of
                    that kind in this change.
                  </p>
                  {levelPickers}
                </div>
              </Disclosure>
            )}
            {action === "set_level" && plan.levelKinds.length > 0 && levelPickers}
            <PlanNotes plan={plan} />
            <FormError message={error} />
          </>
        )}
      </div>
    </Modal>
  );
}

function KindSummary({
  action,
  plan,
  levels,
}: {
  action: AccessBulkAction;
  plan: BulkPlan;
  levels: LevelChoice;
}) {
  if (plan.apply.length === 0) {
    return (
      <p className="text-sm text-slate-600 dark:text-slate-300">
        {action === "set_level" && plan.levelKinds.length > 0
          ? "Choose the level each kind should move to."
          : "Nothing you ticked would change. Every one is already as asked or is not yours to change."}
      </p>
    );
  }
  const counts = new Map<AccessKind, number>();
  for (const item of plan.apply) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  const verb = action === "grant" ? "Will grant" : action === "set_level" ? "Will change" : "Will revoke";
  return (
    <div>
      <p className="text-sm text-slate-600 dark:text-slate-300">
        {verb}{" "}
        <span className="font-medium text-slate-900 dark:text-slate-100">
          {plan.apply.length} {plan.apply.length === 1 ? "item" : "items"}
        </span>
        . Each follows its own section&apos;s rules, and each is audited there.
      </p>
      <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="What changes">
        {[...counts].map(([kind, count]) => {
          const level = action !== "revoke" && ACCESS_KIND_META[kind].levels.length ? levels[kind] : null;
          return (
            <li
              key={kind}
              className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              {kindCount(kind, count)}
              {level ? ` · ${accessLevelLabel(kind, level)}` : ""}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function LevelPicker({
  kind,
  count,
  value,
  onChange,
}: {
  kind: AccessKind;
  count: number;
  value: string;
  onChange: (value: string) => void;
}) {
  const meta = ACCESS_KIND_META[kind];
  const hint = meta.levels.find((level) => level.value === value)?.hint;
  return (
    <li className="flex flex-col gap-1">
      <Select
        label={kindCount(kind, count)}
        aria-label={`Level for ${meta.plural}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {meta.levels.map((level) => (
          <option key={level.value} value={level.value}>
            {level.label}
          </option>
        ))}
      </Select>
      {hint && <p className="text-xs text-slate-500 dark:text-slate-400">{hint}</p>}
    </li>
  );
}

/** The rows that will not change, said once each so nothing is silently dropped. */
function PlanNotes({ plan }: { plan: BulkPlan }) {
  if (plan.unchanged.length === 0 && plan.skipped.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-300">
      {plan.unchanged.length > 0 && (
        <p>
          {plan.unchanged.length} {plan.unchanged.length === 1 ? "is" : "are"} already as asked and
          will be left as {plan.unchanged.length === 1 ? "it is" : "they are"}.
        </p>
      )}
      {plan.skipped.length > 0 && (
        <div>
          <p>
            {plan.skipped.length} {plan.skipped.length === 1 ? "is" : "are"} left out:
          </p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {plan.skipped.slice(0, 6).map(({ item, reason }) => (
              <li key={item.key}>
                <span className="font-medium">{item.label}</span> — {reason}
              </li>
            ))}
            {plan.skipped.length > 6 && <li>and {plan.skipped.length - 6} more.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

function ResultSummary({ action, report }: { action: AccessBulkAction; report: BulkReport }) {
  const verb = action === "grant" ? "Granted" : action === "set_level" ? "Changed" : "Revoked";
  return (
    <div className="flex flex-col gap-3">
      {report.done > 0 && (
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {verb} {report.done} {report.done === 1 ? "item" : "items"}.
        </p>
      )}
      <FormError
        message={`${report.failures.length} ${report.failures.length === 1 ? "item was" : "items were"} refused by ${report.failures.length === 1 ? "its" : "their"} own section's rules.`}
      />
      <ul className="flex flex-col gap-1.5 text-sm" aria-label="Refused">
        {report.failures.map((failure) => (
          <li key={failure.key} className="text-slate-700 dark:text-slate-200">
            <span className="font-medium">{failure.label}</span>
            <span className="text-slate-500 dark:text-slate-400"> — {failure.message}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        They stay ticked, so you can see them in the list.
      </p>
    </div>
  );
}
