import type { ReactNode } from "react";
import { Nav } from "@/sections/Nav";
import { Footer, InstallCta } from "@/sections/Footer";
import {
  ActionStrip,
  Band,
  Body,
  Chip,
  Container,
  DEPT_FULL,
  type Dept,
  Display,
  Field,
  Head,
  Heading,
  Lede,
  Note,
  Row,
  Sheet,
  StateTag,
  TextLink,
} from "@/sections/Kit";
import { DaySchedule, RoleRail } from "@/roles/RoleDay";
import { ROLES, type RoleDef, type RoleMoment } from "@/roles/data";
import { findProduct } from "@/products/data";
import { PRODUCT_DEPT } from "@/products/ProductPrototype";

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
 * ## HEADCOUNT: the role has a department
 *
 * `ROLE_DEPT` binds each of the eight roles to a department hue, and that hue
 * is this page's accent in three places and nowhere else: the hero chip, the
 * spine down the facts table and the capability rows, and the right-hand
 * column of the setup band. Eight role pages that were previously identical
 * now differ at a glance, and the difference carries information — the SDR is
 * Revenue on this page, on the wall, and on `/products/revenue`.
 *
 * The Recruiter takes `people`, the eighth hue, which exists for exactly this
 * page: there is no People lane on the 24-hour board, so the hue appears here
 * and nowhere else on the site.
 *
 * ## The inversion, drawn twice
 *
 * The setup band splits down the middle by *who writes it*. The left column
 * is prose a person writes — the Soul, the Grants — and takes a 3px **ink**
 * edge. The right column is strings the software reads literally — Skill
 * names, cron lines — and takes the 3px **department** edge. The two columns
 * were already split that way in the markup and the comment; the edges are
 * that split finally made visible, and they are the machine-in-colour,
 * human-in-black rule stated as a layout rather than as a badge.
 *
 * The second is smaller and older: the one moment of the day that stops for a
 * person wears a `StateTag`, which is ink, sitting inside a facts table whose
 * spine is the department's hue.
 *
 * ## What is gone, and why it is gone rather than restyled
 *
 *   - **The `EmployeeCard`.** A rounded, shadowed slab under a radial glow,
 *     with a pastel initials tile, a pulsing emerald "On duty" dot and the
 *     Routine list rendered as decoration inside it. The card's actual
 *     content — Routines, Skills, the next Run — is now printed as rows where
 *     a reader can compare them.
 *   - **`role.accent` and `roleIcon`.** Eight roles in eight arbitrary hues,
 *     each with a tinted icon tile. A hue on this site means a department, so
 *     a role gets the hue of the department it works in and not one of its
 *     own; `role.accent` stays unread in the registry.
 *   - **The Setup cards.** Four bordered boxes on a band with an aurora wash
 *     behind them, now four stacks of rows.
 *   - **The sheet numbers.** The bands ran 01 to 07 and `InstallCta` took its
 *     number as a prop to keep the sequence intact. HEADCOUNT does not
 *     number: these are pages, not a document set, and a band label that has
 *     to be counted is one more thing to keep in step for no reader's benefit.
 *
 * `role.reclaims` is promoted to the top. It is the only sentence in the role
 * registry written about a human rather than about software — the two hours an
 * AE loses to list building, the first ninety minutes of somebody's morning —
 * and it was buried in a tinted box below the fold. It sits in the note face
 * beside the headline, which is the treatment the site reserves for a person
 * talking.
 */

/**
 * Which department each role works in.
 *
 * Seven of the eight fall straight out of the registry: a role's department is
 * the department of the first product in its own `role.products` list, which
 * is the product its day mostly happens in. That includes the Analyst, whose
 * first product is Explore and therefore Finance — the numbers a company
 * closes a month on, for the reason given in `PRODUCT_DEPT`. They are written
 * out rather than derived so that a reader of this file can see the org chart
 * without holding two other modules in their head, and because one of the
 * eight is not derivable at all:
 *
 *   recruiter → people   its first product is Bases, which is Revenue, and a
 *                        Recruiter is not in Revenue. There is no People lane
 *                        on the board and no People product, so the eighth
 *                        hue — reserved for this one page — is the only
 *                        honest answer
 *
 * If `roles/data.ts` ever reorders a `products` list, this table is what has
 * to be checked, and that is deliberate — a page's colour should not change
 * because someone re-sorted an array.
 */
