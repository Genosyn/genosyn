import { useState } from "react";
import type { ReactNode } from "react";
import { GITHUB_URL } from "@/lib/constants";
import {
  Band,
  Body,
  Button,
  Container,
  Display,
  Field,
  Figure,
  Head,
  Lede,
  Pane,
  Row,
  Rule,
  Sheet,
  Subhead,
  TextLink,
} from "@/sections/Kit";

/**
 * The pricing page — HEADCOUNT, without a single hue.
 *
 * A plan is not a department. Free, Growth, Scale, Community and Enterprise
 * are billing states, and painting one of them finance-green or revenue-orange
 * would be the first crack in the whole system: the moment a hue means
 * "premium" instead of "Finance", the wall on the landing page stops being a
 * legend and becomes decoration. So this page is built from ink, the six
 * neutrals, density and type, and nothing else. It is the honest test of
 * whether the system is a system.
 *
 * Three decisions carry it:
 *
 * 1. **The price is a `Figure`.** The previous revision set prices as 15px
 *    mono, arguing that a price is a string the billing system emitted. That
 *    is true of `$19` on an invoice and false of `$19` on a pricing page,
 *    where the number is the argument rather than a record. `t-figure` is
 *    condensed, so it buys scale without buying whitespace, which is the only
 *    way this page gets a loud moment while staying dense.
 *
 * 2. **Plans are tiles on 1px seams**, the same construction as the landing
 *    wall — not three ringed cards, and not a bento box. A ring around "Scale"
 *    is a shop telling you which shelf to look at.
 *
 * 3. **One ink object per band, and it is always that band's human action.**
 *    The install control in 01, the Cloud access cell in 02, the command you
 *    paste in 03. Nothing else on the page is black, so on five bands of paper
 *    the eye finds exactly five things and every one of them is a thing you do.
 *    That is the machine-in-colour / human-in-black inversion doing its job on
 *    a page with no machine colour to invert against.
 *
 * What stayed deleted from the version before last, because the reasons
 * outlive this file: the 44-cell comparison grid (nine of its eleven rows read
 * `1 / Unlimited / Unlimited / Unlimited`, which is one fact about the Free
 * plan written nine times); the `<details>` accordion (a control that hides
 * three sentences buys nothing); the dark gradient CTA slab pasted onto three
 * pages; and the headline "Frequently asked", an amputated stock phrase with
 * no subject.
 *
 * Ordering: the sheet numbers run Cloud then Self-hosted, but the free tier is
 * the loudest thing here. It wins on typography rather than on position — the
 * first headline names it, band 03 is the only tone change on the page, and it
 * carries the real install command.
 */

const CLOUD_ACCESS_HREF = "mailto:cloud@genosyn.com?subject=Genosyn%20Cloud%20early%20access";
const ENTERPRISE_HREF = "mailto:enterprise@genosyn.com?subject=Genosyn%20Enterprise";

/** The command in `client/public/install.sh` and in the install guide, verbatim. */
const INSTALL_COMMAND = "curl -fsSL https://genosyn.com/install.sh | bash";

type Plan = {
  name: string;
  /** Where it runs. A label, so it is set as a field rather than as prose. */
  host: string;
  /** One sentence. What you get, in the product's own nouns. */
  gets: string;
  /** The headline price. Set as a `Figure`. */
  price: string;
  /** The meter the price is charged against, if there is one. */
  meter?: string;
  /** Quota values the software actually enforces. One line each. */
  limits: string[];
};

const CLOUD_PLANS: Plan[] = [
  {
    name: "Free",
    host: "Genosyn Cloud",
    gets: "Hire one AI Employee, give it a Soul and two Routines, and let it run on a schedule. It costs $0 in month one and $0 in month twelve.",
    price: "$0",
    limits: ["1 AI EMPLOYEE", "2 ROUTINES", "1 BASE", "3 CHANNELS", "1 PROJECT", "20 TODOS"],
  },
  {
    name: "Growth",
    host: "Genosyn Cloud",
    gets: "Every limit above comes off. Support is email, answered by the people who wrote the code.",
    price: "$19",
    meter: "PER AI EMPLOYEE / MO",
    limits: ["UNLIMITED AI EMPLOYEES", "UNLIMITED ROUTINES"],
  },
  {
    name: "Scale",
    host: "Genosyn Cloud",
    gets: "Everything in Growth, plus single sign-on and the audit log for the whole company. This is the plan an IT review asks for.",
    price: "$49",
    meter: "PER AI EMPLOYEE / MO",
    limits: ["SSO", "AUDIT LOG"],
  },
];

