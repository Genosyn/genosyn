import { ArrowRight, BookOpen } from "lucide-react";
import { Nav } from "@/sections/Nav";
import { Footer, InstallCta } from "@/sections/Footer";
import {
  HeroActions,
  HeroBadge,
  HeroBadgeDot,
  HeroButton,
  HeroCopy,
  HeroGrid,
  HeroLede,
  HeroProof,
  HeroSection,
  HeroTitle,
  HeroTitleMuted,
} from "@/sections/HeroKit";
import { Roles, Roster } from "@/sections/Roles";
import { ROLES, type RoleDef } from "@/roles/data";
import { roleIcon } from "@/roles/roleIcons";
import { Link } from "@/lib/router";

const CHECKS = [
  "Works unattended, on its own schedule",
  "Escalates by exception, not by default",
  "Any AI model, your own keys",
  "Self-hosted · Apache 2.0 licensed",
];

/**
 * The roster index.
 *
 * The hero makes the argument once — a role is a document, not a product tier
 * — and then the page gets out of the way and shows a day. The interactive
 * day switcher is the same component the landing page uses, because it is the
 * best thing either page has to say.
 */
export function RolesIndex() {
  const flagship = ROLES[0];

  return (
    <div className="min-h-screen bg-paper-100 text-zinc-800">
      <Nav />
      <main>
        <HeroSection>
          <HeroGrid>
            <HeroCopy>
              <HeroBadge>
                Genosyn roles
                <HeroBadgeDot />
                <span className="font-medium text-zinc-500">{ROLES.length} to start from</span>
              </HeroBadge>
              <HeroTitle>
                Every role, working <HeroTitleMuted>a full day.</HeroTitleMuted>
              </HeroTitle>
              <HeroLede>
                An AI Employee holds a real job, not a chat window. It has a constitution, the
                playbooks its job repeats, a schedule nobody has to start, and exactly the access
                you granted it — so the work happens whether or not anyone is watching.
              </HeroLede>

              <HeroActions>
                <HeroButton href="#roles">
                  Read a day, hour by hour
                  <ArrowRight aria-hidden className="h-4 w-4" />
                </HeroButton>
                <HeroButton href="/docs/employees" variant="secondary">
                  <BookOpen aria-hidden className="h-4 w-4" />
                  How employees are built
                </HeroButton>
              </HeroActions>

              <HeroProof items={CHECKS} />
            </HeroCopy>

            <FlagshipRole role={flagship} />
          </HeroGrid>
        </HeroSection>

        <Roles />

        <Roster />

        <InstallCta />
      </main>
      <Footer />
    </div>
  );
}

/** The hero's right column: one role's day, compressed into a preview card. */
function FlagshipRole({ role }: { role: RoleDef }) {
  const Icon = roleIcon(role.icon);
  return (
    <div className="relative">
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-10 -z-10 rounded-[3rem] bg-[radial-gradient(60%_55%_at_50%_40%,rgba(9,9,11,0.10),transparent_72%)] blur-2xl"
      />
      <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-raise">
        <div className="flex items-center gap-3 border-b border-zinc-200 px-6 py-5">
          <span
            className={`flex h-10 w-10 items-center justify-center rounded-xl ring-1 ring-inset ${role.accent}`}
          >
            <Icon aria-hidden className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-label text-zinc-500">
              Tuesday
            </div>
            <div className="mt-0.5 text-[15px] font-semibold tracking-[-0.01em] text-zinc-950">
              {role.person} · {role.name}
            </div>
          </div>
          <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full border border-emerald-500/25 bg-emerald-50 px-2.5 py-1 text-[10px] font-semibold text-emerald-700">
            <span aria-hidden className="preview-live h-1.5 w-1.5 rounded-full bg-emerald-500" />
            On duty
          </span>
        </div>

        <ul className="divide-y divide-zinc-100">
          {role.day.slice(0, 5).map((moment) => (
            <li key={moment.time} className="flex items-start gap-4 px-6 py-3.5">
              <span className="tabular w-11 shrink-0 pt-0.5 font-mono text-[11px] font-semibold text-zinc-500">
                {moment.time}
              </span>
              <span
                aria-hidden
                className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                  moment.kind && moment.kind !== "work" ? "bg-amber-500" : role.dot
                }`}
              />
              <span className="min-w-0 flex-1 text-[13px] leading-5 text-zinc-800">
                {moment.title}
              </span>
            </li>
          ))}
        </ul>

        <div className="flex items-center justify-between gap-3 border-t border-zinc-200 bg-paper-100 px-6 py-4">
          <span className="text-[11px] text-zinc-500">
            {`+ ${role.day.length - 5} more, through to ${role.day[role.day.length - 1].time}`}
          </span>
          <Link
            href={`/roles/${role.slug}`}
            className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-semibold text-zinc-900 transition hover:opacity-70"
          >
            Read the full day
            <ArrowRight aria-hidden className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
    </div>
  );
}
