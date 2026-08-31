import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { ROLES } from "@/roles/data";
import { DaySchedule, RoleRail } from "@/roles/RoleDay";
import { roleIcon } from "@/roles/roleIcons";
import { Container, Eyebrow, Heading, Lede, Section } from "@/sections/Kit";
import { Link } from "@/lib/router";

/**
 * The day-in-the-life section, and the centre of the whole landing page.
 *
 * "Runs your company autonomously" is an abstraction, and abstractions do not
 * convince anyone. A schedule does: pick a role, read what it does at 06:40
 * and at 11:00 and at 17:45, and see the one moment in the day it stopped and
 * asked you something. That last part is not a caveat bolted onto the pitch —
 * it is the pitch, so the escalated moment is drawn in the same list as the
 * work rather than in a footnote underneath it.
 *
 * The tab strip is `aria-pressed` buttons rather than a `tablist`, because a
 * real tablist owes the reader arrow-key navigation and a roving tabindex,
 * and a row of eight toggle buttons is honest about what it is.
 */
export function Roles() {
  const [active, setActive] = useState(ROLES[0].slug);
  const role = ROLES.find((item) => item.slug === active) ?? ROLES[0];

  return (
    <Section id="roles" tone="tint">
      <Container wide>
        <div className="grid gap-10 lg:grid-cols-[1fr_0.85fr] lg:items-end">
          <div>
            <Eyebrow>A day on the roster</Eyebrow>
            {/* The heading is the reader's own question, asked back with the
                role they just picked in it — which is the whole reason the
                switcher is above the fold rather than buried in the panel. */}
            <Heading className="mt-5 max-w-2xl">
              {`So what would ${role.noun} actually do for you all day?`}
            </Heading>
          </div>
          <Lede className="max-w-xl lg:pb-1">
            Pick a role and read its Tuesday, hour by hour — the work it starts on its own, the
            products it works in, and the single moment it stopped and asked a human.
          </Lede>
        </div>

        <RoleTabs active={active} onSelect={setActive} />

        <div className="mt-8 grid gap-4 xl:grid-cols-[1.35fr_0.65fr]">
          <DaySchedule role={role} />
          <RoleRail role={role} />
        </div>
      </Container>
    </Section>
  );
}

function RoleTabs({
  active,
  onSelect,
}: {
  active: string;
  onSelect: (slug: string) => void;
}) {
  return (
    <div className="scrollbar-none -mx-5 mt-12 overflow-x-auto px-5 sm:-mx-8 sm:px-8">
      <div className="flex min-w-max gap-2">
        {ROLES.map((role) => {
          const Icon = roleIcon(role.icon);
          const selected = role.slug === active;
          return (
            <button
              key={role.slug}
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(role.slug)}
              className={`inline-flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm font-semibold transition ${
                selected
                  ? "border-zinc-900 bg-zinc-950 text-white shadow-card"
                  : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:text-zinc-900"
              }`}
            >
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-md ring-1 ring-inset ${role.accent}`}
              >
                <Icon aria-hidden className="h-3.5 w-3.5" />
              </span>
              {role.short}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The roster grid — every role at a glance, under the day.
 *
 * It sits on the white band below so the coloured tiles have somewhere quiet
 * to be loud, and it is the entry point to the role pages.
 */
export function Roster() {
  return (
    <Section id="roster">
      <Container wide>
        <div className="mx-auto max-w-3xl text-center">
          <div className="flex justify-center">
            <Eyebrow>The roster</Eyebrow>
          </div>
          <Heading className="mt-5">Hire the role. Not the headcount.</Heading>
          <Lede className="mx-auto mt-6">
            Every one of these is the same thing underneath — a Soul, a set of Skills, and Routines
            on a schedule. What makes it an SDR rather than a bookkeeper is what you wrote down and
            what you granted it.
          </Lede>
        </div>

        <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {ROLES.map((role) => {
            const Icon = roleIcon(role.icon);
            return (
              <Link
                key={role.slug}
                href={`/roles/${role.slug}`}
                className="group flex min-h-[15rem] flex-col rounded-2xl border border-zinc-200 bg-white p-6 shadow-card transition duration-200 hover:-translate-y-1 hover:border-zinc-300 hover:shadow-lift"
              >
                <div className="flex items-start justify-between">
                  <span
                    className={`flex h-10 w-10 items-center justify-center rounded-xl ring-1 ring-inset ${role.accent}`}
                  >
                    <Icon aria-hidden className="h-5 w-5" />
                  </span>
                  <ArrowRight
                    aria-hidden
                    className="h-4 w-4 text-zinc-300 transition group-hover:translate-x-0.5 group-hover:text-zinc-900"
                  />
                </div>
                <h3 className="mt-6 text-base font-semibold tracking-[-0.01em] text-zinc-950">
                  {role.name}
                </h3>
                <p className="mt-2 flex-1 text-[13px] leading-5 text-zinc-600">{role.summary}</p>
                <span className="mt-5 font-mono text-[10px] text-zinc-500">
                  {role.routines.length} Routines · {role.skills.length} Skills
                </span>
              </Link>
            );
          })}
        </div>

        <p className="mx-auto mt-10 max-w-2xl text-center text-sm leading-6 text-zinc-500">
          None of these is a fixed template you are stuck with. A role is a document you edit — so
          the next one on your roster can be a job title that only exists at your company.
        </p>
      </Container>
    </Section>
  );
}
