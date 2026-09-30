import { useState } from "react";
import type { ReactNode } from "react";
import { Check, Minus } from "lucide-react";
import { useReveal } from "@/components/Reveal";
import { SIGN_UP_URL } from "@/lib/constants";
import { FaqSection, type QA } from "@/sections/Faq";
import { ClosingCta } from "@/sections/Footer";
import { Button, Container, CopyCommand, Em, Section, SectionHead, TextLink } from "@/sections/Kit";
import { PageHero } from "@/sections/PageHero";

const ENTERPRISE_HREF = "mailto:enterprise@genosyn.com?subject=Genosyn%20Enterprise";
const INSTALL_COMMAND = "curl -fsSL https://genosyn.com/install.sh | bash";

type Billing = "monthly" | "annual";

type Plan = {
  name: string;
  blurb: string;
  monthly: string;
  annual?: string;
  unit?: string;
  features: string[];
  cta: { label: string; href: string };
  featured?: boolean;
};

const CLOUD: Plan[] = [
  {
    name: "Free",
    blurb: "One AI Employee with a Soul and two Routines, running on a schedule. It costs nothing in month one or month twelve.",
    monthly: "$0",
    features: ["1 AI Employee", "2 Routines", "1 Base with 1 table", "3 Channels", "1 Project and 20 todos"],
    cta: { label: "Start free", href: SIGN_UP_URL },
  },
  {
    name: "Growth",
    blurb: "Every Free limit comes off. Support is email, answered by the people who wrote the code.",
    monthly: "$19",
    annual: "$17.10",
    unit: "per AI Employee / month",
    features: ["Unlimited AI Employees", "Unlimited Routines", "No caps on Bases, Channels or Projects", "Email support"],
    cta: { label: "Start free, upgrade later", href: SIGN_UP_URL },
    featured: true,
  },
  {
    name: "Scale",
    blurb: "Everything in Growth, plus single sign-on and the audit log for the whole company — the plan an IT review asks for.",
    monthly: "$49",
    annual: "$44.10",
    unit: "per AI Employee / month",
    features: ["Everything in Growth", "Single sign-on", "The audit log", "Priority support"],
    cta: { label: "Start free, upgrade later", href: SIGN_UP_URL },
  },
];

const SELF_HOSTED: Plan[] = [
  {
    name: "Community",
    blurb: "Unlimited AI Employees and Routines on a laptop or a cluster. You keep the database, the model keys and every audit row.",
    monthly: "$0",
    unit: "forever · Apache 2.0",
    features: ["Unlimited AI Employees", "Unlimited Routines", "No licence key, no telemetry", "GitHub issues support"],
    cta: { label: "Read the install guide", href: "/docs/install" },
  },
  {
    name: "Enterprise",
    blurb: "Community plus single sign-on, the audit log and priority support. A signed key validates offline, so air-gapped installs work.",
    monthly: "Quoted",
    unit: "signed licence key",
    features: ["Everything in Community", "Single sign-on", "The audit log", "Priority support", "Offline validation"],
    cta: { label: "Talk to us", href: ENTERPRISE_HREF },
  },
];

type Cell = boolean | string;

const COMPARE: { group: string; rows: { label: string; cells: [Cell, Cell, Cell, Cell, Cell] }[] }[] = [
  {
    group: "The roster",
    rows: [
      { label: "AI Employees", cells: ["1", "Unlimited", "Unlimited", "Unlimited", "Unlimited"] },
      { label: "Routines", cells: ["2", "Unlimited", "Unlimited", "Unlimited", "Unlimited"] },
      { label: "Bases and tables", cells: ["1 and 1", "Unlimited", "Unlimited", "Unlimited", "Unlimited"] },
      { label: "Channels", cells: ["3", "Unlimited", "Unlimited", "Unlimited", "Unlimited"] },
      { label: "Projects and todos", cells: ["1 and 20", "Unlimited", "Unlimited", "Unlimited", "Unlimited"] },
      { label: "Human Members", cells: ["Free", "Free", "Free", "Free", "Free"] },
    ],
  },
  {
    group: "Control",
    rows: [
      { label: "Single sign-on", cells: [false, false, true, false, true] },
      { label: "Audit log", cells: [false, false, true, false, true] },
      { label: "Your own AI Model keys", cells: [true, true, true, true, true] },
    ],
  },
  {
    group: "Operations",
    rows: [
      { label: "Hosting and upgrades", cells: ["We run them", "We run them", "We run them", "You run them", "You run them"] },
      { label: "Licence", cells: ["Cloud terms", "Cloud terms", "Cloud terms", "Apache 2.0", "Signed key"] },
      { label: "Support", cells: ["GitHub issues", "Email", "Priority", "GitHub issues", "Priority"] },
    ],
  },
];

