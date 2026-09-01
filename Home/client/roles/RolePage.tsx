import type { ReactNode } from "react";
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
  Lede,
  Note,
  Rail,
  Row,
  Sheet,
  StateTag,
  TextLink,
} from "@/sections/Kit";
import { DaySchedule, RoleRail } from "@/roles/RoleDay";
import { ROLES, type RoleDef, type RoleMoment } from "@/roles/data";
import { findProduct } from "@/products/data";

/**
 * One role, in full. Eight routes share this page.
 *
 * The order is the order somebody evaluates a hire: who is this and what does
 * a person currently lose to the work, what does it do all day, what can it
 * do, what would I have to write, and what am I still worried about. The day
 * gets `pad="l"` and nothing else does, because the day is the only part of
 * this page that is hard to fake — every other band is a claim, and that one
 * is a timetable with clock times on it.
 *
 * What is gone, and why it is gone rather than restyled:
 *
 *   - **The `EmployeeCard`.** A rounded, shadowed slab under a radial glow,
 *     with a pastel initials tile, a pulsing emerald "On duty" dot and the
 *     Routine list rendered as decoration inside it. Every one of those is a
 *     thing the redesign deleted site-wide, and the card's actual content —
 *     Routines, Skills, the next Run — is now printed as rows where a reader
 *     can compare them.
 *   - **`role.accent` and `roleIcon`.** Eight roles in eight hues, each with a
 *     tinted icon tile. The site owns one colour and it means "a person is
 *     needed here", so a role cannot have one of its own.
 *   - **The Setup cards.** Four bordered boxes on a night band with an aurora
 *     wash behind them. The same four documents are four stacks of rows now,
 *     and the night band went with the boxes: this page's argument never goes
 *     dark, so spending the site's one tone change here would make the change
 *     mean nothing.
 *   - **The third FAQ treatment.** The site keeps one, on Pricing, and this is
 *     now that one.
 *
 * `role.reclaims` is promoted to the top. It is the only sentence in the role
 * registry written about a human rather than about software — the two hours an
 * AE loses to list building, the first ninety minutes of somebody's morning —
 * and it was buried in a tinted box below the fold. It sits in the note face
 * beside the headline, which is the treatment the site reserves for a person
 * talking.
 */
export function RolePage({ role }: { role: RoleDef }) {
  return (
    <div className="min-h-screen bg-paper-100 text-zinc-900">
      <Nav />
      <main>
        <Head role={role} />
        <Day role={role} />
        <Capabilities role={role} />
        <Setup role={role} />
        <Questions role={role} />
        <Roster current={role.slug} />
        {/* The sheet numbers are this page's table of contents, so they have
            to run 01 to 07 without a gap. `InstallCta` is shared with the
            landing page, where it is 09, and takes the number as a prop for
            exactly this reason. */}
        <InstallCta sheet="07 / Install" />
      </main>
      <Footer />
    </div>
  );
}

/* -------------------------------------------------------------------------
   The day, read off the data
------------------------------------------------------------------------- */

/** The employee stopped here: a Decision it wrote, or an Approval it tripped. */
function isStop(moment: RoleMoment): moment is RoleMoment & { kind: "decision" | "approval" } {
  return moment.kind === "decision" || moment.kind === "approval";
}

const STOP_WORD = { decision: "Decision", approval: "Approval" } as const;

/** First and last clock time of the role's own day. Nobody starts that shift. */
function hours(role: RoleDef): string {
  return `${role.day[0].time}–${role.day[role.day.length - 1].time}`;
}

/* -------------------------------------------------------------------------
   01 / The role
------------------------------------------------------------------------- */

/**
 * The opening band.
 *
 * The headline is derived rather than authored: the role name, and the first
 * and last clock time of its own day. That is a sentence the data cannot
 * drift away from, and it replaces a two-tone headline whose second half was
 * always a subordinate clause about an abstraction ("while the pipeline builds
 * itself").
 *
 * The aside carries `reclaims` as a margin note and then four facts as rows.
 * Putting the employee's name and discipline in that little table is what lets
 * the rest of the page say "Robin" without introducing her again.
 */
