import { Mark } from "@/components/Marks";
import { type RoleDef, type RoleMoment } from "@/roles/data";
import { Body, Field, Heading, Note, Row, Sheet, StateTag, TextLink } from "@/sections/Kit";

/**
 * One role's working day, and the rail that reads it back.
 *
 * Shared by the landing page's role switcher and by every role page, because
 * the day is the argument on both and two drawings of it would drift. The
 * schedule and the rail stay separate exports so a page can lay them out in
 * whatever grid it needs.
 *
 * The day used to be a rounded card holding a bulleted timeline with a
 * coloured dot per role and a pill reading "Stopped for you". It is now drawn
 * the way the 24-hour board in Board.tsx is drawn, and for the same reason:
 * left-to-right is time, the marks carry the state, and the one moment that
 * needed a person is the only thing on the page wearing amber. A reader who
 * has already read the board gets the second picture for free.
 */

/** Position on the 24-hour strip. */
const pct = (hours: number) => `${(hours / 24) * 100}%`;

/** The employee stopped here — a Decision it wrote, or an Approval it hit. */
function isStop(moment: RoleMoment): moment is RoleMoment & { kind: "decision" | "approval" } {
  return moment.kind === "decision" || moment.kind === "approval";
}

const STOP_WORD = { decision: "Decision", approval: "Approval" } as const;

