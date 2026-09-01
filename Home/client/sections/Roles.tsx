import { useState } from "react";
import { ROLES } from "@/roles/data";
import { DaySchedule, RoleRail, roleDept } from "@/roles/RoleDay";
import {
  Band,
  Body,
  Container,
  DEPT_FULL,
  Field,
  Head,
  Row,
  Sheet,
  type Dept,
} from "@/sections/Kit";

/**
 * The day-in-the-life band, and the roster under it.
 *
 * Both are mounted on the landing page by `App.tsx` as sheets 02 and 03. (An
 * earlier revision of this header claimed nothing imported them; that stopped
 * being true when the landing sequence was rebuilt, and the note is removed
 * rather than left to mislead the next reader.)
 *
 * "Runs your company autonomously" is an abstraction, and abstractions
 * convince nobody. A schedule does: pick a role, read what it did at 06:40 and
 * at 11:00 and at 17:45, and see the one moment in the day it stopped and
 * asked a person. That last part is not a caveat bolted onto the pitch. It is
 * the pitch, so the stop is drawn in the same strip as the work rather than in
 * a footnote underneath it.
 *
 * ## Where the org chart shows up here
 *
 * Every role belongs to a department, so this pair of bands is where colour
 * has the most work to do on the whole site:
 *
 *   - the switcher is eight cells, each wearing its department's 3px edge, and
 *     the selected one is filled with that department outright;
 *   - the day pane below inherits the same hue on its own top edge, and its
 *     rows carry the hue of whichever product each hour happened in;
 *   - the roster is eight rows on eight department spines.
 *
 * Read top to bottom that is a legend being taught and then used twice, which
 * is the only honest reason to spend eight hues on one screen.
 *
 * The headline is generated from the role the reader just picked, so it is a
 * fact about the schedule below it rather than a claim above it: the last
 * clock time comes out of `role.day`, and switching roles rewrites it.
 *
 * The switcher is `aria-pressed` buttons rather than a `tablist`, because a
 * real tablist owes the reader arrow-key navigation and a roving tabindex, and
 * a row of eight toggle buttons is honest about what it is.
 */
export function Roles() {
  const [active, setActive] = useState(ROLES[0].slug);
  const role = ROLES.find((item) => item.slug === active) ?? ROLES[0];
  const last = role.day[role.day.length - 1].time;

  return (
    <Band id="roles" tone="ground" open="l" close="m">
      <Container>
        <Head
          eyebrow="02 / One role's day"
          title={`${role.person} ${role.shipped} by ${last}.`}
          lede="Pick a role and read its day. Every line is a Routine on a schedule: what it did, which product it did it in, and the one hour it stopped and put a question in front of a person."
        />

        {/* The switcher sits inside the day's own column rather than across the
            container, and the pane is pulled up onto its bottom border, so the
            eight cells read as an index of the thing directly beneath them.
            Spanning the full width was tried and the strip then indexed the
            rail as well, which it does not. */}
        <div className="mt-12 grid gap-10 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0">
            <RoleTabs active={active} onSelect={setActive} />
            <div className="-mt-px">
              <DaySchedule role={role} />
            </div>
          </div>
          <RoleRail role={role} />
        </div>
      </Container>
    </Band>
  );
}

/**
 * Tailwind only ever sees whole class names, so `hover:${DEPT_TINT[dept]}`
 * would never be generated and the hover would silently do nothing. Written
 * out for that reason alone — the values are the kit's tints and must not
 * drift from them.
 */
const DEPT_TINT_HOVER: Record<Dept, string> = {
  finance: "hover:bg-tint-finance",
  repositories: "hover:bg-tint-repositories",
  marketing: "hover:bg-tint-marketing",
  workspace: "hover:bg-tint-workspace",
  email: "hover:bg-tint-email",
  revenue: "hover:bg-tint-revenue",
  operations: "hover:bg-tint-operations",
  people: "hover:bg-tint-people",
};

