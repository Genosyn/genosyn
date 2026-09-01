import { Nav } from "@/sections/Nav";
import { Footer, InstallCta } from "@/sections/Footer";
import { PageHero } from "@/sections/HeroKit";
import {
  ActionStrip,
  Band,
  Body,
  Container,
  Field,
  Heading,
  Rail,
  Row,
  Sheet,
  StateTag,
} from "@/sections/Kit";
import { ROLES, ROLE_DISCIPLINES, type RoleDef, type RoleMoment } from "@/roles/data";

/**
 * The roster index.
 *
 * The old page opened with a badge, a two-tone headline and a four-tick
 * checklist, then showed one role as a floating preview card and the rest as
 * eight hover-lifting tiles, each in its own pastel hue. The products index
 * was the identical page with different nouns in it, which is the clearest
 * possible sign that neither page was saying anything.
 *
 * The hues are gone, so a row has to distinguish itself by what it knows. Two
 * facts do that here and they are the two a reader is actually deciding on:
 *
 *   - **The hours.** First moment to last moment of the role's own day,
 *     straight out of `data.ts`. Robin works 06:40 to 17:45; nobody starts
 *     that shift.
 *   - **The one thing it hands back.** Every role on the roster stops exactly
 *     once a day, and the question it writes is printed verbatim rather than
 *     summarised. That is the artefact, and a summary of it would be a claim.
 *
 * The Decision / Approval distinction is carried in the mark rather than in a
 * word: seven roles write a Decision, the Marketer trips an Approval when it
 * asks to raise the launch spend. AGENTS.md §3 is emphatic that those are not
 * synonyms, so the roster does not flatten them into one label.
 *
 * The landing page's day switcher and roster grid used to be mounted here as
 * well. They are not any more: the grid was this table drawn worse, and a
 * reader who wants the hour-by-hour version is one row away from the real one.
 */
export function RolesIndex() {
  return (
    <div className="min-h-screen bg-paper-100 text-zinc-900">
      <Nav />
      <main>
        <PageHero
          // "01 / Roles", not "01 / Roster": the band below is 02 / Roster, and
          // two sheets on one page carrying the same name stop being a
          // numbering. Products reads 01 / Products then 02 / Catalogue.
          sheet="01 / Roles"
          fields={[`${ROLES.length} ROLES`, `${ROLE_DISCIPLINES.length} DISCIPLINES`, "APACHE-2.0"]}
          title={`${ROLES.length} roles ship written, from ${ROLES[0].short} to ${
            ROLES[ROLES.length - 1].short
          }.`}
          lede={
            <>
              Each role below is a document you edit: a Soul, the Skills its job repeats, and
              Routines on a cron line. The table gives the hours it works and the question it hands
              back to a person.
            </>
          }
          actions={
            <>
              <ActionStrip href={`/roles/${ROLES[0].slug}`} trailing="Read">
                {`${ROLES[0].person}'s Tuesday, hour by hour`}
              </ActionStrip>
              <ActionStrip href="/docs/employees" trailing="Docs" className="-mt-px">
                How a Soul and its Skills are written
              </ActionStrip>
            </>
          }
        />

        <Roster />

        <InstallCta />
      </main>
      <Footer />
    </div>
  );
}

/**
 * Column widths, shared by the header and every row so the two stay in step.
 *
 * The grid only exists from `lg`. Below that the cells stack, which is the
 * only honest projection at 375px — the third column is a whole question in
 * prose and a phone has no room to put it beside anything.
 */
const COLUMNS = "gap-x-6 gap-y-2 lg:grid-cols-[13rem_9.5rem_minmax(0,1fr)]";

/**
 * Row cells set their own colour, so they also have to answer the row's hover
 * inversion — `Row` puts `group` on the link and flips the text on itself,
 * which cannot reach a child that has already declared a colour of its own.
 * The state tag is deliberately left out of that: it is an amber fill
 * carrying near-black text, and near-black is what has to stay on it.
 */
const INVERT = "group-hover:!text-paper-50";

