import { useState } from "react";
import type { ReactNode } from "react";
import { GITHUB_URL } from "@/lib/constants";
import {
  ActionStrip,
  Band,
  Body,
  Container,
  Display,
  Field,
  Heading,
  Lede,
  Rail,
  Row,
  Sheet,
  TextLink,
} from "@/sections/Kit";

/**
 * The pricing page.
 *
 * Five things were removed rather than restyled, and each one was removed for
 * a reason that outlives this file:
 *
 * 1. **The three ringed tier cards.** A ring around "Scale" is a shop telling
 *    you which shelf to look at. The plans are a set, so they are rows in a
 *    fixed column structure — plan, what you get, price — and the reader
 *    compares down a column instead of across three boxes.
 *
 * 2. **The 44-cell comparison grid.** Nine of its eleven rows read
 *    `1 / Unlimited / Unlimited / Unlimited`, which is one fact about the
 *    Free plan written nine times. What survives is four lines that the plan
 *    rows genuinely cannot carry: who runs the upgrade, where SSO lives, which
 *    licence you are under, and who answers you.
 *
 * 3. **The `<details>` accordion.** These answers are the best-written copy on
 *    the site. Six of them are three sentences long. Hiding three sentences
 *    behind a chevron costs a click and buys nothing, so the FAQ is a plain
 *    definition list and it is the last and loudest band.
 *
 * 4. **The dark gradient CTA slab.** Rounded to 2rem, dotted, with an indigo
 *    blur orb and a white one, and pasted verbatim onto three pages. A slab
 *    that appears identically on three pages is not an argument for any of
 *    them. The page's controls sit in the bands that earn them.
 *
 * 5. **"Frequently asked."** An amputated stock phrase with no subject.
 *
 * There is no signal amber anywhere on this page, and that is deliberate.
 * Amber marks the human boundary — a Decision, an Approval, the 09:30 arrival
 * line — and a price is none of those. Spending the site's one colour on a
 * plan name is how it stops meaning anything.
 *
 * Ordering: the sheet numbers run Cloud then Self-hosted, but the free tier is
 * the loudest thing here. It wins on typography instead of on position — the
 * first headline on the page names it, band 03 is the only tone change and the
 * only `Display` below the hero, and it carries the real install command.
 */

const CLOUD_ACCESS_HREF = "mailto:cloud@genosyn.com?subject=Genosyn%20Cloud%20early%20access";
const ENTERPRISE_HREF = "mailto:enterprise@genosyn.com?subject=Genosyn%20Enterprise";

/** The command in `client/public/install.sh` and in the install guide, verbatim. */
const INSTALL_COMMAND = "curl -fsSL https://genosyn.com/install.sh | bash";

