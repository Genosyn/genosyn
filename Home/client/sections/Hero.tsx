import { useState } from "react";
import { GITHUB_URL } from "@/lib/constants";
import { Board, OTHERS_BEFORE_ARRIVAL } from "@/sections/Board";
import { Claims } from "@/sections/Claims";
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
 * What replaces it is a promise and its rotating evidence.
 *
 * The headline is the claim the product actually makes. Under it, `Claims`
 * cycles real overnight Runs — 340 dependencies audited, 42 Stripe payments
 * reconciled, 31 support emails answered — read out of the board's own event
 * list rather than written for the page, so the promise and the proof cannot
 * drift apart and a reader sees a different piece of evidence every few
 * seconds without the headline ever moving.
 *
 * A single fixed artefact was tried here first ("42 Stripe payments were
 * reconciled by 04:45"). It was more checkable and less persuasive: one
 * reconciliation is a fact, and the product's claim is a category of facts.
 * The rotation is what makes the difference between the two visible.
 *
 * Then the install command, as a real object you can copy rather than a button
 * that scrolls somewhere. Then the Tuesday itself, at full width.
 */
export function Hero() {
  return (
    <Band tone="paper" open="xs" close="l" rule={false}>
      <Container>
        <Rail
          sheet="01 / One Tuesday"
          fields={["2026-09-01", "TUE", "00:00–24:00"]}
          margin={
            /* The count that used to be the lede's second sentence. It
               supports the claim rather than making it, which is what a margin
               is for, and it is the first place on the site where the note
               face appears at reading size instead of in a 15px caption. */
            <Note className="text-[1.0625rem] leading-[1.5] text-zinc-800">
              {`${spell(OTHERS_BEFORE_ARRIVAL)} other things finished before 09:30, from a triaged inbox to 340 audited dependencies. Three were left for a person.`}
            </Note>
          }
          head={
            <>
              <Display scale="hero">Your company can now run automatically.</Display>
              {/* The headline makes the promise; this cycles the evidence. Every
                  line is a real overnight Run read out of the board's own event
                  list, so the two cannot drift apart. */}
              <Claims className="mt-8" />
            </>
          }
        >
          <Lede className="mt-6">
            Genosyn is an open-source platform for running a company with AI Employees.
          </Lede>

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