const SELF_HOSTED_PLANS: Plan[] = [
  {
    name: "Community",
    host: "Your hardware",
    gets: "Unlimited AI Employees and unlimited Routines, on a laptop or on a cluster. You keep the database, the model keys and every audit row.",
    price: "$0",
    meter: "APACHE-2.0",
    limits: ["UNLIMITED AI EMPLOYEES", "UNLIMITED ROUTINES", "NO LICENCE KEY"],
  },
  {
    name: "Enterprise",
    host: "Your hardware",
    gets: "Community plus single sign-on, the audit log and priority support. A master admin pastes a signed key at Admin / License and it validates offline, so air-gapped installs work.",
    price: "Quoted",
    meter: "SIGNED LICENCE KEY",
    limits: ["SSO", "AUDIT LOG", "OFFLINE VALIDATION"],
  },
];

/** The ladder in the masthead is derived, so it cannot drift from the tiles. */
const ALL_PLANS: Plan[] = [...CLOUD_PLANS, ...SELF_HOSTED_PLANS];

/**
 * The comparison, reduced to the lines that differ.
 *
 * Every row here answers a question the plan tiles cannot: the tiles say what
 * you get, and these four say who operates it, who is on the hook, and under
 * what terms. A row whose five cells all read the same value has been moved
 * into prose underneath, because a table is for differences.
 */
type CompareRow = {
  label: string;
  /** Free, Growth, Scale, Community, Enterprise — in that order. */
  cells: [ReactNode, ReactNode, ReactNode, ReactNode, ReactNode];
};

const PLAN_COLUMNS: Array<[name: string, host: string]> = [
  ["Free", "Cloud"],
  ["Growth", "Cloud"],
  ["Scale", "Cloud"],
  ["Community", "Self-hosted"],
  ["Enterprise", "Self-hosted"],
];

const COMPARE_ROWS: CompareRow[] = [
  {
    label: "Upgrades",
    cells: ["We run them", "We run them", "We run them", "You run them", "You run them"],
  },
  {
    label: "SSO and audit log",
    cells: [<Absent key="f" />, <Absent key="g" />, "Included", <Absent key="c" />, "Included"],
  },
  {
    label: "Licence",
    cells: ["Cloud terms", "Cloud terms", "Cloud terms", "Apache-2.0", "Signed key"],
  },
  {
    label: "Support",
    cells: ["GitHub issues", "Email", "Priority", "GitHub issues", "Priority"],
  },
];

type Question = { q: string; a: string };

/**
 * The six answers, kept almost word for word.
 *
 * These were already the strongest writing in the codebase and every revision
 * since has left them alone. Three edits were ever made: the banned "simply"
 * is gone, five em dashes became full stops and colons, and the arrow in
 * `Admin -> License` became a slash, because U+2192 is not in the served font
 * subset and falls back to a system face mid-line.
 *
 * There are six of them and the band heading says "Six answers", so a seventh
 * entry means editing that line too. The mono field beside it is derived from
 * the array, which is what will make the mismatch visible.
 */
const QUESTIONS: Question[] = [
  {
    q: "What counts as an AI Employee?",
    a: "An AI Employee is a hired teammate on your roster: a persistent role with its own Soul, Skills and Routines. You pay per AI Employee hired, and human Members are always free on every plan. At $19 a month that hire costs a fraction of what a person in the same seat would, and it works its Routines around the clock.",
  },
  {
    q: "Do I need my own AI Model API keys?",
    a: "Yes, on every plan. You connect Anthropic, OpenAI, or any OpenAI-compatible endpoint under Settings, and model usage is billed by your provider directly. Genosyn prices the platform, not the tokens.",
  },
  {
    q: "Is the self-hosted version really free?",
    a: "Yes. The community edition is Apache 2.0 licensed with unlimited AI Employees and Routines, forever. Genosyn Enterprise adds SSO, the audit log and priority support on top, for self-hosted installs at work.",
  },
  {
    q: "How does Enterprise licensing work?",
    a: "We issue a signed license key that a master admin pastes at Admin / License in your install. The key validates offline against a public key shipped in the product, so it works in fully air-gapped environments.",
  },
  {
    q: "Can I switch plans?",
    a: "Any time. Upgrades and downgrades take effect through Stripe with per-AI-Employee proration, and hiring or letting go of an AI Employee adjusts your billed quantity automatically.",
  },
  {
    q: "What happens if I go over a Free plan limit?",
    a: "Nothing breaks. Genosyn asks you to upgrade before you hire another AI Employee, add a third Routine, a second Base or Base table, a fourth Channel, a second Project, or the twenty-first Todo. Everything already running keeps running.",
  },
];

