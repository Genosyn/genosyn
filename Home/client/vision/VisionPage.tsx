import { ArrowUpRight, BookHeart, CircleSlash2, KeyRound, MessageCircleQuestion, ScrollText, Target, type LucideIcon } from "lucide-react";
import { useReveal } from "@/components/Reveal";
import { Link } from "@/lib/router";
import { ClosingCta, Footer } from "@/sections/Footer";
import { Container, Em, NightPanel, Section, SectionHead, TextLink } from "@/sections/Kit";
import { Nav } from "@/sections/Nav";
import { Charter } from "@/vision/Charter";
import { BIG_IDEAS, FUTURE_COMPANIES, POWERS, ROAD, type Power } from "@/vision/data";
import { Hands } from "@/vision/Hands";
import { Letters } from "@/vision/Letters";
import { Prologue, Shift } from "@/vision/Shift";
import { Treasury } from "@/vision/Treasury";
import { VisionHero } from "@/vision/VisionHero";
import "./vision.css";

/**
 * /vision — where Genosyn is going.
 *
 * The rest of the site describes what ships. This page describes the company
 * Genosyn is being built to make possible: one that runs itself toward a Goal
 * its board sets, keeps its own money, hires people for the physical world,
 * and writes to its owners once a month. It follows one sample company,
 * Furrow, from its first sentence to its twentieth year, and it ends by saying
 * plainly which parts already ship and which are still on the road.
 */
export function VisionPage() {
  return (
    <div className="min-h-screen overflow-x-clip bg-paper text-ink">
      <Nav />
      <main>
        <VisionHero />
        <Prologue />
        <Shift />
        <Charter />
        <Treasury />
        <Hands />
        <Letters />
        <Powers />
        <Bigger />
        <Road />
        <ClosingCta
          title="Take your seat on the board."
          lede="Start with what ships today: hire one AI Employee, give it a Goal and a Routine, and read what it did in the morning. The rest of the company is on its way."
        />
      </main>
      <Footer />
    </div>
  );
}

/* -------------------------------------------------------------------------
   Governance
------------------------------------------------------------------------- */

const POWER_ICON: Record<Power["icon"], LucideIcon> = {
  goal: Target,
  policy: ScrollText,
  decision: MessageCircleQuestion,
  soul: BookHeart,
  keys: KeyRound,
  standdown: CircleSlash2,
};

function Powers() {
  const grid = useReveal<HTMLUListElement>(0, 60);
  return (
    <Section id="governance" space="md">
      <Container>
        <SectionHead
          kicker="Governance"
          title="Autonomous is not unaccountable."
          lede="A company that runs itself still answers to its owners. The board keeps six powers, and Genosyn is built so the company can never take them back: a bar the company could rewrite would not be a bar."
        />
        <ul
          ref={grid}
          className="mt-14 grid gap-px overflow-hidden rounded-3xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3"
        >
          {POWERS.map((power) => {
            const Icon = POWER_ICON[power.icon];
            return (
              <li key={power.name} className="flex flex-col bg-paper-raised p-6 sm:p-7">
                <div className="flex items-center justify-between gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-full border border-line bg-paper">
                    <Icon aria-hidden className="h-[18px] w-[18px] text-ink" strokeWidth={1.6} />
                  </span>
                  {power.docsPath ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-paper px-2.5 py-1 font-mono text-[10.5px] uppercase leading-none tracking-[0.08em] text-ink-600">
                      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-moss-500" />
                      Ships today
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-ink-300 px-2.5 py-1 font-mono text-[10.5px] uppercase leading-none tracking-[0.08em] text-ink-500">
                      On the road
                    </span>
                  )}
                </div>
                <h3 className="mt-6 font-display text-[1.3rem] leading-tight tracking-[-0.025em] text-ink">{power.name}</h3>
                <p className="mt-2.5 text-[14.5px] leading-6 text-ink-600">{power.body}</p>
                {power.docsPath && (
                  <TextLink href={power.docsPath} className="mt-auto pt-6 !text-[14px]">
                    How it works today
                  </TextLink>
                )}
              </li>
            );
          })}
        </ul>
      </Container>
    </Section>
  );
}

/* -------------------------------------------------------------------------
   Think bigger
------------------------------------------------------------------------- */