function Roster() {
  return (
    <Band id="roster" tone="paper" pad="m">
      <Container>
        {/* Both fields are emitted data. "1 STOP PER ROLE" was a claim set in
            mono, and it restated the count beside it; the clock range is read
            off the same marked moments the count is. */}
        <Rail sheet="02 / Roster" fields={[STOP_COUNT_FIELD, STOP_RANGE_FIELD]}>
          <Heading as="h2" className="max-w-[22ch]">
            {`${ROLES.length} roles stop once each, ${STOP_WINDOW}.`}
          </Heading>

          <div className="mt-12">
            <div className={`hidden w-full px-1 pb-2 lg:grid ${COLUMNS}`}>
              <Sheet>Role</Sheet>
              <Sheet>Hours</Sheet>
              <Sheet>Hands back</Sheet>
            </div>

            {ROLE_DISCIPLINES.map((discipline) => {
              const roles = ROLES.filter((role) => role.discipline === discipline);
              if (roles.length === 0) return null;

              return (
                <section key={discipline} aria-label={discipline} className="mt-12 first:mt-0">
                  {/* The head carries the discipline and nothing else. A count
                      belongs beside a group that has one worth reading, and
                      "1 ROLE" printed eight times down the page is furniture. */}
                  <div className="pb-3">
                    <Sheet>{discipline}</Sheet>
                  </div>

                  {roles.map((role, index) => (
                    <RoleRow key={role.slug} role={role} opens={index === 0} />
                  ))}
                </section>
              );
            })}
          </div>
        </Rail>
      </Container>
    </Band>
  );
}

/**
 * One role.
 *
 * `opens` promotes the top border of a group's first row from a hairline to
 * the structural weight, which is how a group boundary is drawn without a
 * second element: a `Rule` placed above the row would sit under the row's own
 * `-mt-px` and disappear, and giving it room instead draws a double line.
 */
function RoleRow({ role, opens }: { role: RoleDef; opens: boolean }) {
  const moment = stop(role);
  const state = moment?.kind === "approval" ? "approval" : "decision";
  const first = role.day[0].time;
  const last = role.day[role.day.length - 1].time;

  return (
    <Row href={`/roles/${role.slug}`} className={opens ? "!border-t-paper-400" : ""}>
      <div className={`grid w-full min-w-0 ${COLUMNS}`}>
        <div className="min-w-0">
          <Body className={`!text-[1.0625rem] !leading-6 !text-zinc-950 ${INVERT}`}>
            {role.name}
          </Body>
          <Sheet className={`mt-1 block ${INVERT}`}>{role.person}</Sheet>
        </div>

        {/* The range separator is U+2212, not an arrow: the arrow is outside
            the served font subset and would swap face mid-string. The printed
            form is aria-hidden and the spoken form says "to", because a
            screen reader reading a minus sign between two clock times reads
            it as arithmetic. */}
        <div className="min-w-0">
          <span aria-hidden className="block">
            <Field className={INVERT}>{`${first} − ${last}`}</Field>
          </span>
          <span className="sr-only">{`Works ${first} to ${last}`}</span>
        </div>

        <div className="min-w-0">
          <StateTag state={state}>{state === "approval" ? "Approval" : "Decision"}</StateTag>
          <Body className={`mt-2 ${INVERT}`}>{role.decisions[0]}</Body>
        </div>
      </div>
    </Row>
  );
}

/** The one moment a day the role stops and a person is needed. */
function stop(role: RoleDef): RoleMoment | undefined {
  return role.day.find((moment) => moment.kind === "decision" || moment.kind === "approval");
}

/**
 * The window the roster's stops fall in, computed rather than asserted.
 *
 * Every role currently has exactly one marked moment, so this reads "between
 * 11:00 and 16:00". A role that ever shipped without one drops out of the
 * window instead of widening it into a claim the data does not support, and
 * if none of them had one the sentence falls back to saying nothing about
 * clock times at all.
 */
const STOP_TIMES = ROLES.map(stop)
  .filter((moment): moment is RoleMoment => Boolean(moment))
  .map((moment) => moment.time)
  .sort();

const STOP_WINDOW = STOP_TIMES.length
  ? `between ${STOP_TIMES[0]} and ${STOP_TIMES[STOP_TIMES.length - 1]}`
  : "on a day they schedule themselves";

const STOP_COUNT_FIELD = `${STOP_TIMES.length} STOPS A DAY`;

/**
 * The same window as a rail field.
 *
 * Written "11:00 TO 16:00" rather than with a dash: a rail field has nowhere
 * to hang an `sr-only` gloss the way the row's hours cell does, and a screen
 * reader given "11:00 − 16:00" bare reads the minus as arithmetic.
 */
const STOP_RANGE_FIELD = STOP_TIMES.length
  ? `${STOP_TIMES[0]} TO ${STOP_TIMES[STOP_TIMES.length - 1]}`
  : "NO STOPS";
