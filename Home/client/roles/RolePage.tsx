import {
  ArrowRight,
  BookOpen,
  CalendarClock,
  KeyRound,
  ScrollText,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { Nav } from "@/sections/Nav";
import { Footer, InstallCta } from "@/sections/Footer";
import {
  HeroActions,
  HeroBadge,
  HeroButton,
  HeroCopy,
  HeroGrid,
  HeroLede,
  HeroSection,
  HeroTitle,
  HeroTitleMuted,
} from "@/sections/HeroKit";
import { Container, Eyebrow, Heading, Lede, Panel, Section, TextLink } from "@/sections/Kit";
import { DaySchedule, RoleRail } from "@/roles/RoleDay";
import { ROLES, type RoleDef } from "@/roles/data";
import { roleIcon } from "@/roles/roleIcons";
import { findProduct } from "@/products/data";
import { productIcon } from "@/products/productIcons";
import { Link } from "@/lib/router";

/**
 * One role, in full.
 *
 * The page is ordered the way somebody evaluates a hire: what is this, what
 * does it do all day, what can it actually do, what would I have to set up,
 * where does the work land, and what am I still worried about. The day is the
 * largest thing on the page because it is the only part that is hard to fake.
 */
export function RolePage({ role }: { role: RoleDef }) {
  const Icon = roleIcon(role.icon);

  return (
    <div className="min-h-screen bg-paper-100 text-zinc-800">
      <Nav />
      <main>
        <HeroSection>
          <HeroGrid>
            <HeroCopy>
              <HeroBadge
                href="/roles"
                leading={
                  <span
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md ring-1 ring-inset ${role.accent}`}
                  >
                    <Icon aria-hidden className="h-3 w-3" />
                  </span>
                }
              >
                {role.discipline}
              </HeroBadge>
              <HeroTitle>
                {role.headline} <HeroTitleMuted>{role.headlineMuted}</HeroTitleMuted>
              </HeroTitle>
              <HeroLede>{role.intro}</HeroLede>

              <HeroActions>
                <HeroButton href="/#quickstart">
                  Install Genosyn
                  <ArrowRight aria-hidden className="h-4 w-4" />
                </HeroButton>
                <HeroButton href="/docs/employees" variant="secondary">
                  <BookOpen aria-hidden className="h-4 w-4" />
                  How employees are built
                </HeroButton>
              </HeroActions>

              <div className="mt-10 rounded-2xl border border-zinc-200 bg-white/70 p-5 backdrop-blur">
                <div className="text-[11px] font-semibold uppercase tracking-label text-zinc-500">
                  What you stop doing
                </div>
                <p className="mt-2.5 text-[15px] leading-6 text-zinc-700">{role.reclaims}</p>
              </div>
            </HeroCopy>

            <EmployeeCard role={role} />
          </HeroGrid>
        </HeroSection>

        <Section id="day" tone="tint">
          <Container wide>
            <div className="grid gap-10 lg:grid-cols-[1fr_0.8fr] lg:items-end">
              <div>
                <Eyebrow>The working day</Eyebrow>
                <Heading className="mt-5 max-w-2xl">
                  {`What ${role.person} does between waking the servers and going quiet.`}
                </Heading>
              </div>
              <Lede className="max-w-xl lg:pb-1">
                Every hour below is one Routine you can open, read, and change — including the one
                where it stopped and asked a human.
              </Lede>
            </div>

            <div className="mt-12 grid gap-4 xl:grid-cols-[1.35fr_0.65fr]">
              <DaySchedule role={role} />
              <RoleRail role={role} identity={false} />
            </div>
          </Container>
        </Section>

        <Section>
          <Container wide>
            <div className="mx-auto max-w-3xl text-center">
              <div className="flex justify-center">
                <Eyebrow>{`What ${role.noun} can do`}</Eyebrow>
              </div>
              <Heading className="mt-5">Capable in the ways that matter, bounded in the ways that count.</Heading>
            </div>
            <div className="mt-14 grid gap-4 sm:grid-cols-2">
              {role.capabilities.map((capability) => {
                const CapIcon = productIcon(capability.icon);
                return (
                  <Panel key={capability.title} className="p-7">
                    <span
                      className={`flex h-11 w-11 items-center justify-center rounded-xl ring-1 ring-inset ${role.accent}`}
                    >
                      <CapIcon aria-hidden className="h-5 w-5" />
                    </span>
                    <h3 className="mt-5 text-lg font-semibold tracking-[-0.015em] text-zinc-950">
                      {capability.title}
                    </h3>
                    <p className="mt-2.5 text-[14px] leading-6 text-zinc-600">{capability.body}</p>
                  </Panel>
                );
              })}
            </div>
          </Container>
        </Section>

        <Setup role={role} />

        <Section>
          <Container wide>
            <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:items-center lg:gap-16">
              <div>
                <Eyebrow>Where the work lands</Eyebrow>
                <Heading className="mt-5 max-w-lg">
                  It works your records, not a copy of them.
                </Heading>
                <Lede className="mt-6 max-w-lg">
                  {`Everything ${role.person} does happens inside the products your team already
                  uses — the same rows, the same threads, the same queues. There is no export step
                  and no second system of record.`}
                </Lede>
                <TextLink href="/products" className="mt-8">
                  See every product
                  <ArrowRight aria-hidden className="h-4 w-4 transition group-hover:translate-x-0.5" />
                </TextLink>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {role.products.map((slug) => {
                  const product = findProduct(slug);
                  if (!product) return null;
                  const ProductIcon = productIcon(product.icon);
                  return (
                    <Link
                      key={slug}
                      href={`/products/${slug}`}
                      className="group flex items-start gap-3.5 rounded-2xl border border-zinc-200 bg-white p-5 shadow-card transition hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-lift"
                    >
                      <span
                        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ${product.accent}`}
                      >
                        <ProductIcon aria-hidden className="h-4 w-4" />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-zinc-950">
                          {product.name}
                        </span>
                        <span className="mt-1 block line-clamp-2 text-[12px] leading-5 text-zinc-500">
                          {product.summary}
                        </span>
                      </span>
                    </Link>
                  );
                })}
              </div>
            </div>
          </Container>
        </Section>

        <Section tone="tint">
          <Container>
            <div className="grid gap-10 lg:grid-cols-[0.7fr_1.3fr] lg:gap-16">
              <div>
                <Eyebrow>Questions</Eyebrow>
                <Heading className="mt-5">The ones people actually ask.</Heading>
              </div>
              <dl className="divide-y divide-zinc-200 border-y border-zinc-200">
                {role.faqs.map((faq) => (
                  <div key={faq.q} className="py-7">
                    <dt className="text-lg font-semibold tracking-[-0.015em] text-zinc-950">
                      {faq.q}
                    </dt>
                    <dd className="mt-3 text-[15px] leading-7 text-zinc-600">{faq.a}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </Container>
        </Section>

        <OtherRoles current={role.slug} />
        <InstallCta />
      </main>
      <Footer />
    </div>
  );
}

/**
 * The hero's right column: the employee as it appears on the roster — a Soul,
 * a model, a Routine list, and the next thing it will do without being asked.
 */
function EmployeeCard({ role }: { role: RoleDef }) {
  const Icon = roleIcon(role.icon);
  const initials = role.person.slice(0, 2).toUpperCase();
  return (
    <div className="relative">
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-10 -z-10 rounded-[3rem] bg-[radial-gradient(60%_55%_at_50%_40%,rgba(9,9,11,0.10),transparent_72%)] blur-2xl"
      />
      <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-raise">
        <div className="flex items-center gap-3 border-b border-zinc-200 px-6 py-5">
          <span
            className={`flex h-11 w-11 items-center justify-center rounded-xl text-[13px] font-bold ring-1 ring-inset ${role.accent}`}
          >
            {initials}
          </span>
          <div className="min-w-0">
            <div className="text-[15px] font-semibold tracking-[-0.01em] text-zinc-950">
              {role.person}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] font-medium text-zinc-500">
              <Icon aria-hidden className="h-3 w-3" />
              {role.name}
            </div>
          </div>
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-emerald-500/25 bg-emerald-50 px-2.5 py-1 text-[10px] font-semibold text-emerald-700">
            <span aria-hidden className="preview-live h-1.5 w-1.5 rounded-full bg-emerald-500" />
            On duty
          </span>
        </div>

        <div className="grid gap-px bg-zinc-200 sm:grid-cols-2">
          <div className="bg-white px-6 py-5">
            <div className="text-[10px] font-semibold uppercase tracking-label text-zinc-500">
              Routines
            </div>
            <ul className="mt-3 space-y-2.5">
              {role.routines.map((routine) => (
                <li key={routine.name} className="flex items-start gap-2.5">
                  <span aria-hidden className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${role.dot}`} />
                  <span className="min-w-0">
                    <span className="block text-[12px] font-medium leading-4 text-zinc-800">
                      {routine.name}
                    </span>
                    <span className="mt-0.5 block font-mono text-[10px] text-zinc-500">
                      {routine.when}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="bg-white px-6 py-5">
            <div className="text-[10px] font-semibold uppercase tracking-label text-zinc-500">
              Skills
            </div>
            <ul className="mt-3 flex flex-wrap gap-1.5">
              {role.skills.map((skill) => (
                <li
                  key={skill}
                  className="rounded-md bg-zinc-100 px-2 py-1 font-mono text-[10px] text-zinc-600"
                >
                  {skill}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="border-t border-zinc-200 bg-paper-100 px-6 py-4">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-zinc-500">
            <span aria-hidden className="preview-live h-1.5 w-1.5 rounded-full bg-emerald-500" />
            <span className="font-medium text-zinc-700">Next Run</span>
            <span className="font-mono">{role.routines[0]?.when}</span>
            <span aria-hidden className="hidden h-3 w-px bg-zinc-300 sm:block" />
            <span className="hidden sm:inline">no one has to start it</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** What a human sets up once: the Soul, the Skills, the Routines, the Grants. */
function Setup({ role }: { role: RoleDef }) {
  return (
    <Section tone="night" divide={false}>
      <div aria-hidden className="pointer-events-none absolute inset-0 aurora-night" />
      <div aria-hidden className="pointer-events-none absolute inset-0 night-grid" />
      <Container wide>
        <div className="grid gap-10 lg:grid-cols-[1fr_0.85fr] lg:items-end">
          <div>
            <Eyebrow night>Setting it up</Eyebrow>
            <Heading night className="mt-5 max-w-2xl">
              Four documents, and then you stop being the trigger.
            </Heading>
          </div>
          <Lede night className="max-w-xl lg:pb-1">
            {`Everything that makes this ${role.noun} rather than any other role is plain, editable
            text. Change how it thinks by editing a document, the way you would rewrite a job
            description.`}
          </Lede>
        </div>

        <div className="mt-14 grid gap-px overflow-hidden rounded-2xl border border-white/[0.10] bg-white/[0.10] md:grid-cols-2 xl:grid-cols-4">
          <SetupCard
            icon={ScrollText}
            label="Soul"
            title="How it judges"
            lines={[`Voice, priorities, and the lines ${role.person} will not cross alone.`]}
          />
          <SetupCard icon={Sparkles} label="Skills" title="What it repeats" lines={role.skills} mono />
          <SetupCard
            icon={CalendarClock}
            label="Routines"
            title="When it works"
            lines={role.routines.map((routine) => `${routine.name} — ${routine.when}`)}
          />
          <SetupCard icon={KeyRound} label="Grants" title="What it can reach" lines={role.grants} />
        </div>

        <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
          <TextLink href="/docs/employees" night>
            Read how an employee is assembled
            <ArrowRight aria-hidden className="h-4 w-4 transition group-hover:translate-x-0.5" />
          </TextLink>
          <TextLink href="/docs/routines" night>
            Read how Routines and Runs work
            <ArrowRight aria-hidden className="h-4 w-4 transition group-hover:translate-x-0.5" />
          </TextLink>
        </div>
      </Container>
    </Section>
  );
}

function SetupCard({
  icon: SetupIcon,
  label,
  title,
  lines,
  mono = false,
}: {
  icon: LucideIcon;
  label: string;
  title: string;
  lines: string[];
  mono?: boolean;
}) {
  return (
    <div className="bg-night-950 p-6">
      <div className="flex items-center justify-between">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/[0.08] text-white ring-1 ring-inset ring-white/15">
          <SetupIcon aria-hidden className="h-4 w-4" />
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-label text-zinc-400">
          {label}
        </span>
      </div>
      <h3 className="mt-6 text-base font-semibold text-white">{title}</h3>
      <ul className="mt-4 space-y-2">
        {lines.map((line) => (
          <li
            key={line}
            className={`flex items-start gap-2.5 leading-5 text-zinc-400 ${
              mono ? "font-mono text-[11px]" : "text-[12px]"
            }`}
          >
            <span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-zinc-600" />
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The rest of the roster, so a reader who is on the wrong page can leave. */
function OtherRoles({ current }: { current: string }) {
  const others = ROLES.filter((role) => role.slug !== current);
  return (
    <Section tone="tint">
      <Container wide>
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <Eyebrow>The rest of the roster</Eyebrow>
            <Heading className="mt-5 max-w-xl">Every other role, working the same way.</Heading>
          </div>
          <TextLink href="/roles">
            See all roles
            <ArrowRight aria-hidden className="h-4 w-4 transition group-hover:translate-x-0.5" />
          </TextLink>
        </div>

        <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {others.map((role) => {
            const OtherIcon = roleIcon(role.icon);
            return (
              <Link
                key={role.slug}
                href={`/roles/${role.slug}`}
                className="group flex items-center gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-3.5 shadow-card transition hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-lift"
              >
                <span
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ${role.accent}`}
                >
                  <OtherIcon aria-hidden className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-900">
                  {role.name}
                </span>
                <ArrowRight
                  aria-hidden
                  className="h-4 w-4 shrink-0 text-zinc-300 transition group-hover:translate-x-0.5 group-hover:text-zinc-900"
                />
              </Link>
            );
          })}
        </div>
      </Container>
    </Section>
  );
}
