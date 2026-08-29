import type { ReactNode } from "react";
import {
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  Cloud,
  Mail,
  Server,
  Sparkles,
} from "lucide-react";
import { Eyebrow } from "@/sections/Kit";
import {
  HeroBadge,
  HeroBadgeDot,
  HeroCopy,
  HeroLede,
  HeroSection,
  HeroTitle,
  HeroTitleMuted,
} from "@/sections/HeroKit";
import { Link } from "@/lib/router";

const CLOUD_ACCESS_HREF = "mailto:cloud@genosyn.com?subject=Genosyn%20Cloud%20early%20access";
const ENTERPRISE_HREF = "mailto:enterprise@genosyn.com?subject=Genosyn%20Enterprise";
const INSTALL_COMMAND = "curl -fsSL https://genosyn.com/install.sh | bash";

type CloudPlan = {
  name: string;
  price: string;
  priceSuffix: string | null;
  tagline: string;
  bullets: string[];
  footnote: string | null;
  ctaVariant: "primary" | "secondary";
  highlighted: boolean;
};

const CLOUD_PLANS: CloudPlan[] = [
  {
    name: "Free",
    price: "$0",
    priceSuffix: null,
    tagline: "Try a real AI employee across every core surface.",
    bullets: [
      "1 AI Employee",
      "2 Routines",
      "1 Base with 1 table",
      "3 Channels",
      "1 Project with 20 Todos",
      "Bring your own AI Model keys",
      "Community support",
    ],
    footnote: null,
    ctaVariant: "secondary",
    highlighted: false,
  },
  {
    name: "Growth",
    price: "$19",
    priceSuffix: "/ AI Employee / mo",
    tagline: "Your first AI department.",
    bullets: [
      "Unlimited AI Employees & Routines",
      "Unlimited Bases, Channels, Projects & Todos",
      "Every integration",
      "Priority email support",
    ],
    footnote: "Billed per AI Employee hired — vs. thousands for a human hire.",
    ctaVariant: "primary",
    highlighted: false,
  },
  {
    name: "Scale",
    price: "$49",
    priceSuffix: "/ AI Employee / mo",
    tagline: "For companies that run on Genosyn.",
    bullets: [
      "Everything in Growth",
      "Single sign-on (SSO)",
      "Audit log",
      "Priority support",
    ],
    footnote: "Billed per AI Employee hired — vs. thousands for a human hire.",
    ctaVariant: "primary",
    highlighted: true,
  },
];

type ComparisonRow = {
  label: string;
  free: ReactNode;
  growth: ReactNode;
  scale: ReactNode;
  enterprise: ReactNode;
};

function Yes() {
  return <Check aria-label="Included" className="mx-auto h-4 w-4 text-emerald-600" />;
}

function No() {
  return (
    <span aria-label="Not included" className="text-stone-300">
      —
    </span>
  );
}

const COMPARISON_ROWS: ComparisonRow[] = [
  { label: "AI Employees", free: "1", growth: "Unlimited", scale: "Unlimited", enterprise: "Unlimited" },
  { label: "Routines", free: "2", growth: "Unlimited", scale: "Unlimited", enterprise: "Unlimited" },
  { label: "Bases", free: "1", growth: "Unlimited", scale: "Unlimited", enterprise: "Unlimited" },
  { label: "Base tables", free: "1", growth: "Unlimited", scale: "Unlimited", enterprise: "Unlimited" },
  { label: "Channels", free: "3", growth: "Unlimited", scale: "Unlimited", enterprise: "Unlimited" },
  { label: "Projects", free: "1", growth: "Unlimited", scale: "Unlimited", enterprise: "Unlimited" },
  { label: "Todos", free: "20", growth: "Unlimited", scale: "Unlimited", enterprise: "Unlimited" },
  { label: "SSO", free: <No />, growth: <No />, scale: <Yes />, enterprise: <Yes /> },
  { label: "Audit log", free: <No />, growth: <No />, scale: <Yes />, enterprise: <Yes /> },
  { label: "Support", free: "Community", growth: "Priority email", scale: "Priority", enterprise: "Priority" },
  { label: "Hosting", free: "Genosyn Cloud", growth: "Genosyn Cloud", scale: "Genosyn Cloud", enterprise: "Self-hosted" },
];

type Faq = { q: string; a: string };

