import { useState } from "react";
import { GITHUB_URL } from "@/lib/constants";
import { Board, RUNS_BEFORE_ARRIVAL } from "@/sections/Board";
import { ActionStrip, Band, Container, Display, Lede, Rail } from "@/sections/Kit";

const COMMAND = "curl -fsSL https://genosyn.com/install.sh | sh";

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
 * What replaces it is one claim and its evidence. The headline is a count
 * ("Eighteen"), not an abstraction, and it is derived from the board below it
 * rather than asserted above it: `RUNS_BEFORE_ARRIVAL` is computed from the
 * actual event list, so the sentence cannot drift away from the picture. Then
 * the install command, as a real object you can copy rather than a button that
 * scrolls somewhere. Then the Tuesday itself, at full width.
 */
export function Hero() {
  return (
    <Band tone="paper" pad="l" rule={false}>
      <Container>
        <Rail sheet="01 / One Tuesday" fields={["2026-09-01", "TUE", "00:00–24:00"]}>
          <Display className="max-w-[24ch]">
            {`${spell(RUNS_BEFORE_ARRIVAL)} Routines ran before anyone signed in.`}
          </Display>

          <Lede className="mt-7">
            Genosyn is an open-source platform for running a company with AI Employees. They hold
            real roles, work to their own schedule, and stop for you only when a job genuinely
            needs a person.
          </Lede>

          <div className="mt-10 max-w-[34rem]">
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
      <code className="t-data min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-[12px] text-zinc-950 scrollbar-none sm:text-[13px]">
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
    "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
    "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen",
    "Nineteen", "Twenty",
  ];
  return words[value] ?? String(value);
}
