import { ArrowRight, ShieldCheck } from "lucide-react";
import { type RoleDef } from "@/roles/data";
import { roleIcon } from "@/roles/roleIcons";
import { TextLink } from "@/sections/Kit";

/**
 * One role's working day, and the rail that reads it back.
 *
 * Shared by the landing page's role switcher and by every role page, because
 * the day is the argument on both and two drawings of it would drift. The
 * schedule and the rail are separate exports so a page can lay them out in
 * whatever grid it needs.
 */

/**
 * The day itself. Times are mono and tabular so the column reads as a clock,
 * and the connector between rows is what makes eight separate paragraphs read
 * as one continuous day.
 */
export function DaySchedule({ role }: { role: RoleDef }) {
  // Counted and named separately: a Decision and an Approval are different
  // stops (see the note on RoleMoment.kind), and a header that called one the
  // other would undo the distinction the rest of the page is making.
  const decisions = role.day.filter((moment) => moment.kind === "decision").length;
  const approvals = role.day.filter((moment) => moment.kind === "approval").length;
  const stops = [
    decisions && `${decisions} ${decisions === 1 ? "Decision" : "Decisions"}`,
    approvals && `${approvals} ${approvals === 1 ? "Approval" : "Approvals"}`,
  ].filter(Boolean);
  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-zinc-200 px-5 py-4 sm:px-7">
        <span className="text-[11px] font-semibold uppercase tracking-label text-zinc-600">
          One Tuesday
        </span>
        <span aria-hidden className="h-3 w-px bg-zinc-200" />
        <span className="text-[13px] font-semibold text-zinc-950">
          {role.person} · {role.name}
        </span>
        <span className="ml-auto font-mono text-[11px] text-zinc-600">
          {[`${role.day.length} Runs`, ...stops].join(" · ")}
        </span>
      </div>

      <ol className="px-5 py-2 sm:px-7">
        {role.day.map((moment, index) => {
          const escalated = moment.kind === "decision" || moment.kind === "approval";
          const last = index === role.day.length - 1;
          return (
            <li key={moment.time} className="relative grid grid-cols-[3.25rem_auto_minmax(0,1fr)] gap-x-3 sm:grid-cols-[4rem_auto_minmax(0,1fr)] sm:gap-x-4">
              <div className="py-5 text-right">
                <span className="tabular font-mono text-[12px] font-semibold text-zinc-950">
                  {moment.time}
                </span>
              </div>

              <div className="relative flex justify-center py-5">
                <span
                  aria-hidden
                  className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ring-4 ring-white ${
                    escalated ? "bg-amber-500" : role.dot
                  }`}
                />
                {!last && (
                  <span aria-hidden className="absolute left-1/2 top-9 h-[calc(100%-1.25rem)] w-px -translate-x-1/2 bg-zinc-200" />
                )}
              </div>

              <div className={`py-5 ${last ? "" : "border-b border-zinc-100"}`}>
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-zinc-950">
                    {moment.title}
                  </h3>
                  {escalated && (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                      <ShieldCheck aria-hidden className="h-3 w-3" />
                      Stopped for you
                    </span>
                  )}
                </div>
                <p className="mt-2 max-w-2xl text-[14px] leading-6 text-zinc-700">{moment.body}</p>
                <span className="mt-3 inline-flex items-center gap-2 rounded-md bg-zinc-100 px-2 py-1 font-mono text-[10px] font-medium text-zinc-700">
                  {moment.where}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * The right rail: who this is, what the day produced, and what it asked.
 *
 * `identity` draws the who-is-this card. The role page turns it off — the
 * hero two screens up has already introduced the employee, and repeating the
 * name, the summary and a link to the page you are already on is the kind of
 * duplication that makes a page feel padded.
 */
export function RoleRail({ role, identity = true }: { role: RoleDef; identity?: boolean }) {
  const Icon = roleIcon(role.icon);
  return (
    <div className="flex flex-col gap-4">
      {identity && (
      <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-card">
        <div className="flex items-center gap-3">
          <span
            className={`flex h-11 w-11 items-center justify-center rounded-xl ring-1 ring-inset ${role.accent}`}
          >
            <Icon aria-hidden className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-label text-zinc-600">
              {role.discipline}
            </div>
            <div className="mt-0.5 text-base font-semibold tracking-[-0.01em] text-zinc-950">
              {role.name}
            </div>
          </div>
        </div>
        <p className="mt-4 text-[14px] leading-6 text-zinc-700">{role.summary}</p>
        <TextLink href={`/roles/${role.slug}`} className="mt-6">
          {`See the ${role.name} role`}
          <ArrowRight aria-hidden className="h-4 w-4 transition group-hover:translate-x-0.5" />
        </TextLink>
      </div>
      )}

      <div className="rounded-2xl border border-zinc-200 bg-white shadow-card">
        <div className="border-b border-zinc-200 px-6 py-4 text-[11px] font-semibold uppercase tracking-label text-zinc-600">
          By the end of the day
        </div>
        <dl className="divide-y divide-zinc-100">
          {role.outputs.map((output) => (
            <div key={output.label} className="flex items-baseline gap-4 px-6 py-4">
              <dt className="tabular shrink-0 text-2xl font-semibold tracking-[-0.03em] text-zinc-950">
                {output.value}
              </dt>
              <dd className="text-[13px] leading-5 text-zinc-700">{output.label}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-6">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-label text-amber-800">
          <ShieldCheck aria-hidden className="h-3.5 w-3.5" />
          What it brought to you
        </div>
        <ul className="mt-4 space-y-3">
          {role.decisions.map((decision) => (
            <li key={decision} className="text-[13px] leading-5 text-amber-950">
              {decision}
            </li>
          ))}
        </ul>
        <p className="mt-5 text-[12px] leading-5 text-amber-900/80">
          Answering one performs no side effect. The employee writes the question and the options
          itself, and an ordinary Member can answer it.
        </p>
      </div>
    </div>
  );
}