const COLUMNS: [string, string][] = [
  ["Free", "Cloud"],
  ["Growth", "Cloud"],
  ["Scale", "Cloud"],
  ["Community", "Self-hosted"],
  ["Enterprise", "Self-hosted"],
];

const QUESTIONS: QA[] = [
  {
    q: "What counts as an AI Employee?",
    a: "An AI Employee is a hired teammate on your roster: a persistent role with its own Soul, Skills and Routines. You pay per AI Employee hired, and human Members are always free on every plan.",
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
    a: "We issue a signed licence key that a master admin pastes at Admin / License in your install. The key validates offline against a public key shipped in the product, so it works in fully air-gapped environments.",
  },
  {
    q: "Can I switch plans?",
    a: "Any time, and between monthly and annual billing too. Upgrades and downgrades take effect through Stripe with per-AI-Employee proration, and hiring or letting go of an AI Employee adjusts your billed quantity automatically.",
  },
  {
    q: "What happens if I go over a Free plan limit?",
    a: "Nothing breaks. Genosyn asks you to upgrade before you hire another AI Employee, add a third Routine, a second Base or Base table, a fourth Channel, a second Project, or the twenty-first todo. Everything already running keeps running.",
  },
];

export function Pricing(): ReactNode {
  const [billing, setBilling] = useState<Billing>("monthly");
  return (
    <>
      <PageHero
        kicker="Pricing"
        title={
          <>
            Start free. <Em>Pay only for the AI Employees you hire.</Em>
          </>
        }
        lede="Genosyn Cloud is free for your first AI Employee, and self-hosted Genosyn is free for all of them. Human Members are free everywhere, and you bring your own model keys, so token spend stays between you and your provider."
      />

      <Section id="cloud" space="none" className="pb-20 sm:pb-24">
        <Container>
          <div className="flex flex-wrap items-end justify-between gap-6 border-b border-line pb-6">
            <div>
              <p className="kicker text-ink-400">Genosyn Cloud</p>
              <p className="mt-2 text-[15px] text-ink-600">We run the hosting, the upgrades and the backups.</p>
            </div>
            <BillingToggle value={billing} onChange={setBilling} />
          </div>
          <PlanGrid plans={CLOUD} billing={billing} columns="lg:grid-cols-3" />

          <div className="mt-20 flex flex-wrap items-end justify-between gap-6 border-b border-line pb-6">
            <div>
              <p className="kicker text-ink-400">On your own hardware</p>
              <p className="mt-2 text-[15px] text-ink-600">One command installs the same software. It stays yours.</p>
            </div>
            <CopyCommand command={INSTALL_COMMAND} className="w-full max-w-[32rem]" />
          </div>
          <PlanGrid plans={SELF_HOSTED} billing="monthly" columns="lg:grid-cols-2" />
        </Container>
      </Section>

      <Compare />

      <FaqSection
        items={QUESTIONS}
        footer={<TextLink href="/docs/plans-billing">Plans and billing in the docs</TextLink>}
      />

      <ClosingCta />
    </>
  );
}

function BillingToggle({ value, onChange }: { value: Billing; onChange: (value: Billing) => void }) {
  return (
    <div role="radiogroup" aria-label="Billing period" className="inline-flex rounded-full border border-line bg-paper-raised p-1">
      {(["monthly", "annual"] as const).map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          onClick={() => onChange(option)}
          className={`h-9 rounded-full px-4 text-[13.5px] font-medium transition-colors ${
            value === option ? "bg-ink text-white" : "text-ink-500 hover:text-ink"
          }`}
        >
          {option === "monthly" ? "Monthly" : "Annual · save 10%"}
        </button>
      ))}
    </div>
  );
}

