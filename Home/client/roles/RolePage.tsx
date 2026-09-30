import type { ReactNode } from "react";
import { ArrowUpRight, FileText } from "lucide-react";
import { Reveal, useReveal } from "@/components/Reveal";
import { INSTALL_DOCS_PATH } from "@/lib/constants";
import { iconFor } from "@/lib/icons";
import { Link } from "@/lib/router";
import { findProduct } from "@/products/data";
import { PRODUCT_HOLDS, PRODUCT_ICON } from "@/products/meta";
import { ROLES, type RoleDef } from "@/roles/data";
import { roleDept, roleHours, roleInitials, roleStop, STOP_WORD } from "@/roles/meta";
import { DayReport, DayStrip, DayTimeline } from "@/roles/RoleDay";
import { FaqSection } from "@/sections/Faq";
import { ClosingCta, Footer } from "@/sections/Footer";
import {
  Avatar,
  Button,
  Container,
  DeptLabel,
  GridFill,
  Section,
  SectionHead,
  StateTag,
  TextLink,
} from "@/sections/Kit";
import { Nav } from "@/sections/Nav";

export function RolePage({ role }: { role: RoleDef }) {
  return (
    <div className="min-h-screen overflow-x-clip bg-paper text-ink">
      <Nav />
      <main>
        <Hero role={role} />
        <Day role={role} />
        <Capabilities role={role} />
        <Setup role={role} />
        <Products role={role} />
        <FaqSection
          title={
            <>
              {`Questions about the ${role.name}`}
            </>
          }
          items={role.faqs}
          footer={<TextLink href="/docs/employees">How AI Employees work</TextLink>}
        />
        <OtherRoles current={role.slug} />
        <ClosingCta />
      </main>
      <Footer />
    </div>
  );
}

function Hero({ role }: { role: RoleDef }) {
  const stop = roleStop(role);
  return (
    <section className="relative pb-20 pt-10 sm:pb-24 sm:pt-14 lg:pt-16">
      <Container>
        <Reveal>
          <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-[13.5px] text-ink-500">
            <Link href="/roles" className="transition-colors hover:text-ink">
              Roles
            </Link>
            <span aria-hidden className="text-ink-300">
              /
            </span>
            <span className="text-ink">{role.name}</span>
          </nav>
        </Reveal>

        <div className="mt-10 grid gap-x-16 gap-y-12 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
          <div className="min-w-0">
            <Reveal delay={40} className="flex items-center gap-3">
              <Avatar initials={roleInitials(role)} dept={roleDept(role)} size="lg" />
              <span>
                <span className="block text-[16px] font-medium text-ink">{`${role.person}, ${role.name}`}</span>
                <DeptLabel dept={roleDept(role)} className="mt-1" />
              </span>
            </Reveal>
            <Reveal delay={90}>
              <h1 className="mt-8 max-w-[18ch] text-balance font-display text-display-lg text-ink">{role.headline}</h1>
            </Reveal>
            <Reveal delay={120}>
              <p className="mt-5 max-w-[44ch] text-balance text-[1.25rem] font-medium leading-[1.4] tracking-[-0.01em] text-ink-500 sm:text-[1.375rem]">
                {role.headlineMuted}
              </p>
            </Reveal>
            <Reveal delay={170}>
              <p className="mt-6 max-w-[60ch] text-pretty text-[1.0625rem] leading-[1.65] text-ink-600">{role.intro}</p>
            </Reveal>
            <Reveal delay={200} className="mt-9 flex flex-wrap gap-3">
              <Button href={INSTALL_DOCS_PATH} variant="ink" arrow>
                Install Genosyn
              </Button>
              <Button href="#day" variant="outline">
                {`Read ${role.person}'s day`}
              </Button>
            </Reveal>
          </div>

          <Reveal delay={160} className="min-w-0">
            <div className="overflow-hidden rounded-3xl border border-line bg-paper-raised shadow-soft">
              <div className="border-b border-line px-6 py-6">
                <p className="kicker text-ink-400">What a person does today</p>
                <p className="mt-4 text-[1.125rem] font-medium leading-[1.5] tracking-[-0.01em] text-ink-700">{`“${role.reclaims}”`}</p>
              </div>
              <dl className="divide-y divide-line">
                <Fact label="Employee">{`${role.person} · ${role.name}`}</Fact>
                <Fact label="Discipline">{role.discipline}</Fact>
                <Fact label="Hours">
                  <span className="font-mono text-[13px]">{roleHours(role)}</span>
                </Fact>
                <Fact label="Runs">{`${role.day.length} on the sample day`}</Fact>
                {stop && (
                  <Fact label="Stops">
                    <span className="inline-flex items-center gap-2">
                      <StateTag state={stop.kind}>{STOP_WORD[stop.kind]}</StateTag>
                      <span className="font-mono text-[12.5px] text-ink-500">{stop.time}</span>
                    </span>
                  </Fact>
                )}
              </dl>
            </div>
          </Reveal>
        </div>
      </Container>
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-4 px-6 py-3.5">
      <dt className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-400">{label}</dt>
      <dd className="text-[14px] text-ink">{children}</dd>
    </div>
  );
}