function Head({ role }: { role: RoleDef }) {
  const stop = role.day.find(isStop);

  return (
    <PageHero
      sheet={`01 / ${role.name}`}
      fields={[
        hours(role),
        `${role.day.length} RUNS`,
        stop ? `1 ${STOP_WORD[stop.kind].toUpperCase()}` : "NO STOPS",
      ]}
      title={`${role.name} works ${role.day[0].time} to ${role.day[role.day.length - 1].time}.`}
      lede={role.intro}
      actions={
        <>
          <ActionStrip href="/docs/install" trailing="Free">
            Install it on your own hardware
          </ActionStrip>
          <ActionStrip href="/docs/employees" trailing="Docs" className="-mt-px">
            How a Soul and its Skills are written
          </ActionStrip>
        </>
      }
      aside={
        <div className="border-t border-paper-400 pt-8 xl:border-t-0 xl:pt-1">
          <Sheet>What a human loses today</Sheet>
          {/* The note face, at the size the colophon uses. It is the one voice
              on the site with a different skeleton, and this is the one
              sentence on the page about a person's afternoon. */}
          <Note className="mt-4 text-[1.25rem] leading-[1.6] text-zinc-800">{role.reclaims}</Note>

          <div className="mt-9">
            <Fact label="Employee">
              <Body className="!text-[15px] !leading-5 !text-zinc-950">{role.person}</Body>
            </Fact>
            <Fact label="Discipline">
              <Body className="!text-[15px] !leading-5 !text-zinc-950">{role.discipline}</Body>
            </Fact>
            <Fact label="Hours">
              <Field className="!text-zinc-950">{hours(role)}</Field>
            </Fact>
            {stop && (
              <Fact label="Stops">
                <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <StateTag state={stop.kind}>{STOP_WORD[stop.kind]}</StateTag>
                  <Field className="!text-zinc-950">{stop.time}</Field>
                </span>
              </Fact>
            )}
          </div>
        </div>
      }
    />
  );
}

/** One labelled fact. The label column is fixed so the four values line up. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Row className="items-baseline">
      <div className="w-[6.5rem] shrink-0">
        <Sheet>{label}</Sheet>
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </Row>
  );
}

/* -------------------------------------------------------------------------
   02 / The day
------------------------------------------------------------------------- */

/**
 * The day-in-the-life, and the only band on this page with `pad="l"`.
 *
 * The padding rule is a condition rather than a preference: a band gets `l`
 * only if it holds a timetable. This one does, and it is also the best asset
 * on the site, so it leads — three screens ahead of where the old page put it,
 * which was below a hero panel restating the same Routine list in miniature.
 *
 * `DaySchedule` and `RoleRail` come from RoleDay.tsx and are shared with the
 * landing page. The rail runs without its identity block: the band above has
 * already said who this is, and repeating the name, the summary and a link to
 * the page you are standing on is how a page starts to feel padded.
 */
function Day({ role }: { role: RoleDef }) {
  const stop = role.day.find(isStop);

  return (
    <Band id="day" tone="paper" pad="l">
      <Container>
        <Rail sheet="02 / The day" fields={[`${role.day.length} RUNS`, "TUESDAY", "SAMPLE DAY"]}>
          <Heading as="h2" className="max-w-[20ch]">
            {stop
              ? `${role.person} stops once, at ${stop.time}.`
              : `${role.person} runs ${role.day.length} times on Tuesday.`}
          </Heading>

          <Lede className="mt-6">
            Every hour below is one Routine you can open and edit.{" "}
            {stop
              ? stop.kind === "decision"
                ? `The Decision ${role.person} writes at ${stop.time} is the only moment of the day that needs a person, and any Member can answer it.`
                : `The Approval ${role.person} trips at ${stop.time} is the only moment of the day that needs a person, and an admin releases it.`
              : `Nothing in it waits on you.`}
          </Lede>

          <div className="mt-12 grid gap-12 xl:grid-cols-[minmax(0,1.45fr)_minmax(0,0.55fr)] xl:gap-10">
            <DaySchedule role={role} />
            <RoleRail role={role} identity={false} />
          </div>
        </Rail>
      </Container>
    </Band>
  );
}

