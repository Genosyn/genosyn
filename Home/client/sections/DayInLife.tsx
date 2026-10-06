import { useState } from "react";
import { ROLES } from "@/roles/data";
import { roleDept, roleInitials } from "@/roles/meta";
import { DayReport, DayStrip, DayTimeline } from "@/roles/RoleDay";
import { Avatar, Container, Section, SectionHead, TextLink } from "@/sections/Kit";

/** Pick a role, read its Tuesday. */
export function DayInLife() {
  const [active, setActive] = useState(ROLES[0].slug);
  const [touched, setTouched] = useState(false);
  const role = ROLES.find((item) => item.slug === active) ?? ROLES[0];
  const last = role.day[role.day.length - 1].time;

  return (
    <Section id="day" tone="raised" space="md" rule>
      <Container>
        <SectionHead
          kicker="A day in the life"
          title={
            <span key={role.slug} className={touched ? "settle block" : "block"}>
              {`${role.person} ${role.shipped} by ${last}.`}
            </span>
          }
          lede="Every line below is a Routine that fired on its own schedule, the product it worked in, and the one moment in the day it stopped and put a question in front of a person."
        />

        <div
          role="tablist"
          aria-label="Roles"
          onKeyDown={(event) => {
            const index = ROLES.findIndex((item) => item.slug === role.slug);
            const next = {
              ArrowRight: (index + 1) % ROLES.length,
              ArrowLeft: (index - 1 + ROLES.length) % ROLES.length,
              Home: 0,
              End: ROLES.length - 1,
            }[event.key];
            if (next === undefined) return;
            event.preventDefault();
            setActive(ROLES[next].slug);
            setTouched(true);
            document.getElementById(`day-tab-${ROLES[next].slug}`)?.focus();
          }}
          className="scrollbar-none -mx-5 mt-12 flex gap-2 overflow-x-auto px-5 pb-1 sm:mx-0 sm:flex-wrap sm:px-0"
        >
          {ROLES.map((item) => {
            const selected = item.slug === role.slug;
            return (
              <button
                key={item.slug}
                type="button"
                role="tab"
                id={`day-tab-${item.slug}`}
                aria-selected={selected}
                aria-controls="day-panel"
                tabIndex={selected ? 0 : -1}
                onClick={() => {
                  setActive(item.slug);
                  setTouched(true);
                }}
                className={`inline-flex h-11 shrink-0 items-center gap-2.5 rounded-full border pl-1.5 pr-4 text-[14px] transition-colors duration-200 ${
                  selected
                    ? "border-ink bg-ink text-white"
                    : "border-line bg-paper text-ink-600 hover:border-line-strong hover:text-ink"
                }`}
              >
                <Avatar initials={roleInitials(item)} dept={roleDept(item)} size="sm" night={selected} />
                {item.short}
              </button>
            );
          })}
        </div>

        <div
          id="day-panel"
          role="tabpanel"
          aria-labelledby={`day-tab-${role.slug}`}
          className="mt-6 overflow-hidden rounded-[1.75rem] border border-line bg-paper"
        >
          <div key={role.slug} className={touched ? "settle" : ""}>
            <div className="border-b border-line px-5 pb-6 pt-5 sm:px-8">
              <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                <p className="text-[14px] text-ink-600">
                  <span className="font-medium text-ink">{`${role.person}, ${role.name}`}</span>
                  {` · ${role.discipline} · Tuesday`}
                </p>
                <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-400">
                  {`Sample day · ${role.day.length} Runs`}
                </p>
              </div>
              <DayStrip role={role} className="mt-4 hidden md:block" />
            </div>
            <div className="grid lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
              <div className="px-3 py-4 sm:px-6 sm:py-6">
                <DayTimeline role={role} compact />
              </div>
              <div className="border-t border-line px-5 py-7 sm:px-8 lg:border-l lg:border-t-0">
                <DayReport role={role} />
                <TextLink href={`/roles/${role.slug}`} className="mt-8">
                  {`Read ${role.person}'s whole day`}
                </TextLink>
              </div>
            </div>
          </div>
        </div>
      </Container>
    </Section>
  );
}