export function Pricing(): ReactNode {
  return (
    <>
      <PricingHead />
      <CloudPlans />
      <SelfHosted />
      <Compared />
      <Questions />
    </>
  );
}

/* -------------------------------------------------------------------------
   01 / Pricing
------------------------------------------------------------------------- */

/**
 * The masthead.
 *
 * The first sentence on a pricing page should be the price, and the right
 * column is the whole answer at once: five plans, five numbers, in a Pane, in
 * the first screen. That is the density argument applied to a question a
 * reader arrived with — five rows of paper beats five tiles of scrolling for
 * "what does it cost", and the tiles below then have room to say why.
 */
function PricingHead() {
  return (
    <Band tone="ground" pad="m" rule={false}>
      <Container>
        <div className="grid gap-x-16 gap-y-12 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
          <div className="min-w-0">
            <Sheet>01 / Pricing</Sheet>
            <Fields items={["APACHE-2.0", `v${__APP_VERSION__}`, "USD"]} className="mt-3" />

            <Display className="mt-5 max-w-[20ch]">Genosyn is free on your own hardware.</Display>

            <Lede className="mt-7">
              Download it, run it, and hire as many AI Employees as you want. Genosyn Cloud is the
              same software with us operating it, charged per AI Employee hired.
            </Lede>

            {/* The one black object in this band. A control is a human action,
                so it is ink; the paid path beside it is a text link, because
                the honest hierarchy of an Apache-2.0 product is that the free
                thing is the product. */}
            <div className="mt-9 flex flex-wrap items-center gap-x-8 gap-y-4">
              <Button href="/docs/install">Install it on your own hardware</Button>
              <TextLink href={CLOUD_ACCESS_HREF}>Request Genosyn Cloud access</TextLink>
            </div>
          </div>

          <div className="min-w-0 lg:pt-1">
            <Pane title="Every plan" meta="USD / MO">
              {ALL_PLANS.map((plan) => (
                <div
                  key={plan.name}
                  className="flex items-baseline justify-between gap-4 border-b border-hairline px-4 py-3.5 last:border-b-0"
                >
                  <span>
                    {/* Not a `Subhead`: these five names are also the h3s of
                        the tiles below, and a summary that duplicates them in
                        the outline makes a screen reader read the price list
                        twice. The face is the same; the tag is not. */}
                    <span className="t-h3 block text-[15px] text-ink">{plan.name}</span>
                    <span className="mt-0.5 block">
                      <Sheet className="!text-[10px]">{plan.host}</Sheet>
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    {/* The display face, not `Field`. This file's own argument
                        is that a price on a pricing page is the claim rather
                        than a record, so setting it in the data face here
                        would contradict the `Figure` on every tile below and
                        break the site's one mono predicate: mono is for
                        strings the software emitted, and "Quoted" is not one.
                        `tabular` locks the numerals so five prices line up
                        down the ladder without a table. */}
                    <span className="t-h3 tabular block text-[15px] text-ink">{plan.price}</span>
                    {plan.meter && (
                      <span className="mt-0.5 block">
                        <Sheet className="!text-[10px]">{plan.meter}</Sheet>
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </Pane>
          </div>
        </div>
      </Container>
    </Band>
  );
}

/* -------------------------------------------------------------------------
   02 / Cloud
------------------------------------------------------------------------- */

/** Three plans, one meter, and the fourth cell is the human one. */
function CloudPlans() {
  return (
    <Band id="cloud" tone="ground" pad="m">
      <Container>
        <Head
          eyebrow="02 / Cloud"
          title="Genosyn Cloud has three plans and one meter."
          lede="We run the upgrades, the backups and the hosting. You bring your own AI Model keys on every plan, so token spend is billed to you by Anthropic or OpenAI and never by us."
          aside={<Fields items={["3 PLANS", "USD / MO"]} />}
        />

        <TileStrip className="mt-12 sm:grid-cols-2 lg:grid-cols-4">
          {CLOUD_PLANS.map((plan) => (
            <PlanTile key={plan.name} plan={plan} />
          ))}

          {/* The fourth cell is you — the same move the landing wall makes with
              its eighth cell. It carries no price, so it cannot be misread as
              a plan, and it is the only thing in the strip with no border and
              no paper under it. */}
          <ActionTile
            eyebrow="Rolling out now"
            title="Genosyn Cloud access"
            body="Send one line about what you want an AI Employee to do and we will onboard you."
            href={CLOUD_ACCESS_HREF}
            label="cloud@genosyn.com"
          />
        </TileStrip>
      </Container>
    </Band>
  );
}

/* -------------------------------------------------------------------------
   03 / Self-hosted
------------------------------------------------------------------------- */

/**
 * The band the page is really about.
 *
 * It is the one tone change on the page, spent here rather than on the paid
 * tiers, and its ink object is the command rather than a button: on this band
 * the human action is running a line, not writing an email. The strip is the
 * same object as the landing hero's, inverted — black paper, so that on a page
 * of five bands the loudest single rectangle belongs to the free path.
 */
function SelfHosted() {
  return (
    <Band id="self-hosted" tone="surface" pad="m">
      <Container>
        <Head
          eyebrow="03 / Self-hosted"
          title="Unlimited AI Employees cost $0 on your hardware."
          lede="One command puts the whole platform on a machine you own. It sends no telemetry, and the Apache-2.0 licence reads the same at one AI Employee as at five hundred."
          aside={<Fields items={["$0", "APACHE-2.0", `v${__APP_VERSION__}`]} />}
        />

        <div className="mt-10 max-w-[46rem]">
          <InstallCommand />
        </div>

        <div className="mt-6 flex flex-wrap gap-x-8 gap-y-4">
          <TextLink href="/docs/install">Read the install guide</TextLink>
          <TextLink href={GITHUB_URL} external>
            Read every line on GitHub
          </TextLink>
        </div>

        {/* Paper tiles on a white band, the exact inverse of band 02's white
            tiles on paper. Two white tiles on a white band would have been a
            ruled grid with nothing to hold, and the tone change this band
            spent would have bought nothing. */}
        <TileStrip className="mt-12 lg:grid-cols-2">
          {SELF_HOSTED_PLANS.map((plan) => (
            <PlanTile key={plan.name} plan={plan} tone="ground" />
          ))}
        </TileStrip>

        <div className="mt-8 flex flex-wrap gap-x-8 gap-y-4">
          <TextLink href="/enterprise">What Enterprise adds</TextLink>
          <TextLink href={ENTERPRISE_HREF}>Talk to us about a licence</TextLink>
        </div>
      </Container>
    </Band>
  );
}

/* -------------------------------------------------------------------------
   04 / Compared
------------------------------------------------------------------------- */

/**
 * Four lines, five columns, and nothing that repeats a row.
 *
 * The lede's quota caveat is load-bearing: the Free plan's limits are a real
 * difference and they are listed on its tile, so a lede claiming these four
 * lines are the ONLY difference would be false. It says what the tiles already
 * carry instead.
 */
function Compared() {
  return (
    <Band tone="ground" pad="m">
      <Container>
        <Head
          eyebrow="04 / Compared"
          title="Five plans differ on four lines."
          lede="The tiles above carry the quotas each plan enforces. These four lines carry everything else that differs."
          aside={<Fields items={["5 PLANS", "4 LINES"]} />}
        />

        {/* A Pane, because a comparison is a picture of the product's own
            entitlement table rather than a piece of the page's prose. It gets
            no 3px department edge: five plans are not a department, and a hue
            here would be the first place the legend breaks. */}
        <Pane className="mt-10 max-w-[74rem]" title="What differs" meta="5 PLANS · 4 LINES">
          {/* The table keeps a minimum width and scrolls inside its own box.
              Reflowing a five-column comparison into stacked pairs at 375px
              produces five copies of the same four labels, which is worse to
              read than a scrollbar. */}
          {/* `relative` is load-bearing, not decoration. The `sr-only` spans
              inside the table (the caption, the empty corner header, and each
              "Not included") are `position: absolute`, so without a positioned
              ancestor HERE they resolve against an ancestor outside the clip,
              escape it, and park their 1px selves off to the right — which
              pushes the whole document to a 546px scroll width at a 375px
              viewport. Positioning the scroll container brings them back
              inside. The `Pane` around this is also relative, which is not
              enough: it is outside the overflow box. */}
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[46rem] border-collapse text-left">
              <caption className="sr-only">
                How the five Genosyn plans differ on upgrades, SSO, licence and support.
              </caption>
              <thead>
                <tr className="border-b border-rule">
                  <th scope="col" className="px-4 py-3 align-bottom">
                    <span className="sr-only">Line</span>
                  </th>
                  {PLAN_COLUMNS.map(([name, host]) => (
                    <th key={name} scope="col" className="px-4 py-3 align-bottom">
                      <Sheet className="!text-ink">{name}</Sheet>
                      <span className="mt-1 block">
                        <Sheet className="!text-[10px]">{host}</Sheet>
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {COMPARE_ROWS.map((row) => (
                  <tr key={row.label} className="border-b border-hairline last:border-b-0">
                    <th scope="row" className="px-4 py-3.5 align-top">
                      <Sheet className="!text-ink">{row.label}</Sheet>
                    </th>
                    {row.cells.map((cell, index) => (
                      <td key={PLAN_COLUMNS[index][0]} className="px-4 py-3.5 align-top">
                        <Body className="!text-[13px] !leading-5">{cell}</Body>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Pane>

        {/* The two facts that are identical in all five columns. They were
            rows in the old table, where five repeated cells said "this does not vary" in the most expensive way available. */}
        <Body className="mt-6 max-w-[62ch]">
          Human Members are free on all five plans, and every plan uses AI Model keys you register
          yourself. Only AI Employees are metered, and only on Genosyn Cloud.
        </Body>
      </Container>
    </Band>
  );
}

/* -------------------------------------------------------------------------
   05 / Questions
------------------------------------------------------------------------- */

/**
 * A definition list, at reading size, with the question in the display face
 * and the answer beside it. No accordion: the longest answer here is four
 * sentences, and a control that hides four sentences is a control that exists
 * to make the page look shorter than it is.
 */
function Questions() {
  return (
    <Band tone="ground" pad="s">
      <Container>
        <Head
          eyebrow="05 / Questions"
          title="Six answers cover plans, keys and licences."
          aside={<Fields items={[`${QUESTIONS.length} QUESTIONS`]} />}
        />

        <dl className="mt-10">
          {QUESTIONS.map((item) => (
            <Row
              key={item.q}
              className="!grid grid-cols-1 !py-6 lg:grid-cols-[22rem_minmax(0,1fr)]"
            >
              <dt>
                {/* The display face at row scale. A question inside a list is a
                    step below the band heading above it, and taking the same
                    face at a smaller size keeps that relationship without
                    adding a rung to the ramp. */}
                <Subhead className="!text-[1.0625rem] !leading-[1.45]">{item.q}</Subhead>
              </dt>
              <dd className="mt-2 lg:mt-0">
                <Body className="max-w-[62ch]">{item.a}</Body>
              </dd>
            </Row>
          ))}
        </dl>

        <div className="mt-10">
          <TextLink href="/docs">Read the documentation</TextLink>
        </div>
      </Container>
    </Band>
  );
}

/* -------------------------------------------------------------------------
   Parts
------------------------------------------------------------------------- */

/** The mono line that used to live in the rail's gutter. Counts and emitted
 *  values only — never an adjective in the data face. */
function Fields({ items, className = "" }: { items: string[]; className?: string }) {
  return (
    <div className={`flex flex-wrap items-baseline gap-x-5 gap-y-1 ${className}`}>
      {items.map((item) => (
        <Field key={item}>{item}</Field>
      ))}
    </div>
  );
}

/**
 * A set of plans, tiled on 1px seams.
 *
 * The seam is the page's only depth: `bg-seam` shows through a `gap-px` grid
 * and through the `p-px` ring, so the outer edge of the strip is made of the
 * same 1px line as its interior and the block reads as one object rather than
 * as N boxes that happen to touch. Nothing floats, nothing has a shadow, and
 * there is no radius — a rounded tile in a seam grid draws four little white
 * notches at every junction.
 */
function TileStrip({ className = "", children }: { className?: string; children: ReactNode }) {
  return <div className={`grid gap-px bg-seam p-px ${className}`}>{children}</div>;
}

/**
 * One plan.
 *
 * The price is a `Figure` — condensed, so a 68px number costs about as much
 * horizontal room as a 34px one would in the text face, which is the only
 * reason a page this dense can afford to shout. The meter line under it is
 * height-reserved: Free has no meter, and letting its body copy ride 20px
 * higher than its neighbours' would make four deliberate tiles look like four
 * accidents.
 */
function PlanTile({ plan, tone = "surface" }: { plan: Plan; tone?: "surface" | "ground" }) {
  return (
    <div className={`flex min-w-0 flex-col p-5 ${tone === "ground" ? "bg-ground" : "bg-surface"}`}>
      <div className="flex items-baseline justify-between gap-3">
        <Subhead className="!text-[1.125rem]">{plan.name}</Subhead>
        <Sheet className="shrink-0">{plan.host}</Sheet>
      </div>

      <Figure className="mt-6 !text-[clamp(2.75rem,4.6vw,4.25rem)]">{plan.price}</Figure>
      <div className="mt-2 min-h-[1.125rem]">{plan.meter && <Sheet>{plan.meter}</Sheet>}</div>

      <Rule className="mt-5" />
      <Body className="mt-4 !text-[14px]">{plan.gets}</Body>

      {/* The quota values sit at the foot of the tile on a ruled ledger, so
          across a strip the last line of every tile lands on the same rule.
          A wrapped inline set of fields was tried first and read as a tag
          cloud — these are enforced numbers, not keywords. */}
      <ul className="mt-auto pt-6">
        {plan.limits.map((limit) => (
          <li key={limit} className="border-t border-hairline py-1.5 last:border-b">
            <Field>{limit}</Field>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The human cell in a strip of machine cells.
 *
 * `TextLink` is ink by definition, which is invisible here, so the link is
 * written out in ground with the same left-drawing underline. `on-night`
 * flips the focus ring to the light end of the ramp: the global ring is
 * #131316, which on this tile would be a black outline on a black tile.
 */
function ActionTile({
  eyebrow,
  title,
  body,
  href,
  label,
}: {
  eyebrow: string;
  title: string;
  body: string;
  href: string;
  label: string;
}) {
  return (
    <div className="on-night flex min-w-0 flex-col justify-between gap-8 bg-ink p-5 text-ground">
      <span className="t-field text-ground/70">{eyebrow}</span>
      <div>
        <h3 className="t-h3 text-[1.125rem] text-ground">{title}</h3>
        <p className="mt-2 max-w-[28ch] text-[14px] leading-[1.5] text-ground/85">{body}</p>
        <a href={href} className="group mt-4 inline-flex w-fit items-baseline">
          <span className="t-data relative text-[13px] text-ground">
            {label}
            <span
              aria-hidden
              className="absolute -bottom-1 left-0 h-px w-full origin-left scale-x-0 bg-ground transition-transform duration-150 group-hover:scale-x-100"
            />
          </span>
        </a>
      </div>
    </div>
  );
}

/**
 * The install command, as an object rather than as a call to action.
 *
 * Black paper: this is the one thing on the page a person actually runs, and
 * on a page with no departments the inversion is the only emphasis available
 * that means something. It is the same pattern as the landing hero's strip and
 * deliberately not shared — the hero's copy is a private function inside
 * `Hero.tsx`, and lifting a stateful control into the Kit would put state in a
 * file whose whole job is stateless primitives. If a third page needs it, that
 * is the point to promote it.
 */
function InstallCommand() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // The command stays selectable when clipboard permission is unavailable.
    }
  }

  return (
    <div className="on-night flex min-h-[3.5rem] items-center gap-4 bg-ink px-4">
      <code className="t-data scrollbar-none min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-[12px] text-ground sm:text-[13px]">
        {INSTALL_COMMAND}
      </code>
      <button
        type="button"
        onClick={copy}
        className="t-field shrink-0 text-ground/70 transition-colors duration-100 hover:text-ground"
      >
        {copied ? "Copied" : "Copy"}
        <span className="sr-only"> install command</span>
      </button>
    </div>
  );
}

/**
 * A cell where a feature is absent.
 *
 * U+2212 rather than a grey em dash, and it carries its own screen-reader
 * word: the old table used an emerald tick against a light grey dash, which
 * encoded the answer in a hue at 1.9:1 against paper and in a glyph nobody
 * announces.
 */
function Absent() {
  return (
    <>
      <span aria-hidden className="t-data text-[13px] text-muted">
        −
      </span>
      <span className="sr-only">Not included</span>
    </>
  );
}