/* -------------------------------------------------------------------------
   03 / What it runs
------------------------------------------------------------------------- */

/**
 * What the role can do, and which of your products it does it in.
 *
 * Four capability rows and a product list, both as rules-separated rows. The
 * old version drew the capabilities as four bordered cards each opening with a
 * pastel icon tile, and the products as eight more cards that lifted on hover;
 * between them they spent sixteen boxes and eight hues on twelve sentences.
 */
function Capabilities({ role }: { role: RoleDef }) {
  // `flatMap` with an empty array is the terse way to drop a slug that no
  // longer resolves: `products/data.ts` is owned by another pass and a role
  // must not render an empty row when a product is renamed out from under it.
  const products = role.products.flatMap((slug) => findProduct(slug) ?? []);

  return (
    <Band tone="raised" pad="m">
      <Container>
        <Rail
          sheet="03 / What it runs"
          // "PARTS", not "CAPABILITIES". §3 lists Capability among the words
          // that must not stand in for Skill, and this page prints a SKILLS
          // count two bands down — two mono counts on one page, one of them
          // using the other's forbidden synonym, is exactly the collision the
          // table exists to prevent. ProductPage's feature rows already say
          // PARTS for the same shape.
          fields={[`${role.capabilities.length} PARTS`, `${products.length} PRODUCTS`]}
        >
          <Heading as="h2" className="max-w-[22ch]">
            {`${role.capabilities.length} things ${role.person} does unattended.`}
          </Heading>

          <Lede className="mt-6">
            The work happens in the products your team already opens, on the same rows a Member
            edits. Nothing is exported and there is no second system of record.
          </Lede>

          <div className="mt-10">
            {role.capabilities.map((capability) => (
              <Row
                key={capability.title}
                className="!grid grid-cols-1 !gap-y-2 !py-6 lg:grid-cols-[18rem_minmax(0,1fr)]"
              >
                {/* `Heading`, not `Sheet`. Pricing sets a plan name in a
                    `Sheet` inside its `h3` and that is right there — "Growth"
                    is a label. These titles are sentences ("A Decision is a
                    first-class outcome"), and a Sheet uppercases them, which
                    costs the reader the sentence and flattens the capital on
                    Decision. AGENTS.md §3 spends a paragraph keeping Decision
                    and Approval apart; a stylesheet must not undo it. The size
                    is the FAQ row's, because band 05 below is the same shape:
                    a title in the display face beside its paragraph. */}
                <Heading as="h3" className="!text-[1.0625rem] !leading-[1.45]">
                  {capability.title}
                </Heading>
                <Body className="max-w-[62ch]">{capability.body}</Body>
              </Row>
            ))}
          </div>

          <div className="mt-12">
            <Sheet>Where the work lands</Sheet>
            <div className="mt-4">
              {products.map((product) => (
                <Row
                  key={product.slug}
                  href={`/products/${product.slug}`}
                  className="items-baseline"
                >
                  <span className="t-body min-w-0 flex-1 text-[15px] leading-6 text-zinc-950 group-hover:!text-paper-50">
                    {product.name}
                  </span>
                  <Sheet className="shrink-0 group-hover:!text-paper-50">{product.category}</Sheet>
                </Row>
              ))}
            </div>
          </div>
        </Rail>
      </Container>
    </Band>
  );
}

/* -------------------------------------------------------------------------
   04 / Setting it up
------------------------------------------------------------------------- */

/**
 * The four documents a human writes once.
 *
 * The Routines print their real cron line. That is the point of the band: a
 * schedule described in English ("every weekday, first thing") is a claim, and
 * `40 6 * * 1-5` is the thing the server actually holds. Mono is a predicate
 * here rather than a texture — the cron line is a string the software ingested,
 * so it is a `Field`; the Routine's name beside it is not, so it is not.
 */
