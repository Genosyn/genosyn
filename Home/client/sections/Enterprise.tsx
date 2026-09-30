import type { ReactNode } from "react";
import { Check, Minus } from "lucide-react";
import { useReveal } from "@/components/Reveal";
import { GITHUB_URL } from "@/lib/constants";
import {
  Button,
  Container,
  Em,
  NightPanel,
  Section,
  SectionHead,
  StateTag,
  TextLink,
} from "@/sections/Kit";
import { PageHero } from "@/sections/PageHero";

const CONTACT_EMAIL = "enterprise@genosyn.com";
const CONTACT_SUBJECT = "Genosyn in our environment";
const CONTACT_BODY = [
  "Hi Genosyn team,",
  "",
  "We are looking at running Genosyn inside our own environment.",
  "",
  "- Company:",
  "- Where it would run (one Docker host, Kubernetes, shared Postgres):",
  "- Roughly how many AI Employees:",
  "- Identity provider, and any compliance requirements:",
  "- Anything else worth knowing:",
  "",
  "Thanks,",
].join("\n");
const CONTACT_HREF = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(CONTACT_SUBJECT)}&body=${encodeURIComponent(CONTACT_BODY)}`;

const EDITIONS: { label: string; community: ReactNode; enterprise: ReactNode }[] = [
  { label: "AI Employees", community: "Unlimited", enterprise: "Unlimited" },
  { label: "Routines", community: "Unlimited", enterprise: "Unlimited" },
  { label: "Every product and Integration", community: <Yes />, enterprise: <Yes /> },
  { label: "Single sign-on", community: <No />, enterprise: "Google or OIDC" },
  { label: "Audit log", community: "Recorded", enterprise: "Readable" },
  { label: "Support", community: "GitHub issues", enterprise: "Priority" },
];

const LICENCE: [string, ReactNode][] = [
  ["Key", <>One string beginning <Code>genlic1.</Code>, signed with Ed25519 and checked against public keys compiled into the software.</>],
  ["Network", <>No activation server and no phone-home. An air-gapped install validates the same key the open internet does.</>],
  ["Activation", <>A master admin pastes it at <Code>Admin / License</Code>. No restart, no rebuild.</>],
  ["Expiry", <>A paid key expires soft: features stay on past the date and a renewal warning appears. An evaluation key expires hard.</>],
  ["Seats", <>Informational. Genosyn shows the count beside the number in use and never blocks a hire over it.</>],
  ["Removal", <>Removing the key returns the install to Community. SSO and the audit log switch off; nothing is deleted.</>],
];

const DATA: [string, ReactNode][] = [
  ["Souls, Skills, Routines, Run logs", <>Database rows on <Code>sqlite</Code> or <Code>postgres</Code>. Both drivers carry every entity and every migration.</>],
  ["Model keys, Connection credentials, SSO secret", <>Encrypted at rest with <Code>AES-256-GCM</Code>, never returned to the browser once saved.</>],
  ["Git checkouts, attachments, browser state", <>Files under <Code>/app/data</Code>, which the installer maps to the volume <Code>genosyn-data</Code>.</>],
  ["Instance secrets", <><Code>data/.instance-secrets.json</Code> at mode <Code>0600</Code>, with a key ID in the database so a missing file stops startup instead of being replaced quietly.</>],
];

const TOPOLOGIES: { name: string; command: string; body: ReactNode }[] = [
  {
    name: "One Docker host",
    command: "curl -fsSL https://genosyn.com/install.sh | bash",
    body: (
      <>
        One replica, SQLite in the data volume, and the container on <Code>8471</Code> behind the
        reverse proxy you already run. Coding tools run inside the App container by default;
        bubblewrap isolation is available when you want it.
      </>
    ),
  },
  {
    name: "Kubernetes",
    command: "helm install genosyn oci://ghcr.io/genosyn/charts/genosyn",
    body: (
      <>
        The official Helm chart: a <Code>20Gi</Code> volume at <Code>/app/data</Code>, external
        Postgres when you want it, and your own Ingress. The pod turns Ready only after every
        migration has run.
      </>
    ),
  },
  {
    name: "Shared, on Postgres",
    command: 'db: { driver: "postgres" }',
    body: (
      <>
        Several replicas coordinate through Postgres leases and cross-replica realtime fan-out,
        with a <Code>ReadWriteMany</Code> volume. API-key and custom models scale with the rest.
      </>
    ),
  },
];

const SUPPORT: [string, string][] = [
  ["Deployment", "The topology, database driver, volume sizing, ingress and upgrade path — read against the environment you already run."],
  ["Security review", "A data-flow map for your controls: what is a row, what is encrypted at rest, what an employee token can write, and what the licence verifies offline."],
  ["Identity", "SSO client registration, the callback URL from your public URL, and whether first sign-in creates accounts. Password login keeps working, so SSO cannot lock an operator out."],
  ["Operations", "A restore rehearsal from data/Backup/, the per-driver migration stream, and your first upgrade, watched with you."],
];

export function Enterprise(): ReactNode {
  return (
    <>
      <PageHero
        kicker="Enterprise"
        title={
          <>
            Your perimeter. <Em>Your identity provider.</Em>
          </>
        }
        lede="Self-hosted Genosyn is the whole product under Apache 2.0. An Enterprise licence adds single sign-on, the readable audit log and priority support — and changes nothing else about the software you already run."
        actions={
          <>
            <Button href={CONTACT_HREF} variant="ink" arrow>
              Talk to us
            </Button>
            <Button href="/pricing" variant="outline">
              Compare plans
            </Button>
          </>
        }
        aside={<Editions />}
      />
      <Licence />
      <Architecture />
      <Deployment />
      <Support />
      <Contact />
    </>
  );
}

function Editions() {
  return (
    <div className="overflow-hidden rounded-3xl border border-line bg-paper-raised shadow-soft">
      <div className="grid grid-cols-[minmax(0,1fr)_6.5rem_6.5rem] items-end gap-x-3 border-b border-line px-6 py-4 sm:grid-cols-[minmax(0,1fr)_8rem_8rem]">
        <span className="kicker text-ink-400">Edition</span>
        <span className="text-[14px] font-medium text-ink-600">Community</span>
        <span className="text-[14px] font-medium text-ink">Enterprise</span>
      </div>
      <dl>
        {EDITIONS.map((row) => (
          <div
            key={row.label}
            className="grid grid-cols-[minmax(0,1fr)_6.5rem_6.5rem] items-center gap-x-3 border-b border-line px-6 py-3.5 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_8rem_8rem]"
          >
            <dt className="text-[14px] text-ink">{row.label}</dt>
            <dd className="text-[13.5px] text-ink-500">{row.community}</dd>
            <dd className="text-[13.5px] font-medium text-ink">{row.enterprise}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Licence() {
  const grid = useReveal<HTMLDListElement>(0, 60);
  return (
    <Section id="licence" tone="raised" space="md" rule>
      <Container>
        <SectionHead
          kicker="The licence"
          title={
            <>
              One signed key. <Em>No phone-home.</Em>
            </>
          }
          lede="The licence turns on two features and verifies without a network, so the same key works on an air-gapped cluster and on the open internet."
          aside={<TextLink href="/docs/enterprise-license">Licence reference</TextLink>}
        />
        <dl ref={grid} className="mt-14 grid gap-px overflow-hidden rounded-3xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
          {LICENCE.map(([term, definition]) => (
            <div key={term} className="bg-paper-raised p-7">
              <dt className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-400">{term}</dt>
              <dd className="mt-4 text-[15px] leading-[1.65] text-ink-700">{definition}</dd>
            </div>
          ))}
        </dl>
      </Container>
    </Section>
  );
}

function Architecture() {
  const rows = useReveal<HTMLDListElement>(0, 60);
  return (
    <Section id="architecture" space="md">
      <Container>
        <SectionHead
          kicker="Architecture"
          title={
            <>
              One container. <Em>Everything inside your boundary.</Em>
            </>
          }
          lede="Everything that must survive a restart is a database row or a file under /app/data. Model calls go only to the endpoints you registered; Connections reach only the accounts you authorised."
        />
        <div className="mt-14 grid gap-10 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:gap-14">
          <Boundary />
          <dl ref={rows} className="divide-y divide-line border-y border-line">
            {DATA.map(([artefact, place]) => (
              <div key={artefact} className="grid gap-2 py-6 sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-6">
                <dt className="text-[15px] font-medium text-ink">{artefact}</dt>
                <dd className="text-[14.5px] leading-6 text-ink-600">{place}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="mt-20 overflow-hidden rounded-3xl border border-line bg-paper-raised">
          <div className="border-b border-line px-7 py-5">
            <p className="font-display text-[1.6rem] leading-tight tracking-[-0.015em] text-ink">What stops an AI Employee</p>
          </div>
          <div className="grid divide-y divide-line lg:grid-cols-3 lg:divide-x lg:divide-y-0">
            <Instrument tag={<StateTag state="approval">Approval</StateTag>}>
              The system interposing on an action the employee already attempted — a gated Routine, a
              browser submit, a spend increase, an exact email. An admin ticks it and the server
              replays that exact action. The payload is redacted at every boundary.
            </Instrument>
            <Instrument tag={<StateTag state="decision">Decision</StateTag>}>
              The employee choosing to stop and ask. It writes the question and the options, any
              Member can answer, and answering performs no side effect. Anything privileged
              afterwards still meets its own Approval.
            </Instrument>
            <Instrument tag={<StateTag state="standdown">Standdown</StateTag>}>
              A revocable stop on all AI work for a company, an employee or a Routine, placed by an
              owner or admin. Runs in flight are stopped and queued work waits for the lift. No tool
              lets the roster place one — or lift one.
            </Instrument>
          </div>
        </div>
        <div className="mt-8 flex flex-wrap gap-x-8 gap-y-3">
          <TextLink href="/docs/security">Security</TextLink>
          <TextLink href="/docs/standdowns">Standdowns</TextLink>
          <TextLink href="/docs/autonomy">Autonomy and Waivers</TextLink>
        </div>
      </Container>
    </Section>
  );
}

function Instrument({ tag, children }: { tag: ReactNode; children: ReactNode }) {
  return (
    <div className="p-7">
      {tag}
      <p className="mt-5 text-[14.5px] leading-6 text-ink-600">{children}</p>
    </div>
  );
}

/** Your network, drawn: the App, what it talks to, and the issuer outside it. */
function Boundary() {
  return (
    <figure className="relative isolate">
      <div aria-hidden className="dot-paper absolute -inset-3 -z-10 rounded-[2rem] sm:-inset-5" />
      <div aria-hidden className="rounded-3xl border border-dashed border-ink-300 bg-paper-raised/80 p-4 sm:p-5">
        <p className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-400">
          Your network · your identity · your backups
        </p>
        <div className="mt-4 rounded-2xl bg-ink p-5 text-white shadow-lifted">
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-[15px] font-medium">Genosyn App</span>
            <span className="font-mono text-[12px] text-white/60">:8471</span>
          </div>
          <p className="mt-1 text-[12.5px] text-white/50">One container</p>
        </div>
        <div className="mx-auto h-5 w-px bg-ink-300" />
        <div className="grid gap-2 sm:grid-cols-3">
          {[
            ["Database", "sqlite · postgres"],
            ["AI Models", "anthropic · openai · custom"],
            ["Connections", "the ones you granted"],
          ].map(([label, value]) => (
            <div key={label} className="rounded-2xl border border-line bg-white p-4">
              <p className="text-[13.5px] font-medium text-ink">{label}</p>
              <p className="mt-1 font-mono text-[11px] leading-4 text-ink-500">{value}</p>
            </div>
          ))}
        </div>
        <div className="mx-auto h-5 w-px bg-ink-300" />
        <div className="rounded-2xl border border-line bg-white p-4">
          <p className="text-[13.5px] font-medium text-ink">Volume</p>
          <p className="mt-1 font-mono text-[11px] text-ink-500">genosyn-data → /app/data</p>
        </div>
      </div>
      <div aria-hidden className="mt-4 flex items-center justify-between gap-4 rounded-2xl border border-line bg-paper px-4 py-3">
        <span className="text-[13.5px] text-ink-600">genosyn.com · licence issuer</span>
        <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-400">No connection</span>
      </div>
      <figcaption className="sr-only">
        A diagram: your network holds the Genosyn App on port 8471, its database, the AI Models you
        registered, the Connections you granted, and the data volume. The licence issuer sits
        outside with no connection to it.
      </figcaption>
    </figure>
  );
}

function Deployment() {
  const cards = useReveal<HTMLUListElement>(0, 70);
  return (
    <Section id="deployment" tone="raised" space="md" rule>
      <Container>
        <SectionHead
          kicker="Deployment"
          title={
            <>
              Three supported shapes, <Em>starting at one Docker host.</Em>
            </>
          }
          lede="Pick the one that matches what your team already operates. The database driver and how you authenticate models decide the rest."
          aside={
            <div className="flex flex-wrap gap-x-8 gap-y-3">
              <TextLink href="/docs/self-hosting">Configuration</TextLink>
              <TextLink href="/docs/kubernetes">Kubernetes</TextLink>
            </div>
          }
        />
        <ul ref={cards} className="mt-14 grid gap-4 lg:grid-cols-3">
          {TOPOLOGIES.map((topology, index) => (
            <li key={topology.name} className="flex flex-col rounded-3xl border border-line bg-paper p-7">
              <span className="font-mono text-[12px] text-ink-400">{`0${index + 1}`}</span>
              <p className="mt-6 font-display text-[1.7rem] leading-tight tracking-[-0.015em] text-ink">{topology.name}</p>
              <div className="mt-5 rounded-xl bg-ink px-4 py-3">
                <code className="block break-all font-mono text-[12px] leading-5 text-white">{topology.command}</code>
              </div>
              <p className="mt-5 text-[14.5px] leading-6 text-ink-600">{topology.body}</p>
            </li>
          ))}
        </ul>
      </Container>
    </Section>
  );
}

function Support() {
  const rows = useReveal<HTMLUListElement>(0, 60);
  return (
    <Section id="support" space="md">
      <Container>
        <div className="grid gap-12 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-20">
          <SectionHead
            align="left"
            size="md"
            kicker="Support"
            title={
              <>
                A direct line <Em>to the people who wrote it.</Em>
              </>
            }
            lede="Community support is GitHub issues, and it stays free. A licence adds priority support and four pieces of work you would otherwise do alone."
          />
          <ul ref={rows} className="divide-y divide-line border-y border-line">
            {SUPPORT.map(([area, body]) => (
              <li key={area} className="grid gap-2 py-6 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-6">
                <p className="text-[15px] font-medium text-ink">{area}</p>
                <p className="text-[14.5px] leading-6 text-ink-600">{body}</p>
              </li>
            ))}
          </ul>
        </div>
      </Container>
    </Section>
  );
}

function Contact() {
  return (
    <div className="pb-2 pt-6">
      <NightPanel id="contact" dawn={0.9}>
        <div className="mx-auto grid max-w-site gap-12 px-5 py-20 sm:px-8 sm:py-24 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:items-center lg:px-12">
          <div>
            <p className="kicker inline-flex items-center gap-3 text-night-muted">
              <span aria-hidden className="h-px w-6 bg-white/50" />
              Contact
            </p>
            <h2 className="mt-6 max-w-[16ch] text-balance font-display text-display-lg text-white">
              Tell us where it would run. <Em tone="night">We&apos;ll tell you how.</Em>
            </h2>
            <p className="mt-6 max-w-[48ch] text-[1.0625rem] leading-[1.6] text-night-muted">
              Four lines are enough for a useful answer: a topology, the questions a security review
              usually asks, and a price if you want one.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Button href={CONTACT_HREF} variant="paper" size="lg" arrow>
                {`Email ${CONTACT_EMAIL}`}
              </Button>
              <Button href={GITHUB_URL} external variant="outline-night" size="lg">
                Read the source first
              </Button>
            </div>
          </div>
          <ul className="divide-y divide-white/10 rounded-3xl border border-white/10 bg-white/[0.03]">
            {[
              ["Environment", "One Docker host, a Kubernetes cluster, or a shared Postgres estate."],
              ["Identity", "Google, an OIDC provider, or email and password for now."],
              ["Data", "Where the volume lives, who backs it up, and your retention window."],
              ["Scope", "Which roles the AI Employees would hold, and what a Run would touch."],
            ].map(([term, prompt]) => (
              <li key={term} className="grid gap-1 px-6 py-5 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-4">
                <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-white/50">{term}</span>
                <span className="text-[14.5px] leading-6 text-white/85">{prompt}</span>
              </li>
            ))}
          </ul>
        </div>
      </NightPanel>
    </div>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded-md bg-ink/[0.06] px-1.5 py-0.5 font-mono text-[0.86em] text-ink">{children}</code>;
}

function Yes() {
  return (
    <>
      <Check aria-hidden className="h-4 w-4 text-ink" strokeWidth={2} />
      <span className="sr-only">Included</span>
    </>
  );
}

function No() {
  return (
    <>
      <Minus aria-hidden className="h-4 w-4 text-ink-300" />
      <span className="sr-only">Not included</span>
    </>
  );
}
