import { ArrowRight, BookHeart, CalendarClock, KeyRound, Sparkles } from "lucide-react";
import { useReveal } from "@/components/Reveal";
import { SIGN_UP_URL } from "@/lib/constants";
import { Link } from "@/lib/router";
import { findProduct } from "@/products/data";
import { ROLES } from "@/roles/data";
import { roleDept, roleHours, roleInitials, roleStop, STOP_WORD } from "@/roles/meta";
import { ClosingCta, Footer } from "@/sections/Footer";
import {
  Avatar,
  Button,
  Container,
  FactRow,
  NightPanel,
  Section,
  SectionHead,
  StateTag,
  TextLink,
} from "@/sections/Kit";
import { Nav } from "@/sections/Nav";
import { PageHero } from "@/sections/PageHero";
import { RoleCard } from "@/sections/Roster";

export function RolesIndex() {
  const routines = ROLES.reduce((total, role) => total + role.routines.length, 0);
  return (
    <div className="min-h-screen overflow-x-clip bg-paper text-ink">
      <Nav />
      <main>
        <PageHero
          kicker="Roles"
          title={
            <>
              {`${ROLES.length} roles, written hour by hour.`}
            </>
          }
          lede="Every role is a Soul, a set of Skills and Routines on a schedule. Read one working day of each — what it did, where it did it, and the one moment it stopped for a person. Hire it as written, or write one only your company has."
          actions={
            <>
              <Button href={SIGN_UP_URL} variant="ink" arrow>
                Start free
              </Button>
              <Button href="/docs/employees" variant="outline">
                How a role is written
              </Button>
            </>
          }
          meta={<FactRow items={[`${ROLES.length} worked roles`, `${routines} Routines`, "1 stop each"]} />}
        />

        <Roster />
        <WriteYourOwn />
        <SideBySide />
        <ClosingCta />
      </main>
      <Footer />
    </div>
  );
}

function Roster() {
  const grid = useReveal<HTMLUListElement>(0, 55);
  return (
    <Section id="roster" space="none" className="pb-20 sm:pb-24">
      <Container>
        <ul ref={grid} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {ROLES.map((role) => (
            <li key={role.slug} className="min-w-0">
              <RoleCard role={role} />
            </li>
          ))}
        </ul>
      </Container>
    </Section>
  );
}

function SideBySide() {
  return (
    <Section id="compare" tone="raised" space="md" rule>
      <Container>
        <SectionHead
          kicker="Side by side"
          title={
            <>
              Each works its own day, and stops once.
            </>
          }
          lede="Every role runs unattended through its sample day and stops exactly once — for a Decision it writes itself, or an Approval the system holds for an admin."
        />
        <div className="scrollbar-none mt-12 overflow-x-auto rounded-3xl border border-line bg-paper">
          <table className="w-full min-w-[56rem] border-collapse text-left">
            <caption className="sr-only">Every role&apos;s hours, Runs, stop and products</caption>
            <thead>
              <tr className="border-b border-line font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-400">
                <th scope="col" className="px-6 py-4 font-medium">Role</th>
                <th scope="col" className="px-4 py-4 font-medium">Hours</th>
                <th scope="col" className="px-4 py-4 font-medium">Runs</th>
                <th scope="col" className="px-4 py-4 font-medium">Stops for you</th>
                <th scope="col" className="px-4 py-4 font-medium">Works in</th>
                <th scope="col" className="px-6 py-4">
                  <span className="sr-only">Open</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {ROLES.map((role) => {
                const stop = roleStop(role);
                const products = role.products.flatMap((slug) => findProduct(slug) ?? []);
                return (
                  <tr key={role.slug} className="group transition-colors hover:bg-white">
                    <th scope="row" className="px-6 py-4 font-normal">
                      <Link href={`/roles/${role.slug}`} className="flex items-center gap-3">
                        <Avatar initials={roleInitials(role)} dept={roleDept(role)} size="sm" />
                        <span>
                          <span className="block text-[14.5px] font-medium text-ink">{role.name}</span>
                          <span className="block text-[12.5px] text-ink-500">{`${role.person} · ${role.discipline}`}</span>
                        </span>
                      </Link>
                    </th>
                    <td className="px-4 py-4 font-mono text-[12.5px] text-ink-600">{roleHours(role)}</td>
                    <td className="px-4 py-4 font-mono text-[12.5px] text-ink-600">{role.day.length}</td>
                    <td className="px-4 py-4">
                      {stop ? (
                        <span className="inline-flex items-center gap-2">
                          <StateTag state={stop.kind}>{STOP_WORD[stop.kind]}</StateTag>
                          <span className="font-mono text-[12px] text-ink-500">{stop.time}</span>
                        </span>
                      ) : (
                        <span className="text-[13px] text-ink-400">None</span>
                      )}
                    </td>
                    <td className="px-4 py-4 text-[13.5px] text-ink-600">
                      {products
                        .slice(0, 3)
                        .map((product) => product.name)
                        .join(", ")}
                      {products.length > 3 ? ` +${products.length - 3}` : ""}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <Link
                        href={`/roles/${role.slug}`}
                        aria-label={`Read the ${role.name} page`}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-line text-ink-500 transition-colors group-hover:border-ink group-hover:bg-ink group-hover:text-white"
                      >
                        <ArrowRight aria-hidden className="h-4 w-4" />
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Container>
    </Section>
  );
}

const PARTS = [
  { icon: BookHeart, name: "Soul", body: "How it judges: what to do first, and when to stop and ask instead of guessing." },
  { icon: Sparkles, name: "Skills", body: "The playbooks for the work your company repeats, each with a definition of done." },
  { icon: CalendarClock, name: "Routines", body: "The schedule that starts the work, so nobody has to remember to." },
  { icon: KeyRound, name: "Grants", body: "Exactly which Connections, notebooks and Repositories it may touch." },
];

function WriteYourOwn() {
  return (
    <div className="pb-2">
      <NightPanel id="write-your-own" dawn={0.5}>
        <Container className="py-20 sm:py-24">
          <SectionHead
            night
            kicker="Write your own"
            title={
              <>
                The next role is one only your company has.
              </>
            }
            lede="These eight are worked examples, not the catalogue. Any role you can describe in four documents can be hired, and the AI Employee can help you write them."
            aside={
              <TextLink href="/docs/employees" night>
                How an AI Employee is assembled
              </TextLink>
            }
          />
          <ol className="mt-14 grid gap-px overflow-hidden rounded-3xl border border-white/10 bg-white/10 sm:grid-cols-2 lg:grid-cols-4">
            {PARTS.map((part, index) => (
              <li key={part.name} className="bg-night-raised/90 p-7">
                <div className="flex items-center justify-between">
                  <part.icon aria-hidden className="h-5 w-5 text-white" strokeWidth={1.6} />
                  <span className="font-mono text-[12px] text-white/35">{`0${index + 1}`}</span>
                </div>
                <p className="mt-8 font-display text-[1.35rem] leading-tight tracking-[-0.03em] text-white">{part.name}</p>
                <p className="mt-2.5 text-[14.5px] leading-6 text-night-muted">{part.body}</p>
              </li>
            ))}
          </ol>
        </Container>
      </NightPanel>
    </div>
  );
}
