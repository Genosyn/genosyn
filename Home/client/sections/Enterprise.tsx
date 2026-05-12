import {
  ArrowRight,
  Boxes,
  CheckCircle2,
  Cloud,
  Database,
  FileLock2,
  Github,
  KeyRound,
  LifeBuoy,
  Lock,
  Mail,
  Network,
  Plug,
  Server,
  ShieldCheck,
  Sparkles,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { GITHUB_URL } from "@/lib/constants";
import { SectionEyebrow } from "@/sections/Primitives";

const CONTACT_EMAIL = "enterprise@genosyn.com";
const CONTACT_SUBJECT = "Genosyn in our environment";
const CONTACT_BODY =
  "Hi Genosyn team,\n\nWe'd like to run Genosyn inside our own environment. A few details about us:\n\n- Company / team:\n- Where we want to deploy (VPC / on-prem / air-gapped / k8s):\n- Number of AI employees we expect to run:\n- Compliance requirements (SOC2 / HIPAA / FedRAMP / other):\n- Anything else worth knowing:\n\nThanks!";

const CONTACT_HREF = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(
  CONTACT_SUBJECT,
)}&body=${encodeURIComponent(CONTACT_BODY)}`;

export function EnterpriseHero() {
  return (
    <section className="relative overflow-hidden bg-white">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[560px] bg-[radial-gradient(60%_80%_at_50%_0%,rgba(15,23,42,0.06),transparent_70%)]"
      />

      <div className="mx-auto max-w-7xl px-6 pt-14 pb-20 sm:pt-20 sm:pb-24">
        <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
          <SectionEyebrow>Genosyn for Enterprise</SectionEyebrow>

          <h1 className="mt-6 text-balance font-semibold leading-[1.05] tracking-[-0.035em] text-zinc-950 text-[2.5rem] sm:text-[3.25rem] lg:text-[3.75rem]">
            Run Genosyn inside your environment.
          </h1>

          <p className="mt-6 max-w-2xl text-balance text-lg leading-[1.6] text-zinc-600">
            The same open-source platform you can install in one command — only
            wired into your VPC, your Postgres, your identity provider, and
            your model keys. We help you ship it.
          </p>

          <div className="mt-9 flex flex-col items-center gap-3 sm:flex-row">
            <a
              href={CONTACT_HREF}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-zinc-950 px-6 py-3 text-sm font-semibold text-white shadow-lift transition hover:bg-zinc-800 sm:w-auto"
            >
              <Mail className="h-4 w-4" />
              Talk to us
              <ArrowRight className="h-4 w-4" />
            </a>
            <a
              href="#deployments"
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-6 py-3 text-sm font-semibold text-zinc-800 shadow-card transition hover:border-zinc-300 hover:bg-zinc-50 sm:w-auto"
            >
              See deployment options
            </a>
          </div>

          <ul className="mt-10 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs font-medium text-zinc-500">
            {[
              "Your VPC or on-prem",
              "Bring your own keys",
              "Postgres + HA ready",
              "MIT licensed",
            ].map((c) => (
              <li key={c} className="inline-flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-zinc-700" />
                {c}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

type Reason = {
  icon: LucideIcon;
  title: string;
  body: string;
};

const REASONS: Reason[] = [
  {
    icon: Lock,
    title: "Data never leaves your perimeter",
    body: "Souls, run logs, attachments, customer records — all of it stays on infrastructure you control. No third-party data plane to vet.",
  },
  {
    icon: ShieldCheck,
    title: "Plug into your compliance posture",
    body: "Whatever your security team already audits — networking, KMS, IAM, logging — Genosyn inherits it. We help you map the controls.",
  },
  {
    icon: KeyRound,
    title: "Your model keys, your bill",
    body: "Wire Genosyn to your existing Anthropic, OpenAI, Bedrock, or Vertex contracts. No usage routing through a vendor.",
  },
  {
    icon: FileLock2,
    title: "Air-gapped where you need it",
    body: "Pre-pulled images, offline installer, optional self-hosted model gateways. Works on networks that never see the public internet.",
  },
];

export function EnterpriseReasons() {
  return (
    <section className="border-t border-zinc-100 bg-white">
      <div className="mx-auto max-w-7xl px-6 py-24 sm:py-28">
        <div className="mx-auto max-w-2xl text-center">
          <SectionEyebrow>Why self-host</SectionEyebrow>
          <h2 className="mt-4 text-balance text-4xl font-semibold tracking-[-0.02em] text-zinc-950 sm:text-5xl">
            Autonomous AI workers, on your terms.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-zinc-600">
            Genosyn was designed to be self-hostable on day one. For teams with
            real compliance gravity, running it in your environment is the
            short path — not the long way around.
          </p>
        </div>

        <ol className="mx-auto mt-14 grid max-w-5xl grid-cols-1 gap-5 sm:grid-cols-2">
          {REASONS.map((r) => (
            <li
              key={r.title}
              className="group flex gap-5 rounded-2xl border border-zinc-200 bg-white p-6 shadow-card transition hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-lift"
            >
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-zinc-100 text-zinc-700 ring-1 ring-zinc-200 transition group-hover:bg-zinc-200">
                <r.icon className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-zinc-950">
                  {r.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-zinc-600">
                  {r.body}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

type Topology = {
  icon: LucideIcon;
  tag: string;
  title: string;
  body: string;
  bullets: string[];
  accent: string;
};

const TOPOLOGIES: Topology[] = [
  {
    icon: Server,
    tag: "Single VM",
    title: "One Docker host",
    body: "The simplest production setup: one Linux VM, the genosyn container, a managed Postgres next door. Behind your reverse proxy.",
    bullets: [
      "Single-tenant, single-region",
      "Postgres on RDS / Cloud SQL / your own",
      "Caddy or nginx in front for TLS",
    ],
    accent: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  },
  {
    icon: Cloud,
    tag: "VPC / Private cloud",
    title: "Inside your network",
    body: "Run inside the AWS / GCP / Azure account that already holds your data. We help with IAM, KMS, security groups, and outbound model traffic.",
    bullets: [
      "Private subnets, no public ingress",
      "KMS-managed session secret and at-rest encryption",
      "Outbound egress only to the model providers you approve",
    ],
    accent: "bg-sky-50 text-sky-700 ring-sky-200",
  },
  {
    icon: Network,
    tag: "Kubernetes",
    title: "Multi-replica on k8s",
    body: "Helm-managed deployment with horizontal replicas in front of a shared Postgres, an external volume for the data directory, and your cluster's secret manager.",
    bullets: [
      "Stateless app pods, Postgres as state",
      "External volume for credentials + artifacts",
      "Workload identity / IRSA for cloud secrets",
    ],
    accent: "bg-violet-50 text-violet-700 ring-violet-200",
  },
  {
    icon: FileLock2,
    tag: "Air-gapped",
    title: "No internet, by design",
    body: "Ship the image into your registry, point Genosyn at an internal model gateway, and run on networks the cloud never reaches. Updates come on your schedule.",
    bullets: [
      "Pre-pulled OCI bundle for offline registries",
      "Self-hosted model gateway support",
      "Manual upgrade flow with reversible rollback",
    ],
    accent: "bg-amber-50 text-amber-700 ring-amber-200",
  },
];

export function EnterpriseDeployments() {
  return (
    <section
      id="deployments"
      className="border-t border-zinc-100 bg-gradient-to-b from-zinc-50/60 to-white"
    >
      <div className="mx-auto max-w-7xl px-6 py-24 sm:py-28">
        <div className="mx-auto max-w-2xl text-center">
          <SectionEyebrow>Deployment topologies</SectionEyebrow>
          <h2 className="mt-4 text-balance text-4xl font-semibold tracking-[-0.02em] text-zinc-950 sm:text-5xl">
            However your platform team likes to ship.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-zinc-600">
            Genosyn is a single container that talks to a database. That gives
            you a real menu of deployment options instead of one opinionated
            cloud product.
          </p>
        </div>

        <div className="mt-14 grid grid-cols-1 gap-5 lg:grid-cols-2">
          {TOPOLOGIES.map((t) => (
            <article
              key={t.tag}
              className="group flex flex-col rounded-2xl border border-zinc-200 bg-white p-7 shadow-card transition hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-lift"
            >
              <div className="flex items-center gap-3">
                <div
                  className={`flex h-10 w-10 items-center justify-center rounded-xl ring-1 ${t.accent}`}
                >
                  <t.icon className="h-5 w-5" />
                </div>
                <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  {t.tag}
                </span>
              </div>
              <h3 className="mt-5 text-lg font-semibold text-zinc-950">
                {t.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-zinc-600">
                {t.body}
              </p>
              <ul className="mt-5 space-y-2 border-t border-zinc-100 pt-5">
                {t.bullets.map((b) => (
                  <li
                    key={b}
                    className="flex items-start gap-2 text-sm text-zinc-700"
                  >
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
                    {b}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

type Offering = {
  icon: LucideIcon;
  title: string;
  body: string;
};

const OFFERINGS: Offering[] = [
  {
    icon: Workflow,
    title: "White-glove install",
    body: "We pair with your platform team on the first deploy — provisioning, secrets, reverse proxy, the first AI employee — and hand back a runbook.",
  },
  {
    icon: Database,
    title: "Postgres + scale",
    body: "Help sizing Postgres, picking the right HA pattern, planning your backup and DR story, and migrating from SQLite when you outgrow it.",
  },
  {
    icon: ShieldCheck,
    title: "Security review",
    body: "Threat-model walkthrough, hardening checklist, secret handling review, and answers for your security questionnaire from people who built it.",
  },
  {
    icon: KeyRound,
    title: "SSO & directory sync",
    body: "Wire Genosyn into Okta, Entra, Google Workspace, or any OIDC / SAML provider. Roles and provisioning kept in sync with your IdP.",
  },
  {
    icon: Plug,
    title: "Custom integrations",
    body: "Need an MCP server for an internal system, a private model gateway, or a one-off connector? We can build it with you or for you.",
  },
  {
    icon: LifeBuoy,
    title: "Priority support & SLA",
    body: "A shared channel, named on-call, and a response-time SLA that fits how mission-critical your AI employees actually are.",
  },
];

export function EnterpriseOfferings() {
  return (
    <section className="border-t border-zinc-100 bg-white">
      <div className="mx-auto max-w-7xl px-6 py-24 sm:py-28">
        <div className="mx-auto max-w-2xl text-center">
          <SectionEyebrow>How we help</SectionEyebrow>
          <h2 className="mt-4 text-balance text-4xl font-semibold tracking-[-0.02em] text-zinc-950 sm:text-5xl">
            The product is free.{" "}
            <span className="text-zinc-500">The runway isn&apos;t.</span>
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-zinc-600">
            Genosyn is MIT-licensed and you can absolutely run it on your own.
            For teams that want to skip the trial-and-error, we sell the
            shortest path from contract to first scheduled routine.
          </p>
        </div>

        <div className="mt-14 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {OFFERINGS.map((o) => (
            <article
              key={o.title}
              className="flex flex-col rounded-2xl border border-zinc-200 bg-white p-6 shadow-card transition hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-lift"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-100 text-zinc-700 ring-1 ring-zinc-200">
                <o.icon className="h-5 w-5" />
              </div>
              <h3 className="mt-5 text-base font-semibold text-zinc-950">
                {o.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-zinc-600">
                {o.body}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

type Proof = {
  icon: LucideIcon;
  label: string;
  value: string;
  body: string;
};

const PROOFS: Proof[] = [
  {
    icon: Boxes,
    label: "Runtime",
    value: "One container",
    body: "Single image, no sidecars, no microservice fan-out. Easy to audit, easy to roll back.",
  },
  {
    icon: Database,
    label: "Data plane",
    value: "Your Postgres",
    body: "SQLite for dev, Postgres in prod. Same entities, same migrations, your backup story.",
  },
  {
    icon: Sparkles,
    label: "Models",
    value: "Bring your own",
    body: "Claude, GPT, OSS via Bedrock or self-hosted. We never sit in the inference path.",
  },
  {
    icon: Github,
    label: "License",
    value: "MIT, public repo",
    body: "Every line of what runs in your environment is on GitHub. Diff a release before shipping it.",
  },
];

export function EnterpriseArchitecture() {
  return (
    <section className="border-t border-zinc-100 bg-gradient-to-b from-zinc-50/60 to-white">
      <div className="mx-auto max-w-7xl px-6 py-24 sm:py-28">
        <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:gap-16">
          <div>
            <SectionEyebrow>Architecture</SectionEyebrow>
            <h2 className="mt-4 text-balance text-4xl font-semibold tracking-[-0.02em] text-zinc-950 sm:text-5xl">
              Boring infrastructure. On purpose.
            </h2>
            <p className="mt-5 max-w-md text-lg leading-relaxed text-zinc-600">
              We built Genosyn to be the kind of thing your platform team can
              say yes to without a six-month review. One container, your
              database, your keys, your CI — and a vocabulary they already
              know.
            </p>
            <a
              href="/docs/self-hosting"
              className="mt-7 inline-flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-800 shadow-card transition hover:border-zinc-300 hover:bg-zinc-50"
            >
              Read the self-hosting docs
              <ArrowRight className="h-4 w-4" />
            </a>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {PROOFS.map((p) => (
              <div
                key={p.label}
                className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-card"
              >
                <div className="flex items-center gap-2.5">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-100 text-zinc-700 ring-1 ring-zinc-200">
                    <p.icon className="h-4 w-4" />
                  </span>
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                    {p.label}
                  </span>
                </div>
                <div className="mt-4 text-lg font-semibold tracking-tight text-zinc-950">
                  {p.value}
                </div>
                <p className="mt-1.5 text-sm leading-relaxed text-zinc-600">
                  {p.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export function EnterpriseContact() {
  return (
    <section id="contact" className="border-t border-zinc-100 bg-white">
      <div className="mx-auto max-w-7xl px-6 py-20 sm:py-24">
        <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-zinc-950 via-zinc-900 to-zinc-950 px-8 py-14 text-center sm:px-12 sm:py-20">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.18),transparent_65%)]"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.05)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.05)_1px,transparent_1px)] bg-[size:36px_36px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]"
          />

          <div className="relative mx-auto max-w-2xl">
            <h2 className="text-balance text-4xl font-semibold tracking-[-0.02em] text-white sm:text-5xl">
              Let&apos;s scope your deployment.
            </h2>
            <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-zinc-300">
              Tell us where you want to run Genosyn, what compliance posture
              you need to meet, and how many AI employees you expect to staff.
              We&apos;ll come back with a deployment plan and a price.
            </p>

            <div className="mx-auto mt-8 inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 font-mono text-[13px] text-zinc-200 shadow-card">
              <Mail className="h-4 w-4 text-zinc-300" />
              {CONTACT_EMAIL}
            </div>

            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <a
                href={CONTACT_HREF}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-white px-6 py-3 text-sm font-semibold text-zinc-950 shadow-lift transition hover:bg-zinc-100 sm:w-auto"
              >
                <Mail className="h-4 w-4" />
                Email us
              </a>
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-white/15 px-6 py-3 text-sm font-semibold text-white transition hover:bg-white/5 sm:w-auto"
              >
                <Github className="h-4 w-4" />
                Try it open source first
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function Enterprise(): ReactNode {
  return (
    <>
      <EnterpriseHero />
      <EnterpriseReasons />
      <EnterpriseDeployments />
      <EnterpriseOfferings />
      <EnterpriseArchitecture />
      <EnterpriseContact />
    </>
  );
}
