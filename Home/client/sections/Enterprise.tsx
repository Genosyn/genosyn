import type { ReactNode } from "react";
import {
  ArrowRight,
  Boxes,
  CheckCircle2,
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
import { SectionEyebrow } from "@/sections/Primitives";

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
    body: "Company records, model credentials, Run history, and uploaded artifacts stay in infrastructure you operate.",
  },
  {
    icon: KeyRound,
    title: "Bring your AI Models",
    body: "Use Anthropic, OpenAI, or custom OpenAI-compatible endpoints with credentials encrypted in the database.",
  },
  {
    icon: ShieldCheck,
    title: "Fit existing controls",
    body: "Put Genosyn behind your network, identity, database, logging, backup, and change-management standards.",
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

function EnterpriseHero() {
  return (
    <section className="relative overflow-hidden border-b border-slate-200 bg-white">
      <div aria-hidden className="marketing-grid pointer-events-none absolute inset-0 opacity-60" />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[34rem] bg-[radial-gradient(circle_at_38%_0%,rgba(226,232,240,0.82),transparent_68%)]"
      />
      <div className="relative mx-auto grid max-w-7xl gap-12 px-5 pb-20 pt-14 sm:px-6 sm:pt-20 lg:grid-cols-[0.88fr_1.12fr] lg:items-center lg:gap-16">
        <div>
          <SectionEyebrow>Genosyn for Enterprise</SectionEyebrow>
          <h1 className="mt-6 text-balance text-[3rem] font-semibold leading-[1] tracking-[-0.05em] text-slate-950 sm:text-[4.6rem]">
            Run Genosyn inside <span className="text-slate-500">your environment.</span>
          </h1>
          <p className="mt-6 max-w-2xl text-pretty text-base leading-7 text-slate-600 sm:text-lg sm:leading-8">
            Bring the open-source company operating system into the network, identity, database, and
            model stack your team already trusts. We help you make it production-ready.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <a
              href={CONTACT_HREF}
              className="inline-flex items-center justify-center gap-2 rounded-md bg-slate-950 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-slate-800 hover:shadow-md"
            >
              <Mail className="h-4 w-4" />
              Talk to us
              <ArrowRight className="h-4 w-4" />
            </a>
            <a
              href="#deployment"
              className="inline-flex items-center justify-center rounded-md border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-slate-400"
            >
              See deployment paths
            </a>
          </div>
          <ul className="mt-7 flex flex-wrap gap-x-5 gap-y-2 text-[11px] font-medium text-slate-500">
            {["MIT licensed", "Your model keys", "SQLite or Postgres", "SSO-ready"].map((item) => (
              <li key={item} className="inline-flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-slate-950" />
                {item}
              </li>
            ))}
          </ul>
        </div>

        <ArchitectureCard />
      </div>
    </section>
  );
}

function ArchitectureCard() {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-[0_26px_70px_-36px_rgba(15,23,42,0.45)]">
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-5 sm:p-6">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
              Your environment
            </div>
            <div className="mt-1 text-sm font-semibold text-slate-900">Private application stack</div>
          </div>
          <span className="rounded-md bg-emerald-50 px-2 py-1 text-[9px] font-semibold text-emerald-700">
            You control it
          </span>
        </div>

        <div className="mt-6 rounded-xl border border-slate-300 bg-slate-100 p-4">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-950 text-white">
              <Boxes className="h-4 w-4" />
            </span>
            <div>
              <div className="text-xs font-semibold text-slate-950">Genosyn</div>
              <div className="text-[10px] text-slate-600">Members + AI Employees + company tools</div>
            </div>
          </div>
        </div>

        <div className="mx-auto h-5 w-px bg-slate-300" />

        <div className="grid grid-cols-3 gap-2">
          <ArchitectureNode icon={Database} label="Database" detail="SQLite / PG" />
          <ArchitectureNode icon={Server} label="AI Models" detail="Your keys" />
          <ArchitectureNode icon={Network} label="Systems" detail="Connections" />
        </div>

        <div className="mt-4 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-[10px] leading-5 text-slate-500">
          Your network and identity controls sit around the entire stack. Genosyn adds scoped Grants,
          approvals, and Run history inside it.
        </div>
      </div>
    </div>
  );
}

function ArchitectureNode({ icon: Icon, label, detail }: { icon: LucideIcon; label: string; detail: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 text-center shadow-sm">
      <Icon className="mx-auto h-4 w-4 text-slate-500" />
      <div className="mt-2 text-[10px] font-semibold text-slate-800">{label}</div>
      <div className="mt-0.5 text-[9px] text-slate-400">{detail}</div>
    </div>
  );
}

