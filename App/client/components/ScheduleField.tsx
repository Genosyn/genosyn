import React from "react";
import { AlertTriangle, CalendarClock } from "lucide-react";
import { Select } from "./ui/Select";
import { cronHuman, cronIsReadable } from "../lib/cron";
import {
  HOUR_STEPS,
  MINUTE_STEPS,
  MONTH_NAMES,
  SCHEDULE_PRESETS,
  WEEKDAY_SHORT_NAMES,
  cronToSchedule,
  daysInMonth,
  defaultSchedule,
  describeSchedule,
  formatRunTime,
  normalizeSchedule,
  previewRuns,
  ordinal,
  scheduleToCron,
  timeInputValue,
  withTimeOfDay,
  type Schedule,
  type ScheduleFrequency,
} from "../lib/scheduleBuilder";

/**
 * The one schedule control in the app: pick a cadence, get a cron expression.
 *
 * Every caller still stores a cron string — Routines, Revenue Signals, and
 * Pipeline schedule triggers all hand the server exactly what they always
 * did. The control just stops asking a person to write it. `lib/schedule.ts`
 * and the recurring-invoice form stay separate, because an invoice schedule
 * carries an "every N months" count that rides alongside the cron and only
 * the invoice scheduler knows how to honour.
 *
 * The custom-expression escape hatch is not decoration. Cron can express more
 * than these controls draw, AI Employees write schedules through the MCP tools
 * without going near this component, and expressions predating it are already
 * in people's databases. Anything the picker cannot redraw opens in the hatch
 * with its expression intact rather than being quietly rewritten into the
 * nearest thing the controls happen to support.
 */

const FREQUENCY_OPTIONS: Array<{ value: ScheduleFrequency; label: string }> = [
  { value: "minutes", label: "Every few minutes" },
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
];

const CUSTOM = "custom";

// One border, one radius, one focus ring for every inline control, so the row
// reads as a single sentence rather than a pile of fields. Mirrors `Input`.
const field =
  "h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 shadow-sm " +
  "dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 " +
  "focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 " +
  "dark:focus:ring-indigo-500/25 disabled:cursor-not-allowed disabled:opacity-60";

const word = "text-sm text-slate-600 dark:text-slate-300";

