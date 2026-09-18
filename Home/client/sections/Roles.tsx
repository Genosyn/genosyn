import { useState } from "react";
import { useReveal } from "@/components/Reveal";
import { ROLES } from "@/roles/data";
import { DaySchedule, RoleRail, roleDept } from "@/roles/RoleDay";
import { Band, Body, Container, DEPT_FULL, Field, Head, Row, Sheet } from "@/sections/Kit";

/** The day-in-the-life selector and its roster summary. */
export function Roles() {
  const [active, setActive] = useState(ROLES[0].slug);
  const [hasSwitched, setHasSwitched] = useState(false);
  const role = ROLES.find((item) => item.slug === active) ?? ROLES[0];
  const last = role.day[role.day.length - 1].time;

  return (
    <Band id="roles" tone="surface" open="l" close="m">
      <Container>
        <Head
          eyebrow="02 / One role's day"
          title={
            <span key={role.slug} className={hasSwitched ? "motion-content block" : "block"}>
              {`${role.person} ${role.shipped} by ${last}.`}
            </span>
          }
          lede="Pick a role and read its day. Every line is a Routine on a schedule: what it did, which product it did it in, and the one hour it stopped and put a question in front of a person."
        />

        <div className="mt-12 grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0">
            <RoleTabs
              active={active}
              onSelect={(slug) => {
                setActive(slug);
                setHasSwitched(true);
              }}
            />
            <div className="mt-4">
              <DaySchedule role={role} />
            </div>
          </div>
          <RoleRail role={role} />
        </div>
      </Container>
    </Band>
  );
}

/** A wrapping set of toggle buttons; selection is also exposed by `aria-pressed`. */
function RoleTabs({ active, onSelect }: { active: string; onSelect: (slug: string) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2 rounded-xl border border-slate-200 bg-white p-2 shadow-sm sm:grid-cols-4 xl:grid-cols-8">
      {ROLES.map((role) => {
        const dept = roleDept(role);
        const selected = role.slug === active;
        return (
          <button
            key={role.slug}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(role.slug)}
            className={`relative flex min-h-10 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 ${
              selected
                ? "border-indigo-600 bg-indigo-600 text-white shadow-sm"
                : "border-transparent bg-white text-slate-600 hover:border-slate-200 hover:bg-slate-50 hover:text-slate-900"
            }`}
          >
            <span
              aria-hidden
              className={`h-2 w-2 shrink-0 rounded-full ${
                selected ? "bg-white/80" : DEPT_FULL[dept]
              }`}
            />
            {role.short}
          </button>
        );
      })}
    </div>
  );
}

/** Every shipped role, with its first Routine and schedule read from role data. */
export function Roster() {
  const rows = useReveal<HTMLDivElement>(0, 45);
  const routines = ROLES.reduce((total, role) => total + role.routines.length, 0);

  return (
    <Band id="roster" tone="ground" open="s" close="s">
      <Container>
        <Head
          eyebrow="03 / The roster"
          title={`${ROLES.length} roles arrive with the first day already written.`}
          lede="Underneath, each one is the same three things: a Soul, a set of Skills, and Routines on a schedule. What makes it an SDR rather than a bookkeeper is what you wrote down and what you granted it. The next one can be a job title that exists only at your company."
          aside={<Field>{`${ROLES.length} ROLES · ${routines} ROUTINES`}</Field>}
        />

        <div ref={rows} className="mt-10 space-y-2">
          {/* The three columns only appear where the longest schedule stays readable. */}
          <div className="hidden gap-x-6 pb-3 pl-4 xl:flex">
            <Sheet className="w-[13rem] shrink-0">Role</Sheet>
            <Sheet className="min-w-0 flex-1">What it does</Sheet>
            <Sheet className="w-[19rem] shrink-0">What it runs</Sheet>
          </div>

          {ROLES.map((role) => {
            const routine = role.routines[0];
            return (
              <Row
                key={role.slug}
                href={`/roles/${role.slug}`}
                dept={roleDept(role)}
                className="flex-wrap"
              >
                <div className="w-full xl:w-[13rem] xl:shrink-0">
                  <span className="block text-[15px] font-medium leading-6 text-slate-900 group-hover:text-indigo-700">
                    {role.name}
                  </span>
                  <Sheet className="mt-1 block">{role.discipline}</Sheet>
                </div>

                <Body className="w-full min-w-0 text-[13px] leading-5 xl:flex-1 xl:basis-0">
                  {role.summary}
                </Body>

                <div className="w-full xl:w-[19rem] xl:shrink-0">
                  <span className="block text-[13px] leading-5 text-slate-600">{routine.name}</span>
                  <Field className="mt-1 block">{routine.when}</Field>
                </div>
              </Row>
            );
          })}
        </div>
      </Container>
    </Band>
  );
}