function EnterpriseReasons() {
  return (
    <section className="bg-white">
      <div className="mx-auto max-w-7xl px-5 py-20 sm:px-6 sm:py-24">
        <div className="mx-auto max-w-3xl text-center">
          <SectionEyebrow>Control without compromise</SectionEyebrow>
          <h2 className="mt-5 text-balance text-4xl font-semibold tracking-[-0.04em] text-slate-950 sm:text-5xl">
            AI Employees inside your operating boundary.
          </h2>
        </div>
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {REASONS.map((reason) => (
            <article key={reason.title} className="rounded-xl border border-slate-200 bg-slate-50 p-5 transition hover:-translate-y-0.5 hover:border-slate-300 hover:bg-white hover:shadow-sm">
              <reason.icon className="h-5 w-5 text-slate-950" />
              <h3 className="mt-4 text-sm font-semibold text-slate-900">{reason.title}</h3>
              <p className="mt-2 text-xs leading-5 text-slate-500">{reason.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function EnterpriseDeployments() {
  return (
    <section id="deployment" className="border-y border-slate-200 bg-slate-50">
      <div className="mx-auto max-w-7xl px-5 py-20 sm:px-6 sm:py-24">
        <div className="grid gap-10 lg:grid-cols-[0.7fr_1.3fr] lg:gap-16">
          <div>
            <SectionEyebrow>Deployment paths</SectionEyebrow>
            <h2 className="mt-5 text-3xl font-semibold tracking-[-0.035em] text-slate-950 sm:text-4xl">
              Start with the topology that matches the job.
            </h2>
            <p className="mt-4 text-sm leading-6 text-slate-600">
              Genosyn supports a simple Docker installation and source-managed Linux deployments.
              Model authentication and isolation choices determine the supported shape.
            </p>
          </div>

          <div className="space-y-3">
            <DeploymentRow
              icon={Boxes}
              label="Standard self-hosted"
              title="Docker with API-key or custom AI Models"
              body="The default path for one host: persistent application data, SQLite or Postgres, and the built-in Genosyn CLI for operations."
            />
            <DeploymentRow
              icon={Server}
              label="Source-managed Linux"
              title="Advanced isolation and eligible OpenAI subscription access"
              body="Run the App process directly on Linux with bubblewrap when you need the supported ChatGPT subscription path and its locked temporary credential boundary."
            />
            <DeploymentRow
              icon={Database}
              label="Shared deployment"
              title="Postgres-backed, multi-company operation"
              body="Use Postgres and API-key or custom AI Models for shared or horizontally scaled environments; OpenAI subscription access stays on a single source-managed process."
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
    <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md">
      <div className="flex items-start gap-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-950">
          <Icon className="h-4 w-4" />
        </span>
        <div>
          <div className="text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-950">{label}</div>
          <h3 className="mt-1 text-sm font-semibold text-slate-900">{title}</h3>
          <p className="mt-2 text-xs leading-5 text-slate-500">{body}</p>
        </div>
      </div>
    </article>
  );
}

function EnterpriseServices() {
  return (
    <section className="bg-white">
      <div className="mx-auto max-w-7xl px-5 py-20 sm:px-6 sm:py-24">
        <div className="mx-auto max-w-3xl text-center">
          <SectionEyebrow>Enterprise support</SectionEyebrow>
          <h2 className="mt-5 text-balance text-4xl font-semibold tracking-[-0.04em] text-slate-950 sm:text-5xl">
            From first architecture review to production operations.
          </h2>
        </div>
        <div className="mt-12 grid gap-px overflow-hidden rounded-xl border border-slate-200 bg-slate-200 sm:grid-cols-2">
          {SERVICES.map((service) => (
            <article key={service.title} className="bg-slate-50 p-6 sm:p-7">
              <service.icon className="h-5 w-5 text-slate-950" />
              <h3 className="mt-4 text-sm font-semibold text-slate-900">{service.title}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">{service.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function EnterpriseContact() {
  return (
    <section className="bg-white">
      <div className="mx-auto max-w-7xl px-5 pb-20 sm:px-6 sm:pb-24">
        <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 px-6 py-12 text-center sm:px-12 sm:py-16">
          <div aria-hidden className="marketing-dots pointer-events-none absolute inset-0 opacity-20" />
          <div className="relative mx-auto max-w-2xl">
            <h2 className="text-balance text-3xl font-semibold tracking-[-0.035em] text-white sm:text-4xl">
              Let&apos;s plan your Genosyn deployment.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-sm leading-6 text-slate-200 sm:text-base">
              Tell us about the environment, identity model, compliance needs, and the work you want
              AI Employees to take on.
            </p>
            <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <a
                href={CONTACT_HREF}
                className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-white px-5 py-3 text-sm font-semibold text-slate-800 shadow-sm transition hover:bg-slate-100 sm:w-auto"
              >
                <Mail className="h-4 w-4" />
                Email {CONTACT_EMAIL}
              </a>
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-white/25 bg-white/5 px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/10 sm:w-auto"
              >
                <Github className="h-4 w-4" />
                Try open source first
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
