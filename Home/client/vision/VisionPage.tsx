import { ArrowUpRight, Mail, Power, Target, Vault, type LucideIcon } from "lucide-react";
import { useReveal } from "@/components/Reveal";
import { Link } from "@/lib/router";
import { ClosingCta, Footer } from "@/sections/Footer";
import { Container, Em, Section, SectionHead, TextLink } from "@/sections/Kit";
import { Nav } from "@/sections/Nav";
import { Bigger } from "@/vision/Bigger";
import { Charter } from "@/vision/Charter";
import { BOARD_KEEPS, COMPANY_DECIDES, LETTERS, ROAD, type Keep } from "@/vision/data";
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
 * its board sets, keeps its own money, hires people for the physical world and
 * shares ownership with them, and writes to its owners once a month, every
 * figure checked by an auditor it cannot appoint. It follows one sample company,
 * Sunwise, from its first sentence to its twentieth year, and it ends by saying
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
        <Governance />
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

const KEEP_ICON: Record<Keep["icon"], LucideIcon> = {
  goal: Target,
  vault: Vault,
  letter: Mail,
  switch: Power,
};

/**
 * The board keeps four things and decides almost nothing. The company's side
 * is drawn on the night, because on this site the night is where work happens
 * with nobody watching.
 */
function Governance() {
  const keeps = useReveal<HTMLUListElement>(0, 60);
  const decides = useReveal<HTMLDivElement>(120);
  const lastLetter = LETTERS[LETTERS.length - 1];

  return (
    <Section id="governance" space="md">
      <Container>
        <SectionHead
          kicker="Governance"
          title="Autonomous is not unaccountable."
          lede="The board does not run the company, sign off on its plans, or watch its spending. It keeps four things, the least that owning a company takes, and the company decides everything else on its own."
        />

        <div className="mt-14 grid gap-x-4 gap-y-10 lg:grid-cols-2">
          <div className="flex min-w-0 flex-col">
            <p className="kicker inline-flex items-center gap-3 text-ink-500">
              <span aria-hidden className="h-px w-6 bg-ink" />
              What the board keeps
            </p>
            <ul
              ref={keeps}
              className="mt-5 grid flex-1 gap-px overflow-hidden rounded-3xl border border-line bg-line sm:grid-cols-2"
            >
              {BOARD_KEEPS.map((keep) => {
                const Icon = KEEP_ICON[keep.icon];
                return (
                  <li key={keep.name} className="flex flex-col bg-paper-raised p-6">
                    <div className="flex items-center justify-between gap-3">
                      <span className="flex h-10 w-10 items-center justify-center rounded-full border border-line bg-paper">
                        <Icon aria-hidden className="h-[18px] w-[18px] text-ink" strokeWidth={1.6} />
                      </span>
                      {keep.docsPath ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-paper px-2.5 py-1 font-mono text-[10.5px] uppercase leading-none tracking-[0.08em] text-ink-600">
                          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-moss-500" />
                          Ships today
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full border border-dashed border-ink-300 px-2.5 py-1 font-mono text-[10.5px] uppercase leading-none tracking-[0.08em] text-ink-500">
                          On the road
                        </span>
                      )}
                    </div>
                    <h3 className="mt-6 font-display text-[1.3rem] leading-tight tracking-[-0.025em] text-ink">{keep.name}</h3>
                    <p className="mt-2.5 text-[14.5px] leading-6 text-ink-600">{keep.body}</p>
                    {keep.road && (
                      <p className="mt-3.5 flex flex-wrap items-center gap-2 text-[13px] leading-5 text-ink-500">
                        <span className="inline-flex items-center rounded-full border border-dashed border-ink-300 px-2 py-0.5 font-mono text-[10px] uppercase leading-none tracking-[0.08em] text-ink-500">
                          On the road
                        </span>
                        {keep.road}
                      </p>
                    )}
                    {keep.docsPath && (
                      <TextLink href={keep.docsPath} className="mt-auto pt-5 !text-[14px]">
                        How it works today
                      </TextLink>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          <div ref={decides} className="flex min-w-0 flex-col">
            <p className="kicker inline-flex items-center gap-3 text-ink-500">
              <span aria-hidden className="h-px w-6 bg-ink" />
              What the company decides on its own
            </p>
            <div className="night-sky grain on-night relative mt-5 flex flex-1 flex-col overflow-hidden rounded-3xl p-7 text-white sm:p-9">
              <p className="font-display text-[3.4rem] font-light leading-none tracking-[-0.05em] tabular sm:text-[4.25rem]">
                {lastLetter.decidedWithoutYou.toLocaleString("en-US")}
              </p>
              <p className="mt-3 max-w-[36ch] text-[15px] leading-6 text-night-muted">
                {`decisions a month by ${lastLetter.period.toLowerCase()}, each written down with its reason. Almost none of them ever reach the board.`}
              </p>
              <ul className="mt-8 flex flex-wrap gap-2">
                {COMPANY_DECIDES.map((item) => (
                  <li
                    key={item}
                    className="rounded-full border border-white/15 bg-white/[0.04] px-3.5 py-1.5 text-[13.5px] text-white/90"
                  >
                    {item}
                  </li>
                ))}
              </ul>
              <p className="mt-auto pt-8 text-[13.5px] leading-6 text-night-muted">
                And everything else the board does not keep. The board hears about all of it in the
                letter, and is asked about almost none of it.
              </p>
            </div>
          </div>
        </div>
      </Container>
    </Section>
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