function Day({ role }: { role: RoleDef }) {
  const stop = roleStop(role);
  const last = role.day[role.day.length - 1].time;
  return (
    <Section id="day" tone="raised" space="md" rule>
      <Container>
        <SectionHead
          kicker={`The day · ${role.day.length} Runs · Tuesday`}
          title={
            <>
              {`${role.person} ${role.shipped} by ${last}.`}
            </>
          }
          lede={
            stop
              ? stop.kind === "decision"
                ? `Every hour below is a Routine you can open and edit. The Decision ${role.person} writes at ${stop.time} is the only moment that needs a person, and any Member can answer it.`
                : `Every hour below is a Routine you can open and edit. The Approval ${role.person} trips at ${stop.time} is the only moment that needs a person, and an admin releases it.`
              : "Every hour below is a Routine you can open and edit, and nothing in it waits on you."
          }
        />
        <div className="mt-12 overflow-hidden rounded-[1.75rem] border border-line bg-paper">
          <div className="hidden border-b border-line px-8 pb-6 pt-3 md:block">
            <DayStrip role={role} />
          </div>
          <div className="grid lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
            <div className="px-3 py-4 sm:px-6 sm:py-6">
              <DayTimeline role={role} />
            </div>
            <div className="border-t border-line px-5 py-7 sm:px-8 lg:border-l lg:border-t-0">
              <DayReport role={role} />
            </div>
          </div>
        </div>
      </Container>
    </Section>
  );
}

function Capabilities({ role }: { role: RoleDef }) {
  const grid = useReveal<HTMLUListElement>(0, 55);
  return (
    <Section id="what-it-does" space="md">
      <Container>
        <SectionHead
          kicker="What it does unattended"
          title={
            <>
              {`${role.capabilities.length} things ${role.person} takes off your plate.`}
            </>
          }
          lede="The work happens in the products your team already opens, on the same rows a Member edits. Nothing is exported and there is no second system of record."
        />
        <ul ref={grid} className="mt-14 grid gap-px overflow-hidden rounded-3xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
          {role.capabilities.map((capability) => {
            const Icon = iconFor(capability.icon);
            return (
              <li key={capability.title} className="bg-paper-raised p-7">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-paper">
                  <Icon aria-hidden className="h-[18px] w-[18px] text-ink" strokeWidth={1.7} />
                </span>
                <h3 className="mt-6 text-[16.5px] font-medium leading-6 tracking-[-0.01em] text-ink">{capability.title}</h3>
                <p className="mt-2.5 text-[14.5px] leading-6 text-ink-600">{capability.body}</p>
              </li>
            );
          })}
          <GridFill count={role.capabilities.length} />
        </ul>
      </Container>
    </Section>
  );
}

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