const ROLE_DEPT: Record<string, Dept> = {
  sdr: "revenue",
  "executive-assistant": "workspace",
  marketer: "marketing",
  support: "email",
  bookkeeper: "finance",
  engineer: "repositories",
  recruiter: "people",
  analyst: "finance",
};

export function RolePage({ role }: { role: RoleDef }) {
  const dept = ROLE_DEPT[role.slug] ?? "operations";

  return (
    <div className="min-h-screen bg-ground text-ink">
      <Nav />
      <main>
        <RoleHero role={role} dept={dept} />
        <Day role={role} />
        <Capabilities role={role} dept={dept} />
        <Setup role={role} dept={dept} />
        <Questions role={role} />
        <Roster current={role.slug} />
        <InstallCta />
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
   The hero
------------------------------------------------------------------------- */

/**
 * The opening band, composed here rather than taken from `PageHero`.
 *
 * `PageHero` types its eyebrow as a `string`, and this page's eyebrow is a
 * department `Chip`. Rather than reach into a component shared with the two
 * index pages, the band is composed from the Kit and keeps `PageHero`'s
 * proportions exactly — the same `lg` split, the same `gap-x-16`, the same
 * hairline-topped strip of emitted data closing the band — so the site still
 * opens on one shape and only the detail pages name a department.
 *
 * The headline is derived rather than authored: the role name, and the first
 * and last clock time of its own day. That is a sentence the data cannot
 * drift away from, and it replaces a two-tone headline whose second half was
 * always a subordinate clause about an abstraction ("while the pipeline builds * itself").
 */
function RoleHero({ role, dept }: { role: RoleDef; dept: Dept }) {
  const stop = role.day.find(isStop);
  const fields = [
    hours(role),
    `${role.day.length} RUNS`,
    stop ? `1 ${STOP_WORD[stop.kind].toUpperCase()}` : "NO STOPS",
  ];

  return (
    <Band tone="ground" pad="m" rule={false}>
      <Container>
        <div className="mb-5">
          <Chip dept={dept}>{dept}</Chip>
        </div>

        <div className="grid gap-x-16 gap-y-10 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:items-start">
          <div className="min-w-0">
            <Display as="h1" className="max-w-[20ch]">
              {`${role.name} works ${role.day[0].time} to ${role.day[role.day.length - 1].time}.`}
            </Display>

            <div className="mt-7 min-w-0">
              <Lede>{role.intro}</Lede>

              <div className="mt-9 max-w-[34rem]">
                <ActionStrip href="/docs/install" trailing="Free">
                  Install it on your own hardware
                </ActionStrip>
                <ActionStrip href="/docs/employees" trailing="Docs" className="-mt-px">
                  How a Soul and its Skills are written
                </ActionStrip>
              </div>
            </div>
          </div>

          <div className="min-w-0">
            <Sheet>What a human loses today</Sheet>
            {/* The note face, at the size the colophon uses. It is the one
                voice on the site with a different skeleton, and this is the
                one sentence on the page about a person's afternoon. */}
            <Note className="mt-4 text-[1.25rem] leading-[1.6] text-ink2">{role.reclaims}</Note>

            {/* The facts take the department spine, so the four rows read as
                one block belonging to one department — and the `StateTag` in
                the last of them is ink, which makes this small table the whole
                inversion in four lines: the employee is in colour, the moment
                that needs you is not. */}
            <div className="mt-9">
              <Fact label="Employee" dept={dept}>
                <Body className="!text-[15px] !leading-5 !text-ink">{role.person}</Body>
              </Fact>
              <Fact label="Discipline" dept={dept}>
                <Body className="!text-[15px] !leading-5 !text-ink">{role.discipline}</Body>
              </Fact>
              <Fact label="Hours" dept={dept}>
                <Field className="!text-ink">{hours(role)}</Field>
              </Fact>
              {stop && (
                <Fact label="Stops" dept={dept}>
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <StateTag state={stop.kind}>{STOP_WORD[stop.kind]}</StateTag>
                    <Field className="!text-ink">{stop.time}</Field>
                  </span>
                </Fact>
              )}
            </div>
          </div>
        </div>

        <div className="mt-12 flex flex-wrap items-baseline gap-x-8 gap-y-2 border-t border-hairline pt-4">
          {fields.map((field) => (
            <Field key={field}>{field}</Field>
          ))}
        </div>
      </Container>
    </Band>
  );
}

/** One labelled fact. The label column is fixed so the four values line up. */
function Fact({ label, dept, children }: { label: string; dept: Dept; children: ReactNode }) {
  return (
    <Row dept={dept} className="items-baseline">
      <div className="w-[6.5rem] shrink-0">
        <Sheet>{label}</Sheet>
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </Row>
  );
}

/* -------------------------------------------------------------------------
   The day
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
 * landing page, so they are not coloured from here: the schedule draws its own
 * ink treatment for the stop, and a department hue applied on top of a shared
 * instrument would say something on this page it could not say on the other.
 * The rail runs without its identity block — the band above has already said
 * who this is, and repeating the name, the summary and a link to the page you
 * are standing on is how a page starts to feel padded.
 */
function Day({ role }: { role: RoleDef }) {
  const stop = role.day.find(isStop);

  return (
    <Band id="day" tone="ground" pad="l">
      <Container>
        <Head
          eyebrow={`The day · ${role.day.length} runs · Tuesday`}
          title={
            stop
              ? `${role.person} stops once, at ${stop.time}.`
              : `${role.person} runs ${role.day.length} times on Tuesday.`
          }
          lede={
            <>
              Every hour below is one Routine you can open and edit.{" "}
              {stop
                ? stop.kind === "decision"
                  ? `The Decision ${role.person} writes at ${stop.time} is the only moment of the day that needs a person, and any Member can answer it.`
                  : `The Approval ${role.person} trips at ${stop.time} is the only moment of the day that needs a person, and an admin releases it.`
                : `Nothing in it waits on you.`}
            </>
          }
        />

        <div className="mt-12 grid gap-12 xl:grid-cols-[minmax(0,1.45fr)_minmax(0,0.55fr)] xl:gap-10">
          <DaySchedule role={role} />
          <RoleRail role={role} identity={false} />
        </div>
      </Container>
    </Band>
  );
}

/* -------------------------------------------------------------------------
   What it runs
------------------------------------------------------------------------- */

/**
 * What the role can do, and which of your products it does it in.
 *
 * The capability rows take this role's department spine. The product rows
 * underneath take **each product's own** — so the Marketer's list shows
 * Marketing, then Repositories twice for Notes and Resources, then Finance
 * for Explore. That is the closest thing on the site to an org chart of the
 * install, and it is read out of `PRODUCT_DEPT` rather than written, so it
 * cannot disagree with the fourteen product pages.
 *
 * The old version drew the capabilities as four bordered cards each opening
 * with a pastel icon tile, and the products as eight more cards that lifted on
 * hover; between them they spent sixteen boxes and eight hues on twelve
 * sentences, and none of the hues meant anything.
 */
function Capabilities({ role, dept }: { role: RoleDef; dept: Dept }) {
  // `flatMap` with an empty array is the terse way to drop a slug that no
  // longer resolves: `products/data.ts` is owned by another pass and a role
  // must not render an empty row when a product is renamed out from under it.
  const products = role.products.flatMap((slug) => findProduct(slug) ?? []);

  return (
    <Band tone="surface" pad="m">
      <Container>
        <Head
          // "PARTS", not "CAPABILITIES". §3 lists Capability among the words
          // that must not stand in for Skill, and this page prints a Skills
          // count one band down — two counts on one page, one of them using
          // the other's forbidden synonym, is exactly the collision the table
          // exists to prevent.
          eyebrow={`What it runs · ${role.capabilities.length} parts · ${products.length} products`}
          title={`${role.capabilities.length} things ${role.person} does unattended.`}
          lede="The work happens in the products your team already opens, on the same rows a Member edits. Nothing is exported and there is no second system of record."
        />

        <div className="mt-10">
          {role.capabilities.map((capability) => (
            <Row
              key={capability.title}
              dept={dept}
              className="!grid grid-cols-1 !gap-y-2 !py-6 lg:grid-cols-[18rem_minmax(0,1fr)]"
            >
              {/* `Heading`, not `Sheet`. Pricing sets a plan name in a `Sheet`
                  inside its `h3` and that is right there — "Growth" is a
                  label. These titles are sentences ("A Decision is a first-class outcome"), and a Sheet uppercases them, which
                  costs the reader the sentence and flattens the capital on
                  Decision. AGENTS.md §3 spends a paragraph keeping Decision
                  and Approval apart; a stylesheet must not undo it. */}
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
                dept={PRODUCT_DEPT[product.slug] ?? "operations"}
                className="items-baseline"
              >
                <span className="min-w-0 flex-1 text-[15px] leading-6 text-ink group-hover:!text-ground">
                  {product.name}
                </span>
                <Sheet className="shrink-0 group-hover:!text-ground">{product.category}</Sheet>
              </Row>
            ))}
          </div>
        </div>
      </Container>
    </Band>
  );
}

/* -------------------------------------------------------------------------
   Setting it up
------------------------------------------------------------------------- */

/**
 * A labelled column with a 3px edge down its left.
 *
 * The edge is drawn as a positioned span rather than a `border-l`, because
 * `DEPT_FULL` exports background classes and there is no department border
 * scale — the same construction `Row` and `Pane` use for their spines, for
 * the same reason.
 *
 * `tone` is the argument of the band: `human` is ink, `machine` is the
 * department's hue. There is no third value on purpose. Anything on this site
 * either needs a person or does not, and a column that could not answer that
 * question would not belong in this band.
 */
function SetupColumn({
  tone,
  dept,
  children,
}: {
  tone: "human" | "machine";
  dept: Dept;
  children: ReactNode;
}) {
  return (
    <div className="relative flex flex-col gap-12 pl-5">
      <span
        aria-hidden
        className={`absolute inset-y-0 left-0 w-[3px] ${
          tone === "human" ? "bg-ink" : DEPT_FULL[dept]
        }`}
      />
      {children}
    </div>
  );
}

/** One document, as a label over a stack of rows. */
function Document({ label, note, children }: { label: string; note: string; children: ReactNode }) {
  return (
    <div>
      <Sheet>{label}</Sheet>
      <div className="mt-4">{children}</div>
      <Body className="mt-4 !text-[13px] !leading-5 !text-muted">{note}</Body>
    </div>
  );
}

/**
 * The four documents a human writes once.
 *
 * The Routines print their real cron line. That is the point of the band: a
 * schedule described in English ("every weekday, first thing") is a claim, and
 * `40 6 * * 1-5` is the thing the server actually holds. Mono is a predicate
 * here rather than a texture — the cron line is a string the software ingested,
 * so it is a `Field`; the Routine's name beside it is not, so it is not.
 *
 * Two columns, split by what the reader is looking at rather than by count:
 * prose a person writes on the left under an ink edge, strings the software
 * reads literally on the right under the department's. A 2x2 grid of the four
 * documents was tried first and left a column of dead space under the Soul,
 * which has one paragraph in it against the Skills column's five rows.
 */
function Setup({ role, dept }: { role: RoleDef; dept: Dept }) {
  return (
    <Band id="setup" tone="ground" pad="m">
      <Container>
        <Head
          eyebrow={`Setting it up · ${role.skills.length} skills · ${role.routines.length} routines · ${role.grants.length} grants`}
          title={`4 documents decide how ${role.person} works.`}
          lede={`Everything that makes this ${role.noun} rather than another role is plain text you can edit. Change the Soul and the next Run reads the new version.`}
        />

        <div className="mt-12 grid gap-x-12 gap-y-12 lg:grid-cols-2">
          <SetupColumn tone="human" dept={dept}>
            <Document
              label="Soul"
              note="A Soul is written the way a job description is written, and it is the one document that decides what the employee does when the Skills do not say."
            >
              <Row>
                <Body className="max-w-[56ch]">
                  {`One document says how ${role.person} judges: what to work on first, and when
                  to stop and ask rather than guess. You rewrite it the way you would rewrite a
                  job description.`}
                </Body>
              </Row>
            </Document>

            <Document
              label="Grants"
              note="A Grant is one resource, granted on purpose. Anything not on this list is not reachable, including by a Routine that asks for it politely."
            >
              {role.grants.map((grant) => (
                <Row key={grant}>
                  <Body className="max-w-[56ch]">{grant}</Body>
                </Row>
              ))}
            </Document>
          </SetupColumn>

          <SetupColumn tone="machine" dept={dept}>
            <Document
              label="Skills"
              note="Each Skill is one markdown playbook, and the employee reads it the way a new hire reads the runbook."
            >
              {role.skills.map((skill) => (
                <Row key={skill} className="items-baseline">
                  <Field className="!text-[12px] !text-ink">{skill}</Field>
                </Row>
              ))}
            </Document>

            <Document
              label="Routines"
              note="Those are the schedules as the server stores them. A Run starts when the line fires, and no one has to be awake for it."
            >
              {role.routines.map((routine) => (
                <Row key={routine.name} className="flex-wrap items-baseline">
                  <span className="min-w-[8rem] flex-1 text-[15px] leading-6 text-ink">
                    {routine.name}
                  </span>
                  <Field className="shrink-0 !text-ink">{cron(routine.when)}</Field>
                </Row>
              ))}
            </Document>
          </SetupColumn>
        </div>

        <div className="mt-12 flex flex-wrap gap-x-8 gap-y-4">
          <TextLink href="/docs/employees">How an employee is assembled</TextLink>
          <TextLink href="/docs/routines">How Routines and Runs work</TextLink>
        </div>
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
   Questions
------------------------------------------------------------------------- */

/**
 * The site's one FAQ treatment: a definition list at reading size, the
 * question in the display face beside its answer. No accordion, because a
 * control that hides three sentences exists to make the page look shorter than
 * it is.
 *
 * No spine on these rows, and the omission is the point: a reader's question
 * belongs to no department, and a hue on every stack of the page would have
 * stopped meaning anything by the third one.
 */
function Questions({ role }: { role: RoleDef }) {
  return (
    <Band tone="ground" pad="s">
      <Container>
        <Head
          eyebrow={`Questions · ${role.faqs.length} answered`}
          title={`${role.faqs.length} questions about the ${role.name}.`}
        />

        <dl className="mt-10">
          {role.faqs.map((faq) => (
            <Row key={faq.q} className="!grid grid-cols-1 !py-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
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
      </Container>
    </Band>
  );
}

/* -------------------------------------------------------------------------
   Roster
------------------------------------------------------------------------- */

/**
 * The tail: the rest of the roster, so a reader on the wrong page can leave.
 *
 * Each row takes **its own** role's department hue, so a reader scanning for
 * "the one that does our books" finds the green one. That is the org chart
 * doing the navigating, which is the entire reason the hues are permanently
 * bound rather than assigned per page. Seven rows, six colours: the Bookkeeper
 * and the Analyst are both Finance, and a reader seeing two green rows is
 * being told something true rather than being shown a repeat.
 *
 * Rows rather than the eight hover-lifting tiles that were here, and each one
 * also carries the discipline it belongs to — the fact a reader on the wrong
 * page is actually scanning for.
 */
function Roster({ current }: { current: string }) {
  const others = ROLES.filter((role) => role.slug !== current);

  return (
    <Band tone="ground" pad="s">
      <Container>
        <Head
          eyebrow={`Roster · ${ROLES.length} roles`}
          title={`${others.length} other roles ship written.`}
          aside={<TextLink href="/roles">{`All ${ROLES.length} roles, side by side`}</TextLink>}
        />

        <div className="mt-10">
          {others.map((role) => (
            <Row
              key={role.slug}
              href={`/roles/${role.slug}`}
              dept={ROLE_DEPT[role.slug] ?? "operations"}
              className="items-baseline"
            >
              <span className="min-w-0 flex-1 text-[15px] leading-6 text-ink group-hover:!text-ground">
                {role.name}
              </span>
              <Sheet className="hidden shrink-0 group-hover:!text-ground sm:inline">
                {role.discipline}
              </Sheet>
              <span className="shrink-0">
                <Field className="group-hover:!text-ground">{hours(role)}</Field>
              </span>
            </Row>
          ))}
        </div>
      </Container>
    </Band>
  );
}
