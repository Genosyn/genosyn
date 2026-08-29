import type { ReactNode } from "react";
import {
  ArrowRight,
  Boxes,
  Cloud,
  Database,
  Github,
  KeyRound,
  LifeBuoy,
  LockKeyhole,
  Mail,
  Network,
  Server,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";
import { GITHUB_URL } from "@/lib/constants";
import { Link } from "@/lib/router";
import { Eyebrow } from "@/sections/Kit";
import {
  HeroActions,
  HeroBadge,
  HeroBadgeDot,
  HeroButton,
  HeroCopy,
  HeroGrid,
  HeroLede,
  HeroPanel,
  HeroProof,
  HeroSection,
  HeroTitle,
  HeroTitleMuted,
} from "@/sections/HeroKit";

const CONTACT_EMAIL = "enterprise@genosyn.com";
const CONTACT_SUBJECT = "Genosyn in our environment";
const CONTACT_BODY =
  "Hi Genosyn team,\n\nWe'd like to run Genosyn inside our environment.\n\n- Company / team:\n- Preferred deployment environment:\n- Expected AI Employee usage:\n- Identity or compliance requirements:\n- Anything else worth knowing:\n\nThanks!";
const CONTACT_HREF = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(
  CONTACT_SUBJECT,
)}&body=${encodeURIComponent(CONTACT_BODY)}`;

type Card = {
  icon: LucideIcon;
  title: string;
  body: string;
};

const REASONS: Card[] = [
  {
    icon: LockKeyhole,
    title: "Keep the data plane",
    body: "Company records, model credentials, Run history, and uploaded artifacts stay in infrastructure you operate — including everything an unattended Routine touches.",
  },
  {
    icon: KeyRound,
    title: "Bring your AI Models",
    body: "Use Anthropic, OpenAI, or custom OpenAI-compatible endpoints with credentials encrypted in the database.",
  },
  {
    icon: ShieldCheck,
    title: "Bound the autonomy",
    body: "Grants scope what each employee can reach and approval gates stop sensitive actions — inside your network, identity, logging, backup, and change-management standards.",
  },
  {
    icon: Network,
    title: "Integrate the company",
    body: "Connect the systems your teams already rely on while keeping access scoped through Connections and Grants.",
  },
];

const SERVICES: Card[] = [
  {
    icon: Cloud,
    title: "Deployment planning",
    body: "Choose a topology, database, storage, ingress, and upgrade path that fits the environment you already run.",
  },
  {
    icon: Users,
    title: "Identity and access",
    body: "Configure company membership, SSO, AI Employee Grants, and approval boundaries around sensitive work.",
  },
  {
    icon: ShieldCheck,
    title: "Security review support",
    body: "Map Genosyn's data flows, credential handling, isolation modes, and audit trail to your internal controls.",
  },
  {
    icon: LifeBuoy,
    title: "Operational support",
    body: "Plan upgrades, backups, recovery tests, model changes, and production troubleshooting with the team that builds it.",
  },
];

export function Enterprise(): ReactNode {
  return (
    <>
      <EnterpriseHero />
      <EnterpriseReasons />
      <EnterpriseDeployments />
      <EnterpriseServices />
      <EnterpriseContact />
    </>
  );
}

const ENTERPRISE_PROOF = [
  "MIT licensed",
  "Your model keys",
  "Approval gates on sensitive work",
  "SSO-ready",
];

function EnterpriseHero() {
  return (
    <HeroSection>
      <HeroGrid>
        <HeroCopy>
          <HeroBadge>
            Genosyn for Enterprise
            <HeroBadgeDot />
            <span className="font-medium text-stone-400">Your infrastructure</span>
          </HeroBadge>

          <HeroTitle>
            Run autonomously. <HeroTitleMuted>Inside your perimeter.</HeroTitleMuted>
          </HeroTitle>

          <HeroLede>
            Autonomous work is only as trustworthy as the place it runs. Genosyn puts the whole
            operating system inside the network, identity, database, and AI Model stack your team
            already governs — with a production path designed around your controls.
          </HeroLede>

          <HeroActions>
            <HeroButton href={CONTACT_HREF}>
              <Mail aria-hidden className="h-4 w-4" />
              Talk to us
              <ArrowRight aria-hidden className="h-4 w-4" />
            </HeroButton>
            <HeroButton href="#deployment" variant="secondary">
              See deployment paths
            </HeroButton>
          </HeroActions>

          <HeroProof items={ENTERPRISE_PROOF} />
        </HeroCopy>

        <ArchitectureCard />
      </HeroGrid>
    </HeroSection>
  );
}

function ArchitectureCard() {
  return (
    <HeroPanel label="Deployment profile · Private stack" status="Owned by you">
      <div className="rounded-3xl border border-stone-900/[0.07] bg-white p-3 shadow-raise">
        <div className="rounded-2xl border border-stone-900/[0.08] bg-paper-100 p-5 sm:p-6">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[11px] font-semibold text-stone-600">
                Your environment
              </div>
              <div className="mt-1 text-sm font-semibold text-stone-900">
                Private application stack
              </div>
            </div>
            <span className="rounded-md bg-emerald-50 px-2 py-1 text-[9px] font-semibold text-emerald-700">
              You control it
            </span>
          </div>

          <div className="mt-6 rounded-2xl border border-stone-900/[0.12] bg-paper-200 p-4">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-night-950 text-white">
                <Boxes className="h-4 w-4" />
              </span>
              <div>
                <div className="text-xs font-semibold text-stone-900">Genosyn</div>
                <div className="text-[10px] text-stone-600">
                  Members + AI Employees + company tools
                </div>
              </div>
            </div>
          </div>

          <div className="mx-auto h-5 w-px bg-stone-900/15" />

          <div className="grid grid-cols-3 gap-2">
            <ArchitectureNode icon={Database} label="Database" detail="SQLite / PG" />
            <ArchitectureNode icon={Server} label="AI Models" detail="Your keys" />
            <ArchitectureNode icon={Network} label="Systems" detail="Connections" />
          </div>

          <div className="mt-4 rounded-lg border border-stone-900/[0.08] bg-white px-3 py-2.5 text-[10px] leading-5 text-stone-500">
            Your network and identity controls sit around the entire stack. Genosyn adds scoped
            Grants, approvals, and Run history inside it.
          </div>
        </div>
      </div>
    </HeroPanel>
  );
}

function ArchitectureNode({
  icon: Icon,
  label,
  detail,
}: {
  icon: LucideIcon;
  label: string;
  detail: string;
}) {
  return (
    <div className="rounded-lg border border-stone-900/[0.08] bg-white p-3 text-center shadow-card">
      <Icon className="mx-auto h-4 w-4 text-stone-500" />
      <div className="mt-2 text-[10px] font-semibold text-stone-800">{label}</div>
      <div className="mt-0.5 text-[10px] text-stone-600">{detail}</div>
    </div>
  );
}

function EnterpriseReasons() {
  return (
    <section className="bg-paper-50">
      <div className="mx-auto max-w-[88rem] px-5 py-20 sm:px-8 sm:py-24 lg:py-32">
        <div className="mx-auto max-w-3xl text-center">
          <Eyebrow>Control without compromise</Eyebrow>
          <h2 className="mt-5 text-balance text-[clamp(1.875rem,3.4vw,2.875rem)] font-semibold leading-[1.06] tracking-[-0.035em] text-stone-900">
            An autonomous company inside your operating boundary.
          </h2>
        </div>
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {REASONS.map((reason) => (
            <article
              key={reason.title}
              className="rounded-2xl border border-stone-900/[0.08] bg-white p-5 transition hover:-translate-y-0.5 hover:border-stone-900/[0.14] hover:shadow-lift"
            >
              <reason.icon className="h-5 w-5 text-stone-900" />
              <h3 className="mt-4 text-sm font-semibold text-stone-900">{reason.title}</h3>
              <p className="mt-2 text-xs leading-5 text-stone-500">{reason.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function EnterpriseDeployments() {
  return (
    <section id="deployment" className="border-y border-stone-900/[0.08] bg-paper-100">
      <div className="mx-auto max-w-[88rem] px-5 py-20 sm:px-8 sm:py-24 lg:py-32">
        <div className="grid gap-10 lg:grid-cols-[0.7fr_1.3fr] lg:gap-16">
          <div>
            <Eyebrow>Deployment paths</Eyebrow>
            <h2 className="mt-5 text-[clamp(1.75rem,3vw,2.5rem)] font-semibold leading-[1.08] tracking-[-0.035em] text-stone-900">
              Start with the topology that matches the job.
            </h2>
            <p className="mt-5 text-base leading-7 text-stone-600">
              Genosyn supports a simple Docker installation and source-managed Linux deployments.
              Model authentication and isolation choices determine the supported shape.
            </p>
          </div>

          <div className="space-y-3">
            <DeploymentRow
              icon={Boxes}
              label="Standard self-hosted"
              title="Docker with API keys, custom models, or ChatGPT sign-in"
              body="The default path for one trusted host: persistent data, SQLite or Postgres, subscription Runs beside bubblewrap-isolated coding, and the built-in Genosyn CLI for operations."
            />
            <DeploymentRow
              icon={Server}
              label="Source-managed Linux"
              title="Advanced isolation for coding and repository work"
              body="Run the App process directly on Linux, where bubblewrap gives AI Models — eligible ChatGPT subscriptions included — the isolated bash and repository materialization the standard image also ships."
            />
            <DeploymentRow
              icon={Database}
              label="Shared deployment"
              title="Postgres-backed, multi-company operation"
              body="Use Postgres and API-key or custom AI Models for shared or horizontally scaled environments; OpenAI subscription access stays on one trusted single-tenant App process."
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function DeploymentRow({
  icon: Icon,
  label,
  title,
  body,
}: {
  icon: LucideIcon;
  label: string;
  title: string;
  body: string;
}) {
  return (
    <article className="rounded-2xl border border-stone-900/[0.08] bg-white p-5 shadow-card transition hover:-translate-y-0.5 hover:border-flame-300 hover:shadow-lift">
      <div className="flex items-start gap-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-paper-200 text-stone-900">
          <Icon className="h-4 w-4" />
        </span>
        <div>
          <div className="text-[11px] font-semibold text-stone-900">
            {label}
          </div>
          <h3 className="mt-1 text-sm font-semibold text-stone-900">{title}</h3>
          <p className="mt-2 text-xs leading-5 text-stone-500">{body}</p>
        </div>
      </div>
    </article>
  );
}

function EnterpriseServices() {
  return (
    <section className="bg-paper-50">
      <div className="mx-auto max-w-[88rem] px-5 py-20 sm:px-8 sm:py-24 lg:py-32">
        <div className="mx-auto max-w-3xl text-center">
          <Eyebrow>Enterprise support</Eyebrow>
          <h2 className="mt-5 text-balance text-[clamp(1.875rem,3.4vw,2.875rem)] font-semibold leading-[1.06] tracking-[-0.035em] text-stone-900">
            From first architecture review to production operations.
          </h2>
        </div>
        <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-stone-900/[0.08] bg-stone-900/10 sm:grid-cols-2">
          {SERVICES.map((service) => (
            <article key={service.title} className="bg-white p-6 sm:p-7">
              <service.icon className="h-5 w-5 text-stone-900" />
              <h3 className="mt-4 text-sm font-semibold text-stone-900">{service.title}</h3>
              <p className="mt-2 text-sm leading-6 text-stone-600">{service.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function EnterpriseContact() {
  return (
    <section className="bg-paper-50">
      <div className="mx-auto max-w-[88rem] px-5 pb-20 sm:px-8 sm:pb-24 lg:pb-28">
        <div className="on-night relative overflow-hidden rounded-[2rem] bg-gradient-to-br from-stone-900 to-night-850 px-6 py-14 text-center shadow-raise sm:px-12 sm:py-20">
          <div aria-hidden className="marketing-dots pointer-events-none absolute inset-0 opacity-15" />
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-28 -left-20 h-80 w-80 rounded-full bg-flame-500/25 blur-3xl"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -top-24 right-0 h-80 w-80 rounded-full bg-violet-500/25 blur-3xl"
          />
          <div className="relative mx-auto max-w-2xl">
            <h2 className="text-balance text-[clamp(1.75rem,3vw,2.5rem)] font-semibold leading-[1.08] tracking-[-0.035em] text-white">
              Let&apos;s plan your Genosyn deployment.
            </h2>
            <p className="mx-auto mt-5 max-w-xl text-base leading-7 text-white/85">
              Tell us about the environment, identity model, compliance needs, and the work you want
              AI Employees to take on.
            </p>
            <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <a
                href={CONTACT_HREF}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-white px-6 py-3.5 text-sm font-semibold text-stone-900 shadow-lg transition duration-200 hover:-translate-y-0.5 hover:bg-paper-100 sm:w-auto"
              >
                <Mail className="h-4 w-4" />
                Email {CONTACT_EMAIL}
              </a>
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-white/40 bg-white/10 px-6 py-3.5 text-sm font-semibold text-white backdrop-blur transition duration-200 hover:-translate-y-0.5 hover:bg-white/20 sm:w-auto"
              >
                <Github className="h-4 w-4" />
                Try open source first
              </a>
            </div>
            <p className="mt-6 text-xs text-white/60">
              Comparing editions and Cloud plans first?{" "}
              <Link href="/pricing" className="font-semibold text-white underline underline-offset-2 hover:text-flame-200">
                See pricing
              </Link>
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