function PlanGrid({ plans, billing, columns }: { plans: Plan[]; billing: Billing; columns: string }) {
  const ref = useReveal<HTMLUListElement>(0, 70);
  return (
    <ul ref={ref} className={`mt-8 grid gap-4 ${columns}`}>
      {plans.map((plan) => {
        const price = billing === "annual" && plan.annual ? plan.annual : plan.monthly;
        const dark = plan.featured;
        return (
          <li
            key={plan.name}
            className={`flex flex-col rounded-3xl border p-7 sm:p-8 ${
              dark ? "border-ink bg-ink text-white shadow-lifted" : "border-line bg-paper-raised text-ink"
            }`}
          >
            <p className="text-[18px] font-medium">{plan.name}</p>
            <p className={`mt-3 min-h-[4.5rem] text-[14px] leading-6 ${dark ? "text-white/65" : "text-ink-500"}`}>{plan.blurb}</p>
            <div className="mt-6">
              <p className="flex items-baseline gap-2.5">
                <span key={price} className="settle font-display text-[3.6rem] leading-none tracking-[-0.04em]">
                  {price}
                </span>
                {plan.unit && <span className={`text-[13.5px] ${dark ? "text-white/60" : "text-ink-500"}`}>{plan.unit}</span>}
              </p>
              <p className={`mt-2 h-5 text-[12.5px] ${dark ? "text-white/45" : "text-ink-400"}`}>
                {plan.annual
                  ? billing === "annual"
                    ? `Billed annually — ${plan.monthly} month to month`
                    : `Or ${plan.annual} billed annually`
                  : ""}
              </p>
            </div>
            <ul className={`mt-6 space-y-2.5 border-t pt-6 ${dark ? "border-white/15" : "border-line"}`}>
              {plan.features.map((feature) => (
                <li key={feature} className={`flex items-start gap-2.5 text-[14px] leading-5 ${dark ? "text-white/85" : "text-ink-600"}`}>
                  <Check aria-hidden className={`mt-0.5 h-4 w-4 shrink-0 ${dark ? "text-white" : "text-ink"}`} strokeWidth={1.8} />
                  {feature}
                </li>
              ))}
            </ul>
            <div className="mt-auto pt-8">
              <Button href={plan.cta.href} variant={dark ? "paper" : "outline"} arrow className="w-full">
                {plan.cta.label}
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Compare() {
  return (
    <Section id="compare" tone="raised" space="md" rule>
      <Container>
        <SectionHead
          kicker="Compared"
          title={
            <>
              Five plans, one product.
            </>
          }
          lede="Every plan runs the same software with every product and Integration in it. What changes is who hosts it, how many AI Employees it holds, and the controls an IT review asks for."
        />
        <div className="scrollbar-none mt-12 overflow-x-auto rounded-3xl border border-line bg-paper-raised">
          <table className="w-full min-w-[52rem] border-collapse text-left">
            <caption className="sr-only">What differs between the five Genosyn plans</caption>
            <thead>
              <tr className="border-b border-line">
                <th scope="col" className="w-[26%] px-6 py-5">
                  <span className="sr-only">Feature</span>
                </th>
                {COLUMNS.map(([name, host], index) => (
                  <th
                    key={name}
                    scope="col"
                    className={`px-4 py-5 align-bottom ${index === 3 ? "border-l border-line" : ""} ${index === 1 ? "bg-ink/[0.03]" : ""}`}
                  >
                    <span className="block font-mono text-[10.5px] font-normal uppercase tracking-[0.1em] text-ink-400">{host}</span>
                    <span className="mt-1 block text-[15px] font-medium text-ink">{name}</span>
                  </th>
                ))}
              </tr>
            </thead>
            {COMPARE.map((group) => (
              <tbody key={group.group}>
                <tr>
                  <th colSpan={6} scope="colgroup" className="border-b border-line bg-paper px-6 pb-3 pt-6 text-left">
                    <span className="kicker text-ink-400">{group.group}</span>
                  </th>
                </tr>
                {group.rows.map((row) => (
                  <tr key={row.label} className="border-b border-line last:border-b-0">
                    <th scope="row" className="px-6 py-4 text-[14.5px] font-normal text-ink">
                      {row.label}
                    </th>
                    {row.cells.map((cell, index) => (
                      <td
                        key={COLUMNS[index][0]}
                        className={`px-4 py-4 text-[14px] text-ink-600 ${index === 3 ? "border-l border-line" : ""} ${
                          index === 1 ? "bg-ink/[0.03]" : ""
                        }`}
                      >
                        <CellValue value={cell} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
        <p className="mt-6 max-w-[64ch] text-[14px] leading-6 text-ink-500">
          Human Members are free on all five plans, and every plan uses AI Model keys you register
          yourself. Only AI Employees are metered, and only on Genosyn Cloud.
        </p>
      </Container>
    </Section>
  );
}

function CellValue({ value }: { value: Cell }) {
  if (value === true) {
    return (
      <>
        <Check aria-hidden className="h-4 w-4 text-ink" strokeWidth={2} />
        <span className="sr-only">Included</span>
      </>
    );
  }
  if (value === false) {
    return (
      <>
        <Minus aria-hidden className="h-4 w-4 text-ink-300" />
        <span className="sr-only">Not included</span>
      </>
    );
  }
  return <>{value}</>;
}