export function ScheduleField({
  value,
  onChange,
  label = "Schedule",
  hint,
  disabled = false,
  showPresets = true,
  previewCount = 3,
}: {
  /** The cron expression being edited. */
  value: string;
  onChange: (cronExpr: string) => void;
  label?: string | null;
  /** Extra copy under the control, above the preview. */
  hint?: React.ReactNode;
  disabled?: boolean;
  showPresets?: boolean;
  /** How many upcoming fire times to preview. 0 hides the preview. */
  previewCount?: number;
}) {
  // The friendly model is local state, not derived: switching from Weekly to
  // Monthly and back has to remember which weekdays were picked, and a cron
  // string cannot carry the fields its own frequency does not use. Seeded once
  // from the incoming expression; the effect below handles it changing later.
  const [draft, setDraft] = React.useState<Schedule>(
    () => cronToSchedule(value) ?? defaultSchedule(),
  );
  const [custom, setCustom] = React.useState(() => cronToSchedule(value) === null);

  // The escape hatch keeps its own text. What reaches the caller is trimmed —
  // a pipeline matches its firing node by exact cron string, so one stray
  // space is the difference between a schedule that runs and one that quietly
  // never does — and binding the input straight to that trimmed value would
  // make the space bar do nothing.
  const [customText, setCustomText] = React.useState(value);

  // What we last handed the caller. Re-seeding keys off this rather than off
  // the compiled draft: someone typing `0 9 * * 1` into the escape hatch must
  // not be yanked back into the friendly controls mid-keystroke just because
  // what they typed happens to be representable.
  const emitted = React.useRef(value);

  function emit(expr: string) {
    emitted.current = expr;
    onChange(expr);
  }

  // Re-seed when the expression changes underneath us — an edit form that
  // finished loading, a routine switched in place, a sibling control.
  React.useEffect(() => {
    if (value === emitted.current) return;
    emitted.current = value;
    setCustomText(value);
    const next = cronToSchedule(value);
    if (next) {
      setDraft(next);
      setCustom(false);
    } else {
      setCustom(true);
    }
  }, [value]);

  function apply(next: Schedule) {
    const normalized = normalizeSchedule(next);
    setDraft(normalized);
    emit(scheduleToCron(normalized));
  }

  function chooseFrequency(choice: string) {
    if (choice === CUSTOM) {
      // Hand the hatch whatever is stored now, so switching to it shows the
      // schedule that is actually in force rather than an empty box.
      setCustomText(value);
      setCustom(true);
      return;
    }
    setCustom(false);
    apply({ ...draft, frequency: choice as ScheduleFrequency });
  }

  function toggleWeekday(day: number) {
    const selected = draft.weekdays.includes(day)
      ? draft.weekdays.filter((d) => d !== day)
      : [...draft.weekdays, day];
    // Deselecting the last day would compile to a schedule that never fires,
    // so the last one stays stuck rather than silently disabling the work.
    if (selected.length === 0) return;
    apply({ ...draft, weekdays: selected });
  }

  const readable = cronIsReadable(value);
  const preview = React.useMemo(
    () =>
      previewCount > 0 && readable
        ? previewRuns(value, new Date(), previewCount)
        : { supported: false, runs: [] },
    // A preview anchored to "now" only needs recomputing when the expression
    // does; re-running it every render would churn on every keystroke.
    [value, previewCount, readable],
  );

  // Only ever said about an expression the preview fully understands, so a
  // schedule using cron's `L` / `#` / `W` modifiers — which fire perfectly
  // well and which the preview does not walk — is never accused of being dead.
  const neverFires = readable && preview.supported && preview.runs.length === 0;

  // A monthly schedule past the 28th quietly skips February; a yearly one on
  // February 29th only comes round every four years. Both are legitimate, and
  // both surprise people who did not mean them.
  const shortMonths = !custom && draft.frequency === "monthly" && draft.dayOfMonth > 28;
  const leapDayOnly =
    !custom && draft.frequency === "yearly" && draft.month === 2 && draft.dayOfMonth === 29;

  return (
    <div className="flex flex-col gap-2">
      {label && (
        <span className="text-sm font-medium text-slate-700 dark:text-slate-300">{label}</span>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={custom ? CUSTOM : draft.frequency}
          onChange={(e) => chooseFrequency(e.target.value)}
          disabled={disabled}
          aria-label="How often"
          containerClassName="w-48"
        >
          {FREQUENCY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
          <option value={CUSTOM}>Custom (cron)</option>
        </Select>

        {!custom && draft.frequency === "minutes" && (
          <>
            <span className={word}>every</span>
            <Select
              value={String(draft.every)}
              onChange={(e) => apply({ ...draft, every: Number(e.target.value) })}
              disabled={disabled}
              aria-label="Minutes between runs"
              containerClassName="w-28"
            >
              {MINUTE_STEPS.map((step) => (
                <option key={step} value={step}>
                  {step === 1 ? "1 minute" : `${step} minutes`}
                </option>
              ))}
            </Select>
          </>
        )}

        {!custom && draft.frequency === "hourly" && (
          <>
            <span className={word}>every</span>
            <Select
              value={String(draft.every)}
              onChange={(e) => apply({ ...draft, every: Number(e.target.value) })}
              disabled={disabled}
              aria-label="Hours between runs"
              containerClassName="w-28"
            >
              {HOUR_STEPS.map((step) => (
                <option key={step} value={step}>
                  {step === 1 ? "1 hour" : `${step} hours`}
                </option>
              ))}
            </Select>
            <span className={word}>at</span>
            <Select
              value={String(draft.minute)}
              onChange={(e) => apply({ ...draft, minute: Number(e.target.value) })}
              disabled={disabled}
              aria-label="Minutes past the hour"
              containerClassName="w-24"
            >
              {Array.from({ length: 60 }, (_, minute) => (
                <option key={minute} value={minute}>
                  {`:${String(minute).padStart(2, "0")}`}
                </option>
              ))}
            </Select>
            <span className={word}>past the hour</span>
          </>
        )}

        {!custom && draft.frequency === "weekly" && (
          <div
            className="flex flex-wrap items-center gap-1"
            role="group"
            aria-label="Days of the week"
          >
            <span className={`${word} mr-1`}>on</span>
            {WEEKDAY_SHORT_NAMES.map((name, day) => {
              const on = draft.weekdays.includes(day);
              return (
                <button
                  key={name}
                  type="button"
                  aria-pressed={on}
                  disabled={disabled}
                  onClick={() => toggleWeekday(day)}
                  className={
                    "h-10 min-w-11 rounded-lg border px-2 text-xs font-medium transition-colors " +
                    "disabled:cursor-not-allowed disabled:opacity-60 " +
                    (on
                      ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:border-indigo-500 dark:bg-indigo-500/10 dark:text-indigo-200"
                      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800")
                  }
                >
                  {name}
                </button>
              );
            })}
          </div>
        )}

        {!custom && draft.frequency === "yearly" && (
          <>
            <span className={word}>in</span>
            <Select
              value={String(draft.month)}
              onChange={(e) => apply({ ...draft, month: Number(e.target.value) })}
              disabled={disabled}
              aria-label="Month"
              containerClassName="w-36"
            >
              {MONTH_NAMES.map((name, index) => (
                <option key={name} value={index + 1}>
                  {name}
                </option>
              ))}
            </Select>
          </>
        )}

        {!custom && (draft.frequency === "monthly" || draft.frequency === "yearly") && (
          <>
            <span className={word}>on the</span>
            <Select
              value={String(draft.dayOfMonth)}
              onChange={(e) => apply({ ...draft, dayOfMonth: Number(e.target.value) })}
              disabled={disabled}
              aria-label="Day of the month"
              containerClassName="w-24"
            >
              {Array.from(
                { length: draft.frequency === "yearly" ? daysInMonth(draft.month) : 31 },
                (_, index) => index + 1,
              ).map((day) => (
                <option key={day} value={day}>
                  {ordinal(day)}
                </option>
              ))}
            </Select>
          </>
        )}

        {!custom && draft.frequency !== "minutes" && draft.frequency !== "hourly" && (
          <>
            <span className={word}>at</span>
            <input
              type="time"
              value={timeInputValue(draft)}
              onChange={(e) => apply(withTimeOfDay(draft, e.target.value))}
              disabled={disabled}
              aria-label="Time of day"
              className={field}
            />
          </>
        )}

        {custom && (
          <input
            type="text"
            value={customText}
            onChange={(e) => {
              setCustomText(e.target.value);
              emit(e.target.value.trim());
            }}
            disabled={disabled}
            aria-label="Cron expression"
            spellCheck={false}
            placeholder="0 9 * * 1-5"
            className={`${field} w-56 font-mono`}
          />
        )}
      </div>

      <div className="flex flex-col gap-1 text-xs">
        <div
          className={
            readable ? "text-slate-600 dark:text-slate-300" : "text-amber-600 dark:text-amber-400"
          }
        >
          {!readable
            ? "Not a schedule we can read — check the expression."
            : custom
              ? cronHuman(value)
              : describeSchedule(draft)}
          {readable && (
            <span className="ml-2 font-mono text-slate-400 dark:text-slate-500">{value}</span>
          )}
        </div>

        {preview.runs.length > 0 && (
          <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400">
            <CalendarClock size={12} className="shrink-0" />
            <span>
              Next: {preview.runs.map((run) => formatRunTime(run)).join(" · ")}
              <span className="ml-1 text-slate-400 dark:text-slate-500">(server time)</span>
            </span>
          </div>
        )}

        {neverFires && (
          <div className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
            <AlertTriangle size={12} className="shrink-0" />
            <span>
              This schedule never comes round — no date matches it. The routine would never run.
            </span>
          </div>
        )}

        {!custom && draft.frequency === "minutes" && (
          <div className="text-slate-500 dark:text-slate-400">
            Every {draft.every === 1 ? "minute" : `${draft.every} minutes`} is{" "}
            {Math.round((60 / draft.every) * 24)} runs a day, each one billed to the model. Pick the
            longest gap the work can live with.
          </div>
        )}

        {shortMonths && (
          <div className="text-slate-500 dark:text-slate-400">
            The 29th–31st are skipped in months that are too short.
          </div>
        )}

        {leapDayOnly && (
          <div className="text-slate-500 dark:text-slate-400">
            February 29th only exists in a leap year, so this runs once every four years.
          </div>
        )}

        {hint && <div className="text-slate-500 dark:text-slate-400">{hint}</div>}
      </div>

      {showPresets && !disabled && (
        <div className="flex flex-wrap gap-2">
          {SCHEDULE_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => {
                setCustom(false);
                apply(preset.schedule);
              }}
              className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:border-indigo-300 hover:text-indigo-700 dark:border-slate-700 dark:text-slate-300 dark:hover:border-indigo-700 dark:hover:text-indigo-300"
            >
              {preset.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