function Bigger() {
  const ideas = useReveal<HTMLOListElement>(0, 90);
  return (
    <div className="py-2">
      <NightPanel id="bigger" dawn={0.7}>
        <Container className="pt-20 sm:pt-24 lg:pt-32">
          <SectionHead
            night
            align="center"
            size="xl"
            kicker="Think bigger"
            title={
              <>
                What happens when founding a company takes <Em tone="night">one sentence?</Em>
              </>
            }
          />

          <ol ref={ideas} className="mt-16 grid gap-10 border-t border-white/10 pt-12 lg:mt-20 lg:grid-cols-3 lg:gap-14">
            {BIG_IDEAS.map((idea, index) => (
              <li key={idea.title} className="min-w-0">
                <span className="font-mono text-[12px] text-white/40">{`0${index + 1}`}</span>
                <h3 className="mt-4 font-display text-[1.65rem] leading-[1.12] tracking-[-0.032em] text-white">{idea.title}</h3>
                <p className="mt-4 text-[15.5px] leading-7 text-night-muted">{idea.body}</p>
              </li>
            ))}
          </ol>
        </Container>

        <div className="mt-20 lg:mt-24">
          <p className="kicker flex items-center justify-center gap-3 text-night-muted">
            <span aria-hidden className="h-px w-6 bg-white/50" />
            Companies waiting for a board
            <span aria-hidden className="h-px w-6 bg-white/50" />
          </p>
          <Wall />
        </div>

        <Container className="pb-20 pt-16 text-center sm:pb-24 lg:pb-32 lg:pt-20">
          <p className="mx-auto max-w-[30ch] text-balance font-display text-display-md text-white">
            There are far more problems worth solving than people with the time to run a company.{" "}
            <span className="text-white/45">That is the part that changes.</span>
          </p>
        </Container>
      </NightPanel>
    </div>
  );
}

/**
 * Three rows of Goals, drifting in alternate directions. Each row is written
 * twice so the loop is seamless; the copy is hidden from assistive technology,
 * and reduced motion stops the drift and wraps the first copy instead.
 */
function Wall() {
  return (
    <div className="vw-wall fade-x mt-8 space-y-3 overflow-hidden">
      {FUTURE_COMPANIES.map((row, r) => (
        <ul
          key={r}
          className={`vw-row vw-row-${r} flex w-max motion-reduce:w-auto motion-reduce:flex-wrap motion-reduce:justify-center motion-reduce:gap-y-3 motion-reduce:px-5`}
        >
          {[...row, ...row].map((company, i) => (
            <li
              key={`${company.goal}-${i}`}
              aria-hidden={i >= row.length ? true : undefined}
              className={`w-[18rem] shrink-0 pr-3 sm:w-[21rem] ${i >= row.length ? "motion-reduce:hidden" : ""}`}
            >
              <div className="flex h-full flex-col rounded-2xl border border-white/[0.09] bg-white/[0.035] p-5">
                <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-night-faint">{company.area}</span>
                <span className="mt-3 text-[15px] leading-6 text-white">{company.goal}</span>
                <span className="mt-auto inline-flex items-center gap-2 pt-5 font-mono text-[10.5px] uppercase tracking-[0.12em] text-night-muted">
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full border border-white/60" />
                  Board seat open
                </span>
              </div>
            </li>
          ))}
        </ul>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------
   The road
------------------------------------------------------------------------- */

const STAGE_MARK = [
  <span key="ships" aria-hidden className="h-2 w-2 rounded-full bg-moss-500" />,
  <span key="next" aria-hidden className="h-2 w-2 rounded-full border border-ink" />,
  <span key="horizon" aria-hidden className="h-2 w-2 rounded-full border border-dashed border-ink-400" />,
];

function Road() {
  const stages = useReveal<HTMLOListElement>(0, 90);
  return (
    <Section id="road" tone="raised" space="md" rule>
      <Container>
        <SectionHead
          kicker="The road"
          title={
            <>
              Much of it ships today. <Em>The rest is what we are building.</Em>
            </>
          }
          lede="Genosyn is open source, and the vision lands one feature at a time: each one something you can install, read, and run on your own hardware. This is where it stands."
        />
        <ol ref={stages} className="mt-14 grid gap-4 lg:grid-cols-3">
          {ROAD.map((stage, index) => (
            <li
              key={stage.stage}
              className={`flex min-w-0 flex-col rounded-3xl p-6 sm:p-7 ${
                index === 0 ? "border border-line bg-paper" : "border border-dashed border-line-strong"
              }`}
            >
              <div className="flex items-center gap-2.5">
                {STAGE_MARK[index]}
                <h3 className="font-display text-[1.3rem] leading-tight tracking-[-0.025em] text-ink">{stage.stage}</h3>
              </div>
              <p className="mt-1.5 text-[13.5px] text-ink-500">{stage.note}</p>
              <ul className="mt-6 divide-y divide-line border-t border-line">
                {stage.items.map((item) =>
                  item.href ? (
                    <li key={item.label}>
                      <Link
                        href={item.href}
                        className="group flex items-center justify-between gap-4 py-3 text-[14.5px] leading-5 text-ink transition-colors hover:text-ink-600"
                      >
                        {item.label}
                        <ArrowUpRight aria-hidden className="nudge-up h-4 w-4 shrink-0 text-ink-300 group-hover:text-ink" />
                      </Link>
                    </li>
                  ) : (
                    <li key={item.label} className="py-3 text-[14.5px] leading-5 text-ink-600">
                      {item.label}
                    </li>
                  ),
                )}
              </ul>
            </li>
          ))}
        </ol>
      </Container>
    </Section>
  );
}
