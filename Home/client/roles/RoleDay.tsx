import type { RoleDef, RoleMoment } from "@/roles/data";
import { isStop, momentDept, roleDept, STOP_WORD } from "@/roles/meta";
import { DEPT_DOT, StateTag } from "@/sections/Kit";

const pct = (hours: number) => `${(hours / 24) * 100}%`;

/**
 * A role's day on a 24-hour strip: one tick per Routine firing, and the stop
 * — the one moment a person is needed — called out above the line.
 */
export function DayStrip({ role, className = "" }: { role: RoleDef; className?: string }) {
  const first = role.day[0].at;
  const last = role.day[role.day.length - 1].at;
  return (
    <div aria-hidden className={`relative select-none pt-8 ${className}`}>
      <div className="relative h-10 rounded-xl bg-paper-sunken/70">
        <div className="hour-grid absolute inset-0 rounded-xl" />
        {/* The working span, first Run to last. */}
        <div
          className="absolute inset-y-0 rounded-xl bg-ink/[0.04] ring-1 ring-inset ring-ink/[0.06]"
          style={{ left: pct(first), width: pct(Math.max(0.5, last - first + 0.4)) }}
        />
        {role.day.map((moment) => {
          if (isStop(moment)) {
            return (
              <span key={moment.time}>
                <span
                  className={`absolute inset-y-1 w-[3px] -translate-x-1/2 rounded-full ${
                    moment.kind === "decision" ? "bg-ink" : "border border-ink bg-paper-raised"
                  }`}
                  style={{ left: pct(moment.at) }}
                />
                <span
                  className={`absolute -top-8 -translate-x-1/2 whitespace-nowrap rounded-full px-2 py-1 font-mono text-[10px] uppercase leading-none tracking-[0.08em] ${
                    moment.kind === "decision" ? "bg-ink text-white" : "border border-ink bg-paper-raised text-ink"
                  }`}
                  style={{ left: pct(moment.at) }}
                >
                  {`${moment.time} ${STOP_WORD[moment.kind]}`}
                </span>
              </span>
            );
          }
          const dept = momentDept(moment);
          return (
            <span
              key={moment.time}
              className={`absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-[3px] ring-paper-sunken ${
                dept ? DEPT_DOT[dept] : "bg-ink-400"
              }`}
              style={{ left: pct(moment.at) }}
            />
          );
        })}
      </div>
      <div className="mt-2 flex justify-between font-mono text-[10px] text-ink-400">
        {["00:00", "06:00", "12:00", "18:00", "24:00"].map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
    </div>
  );
}

/**
 * The day as a vertical timeline. `compact` keeps each hour to its headline,
 * which is what the landing page wants; role pages print the whole entry.
 */
export function DayTimeline({ role, compact = false }: { role: RoleDef; compact?: boolean }) {
  return (
    <ol className="relative">
      <span aria-hidden className="absolute bottom-3 left-[4.95rem] top-3 w-px bg-line sm:left-[5.7rem]" />
      {role.day.map((moment) => (
        <Moment key={moment.time} moment={moment} compact={compact} fallback={roleDept(role)} />
      ))}
    </ol>
  );
}

function Moment({
  moment,
  compact,
  fallback,
}: {
  moment: RoleMoment;
  compact: boolean;
  fallback: ReturnType<typeof roleDept>;
}) {
  const stop = isStop(moment);
  // A Decision is drawn solid — the one inverted block in the day — and an
  // Approval outlined, the same way their tags are.
  const inverted = stop && moment.kind === "decision";
  const dept = momentDept(moment) ?? fallback;
  const dot = stop
    ? moment.kind === "decision"
      ? "bg-ink ring-ink-100"
      : "border-2 border-ink bg-paper-raised ring-ink-100"
    : `${DEPT_DOT[dept]} ring-paper-raised`;

  return (
    <li
      className={`relative grid grid-cols-[4.2rem_1.5rem_minmax(0,1fr)] gap-x-1 sm:grid-cols-[4.9rem_1.6rem_minmax(0,1fr)] ${
        compact ? "py-3" : "py-5"
      }`}
    >
      <span className={`pt-0.5 font-mono text-[12px] tabular ${stop ? "text-ink" : "text-ink-500"}`}>
        {moment.time}
      </span>
      <span aria-hidden className="relative flex justify-center pt-1.5">
        <span className={`h-2.5 w-2.5 rounded-full ring-4 ${dot}`} />
      </span>
      <div
        className={`min-w-0 ${
          stop
            ? `rounded-2xl border px-4 py-3.5 ${
                inverted ? "border-ink bg-ink shadow-lifted" : "border-ink/70 bg-paper-raised"
              }`
            : ""
        }`}
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {stop && (
            <StateTag state={moment.kind} night={inverted}>
              {STOP_WORD[moment.kind]}
            </StateTag>
          )}
          <h3
            className={`text-[15.5px] font-medium leading-6 tracking-[-0.005em] ${inverted ? "text-white" : "text-ink"}`}
          >
            {moment.title}
          </h3>
        </div>
        {(!compact || stop) && (
          <p className={`mt-1.5 max-w-[64ch] text-[14.5px] leading-6 ${inverted ? "text-white/70" : "text-ink-600"}`}>
            {moment.body}
          </p>
        )}
        <p
          className={`mt-2 inline-flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.1em] ${
            inverted ? "text-white/50" : "text-ink-400"
          }`}
        >
          {!stop && <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${DEPT_DOT[dept]}`} />}
          {moment.where}
        </p>
      </div>
    </li>
  );
}

/** What the day produced, and what it brought back to a person. */
export function DayReport({ role }: { role: RoleDef }) {
  return (
    <div className="flex flex-col gap-8">
      <div>
        <p className="kicker text-ink-400">By the end of the day</p>
        <dl className="mt-4 divide-y divide-line border-y border-line">
          {role.outputs.map((output) => (
            <div key={output.label} className="flex items-baseline gap-4 py-4">
              <dt className="w-[5.5rem] shrink-0 font-display text-[2rem] leading-none tracking-[-0.04em] text-ink">
                {output.value}
              </dt>
              <dd className="text-[14px] leading-5 text-ink-600">{output.label}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div>
        <p className="kicker text-ink-400">What it brought back</p>
        <ul className="mt-4 space-y-3">
          {role.decisions.map((question) => (
            <li key={question} className="border-l-2 border-ink pl-4">
              <p className="text-[1rem] font-medium leading-[1.45] tracking-[-0.005em] text-ink">{`“${question}”`}</p>
            </li>
          ))}
        </ul>
        <p className="mt-5 text-[13px] leading-5 text-ink-500">
          {`A Decision is ${role.person} choosing to ask: it writes the question and the options, and answering it performs no side effect. An Approval is the system holding an action already attempted until an admin releases it.`}
        </p>
      </div>
    </div>
  );
}