/** "Every weekday, 06:40" → "40 6 * * 1-5": the schedule as the server stores it. */
function cron(when: string): string {
  const [head = "", tail = ""] = when.split(",").map((part) => part.trim());
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

function Setup({ role }: { role: RoleDef }) {
  const grid = useReveal<HTMLDivElement>(0, 70);
  return (
    <Section id="setup" tone="raised" space="md" rule>
      <Container>
        <SectionHead
          kicker={`Setting it up · ${role.skills.length} Skills · ${role.routines.length} Routines · ${role.grants.length} Grants`}
          title={
            <>
              {`Four documents decide how ${role.person} works.`}
            </>
          }
          lede={`Everything that makes this ${role.noun} rather than another role is plain text. Change the Soul and the next Run reads the new version.`}
        />
        <div ref={grid} className="mt-14 grid gap-4 lg:grid-cols-2">
          <Document label="Soul" caption="Who they are">
            <div className="flex h-full flex-col px-6 py-5">
              <p className="text-[1.125rem] font-medium leading-[1.5] tracking-[-0.01em] text-ink-700">
                {`One document says how ${role.person} judges: what to work on first, and when to stop and ask rather than guess. You rewrite it the way you would rewrite a job description.`}
              </p>
              <p className="mt-auto flex items-center gap-2 pt-6 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-400">
                <FileText aria-hidden className="h-3.5 w-3.5" />
                Markdown · read fresh on every Run
              </p>
            </div>
          </Document>
          <Document label="Skills" caption="How they work">
            <ul className="divide-y divide-line">
              {role.skills.map((skill) => (
                <li key={skill} className="flex items-center gap-3 px-6 py-3">
                  <FileText aria-hidden className="h-4 w-4 shrink-0 text-ink-400" />
                  <span className="min-w-0 truncate font-mono text-[13px] text-ink">{skill}</span>
                </li>
              ))}
            </ul>
          </Document>
          <Document label="Routines" caption="When they work">
            <ul className="divide-y divide-line">
              {role.routines.map((routine) => (
                <li key={routine.name} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-6 py-3.5">
                  <span>
                    <span className="block text-[14.5px] text-ink">{routine.name}</span>
                    <span className="block text-[12.5px] text-ink-500">{routine.when}</span>
                  </span>
                  <code className="rounded-lg border border-line bg-paper px-2.5 py-1 font-mono text-[12px] text-ink">
                    {cron(routine.when)}
                  </code>
                </li>
              ))}
            </ul>
          </Document>
          <Document label="Grants" caption="What they can reach">
            <ul className="divide-y divide-line">
              {role.grants.map((grant) => (
                <li key={grant} className="px-6 py-3.5 text-[14.5px] leading-6 text-ink">
                  {grant}
                </li>
              ))}
              <li className="px-6 py-3.5 text-[13.5px] text-ink-500">Everything else stays unreachable.</li>
            </ul>
          </Document>
        </div>
        <div className="mt-10 flex flex-wrap gap-x-8 gap-y-3">
          <TextLink href="/docs/soul">Writing a Soul</TextLink>
          <TextLink href="/docs/skills">Skills</TextLink>
          <TextLink href="/docs/routines">Routines and Runs</TextLink>
        </div>
      </Container>
    </Section>
  );
}

function Document({ label, caption, children }: { label: string; caption: string; children: ReactNode }) {
  return (
    <div className="flex flex-col overflow-hidden rounded-3xl border border-line bg-paper [&>*:last-child]:flex-1">
      <div className="flex items-baseline justify-between gap-4 border-b border-line px-6 py-4">
        <p className="font-display text-[1.3rem] leading-none tracking-[-0.03em] text-ink">{label}</p>
        <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-400">{caption}</p>
      </div>
      {children}
    </div>
  );
}

function Products({ role }: { role: RoleDef }) {
  const products = role.products.flatMap((slug) => findProduct(slug) ?? []);
  const grid = useReveal<HTMLUListElement>(0, 50);
  if (products.length === 0) return null;
  return (
    <Section id="products" space="md">
      <Container>
        <SectionHead
          kicker="Where the work lands"
          title={
            <>
              {`${role.person} works in ${products.length} products, one Grant at a time.`}
            </>
          }
        />
        <ul ref={grid} className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((product) => {
            const Icon = PRODUCT_ICON[product.slug] ?? iconFor(product.icon);
            return (
              <li key={product.slug}>
                <Link
                  href={`/products/${product.slug}`}
                  className="lift group flex h-full items-start gap-4 rounded-2xl border border-line bg-paper-raised p-5 hover:border-line-strong hover:shadow-soft"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-ink text-white">
                    <Icon aria-hidden className="h-[18px] w-[18px]" strokeWidth={1.7} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-3 text-[15.5px] font-medium text-ink">
                      {product.name}
                      <ArrowUpRight aria-hidden className="nudge-up h-4 w-4 text-ink-300 group-hover:text-ink" />
                    </span>
                    <span className="mt-1 block text-[13.5px] leading-5 text-ink-500">
                      {PRODUCT_HOLDS[product.slug] ?? product.summary}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </Container>
    </Section>
  );
}

function OtherRoles({ current }: { current: string }) {
  const others = ROLES.filter((role) => role.slug !== current);
  const grid = useReveal<HTMLUListElement>(0, 40);
  return (
    <Section id="other-roles" tone="raised" space="md" rule>
      <Container>
        <SectionHead
          kicker="The rest of the roster"
          title={
            <>
              {`${others.length} more roles, each with its day written.`}
            </>
          }
          aside={<TextLink href="/roles">Compare every role</TextLink>}
        />
        <ul ref={grid} className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {others.map((role) => (
            <li key={role.slug}>
              <Link
                href={`/roles/${role.slug}`}
                className="lift group flex h-full items-center gap-3 rounded-2xl border border-line bg-paper p-4 hover:border-line-strong hover:bg-white hover:shadow-soft"
              >
                <Avatar initials={roleInitials(role)} dept={roleDept(role)} size="md" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14.5px] font-medium text-ink">{role.name}</span>
                  <span className="block truncate font-mono text-[11.5px] text-ink-500">{roleHours(role)}</span>
                </span>
                <ArrowUpRight aria-hidden className="nudge-up h-4 w-4 shrink-0 text-ink-300 group-hover:text-ink" />
              </Link>
            </li>
          ))}
        </ul>
      </Container>
    </Section>
  );
}