export function DaySchedule({ role }: { role: RoleDef }) {
  // Counted and named separately: a Decision and an Approval are different
  // stops (see the note on RoleMoment.kind), and a header that called one the
  // other would undo the distinction the rest of the page is making.
  const decisions = role.day.filter((moment) => moment.kind === "decision").length;
  const approvals = role.day.filter((moment) => moment.kind === "approval").length;
  const stops = [
    decisions && `${decisions} ${decisions === 1 ? "DECISION" : "DECISIONS"}`,
    approvals && `${approvals} ${approvals === 1 ? "APPROVAL" : "APPROVALS"}`,
  ].filter(Boolean);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border border-paper-400 bg-zinc-950 px-4 py-2.5">
        <Sheet className="!text-paper-50">Tuesday</Sheet>
        <span className="t-body text-[13px] leading-5 text-paper-50">
          {`${role.person} · ${role.name}`}
        </span>
        <span className="t-data text-[11px] leading-4 text-zinc-400">SAMPLE DAY</span>
        <span className="t-data ml-auto text-[11px] leading-4 text-zinc-300">
          {[`${role.day.length} RUNS`, ...stops].join(" · ")}
        </span>
      </div>

      <div className="border-x border-b border-paper-400 bg-paper-50">
        <Strip role={role} />

        <div className="px-4 pb-1 sm:px-5">
          {role.day.map((moment) => (
            <MomentRow key={moment.time} moment={moment} />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The day as a 24-hour strip.
 *
 * **A moment is drawn as a tick, not as a bar, and that is a truth claim.** On
 * the board in the hero every bar's width is the Run's duration, because the
 * data carries one. A `RoleMoment` carries a start and nothing else, so
 * inventing a width here would be the one thing this whole design is against:
 * a rectangle that looks like measurement and is not. Ticks say what is known.
 *
 * The stop gets the treatment the 09:30 arrival line gets on the board — a
 * flag in a reserved row above the lane and a 2px amber rule down through it.
 * Anchoring the flag beside the tick was tried first and the label ran over
 * the next two ticks; more to the point, this is the same event as 09:30. It
 * is the boundary where the machine hands the day back to a person.
 *
 * It is `aria-hidden` and it costs nothing to hide: every moment on it is
 * printed in full, in order, in the rows underneath. Below `md` it is not
 * rendered at all rather than squeezed, because a timeline that reflows at
 * 375px has stopped being a timeline.
 */
function Strip({ role }: { role: RoleDef }) {
  const stop = role.day.find(isStop);

  return (
    <div aria-hidden className="hidden border-b border-paper-300 px-5 pt-4 pb-2 md:block">
      <div className="relative pt-7">
        <div className="hours absolute top-7 right-0 bottom-6 left-0" />

        {/* Quarter marks, so the eye has something to measure against without
            turning the strip into graph paper. */}
        {[6, 12, 18].map((hour) => (
          <div
            key={hour}
            className="absolute top-7 bottom-6 w-px bg-paper-400"
            style={{ left: pct(hour) }}
          />
        ))}

        {stop && (
          <>
            <span
              className="arrive-in absolute top-0 flex h-[1.375rem] items-center gap-1.5 bg-signal-500 px-1.5 text-zinc-950"
              style={{ left: pct(stop.at) }}
            >
              <Mark state={stop.kind} className="h-2.5 w-2.5" />
              <span className="t-data whitespace-nowrap text-[10px] leading-none">
                {`${stop.time} ${STOP_WORD[stop.kind].toUpperCase()}`}
              </span>
            </span>
            {/* Every worked day in the roster stops between 11:00 and 16:00, so
                the flag is left-anchored and has room to run. */}
            <span
              className="arrive-in absolute top-7 bottom-6 w-0.5 bg-signal-500"
              style={{ left: pct(stop.at) }}
            />
          </>
        )}

        <div className="relative h-[2.375rem] border-b border-paper-300">
          {/* The stop is drawn by the amber rule above, so it does not also get
              a tick: two marks for one event reads as two events. */}
          {role.day
            .filter((moment) => !isStop(moment))
            .map((moment) => (
              <span
                key={moment.time}
                className="absolute top-1/2 h-[1.375rem] w-[3px] -translate-y-1/2 bg-zinc-950"
                style={{ left: pct(moment.at) }}
              />
            ))}
        </div>

        <div className="relative h-6">
          {[0, 6, 12, 18].map((hour) => (
            <span
              key={hour}
              className="t-data absolute top-1.5 text-[10px] leading-none text-zinc-600"
              style={{ left: pct(hour) }}
            >
              {`${String(hour).padStart(2, "0")}:00`}
            </span>
          ))}
          <span className="t-data absolute top-1.5 right-0 text-[10px] leading-none text-zinc-600">
            24:00
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * One hour of the day: clock, state, what happened, where it happened.
 *
 * The stop carries the mark its kind earns. A Decision is the employee
 * choosing to ask and a `StateTag` with the open-right mark says so; an
 * Approval is the system holding an action the employee already attempted and
 * gets the barred mark. Collapsing them into one "Stopped for you" pill, which
 * is what was here before, describes a product Genosyn does not ship.
 */
function MomentRow({ moment }: { moment: RoleMoment }) {
  const stop = isStop(moment);

  return (
    <Row className="last:border-b-0">
      <Field className="w-[3.25rem] shrink-0 sm:w-[3.75rem]">{moment.time}</Field>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {stop ? (
            <StateTag state={moment.kind}>{STOP_WORD[moment.kind]}</StateTag>
          ) : (
            <Mark state="run" className="h-3 w-3 text-zinc-600" />
          )}
          <h3 className="t-body text-[15px] leading-6 text-zinc-950">{moment.title}</h3>
        </div>

        <Body className="mt-2 max-w-[70ch] text-[14px] leading-6">{moment.body}</Body>
        <Field className="mt-3 block">{moment.where}</Field>
      </div>
    </Row>
  );
}

/**
 * The right rail: who this is, what the day produced, and what it asked.
 *
 * `identity` draws the who-is-this block. The role page turns it off — the
 * hero two screens up has already introduced the employee, and repeating the
 * name, the summary and a link to the page you are already on is the kind of
 * duplication that makes a page feel padded.
 *
 * The questions used to sit in an amber-tinted box with a shield icon on it,
 * which spent the site's one colour on a decoration and labelled every
 * question a Decision whether it was one or not. They are now plain rows under
 * a column header, and the note underneath states the split rather than the
 * box implying it.
 */
export function RoleRail({ role, identity = true }: { role: RoleDef; identity?: boolean }) {
  return (
    <div className="flex flex-col gap-12">
      {identity && (
        <div>
          <Sheet>{role.discipline}</Sheet>
          <Heading as="h3" className="mt-2">
            {role.name}
          </Heading>
          <Body className="mt-4">{role.summary}</Body>
          <TextLink href={`/roles/${role.slug}`} className="mt-6">
            {`Read the ${role.name} page`}
          </TextLink>
        </div>
      )}

      <div>
        <Sheet>By the end of the day</Sheet>
        <div className="mt-4">
          {role.outputs.map((output) => (
            <Row key={output.label} className="items-baseline last:border-b-0">
              {/* A produced figure, set at figure size rather than in the
                  heading ramp: it is a count the software would print, so it
                  is tabular and it is not a heading. */}
              <span className="t-display tabular w-[5.5rem] shrink-0 text-[1.5rem] leading-none text-zinc-950">
                {output.value}
              </span>
              <Body className="min-w-0 flex-1 text-[13px] leading-5">{output.label}</Body>
            </Row>
          ))}
        </div>
      </div>

      <div>
        <Sheet>What it brought back</Sheet>
        <div className="mt-4">
          {role.decisions.map((question) => (
            <Row key={question} className="last:border-b-0">
              <Body className="text-[13px] leading-5">{question}</Body>
            </Row>
          ))}
        </div>
        <Note className="mt-5 text-[15px] leading-[1.65]">
          A Decision is the employee choosing to ask. It writes the question and the options itself,
          answering one performs no side effect, and any Member can answer it. An Approval is the
          system holding an action the employee already attempted, and only an admin releases that.
        </Note>
      </div>
    </div>
  );
}
