import { useState } from "react";
import { ROLES } from "@/roles/data";
import { DaySchedule, RoleRail } from "@/roles/RoleDay";
import { Band, Body, Container, Field, Heading, Lede, Rail, Row, Sheet } from "@/sections/Kit";

/**
 * The day-in-the-life band.
 *
 * NOTE ON WHERE THIS RENDERS: nothing imports it right now. `App.tsx` was
 * rewritten to run Hero, CliShowcase, Autonomy, InstallCta, Colophon, and
 * `RolesIndex.tsx` says in its own header that it no longer mounts the day
 * switcher or the roster grid either. So `Roles` and `Roster` below are built
 * to the kit and compile, but they are unreferenced, and the sheet numbers
 * `02` and `03` are claims on a slot in a landing page that does not currently
 * include them. Whoever owns `App.tsx` has to either mount these two or delete
 * this file — leaving it as it is means the landing page reads 01, 08, 04,
 * 09, 10 and this file rots.
 *
 * "Runs your company autonomously" is an abstraction, and abstractions
 * convince nobody. A schedule does: pick a role, read what it did at 06:40 and
 * at 11:00 and at 17:45, and see the one moment in the day it stopped and
 * asked a person. That last part is not a caveat bolted onto the pitch. It is
 * the pitch, so the stop is drawn in the same strip as the work rather than in
 * a footnote underneath it.
 *
 * The band gets `pad="l"` because it holds a timetable, which is the only
 * condition that earns it.
 *
 * The headline is generated from the role the reader just picked, so it is a
 * fact about the schedule below it rather than a claim above it: the first and
 * last clock times come out of `role.day`, and switching roles rewrites it.
 * That is also why the switcher sits above the day instead of inside it.
 *
 * The switcher is `aria-pressed` buttons rather than a `tablist`, because a
 * real tablist owes the reader arrow-key navigation and a roving tabindex, and
 * a row of eight toggle buttons is honest about what it is.
 */
export function Roles() {
  const [active, setActive] = useState(ROLES[0].slug);
  const role = ROLES.find((item) => item.slug === active) ?? ROLES[0];
  const first = role.day[0].time;
  const last = role.day[role.day.length - 1].time;

  return (
    <Band id="roles" tone="paper" pad="l">
      <Container>
        <Rail
          sheet="02 / A day on the roster"
          fields={["TUE", `${first}-${last}`, `${role.day.length} RUNS`]}
        >
          <Heading className="max-w-[22ch]">
            {`${role.person} worked ${first} to ${last} on Tuesday.`}
          </Heading>

          <Lede className="mt-7">
            Pick a role and read its day. Every line is a Routine on a schedule: what it did, which
            product it did it in, and the one hour it stopped and put a question in front of a
            person.
          </Lede>

          <RoleTabs active={active} onSelect={setActive} />
        </Rail>

        {/* The day breaks out of the rail to the full container, the way the
            board does in the hero. It is the evidence, so it gets the width. */}
        <div className="mt-14 grid gap-12 sm:mt-16 xl:grid-cols-[minmax(0,1fr)_20rem] xl:gap-10">
          <DaySchedule role={role} />
          <RoleRail role={role} />
        </div>
      </Container>
    </Band>
  );
}

/**
 * The switcher.
 *
 * Eight rule-bounded cells sharing one border between each pair, wrapping at
 * every width instead of scrolling sideways: the old strip was a horizontally
 * scrolling row of rounded pills carrying a pastel icon tile each, which meant
 * five of the eight roles were off-screen at 375px with nothing to say so.
 * Selection is the same inversion the rest of the site uses for hover, so
 * there is one visual language for "this one".
 */