function Setup({ role }: { role: RoleDef }) {
  return (
    <Band id="setup" tone="paper" pad="m">
      <Container>
        <Rail
          sheet="04 / Setting it up"
          fields={[
            `${role.skills.length} SKILLS`,
            `${role.routines.length} ROUTINES`,
            `${role.grants.length} GRANTS`,
          ]}
        >
          <Heading as="h2" className="max-w-[22ch]">
            {`4 documents decide how ${role.person} works.`}
          </Heading>

          <Lede className="mt-6">
            {`Everything that makes this ${role.noun} rather than another role is plain text you can
            edit. Change the Soul and the next Run reads the new version.`}
          </Lede>

          {/* Two columns, split by what the reader is looking at rather than
              by count: prose a person writes on the left, strings the software
              reads literally on the right. A 2x2 grid of the four documents was
              tried first and left a column of dead space under the Soul, which
              has one paragraph in it against the Skills column's five rows. */}
          <div className="mt-12 grid gap-x-12 gap-y-12 lg:grid-cols-2">
            <div className="flex flex-col gap-12">
              <div>
                <Sheet>Soul</Sheet>
                <div className="mt-4">
                  <Row>
                    <Body className="max-w-[56ch]">
                      {`One document says how ${role.person} judges: what to work on first, and when
                      to stop and ask rather than guess. You rewrite it the way you would rewrite a
                      job description.`}
                    </Body>
                  </Row>
                </div>
              </div>

              <div>
                <Sheet>Grants</Sheet>
                <div className="mt-4">
                  {role.grants.map((grant) => (
                    <Row key={grant}>
                      <Body className="max-w-[56ch]">{grant}</Body>
                    </Row>
                  ))}
                </div>
                <Body className="mt-4 !text-[13px] !leading-5 !text-zinc-600">
                  A Grant is one resource, granted on purpose. Anything not on this list is not
                  reachable, including by a Routine that asks for it politely.
                </Body>
              </div>
            </div>

            <div className="flex flex-col gap-12">
              <div>
                <Sheet>Skills</Sheet>
                <div className="mt-4">
                  {role.skills.map((skill) => (
                    <Row key={skill} className="items-baseline">
                      <Field className="!text-[12px] !text-zinc-950">{skill}</Field>
                    </Row>
                  ))}
                </div>
                <Body className="mt-4 !text-[13px] !leading-5 !text-zinc-600">
                  Each Skill is one markdown playbook, and the employee reads it the way a new hire
                  reads the runbook.
                </Body>
              </div>

              <div>
                <Sheet>Routines</Sheet>
                <div className="mt-4">
                  {role.routines.map((routine) => (
                    <Row key={routine.name} className="flex-wrap items-baseline">
                      <span className="t-body min-w-[8rem] flex-1 text-[15px] leading-6 text-zinc-950">
                        {routine.name}
                      </span>
                      <Field className="shrink-0 !text-zinc-950">{cron(routine.when)}</Field>
                    </Row>
                  ))}
                </div>
                <Body className="mt-4 !text-[13px] !leading-5 !text-zinc-600">
                  Those are the schedules as the server stores them. A Run starts when the line
                  fires, and no one has to be awake for it.
                </Body>
              </div>
            </div>
          </div>

          <div className="mt-12 flex flex-wrap gap-x-8 gap-y-4">
            <TextLink href="/docs/employees">How an employee is assembled</TextLink>
            <TextLink href="/docs/routines">How Routines and Runs work</TextLink>
          </div>
        </Rail>
      </Container>
    </Band>
  );
}

/**
 * The plain-English schedule, back as the cron line it came from.
 *
 * `data.ts` stores "Every weekday, 06:40" because that is what reads on a
 * roster, and this page needs `40 6 * * 1-5` because that is what a reader
 * evaluating the product wants to see. Deriving it here rather than adding a
 * second field to the registry keeps one source of truth for the schedule:
 * two hand-maintained spellings of the same time drift, and the one that
 * drifts is always the one nobody reads.
 *
 * Anything this cannot parse falls back to the English, which is honest — an
 * unparsed line printed as a fake cron expression would be exactly the kind of
 * decorative data the redesign exists to remove.
 */
const CRON_DAYS: Record<string, string> = {
  "every day": "*",
  "every weekday": "1-5",
  mondays: "1",
  tuesdays: "2",
  wednesdays: "3",
  thursdays: "4",
  fridays: "5",
  saturdays: "6",
  sundays: "0",
};