const FAQS: Faq[] = [
  {
    q: "What counts as an AI Employee?",
    a: "An AI Employee is a hired teammate on your roster — a persistent role with its own Soul, Skills, and Routines. You pay per AI Employee hired; human Members are always free, on every plan. At $19 a month, that hire costs a fraction of what a person in the same seat would — and it works its Routines around the clock.",
  },
  {
    q: "Do I need my own AI Model API keys?",
    a: "Yes, on every plan. You connect Anthropic, OpenAI, or any OpenAI-compatible endpoint under Settings, and model usage is billed by your provider directly. Genosyn prices the platform, not the tokens.",
  },
  {
    q: "Is the self-hosted version really free?",
    a: "Yes. The community edition is Apache 2.0 licensed with unlimited AI Employees and Routines, forever. Genosyn Enterprise adds SSO, the audit log, and priority support on top for self-hosted installs at work.",
  },
  {
    q: "How does Enterprise licensing work?",
    a: "We issue a signed license key that a master admin pastes at Admin → License in your install. The key validates offline against a public key shipped in the product, so it works in fully air-gapped environments.",
  },
  {
    q: "Can I switch plans?",
    a: "Any time. Upgrades and downgrades take effect through Stripe with per-AI-Employee proration, and hiring or letting go of an AI Employee adjusts your billed quantity automatically.",
  },
  {
    q: "What happens if I go over a Free plan limit?",
    a: "Nothing breaks — Genosyn simply asks you to upgrade before hiring another AI Employee, adding a third Routine, a second Base or Base table, a fourth Channel, a second Project, or the twenty-first Todo — everything already running keeps running.",
  },
];

export function Pricing(): ReactNode {
  return (
    <>
      <PricingHero />
      <CloudPlans />
      <SelfHostedBand />
      <ComparisonTable />
      <PricingFaq />
      <PricingCta />
    </>
  );
}

function PricingHero() {
  return (
    <HeroSection tight>
      <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
        <HeroCopy>
          <div className="flex flex-col items-center">
            <HeroBadge>
              Simple pricing
              <HeroBadgeDot />
              <span className="font-medium text-stone-500">Open source core</span>
            </HeroBadge>

            <HeroTitle>
              Start free. <HeroTitleMuted>Scale when your AI team does.</HeroTitleMuted>
            </HeroTitle>

            <HeroLede>
              Self-host the Apache 2.0-licensed community edition free forever, or let us run it for you on
              Genosyn Cloud — an employee-grade hire for $19 a month, not the thousands a human
              costs.
            </HeroLede>
          </div>
        </HeroCopy>
      </div>
    </HeroSection>
  );
}

function CloudPlans() {
  return (
    <section className="bg-paper-50">
      <div className="mx-auto max-w-[88rem] px-5 py-20 sm:px-8 sm:py-24 lg:py-32">
        <div className="mx-auto max-w-3xl text-center">
          <Eyebrow>Genosyn Cloud</Eyebrow>
          <h2 className="mt-5 text-balance text-[clamp(1.875rem,3.4vw,2.875rem)] font-semibold leading-[1.06] tracking-[-0.035em] text-stone-900">
            We run it. You hire.
          </h2>
          <p className="mx-auto mt-6 max-w-xl text-base leading-7 text-stone-600">
            A human hire costs thousands a month before they start. An AI Employee on Genosyn is
            $19 — working its Routines around the clock.
          </p>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-stone-500">
            A fully managed Genosyn — upgrades, backups, and hosting handled. Every plan uses your
            own AI Model keys, so model usage stays between you and your provider.
          </p>
        </div>

        <div className="mt-12 grid gap-4 sm:grid-cols-3">
          {CLOUD_PLANS.map((plan) => (
            <PlanCard key={plan.name} plan={plan} />
          ))}
        </div>

        <p className="mt-6 text-center text-xs leading-5 text-stone-500">
          Genosyn Cloud is rolling out now — request access and we&apos;ll onboard you.
        </p>
      </div>
    </section>
  );
}