function RoleTabs({ active, onSelect }: { active: string; onSelect: (slug: string) => void }) {
  return (
    <div className="mt-10 flex flex-wrap">
      {ROLES.map((role) => {
        const selected = role.slug === active;
        return (
          <button
            key={role.slug}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(role.slug)}
            className={`t-cond -mt-px -ml-px border px-3.5 py-2.5 text-[12px] uppercase tracking-field transition-colors duration-100 ${
              selected
                ? "border-zinc-950 bg-zinc-950 text-paper-50"
                : "border-paper-400 text-zinc-800 hover:bg-zinc-950 hover:text-paper-50"
            }`}
          >
            {role.short}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The roster — every role, in one stack.
 *
 * It was a four-across grid of cards that lifted on hover, each with a pastel
 * icon tile in a different hue, and it read as a pricing page. A roster is a
 * list: one row per role, three columns that mean the same thing on every row,
 * one hairline between each pair. That structure lets a reader compare down a
 * column, which is the only thing anybody does with eight of anything.
 *
 * The third column prints the first Routine and its schedule verbatim from
 * `role.routines`, because the real cron line is worth more than a sentence
 * saying that schedules exist.
 *
 * The lede says "the next one" rather than naming an ordinal. The headline
 * counts `ROLES.length`, so a hard-coded "the ninth" beside it is a sentence
 * that goes wrong the first time `roles/data.ts` gains a role — and that file
 * is owned by another pass.
 */
export function Roster() {
  const routines = ROLES.reduce((total, role) => total + role.routines.length, 0);

  return (
    <Band id="roster" tone="paper" pad="m">
      <Container>
        <Rail sheet="03 / The roster" fields={[`${ROLES.length} ROLES`, `${routines} ROUTINES`]}>
          <Heading className="max-w-[20ch]">
            {`${ROLES.length} roles arrive with ${routines} Routines written.`}
          </Heading>

          <Lede className="mt-7">
            Underneath, each one is the same three things: a Soul, a set of Skills, and Routines on
            a schedule. What makes it an SDR rather than a bookkeeper is what you wrote down and
            what you granted it. The next one can be a job title that exists only at your company.
          </Lede>

          <div className="mt-12">
            {/* Column headers, and the width where three columns actually fit.
                The break is `xl` rather than `lg` because the schedule column
                has to hold "Every 15 minutes, around the clock" on one line —
                a mono field that wraps stops looking like a field — and paying
                that 19rem out of a 1024px grid leaves the summary at 182px,
                which is eight lines of text in a column meant to be scanned.
                Below it the three parts stack and nothing is dropped. */}
            <div className="hidden gap-x-6 px-1 pb-3 xl:flex">
              <Sheet className="w-[13rem] shrink-0">Role</Sheet>
              <Sheet className="min-w-0 flex-1">What it does</Sheet>
              <Sheet className="w-[19rem] shrink-0">What it runs</Sheet>
            </div>

            {ROLES.map((role) => {
              const routine = role.routines[0];
              return (
                <Row
                  key={role.slug}
                  href={`/roles/${role.slug}`}
                  className="flex-wrap last:border-b-0"
                >
                  <div className="w-full xl:w-[13rem] xl:shrink-0">
                    <span className="t-body block text-[15px] leading-6 text-zinc-950 group-hover:text-paper-50">
                      {role.name}
                    </span>
                    <Sheet className="mt-1 block group-hover:text-paper-50">
                      {role.discipline}
                    </Sheet>
                  </div>

                  <Body className="w-full min-w-0 text-[13px] leading-5 group-hover:text-paper-50 xl:flex-1 xl:basis-0">
                    {role.summary}
                  </Body>

                  <div className="w-full xl:w-[19rem] xl:shrink-0">
                    <span className="t-body block text-[13px] leading-5 text-zinc-800 group-hover:text-paper-50">
                      {routine.name}
                    </span>
                    <Field className="mt-1 block group-hover:text-zinc-300">{routine.when}</Field>
                  </div>
                </Row>
              );
            })}
          </div>
        </Rail>
      </Container>
    </Band>
  );
}