type Plan = {
  name: string;
  /** Where it runs. Sits under the name in the first column. */
  host: string;
  /** One sentence. What you get, in the product's own nouns. */
  gets: string;
  /** The headline price, as a mono field. */
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
    gets: "Every limit above comes off, and every Integration is available to connect. Support is email, answered by the people who wrote the code.",
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

/**
 * The comparison, reduced to the lines that differ.
 *
 * Every row here answers a question the plan rows above cannot: the plan rows
 * say what you get, and these four say who operates it, who is on the hook,
 * and under what terms. A row whose five cells all read the same value has
 * been moved into prose underneath, because a table is for differences.
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
 * These were already the strongest writing in the codebase and the revamp's
 * job was to stop hiding them, not to rewrite them. Three edits were made:
 * the banned "simply" is gone, five em dashes became full stops and colons,
 * and the arrow in `Admin -> License` became a slash, because U+2192 is not
 * in the served font subset and falls back to a system face mid-line.
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

/**
 * 01 / Pricing.
 *
 * The first sentence on a pricing page should be the price. The old one was a
 * centred badge reading "Simple pricing" over a two-tone headline, which is
 * three elements spent saying nothing a reader could act on.
 */
function PricingHead() {
  return (
    <Band tone="paper" pad="m" rule={false}>
      <Container>
        <Rail sheet="01 / Pricing" fields={["Apache-2.0", `v${__APP_VERSION__}`, "USD"]}>
          <Display className="max-w-[20ch]">Genosyn is free on your own hardware.</Display>

          <Lede className="mt-7">
            Download it, run it, and hire as many AI Employees as you want. Genosyn Cloud is the
            same software with us operating it, charged per AI Employee hired.
          </Lede>

          <div className="mt-10 max-w-[34rem]">
            <ActionStrip href="/docs/install" trailing="Free">
              Install it on your own hardware
            </ActionStrip>
            <ActionStrip href={CLOUD_ACCESS_HREF} trailing="Email" className="-mt-px">
              Request Genosyn Cloud access
            </ActionStrip>
          </div>
        </Rail>
      </Container>
    </Band>
  );
}

/** 02 / Cloud. Three plans, one meter, drawn as three rows. */
function CloudPlans() {
  return (
    <Band id="cloud" tone="paper" pad="m">
      <Container>
        <Rail sheet="02 / Cloud" fields={["3 PLANS", "USD / MO"]}>
          <Heading as="h2" className="max-w-[22ch]">
            Genosyn Cloud has three plans and one meter.
          </Heading>

          <Lede className="mt-6">
            We run the upgrades, the backups and the hosting. You bring your own AI Model keys on
            every plan, so token spend is billed to you by Anthropic or OpenAI and never by us.
          </Lede>

          <div className="mt-10">
            {CLOUD_PLANS.map((plan) => (
              <PlanRow key={plan.name} plan={plan} />
            ))}
          </div>

          <div className="mt-8 max-w-[34rem]">
            <Body className="mb-5 !text-zinc-600">
              Genosyn Cloud is rolling out now. Send one line about what you want an AI Employee to
              do and we will onboard you.
            </Body>
            <ActionStrip href={CLOUD_ACCESS_HREF} trailing="Email">
              Request Genosyn Cloud access
            </ActionStrip>
          </div>
        </Rail>
      </Container>
    </Band>
  );
}

/**
 * 03 / Self-hosted — the band the page is really about.
 *
 * It is the one tone change on the page and the only `Display` below the hero.
 * Both were spent here rather than on the paid tiers because the honest
 * hierarchy of an Apache-2.0 product is that the free thing is the product and
 * the hosted thing is a convenience.
 */
function SelfHosted() {
  return (
    <Band id="self-hosted" tone="raised" pad="m">
      <Container>
        <Rail sheet="03 / Self-hosted" fields={["$0", "APACHE-2.0", `v${__APP_VERSION__}`]}>
          <Display as="h2" className="max-w-[20ch]">
            Unlimited AI Employees cost $0 on your hardware.
          </Display>

          <Lede className="mt-7">
            One command puts the whole platform on a machine you own. It sends no telemetry, and the
            Apache-2.0 licence reads the same at one AI Employee as at five hundred.
          </Lede>

          <div className="mt-9 max-w-[38rem]">
            <InstallCommand />
            <ActionStrip href="/docs/install" trailing="Guide" className="-mt-px">
              Read the install guide
            </ActionStrip>
            <ActionStrip href={GITHUB_URL} external trailing="Source" className="-mt-px">
              Read every line on GitHub
            </ActionStrip>
          </div>

          <div className="mt-12">
            {SELF_HOSTED_PLANS.map((plan) => (
              <PlanRow key={plan.name} plan={plan} />
            ))}
          </div>

          <div className="mt-8 flex flex-wrap gap-x-8 gap-y-4">
            <TextLink href="/enterprise">What Enterprise adds</TextLink>
            <TextLink href={ENTERPRISE_HREF}>Talk to us about a licence</TextLink>
          </div>
        </Rail>
      </Container>
    </Band>
  );
}

/** 04 / Compared. Four lines, five columns, and nothing that repeats a row. */
function Compared() {
  return (
    <Band tone="paper" pad="m">
      <Container>
        <Rail sheet="04 / Compared" fields={["5 PLANS", "4 LINES"]}>
          <Heading as="h2" className="max-w-[22ch]">
            Five plans differ on four lines.
          </Heading>

          {/* The table keeps a minimum width and scrolls inside its own box.
              Reflowing a five-column comparison into stacked pairs at 375px
              produces five copies of the same four labels, which is worse to
              read than a scrollbar. */}
          {/* `relative` is load-bearing, not decoration. The `sr-only` spans
              inside the table (the caption, the empty corner header, and each
              "Not included") are `position: absolute`, so without a positioned
              ancestor here they resolve against the band's own `relative`
              section, escape this box's clip, and park their 1px selves at
              x=545 — which pushes the whole document to a 546px scroll width
              at a 375px viewport. Positioning the scroll container brings them
              back inside the clip. */}
          <div className="relative mt-9 overflow-x-auto border border-paper-400 bg-paper-50">
            <table className="w-full min-w-[46rem] border-collapse text-left">
              <caption className="sr-only">
                How the five Genosyn plans differ on upgrades, SSO, licence and support.
              </caption>
              <thead>
                <tr className="border-b border-paper-400">
                  <th scope="col" className="px-4 py-3 align-bottom">
                    <span className="sr-only">Line</span>
                  </th>
                  {PLAN_COLUMNS.map(([name, host]) => (
                    <th key={name} scope="col" className="px-4 py-3 align-bottom">
                      <Sheet className="!text-zinc-950">{name}</Sheet>
                      <span className="mt-1 block">
                        <Sheet className="!text-[10px]">{host}</Sheet>
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {COMPARE_ROWS.map((row) => (
                  <tr key={row.label} className="border-b border-paper-300 last:border-b-0">
                    <th scope="row" className="px-4 py-3.5 align-top">
                      <Sheet className="!text-zinc-950">{row.label}</Sheet>
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

          {/* The two facts that are identical in all five columns. They were
              rows in the old table, where five repeated cells said "this does
              not vary" in the most expensive way available. */}
          <Body className="mt-6 max-w-[62ch]">
            Human Members are free on all five plans, and every plan uses AI Model keys you register
            yourself. Only AI Employees are metered, and only on Genosyn Cloud.
          </Body>
        </Rail>
      </Container>
    </Band>
  );
}

/**
 * 05 / Questions.
 *
 * A definition list, at reading size, with the question in the display face
 * and the answer beside it. No accordion: the longest answer here is four
 * sentences, and a control that hides four sentences is a control that exists
 * to make the page look shorter than it is.
 */
function Questions() {
  return (
    <Band tone="paper" pad="s">
      <Container>
        <Rail sheet="05 / Questions" fields={[`${QUESTIONS.length} QUESTIONS`]}>
          <Heading as="h2" className="max-w-[24ch]">
            Six answers cover plans, keys and licences.
          </Heading>

          <dl className="mt-10">
            {QUESTIONS.map((item) => (
              <Row
                key={item.q}
                className="!grid grid-cols-1 !py-6 lg:grid-cols-[20rem_minmax(0,1fr)]"
              >
                <dt>
                  {/* The Heading face at row scale. A question inside a list is
                      a step below the band heading above it, and taking the
                      same face at a smaller size keeps that relationship
                      without adding a rung to the ramp. */}
                  <Heading as="h3" className="!text-[1.0625rem] !leading-[1.45]">
                    {item.q}
                  </Heading>
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
        </Rail>
      </Container>
    </Band>
  );
}

/**
 * One plan, as a row in a fixed three-column structure.
 *
 * The price is a `Field` rather than a 36px number, which is the whole
 * argument of the redesign applied to a pricing page: the price is a string
 * the billing system emitted, and setting it in mono next to the quota values
 * it belongs with is more honest than setting it in display type to make the
 * plan feel significant. `order` puts the price directly under the plan name
 * on a phone, where a price at the bottom of a paragraph is easy to miss.
 */
function PlanRow({ plan }: { plan: Plan }) {
  return (
    <Row className="!grid grid-cols-1 !gap-y-3 !py-6 lg:grid-cols-[8rem_minmax(0,1fr)_11rem]">
      <div className="order-1">
        <h3>
          <Sheet className="!text-[12px] !text-zinc-950">{plan.name}</Sheet>
        </h3>
        <span className="mt-1 block">
          <Sheet className="!text-[10px]">{plan.host}</Sheet>
        </span>
      </div>

      <div className="order-3 lg:order-2">
        <Body className="max-w-[54ch]">{plan.gets}</Body>
        <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          {plan.limits.map((limit) => (
            <Field key={limit}>{limit}</Field>
          ))}
        </div>
      </div>

      <div className="order-2 lg:order-3 lg:text-right">
        <Field className="!text-[15px] !leading-5 !text-zinc-950">{plan.price}</Field>
        {plan.meter && (
          <span className="mt-1.5 block">
            <Field>{plan.meter}</Field>
          </span>
        )}
      </div>
    </Row>
  );
}

/**
 * The install command, as an object rather than a call to action.
 *
 * This is the same pattern as the landing hero's install strip, deliberately
 * not shared: the hero's copy is a private function inside `Hero.tsx`, and
 * lifting it into the Kit would put a stateful control in a file whose whole
 * job is stateless primitives. If a third page needs it, that is the point to
 * promote it.
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
    <div className="flex min-h-[3.25rem] items-center gap-4 border border-paper-400 bg-paper-100 px-4">
      <code className="t-data min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-[12px] text-zinc-950 scrollbar-none sm:text-[13px]">
        {INSTALL_COMMAND}
      </code>
      <button
        type="button"
        onClick={copy}
        className="t-cond shrink-0 text-[11px] uppercase tracking-field text-zinc-600 transition-colors hover:text-zinc-950"
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
      <span aria-hidden className="t-data text-[13px] text-zinc-600">
        −
      </span>
      <span className="sr-only">Not included</span>
    </>
  );
}