function PlanCard({ plan }: { plan: CloudPlan }) {
  return (
    <article
      className={`flex flex-col rounded-2xl border bg-white p-6 shadow-card ${
        plan.highlighted ? "border-tide-400 ring-1 ring-tide-400" : "border-stone-900/[0.07]"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-stone-900">{plan.name}</h3>
        {plan.highlighted && (
          <span className="rounded-full bg-tide-50 px-2.5 py-1 text-[11px] font-semibold text-tide-700">
            SSO + audit log
          </span>
        )}
      </div>
      <div className="mt-4 flex items-baseline gap-1.5">
        <span className="text-4xl font-semibold tracking-[-0.03em] text-stone-900 tabular-nums">
          {plan.price}
        </span>
        {plan.priceSuffix && <span className="text-xs text-stone-500">{plan.priceSuffix}</span>}
      </div>
      <p className="mt-2 text-sm font-medium text-stone-600">{plan.tagline}</p>
      <ul className="mt-5 space-y-2.5 text-sm text-stone-600">
        {plan.bullets.map((bullet) => (
          <li key={bullet} className="flex items-start gap-2">
            <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
            {bullet}
          </li>
        ))}
      </ul>
      <div className="mt-auto pt-6">
        <a
          href={CLOUD_ACCESS_HREF}
          className={`inline-flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold transition ${
            plan.ctaVariant === "primary"
              ? "bg-tide-500 text-white shadow-card hover:bg-tide-600"
              : "border border-stone-900/[0.10] bg-white text-stone-800 hover:border-stone-900/20 hover:bg-paper-50"
          }`}
        >
          <Mail aria-hidden className="h-4 w-4" />
          Request early access
        </a>
        {plan.footnote && <p className="mt-3 text-[11px] leading-4 text-stone-400">{plan.footnote}</p>}
      </div>
    </article>
  );
}

function SelfHostedBand() {
  return (
    <section className="border-y border-stone-900/[0.07] bg-paper-200">
      <div className="mx-auto max-w-[88rem] px-5 py-20 sm:px-8 sm:py-24 lg:py-32">
        <div className="mx-auto max-w-3xl text-center">
          <Eyebrow>Self-hosted</Eyebrow>
          <h2 className="mt-5 text-balance text-[clamp(1.875rem,3.4vw,2.875rem)] font-semibold leading-[1.06] tracking-[-0.035em] text-stone-900">
            Your hardware, your rules.
          </h2>
        </div>

        <div className="mt-12 grid gap-4 lg:grid-cols-2">
          {/* min-w-0: without it the nowrap install command sets the grid
              column's min-content width and the tile overflows the viewport
              on phones — the code block then scrolls inside the tile. */}
          <article className="flex min-w-0 flex-col rounded-2xl border border-stone-900/[0.08] bg-white p-6 shadow-card sm:p-8">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-paper-200 text-stone-900">
                <Server className="h-4 w-4" />
              </span>
              <div>
                <h3 className="text-sm font-semibold text-stone-900">Community</h3>
                <div className="text-xs font-medium text-emerald-700">Free forever</div>
              </div>
            </div>
            <p className="mt-5 text-base leading-7 text-stone-600">
              Apache 2.0 licensed, with unlimited AI Employees and Routines and every core feature. Runs on
              your hardware, from a laptop to a cluster.
            </p>
            <div className="mt-5 overflow-x-auto rounded-lg border border-night-700 bg-night-950 px-4 py-3">
              <code className="whitespace-nowrap font-mono text-xs text-white">
                <span aria-hidden className="mr-2 select-none text-stone-500">
                  $
                </span>
                {INSTALL_COMMAND}
              </code>
            </div>
            <div className="mt-auto pt-6">
              <Link
                href="/docs/install"
                className="inline-flex items-center gap-2 rounded-md border border-stone-900/[0.12] bg-white px-4 py-2.5 text-sm font-semibold text-stone-700 transition hover:border-tide-300 hover:bg-paper-100"
              >
                <BookOpen aria-hidden className="h-4 w-4" />
                Read the install guide
              </Link>
            </div>
          </article>

          <article className="flex min-w-0 flex-col rounded-2xl border border-stone-900/[0.08] bg-white p-6 shadow-card sm:p-8">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-night-950 text-white">
                <Sparkles className="h-4 w-4" />
              </span>
              <div>
                <h3 className="text-sm font-semibold text-stone-900">Enterprise</h3>
                <div className="text-xs font-medium text-stone-500">For self-hosted at work</div>
              </div>
            </div>
            <p className="mt-5 text-base leading-7 text-stone-600">
              Everything in Community plus single sign-on (SSO), the audit log, priority support, and
              a signed license that validates fully offline — air-gapped environments included.
            </p>
            <div className="mt-auto flex flex-col gap-3 pt-6 sm:flex-row sm:items-center">
              <a
                href={ENTERPRISE_HREF}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-tide-500 px-5 py-3 text-sm font-semibold text-white shadow-card transition hover:bg-tide-600"
              >
                <Mail aria-hidden className="h-4 w-4" />
                Talk to us
              </a>
              <Link
                href="/enterprise"
                className="inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-2.5 text-sm font-semibold text-stone-600 transition hover:text-tide-600"
              >
                Learn about Enterprise
                <ArrowRight aria-hidden className="h-4 w-4" />
              </Link>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}

function ComparisonTable() {
  return (
    <section className="bg-paper-50">
      <div className="mx-auto max-w-5xl px-5 py-20 sm:px-8 sm:py-24 lg:py-28">
        <div className="text-center">
          <Eyebrow>Compare</Eyebrow>
          <h2 className="mt-5 text-[clamp(1.75rem,3vw,2.5rem)] font-semibold leading-[1.08] tracking-[-0.035em] text-stone-900">
            Every plan, side by side.
          </h2>
        </div>

        <div className="mt-10 overflow-x-auto rounded-2xl border border-stone-900/[0.08] shadow-card">
          <table className="w-full min-w-[40rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-stone-900/[0.08] bg-paper-100 text-left">
                <th scope="col" className="px-4 py-3.5 font-semibold text-stone-500">
                  <span className="sr-only">Feature</span>
                </th>
                <th scope="col" className="px-4 py-3.5 text-center font-semibold text-stone-900">
                  Free
                </th>
                <th scope="col" className="px-4 py-3.5 text-center font-semibold text-stone-900">
                  Growth
                </th>
                <th scope="col" className="px-4 py-3.5 text-center font-semibold text-stone-900">
                  Scale
                </th>
                <th scope="col" className="px-4 py-3.5 text-center font-semibold text-stone-900">
                  Enterprise
                  <span className="block text-[10px] font-medium text-stone-500">self-hosted</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {COMPARISON_ROWS.map((row) => (
                <tr key={row.label} className="border-b border-stone-900/[0.06] last:border-b-0">
                  <th scope="row" className="px-4 py-3.5 text-left font-medium text-stone-700">
                    {row.label}
                  </th>
                  <td className="px-4 py-3.5 text-center text-stone-600 tabular-nums">{row.free}</td>
                  <td className="px-4 py-3.5 text-center text-stone-600 tabular-nums">
                    {row.growth}
                  </td>
                  <td className="px-4 py-3.5 text-center text-stone-600 tabular-nums">
                    {row.scale}
                  </td>
                  <td className="px-4 py-3.5 text-center text-stone-600 tabular-nums">
                    {row.enterprise}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function PricingFaq() {
  return (
    <section className="bg-paper-50">
      <div className="mx-auto max-w-3xl px-5 pb-20 sm:px-8 sm:pb-24 lg:pb-28">
        <div className="text-center">
          <Eyebrow>Questions</Eyebrow>
          <h2 className="mt-5 text-[clamp(1.75rem,3vw,2.5rem)] font-semibold leading-[1.08] tracking-[-0.035em] text-stone-900">
            Frequently asked.
          </h2>
        </div>
        <div className="mt-9 space-y-2.5">
          {FAQS.map((faq) => (
            <details
              key={faq.q}
              className="group rounded-2xl border border-stone-900/[0.08] bg-white open:bg-paper-100"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-sm font-semibold text-stone-900 [&::-webkit-details-marker]:hidden">
                {faq.q}
                <ChevronDown className="h-4 w-4 shrink-0 text-stone-400 transition group-open:rotate-180" />
              </summary>
              <p className="px-5 pb-5 text-sm leading-6 text-stone-600">{faq.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function PricingCta() {
  return (
    <section className="bg-paper-50">
      <div className="mx-auto max-w-[88rem] px-5 pb-20 sm:px-8 sm:pb-24 lg:pb-28">
        <div className="on-night relative overflow-hidden rounded-[2rem] bg-gradient-to-br from-stone-900 to-night-850 px-6 py-14 text-center shadow-raise sm:px-12 sm:py-20">
          <div aria-hidden className="marketing-dots pointer-events-none absolute inset-0 opacity-15" />
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-28 -left-20 h-80 w-80 rounded-full bg-tide-500/25 blur-3xl"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -top-24 right-0 h-80 w-80 rounded-full bg-violet-500/25 blur-3xl"
          />
          <div className="relative mx-auto max-w-2xl">
            <h2 className="text-balance text-[clamp(1.75rem,3vw,2.5rem)] font-semibold leading-[1.08] tracking-[-0.035em] text-white">
              Run your company on autopilot.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-sm leading-6 text-stone-200 sm:text-base">
              Hire your first AI Employee free — on Genosyn Cloud or your own hardware — and add
              plans only when the AI team grows.
            </p>
            <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <a
                href={CLOUD_ACCESS_HREF}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-white px-6 py-3.5 text-sm font-semibold text-stone-900 shadow-lg transition duration-200 hover:-translate-y-0.5 hover:bg-paper-100 sm:w-auto"
              >
                <Cloud className="h-4 w-4" />
                Request Cloud access
              </a>
              <Link
                href="/docs"
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-white/40 bg-white/10 px-6 py-3.5 text-sm font-semibold text-white backdrop-blur transition duration-200 hover:-translate-y-0.5 hover:bg-white/20 sm:w-auto"
              >
                <BookOpen className="h-4 w-4" />
                Read the docs
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