function cron(when: string): string {
  const [head = "", tail = ""] = when.split(",").map((part) => part.trim());

  // "08:00–19:00" narrows the hour field; "around the clock" leaves it open.
  const range = tail.match(/^(\d{1,2}):\d{2}\s*[–—-]\s*(\d{1,2}):\d{2}$/);
  const hourField = range ? `${Number(range[1])}-${Number(range[2])}` : "*";

  const everyMinutes = head.match(/^every (\d+) minutes$/i);
  if (everyMinutes) return `*/${everyMinutes[1]} ${hourField} * * *`;
  if (/^hourly$/i.test(head)) return `0 ${hourField} * * *`;

  const at = tail.match(/^(\d{1,2}):(\d{2})$/);
  const days = CRON_DAYS[head.toLowerCase()];
  if (at && days) return `${Number(at[2])} ${Number(at[1])} * * ${days}`;

  return when;
}

/* -------------------------------------------------------------------------
   05 / Questions
------------------------------------------------------------------------- */

/**
 * The site's one FAQ treatment: a definition list at reading size, the
 * question in the display face beside its answer. No accordion, because a
 * control that hides three sentences exists to make the page look shorter than
 * it is.
 */
function Questions({ role }: { role: RoleDef }) {
  return (
    <Band tone="paper" pad="s">
      <Container>
        <Rail sheet="05 / Questions" fields={[`${role.faqs.length} QUESTIONS`]}>
          <Heading as="h2" className="max-w-[24ch]">
            {`${role.faqs.length} questions about the ${role.name}.`}
          </Heading>

          <dl className="mt-10">
            {role.faqs.map((faq) => (
              <Row
                key={faq.q}
                className="!grid grid-cols-1 !py-6 lg:grid-cols-[20rem_minmax(0,1fr)]"
              >
                <dt>
                  <Heading as="h3" className="!text-[1.0625rem] !leading-[1.45]">
                    {faq.q}
                  </Heading>
                </dt>
                <dd className="mt-2 lg:mt-0">
                  <Body className="max-w-[62ch]">{faq.a}</Body>
                </dd>
              </Row>
            ))}
          </dl>

          <div className="mt-10">
            <TextLink href="/docs/employees">Read the documentation</TextLink>
          </div>
        </Rail>
      </Container>
    </Band>
  );
}

/* -------------------------------------------------------------------------
   06 / Roster
------------------------------------------------------------------------- */

/**
 * The tail: the rest of the roster, so a reader on the wrong page can leave.
 *
 * Rows rather than the eight hover-lifting tiles that were here, and each one
 * carries the discipline it belongs to — which is the fact a reader who is on
 * the wrong page is actually scanning for.
 */
function Roster({ current }: { current: string }) {
  const others = ROLES.filter((role) => role.slug !== current);

  return (
    // `paper`, not `raised`: `InstallCta` below this is the raised band, and
    // two lifted surfaces in a row read as one long band with a rule in it.
    <Band tone="paper" pad="s">
      <Container>
        <Rail sheet="06 / Roster" fields={[`${ROLES.length} ROLES`]}>
          <Heading as="h2" className="max-w-[22ch]">
            {`${others.length} other roles ship written.`}
          </Heading>

          <div className="mt-10">
            {others.map((role) => (
              <Row key={role.slug} href={`/roles/${role.slug}`} className="items-baseline">
                <span className="t-body min-w-0 flex-1 text-[15px] leading-6 text-zinc-950 group-hover:!text-paper-50">
                  {role.name}
                </span>
                <Sheet className="hidden shrink-0 group-hover:!text-paper-50 sm:inline">
                  {role.discipline}
                </Sheet>
                <span className="shrink-0">
                  <Field className="group-hover:!text-paper-50">{hours(role)}</Field>
                </span>
              </Row>
            ))}
          </div>

          <div className="mt-10">
            <TextLink href="/roles">{`All ${ROLES.length} roles, side by side`}</TextLink>
          </div>
        </Rail>
      </Container>
    </Band>
  );
}