/**
 * The switcher.
 *
 * Eight rule-bounded cells sharing one border between each pair, wrapping at
 * every width instead of scrolling sideways: the old strip was a horizontally
 * scrolling row of rounded pills carrying a pastel icon tile each, which meant
 * five of the eight roles were off-screen at 375px with nothing to say so.
 *
 * Selection used to be `bg-ink`, borrowed from the site's hover language. That
 * was the wrong loan under this palette: ink means a person is needed, and a
 * reader picking a tab is not a Decision. Selection is now the department's own
 * hue at tile scale, which makes the strip the org chart it was always drawing
 * — eight departments, one of them currently open — and leaves black free for
 * the one row in the day below that actually stopped.
 *
 * Selection is legible with colour off: the selected cell is FILLED and the
 * other seven are outlined, which is a difference in form rather than in hue,
 * and `aria-pressed` carries it for anyone not looking at all.
 */
function RoleTabs({ active, onSelect }: { active: string; onSelect: (slug: string) => void }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8">
      {ROLES.map((role) => {
        const dept = roleDept(role);
        const selected = role.slug === active;
        return (
          <button
            key={role.slug}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(role.slug)}
            className={`t-field relative -mt-px -ml-px border px-3.5 pt-3.5 pb-2.5 text-[12px] transition-colors duration-100 ${
              selected
                ? `${DEPT_FULL[dept]} border-transparent text-surface`
                : `border-rule bg-surface text-ink2 ${DEPT_TINT_HOVER[dept]}`
            }`}
          >
            {/* The edge is drawn on all eight, not just the selected one: a
                legend a reader can only see one eighth of at a time is not a
                legend. On the selected cell it merges into the fill. */}
            <span aria-hidden className={`absolute inset-x-0 top-0 h-[3px] ${DEPT_FULL[dept]}`} />
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
 * Each row now carries its department's 3px spine, which is what turns the
 * stack into an org chart: eight roles, eight departments, one edge each,
 * decoded from the switcher two hundred pixels above. The hue survives the
 * hover inversion on purpose — the row goes black under the cursor and the
 * spine does not, so the department is still stated while you are pointing at
 * it.
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
    <Band id="roster" tone="ground" open="s" close="s">
      <Container>
        <Head
          eyebrow="03 / The roster"
          title={`${ROLES.length} roles arrive with the first day already written.`}
          lede="Underneath, each one is the same three things: a Soul, a set of Skills, and Routines on a schedule. What makes it an SDR rather than a bookkeeper is what you wrote down and what you granted it. The next one can be a job title that exists only at your company."
          aside={<Field>{`${ROLES.length} ROLES · ${routines} ROUTINES`}</Field>}
        />

        <div className="mt-10">
          {/* Column headers, and the width where three columns actually fit.
              The break is `xl` rather than `lg` because the schedule column
              has to hold "Every 15 minutes, around the clock" on one line —
              a mono field that wraps stops looking like a field — and paying
              that 19rem out of a 1024px grid leaves the summary at 182px,
              which is eight lines of text in a column meant to be scanned.
              Below it the three parts stack and nothing is dropped.

              `pl-4` rather than `px-1`: the rows are indented by their spines
              now, and a header that does not sit over its own column is worse
              than no header. */}
          <div className="hidden gap-x-6 pb-3 pl-4 xl:flex">
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
                dept={roleDept(role)}
                className="flex-wrap pr-1 last:border-b-0"
              >
                <div className="w-full xl:w-[13rem] xl:shrink-0">
                  <span className="block text-[15px] leading-6 text-ink group-hover:text-surface">
                    {role.name}
                  </span>
                  <Sheet className="mt-1 block group-hover:text-surface">{role.discipline}</Sheet>
                </div>

                <Body className="w-full min-w-0 text-[13px] leading-5 group-hover:text-surface xl:flex-1 xl:basis-0">
                  {role.summary}
                </Body>

                <div className="w-full xl:w-[19rem] xl:shrink-0">
                  <span className="block text-[13px] leading-5 text-ink2 group-hover:text-surface">
                    {routine.name}
                  </span>
                  <Field className="mt-1 block group-hover:text-hairline">{routine.when}</Field>
                </div>
              </Row>
            );
          })}
        </div>
      </Container>
    </Band>
  );
}
