import { ArrowRight } from "lucide-react";
import { useReveal } from "@/components/Reveal";
import { ROLES, type RoleDef } from "@/roles/data";
import { roleDept, roleInitials } from "@/roles/meta";
import { Avatar, Container, DeptLabel, Em, LinkCard, Section, SectionHead, TextLink } from "@/sections/Kit";

/** The eight worked roles, each as a card you could pin to a wall. */
export function Roster() {
  const cards = useReveal<HTMLUListElement>(0, 60);
  const routines = ROLES.reduce((total, role) => total + role.routines.length, 0);

  return (
    <Section id="roster" space="md" className="!pt-10 sm:!pt-12">
      <Container>
        <SectionHead
          kicker="The roster"
          title={
            <>
              {`${ROLES.length} roles arrive with`} <Em tone="muted">the first day already written.</Em>
            </>
          }
          lede={`Each one is a Soul, a set of Skills and Routines on a schedule — ${routines} Routines between them. Hire one as written, tune it to how your company works, or write a role only your company has.`}
        />

        <ul
          ref={cards}
          className="scrollbar-none -mx-5 mt-14 flex snap-x snap-mandatory gap-3 overflow-x-auto px-5 pb-2 sm:mx-0 sm:grid sm:snap-none sm:grid-cols-2 sm:gap-4 sm:overflow-visible sm:px-0 sm:pb-0 xl:grid-cols-4"
        >
          {ROLES.map((role) => (
            <li key={role.slug} className="w-[78%] min-w-0 shrink-0 snap-start sm:w-auto">
              <RoleCard role={role} />
            </li>
          ))}
        </ul>

        <div className="mt-10 flex flex-wrap items-center justify-between gap-6 border-t border-line pt-8">
          <p className="max-w-[52ch] text-[15px] leading-6 text-ink-600">
            None of them is a black box. Every line of a role is text on a database row you can
            edit, diff and roll back.
          </p>
          <TextLink href="/roles">Compare every role</TextLink>
        </div>
      </Container>
    </Section>
  );
}

export function RoleCard({ role }: { role: RoleDef }) {
  const output = role.outputs[0];
  const routine = role.routines[0];
  return (
    <LinkCard href={`/roles/${role.slug}`} className="flex h-full flex-col p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar initials={roleInitials(role)} dept={roleDept(role)} size="md" />
          <div className="min-w-0">
            <p className="truncate font-display text-[1.35rem] leading-tight tracking-[-0.01em] text-ink">
              {role.person}
            </p>
            <p className="truncate text-[13px] text-ink-500">{role.name}</p>
          </div>
        </div>
        <ArrowRight aria-hidden className="nudge mt-1 h-4 w-4 shrink-0 text-ink-300 group-hover:text-ink" />
      </div>

      <div className="mt-8">
        <p className="font-display text-[3.1rem] leading-none tracking-[-0.03em] text-ink tabular">
          {output.value}
        </p>
        <p className="mt-2 text-[14px] leading-5 text-ink-600">{output.label}</p>
      </div>

      <div className="mt-auto pt-8">
        <div className="border-t border-line pt-4">
          <DeptLabel dept={roleDept(role)} />
          <p className="mt-2.5 text-[13.5px] leading-5 text-ink">{routine.name}</p>
          <p className="mt-0.5 font-mono text-[11.5px] text-ink-500">{routine.when}</p>
        </div>
      </div>
    </LinkCard>
  );
}
