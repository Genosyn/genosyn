import { useState } from "react";
import { GITHUB_URL } from "@/lib/constants";
import { Board, LEAD_CLAIM, LEAD_DONE_BY, OTHERS_BEFORE_ARRIVAL } from "@/sections/Board";
import { ActionStrip, Band, Container, Display, Lede, Note, Rail } from "@/sections/Kit";

const COMMAND = "curl -fsSL https://genosyn.com/install.sh | bash";

/**
 * The landing hero.
 *
 * What is absent is the design. There is no pill badge, no pulsing dot, no
 * centred column, no two-tone headline, no row of three buttons, no aurora
 * wash, no grid overlay, no grain, no drift, no radial glow under a screenshot
 * and no floating badge card on its corner. That stack — all seven pieces, in
 * that order — is the thing a reader recognises in under a second as the
 * default landing page, and no amount of restyling it helps. It had to go
 * rather than improve.
 *
 * What replaces it is one finished thing and its evidence.
 *
 * The headline used to count Runs — "Eighteen Routines ran before anyone
 * signed in" — which told a reader the scheduler had fired eighteen times.
 * That is activity, not output: it says the machine was busy and nothing about
 * whether anything now exists. It names one artefact instead, with the clock
 * time it was finished by, and both halves are read out of the board's own
 * event list (`LEAD_CLAIM`, `LEAD_DONE_BY`) so the sentence cannot drift away
 * from the picture underneath it. A reader can hold "42 reconciled payments"
 * in their head; nobody can picture eighteen Runs.
 *
 * The lede then carries the breadth the headline gives up, so the page is
 * specific first and comprehensive second rather than the other way round.
 * Then the install command, as a real object you can copy rather than a button
 * that scrolls somewhere. Then the Tuesday itself, at full width.
 */
export function Hero() {
  return (
    <Band tone="paper" open="xs" close="l" rule={false}>
      <Container>
        <Rail sheet="01 / One Tuesday" fields={["2026-09-01", "TUE", "00:00–24:00"]}>
          <Display scale="hero">{`${LEAD_CLAIM} by ${LEAD_DONE_BY}.`}</Display>

          <Lede className="mt-6">
            Genosyn is an open-source platform for running a company with AI Employees.
          </Lede>

          {/* The count moves out of the lede and is set as marginalia in the
              note face. It is not deleted; it is demoted to the margin, which
              is what a publication does with a figure that supports a claim
              rather than makes it — and it is the first place on the site
              where the third type voice appears at reading size. */}
          <Note className="mt-5 max-w-[52ch] text-[1.0625rem] leading-[1.5] text-zinc-800">
            {`${spell(OTHERS_BEFORE_ARRIVAL)} other things finished before 09:30, from a triaged inbox to 340 audited dependencies. Three were left for a person.`}
          </Note>

          <div className="mt-10 max-w-[36rem]">
            <InstallStrip />
            <ActionStrip href="/roles/sdr" trailing="Read" className="-mt-px">
              One role, hour by hour
            </ActionStrip>
            <ActionStrip href={GITHUB_URL} external trailing="Source" className="-mt-px">
              Apache 2.0 on GitHub
            </ActionStrip>
          </div>
        </Rail>

        {/* The board breaks out of the rail to the full container: it is the
            evidence for the headline, so it gets the width. */}
        <div className="mt-16 sm:mt-20">
          <Board />
        </div>
      </Container>
    </Band>
  );
}

/**
 * The install command as an object rather than a call to action.
 *
 * On an Apache-2.0 self-hosted product this string *is* the conversion event,
 * so it is the first control on the page and it is the real thing, not a
 * button that scrolls to it. The affordance is the word COPY rather than a
 * clipboard glyph, which is the difference between a control and an
 * icon-shaped decoration.
 */
function InstallStrip() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(COMMAND);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // The command stays selectable when clipboard permission is unavailable.
    }
  }

  return (
    <div className="flex min-h-[3.25rem] items-center gap-4 border border-paper-400 bg-paper-50 px-4">
      <code className="t-data min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-[11px] text-zinc-950 scrollbar-none sm:text-[12px]">
        {COMMAND}
      </code>
      <button
        type="button"
        onClick={copy}
        className="t-cond shrink-0 text-[11px] uppercase tracking-field text-zinc-600 transition-colors hover:text-zinc-950"
      >
        {copied ? "Copied" : "Copy"}
        <span className="sr-only"> install command</span>
      </button>
    </div>
  );
}

/** Counts read as counts when they are words at display size. */
function spell(value: number): string {
  const words = [
    "Zero",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
    "Thirteen",
    "Fourteen",
    "Fifteen",
    "Sixteen",
    "Seventeen",
    "Eighteen",
    "Nineteen",
    "Twenty",
  ];
  return words[value] ?? String(value);
}
