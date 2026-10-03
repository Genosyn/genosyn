import { useEffect, useId, useRef, useState } from "react";
import { useReveal } from "@/components/Reveal";
import { Avatar, Container, Em, NightPanel, SectionHead } from "@/sections/Kit";
import { BIG_IDEAS, FUTURE_COMPANIES } from "@/vision/data";
import { IdeaArt } from "@/vision/IdeaArt";

/**
 * Think bigger: the vision past one company. Six ideas, each drawn in the
 * hero's vocabulary; the wall of Goals still waiting for a board; and last, a
 * blank charter card for the reader's own Goal, because the page's whole claim
 * is that founding a company takes one sentence.
 */
export function Bigger() {
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
            lede="Sunwise is one company. Zoom out, and the same few powers change what a company can be: who it serves, who owns it, how it answers for itself, how it spreads, and how long it lasts."
          />

          <ol ref={ideas} className="mt-16 grid gap-3 sm:grid-cols-2 lg:mt-20 lg:grid-cols-3">
            {BIG_IDEAS.map((idea, index) => (
              <li
                key={idea.title}
                className="flex min-w-0 flex-col overflow-hidden rounded-[1.4rem] border border-white/[0.09] bg-gradient-to-b from-white/[0.05] to-white/[0.015]"
              >
                <IdeaArt art={idea.art} legend={idea.legend} />
                <div className="flex flex-1 flex-col p-6 sm:p-7">
                  <span className="font-mono text-[12px] text-white/40">{`0${index + 1}`}</span>
                  <h3 className="mt-3 font-display text-[1.5rem] leading-[1.12] tracking-[-0.03em] text-white">
                    {idea.title}
                  </h3>
                  <p className="mt-3 text-[15px] leading-7 text-night-muted">{idea.body}</p>
                </div>
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

        <Container className="pb-20 pt-20 sm:pb-24 lg:pb-32 lg:pt-28">
          <YourGoal />
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

/** Every Goal on the wall, for the blank card to suggest one at a time. */
const EXAMPLES = FUTURE_COMPANIES.flat().map((company) => company.goal);
const EXAMPLE_MS = 3400;
const GOAL_LIMIT = 120;
const GOAL_TYPE = "font-display text-[clamp(1.65rem,3.4vw,2.6rem)] leading-[1.08] tracking-[-0.038em]";

/**
 * The page ends where Sunwise began: a charter card, blank this time. It is
 * drawn solid because it is the one thing on this panel that belongs to a
 * person, and nothing written on it leaves the page.
 */
function YourGoal() {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [goal, setGoal] = useState("");
  const [example, setExample] = useState(0);
  const [focused, setFocused] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // While the card is blank, on screen, and nobody is writing on it, it
  // suggests the Goals from the wall, one at a time.
  useEffect(() => {
    if (goal || focused || !visible) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setInterval(() => setExample((current) => (current + 1) % EXAMPLES.length), EXAMPLE_MS);
    return () => clearInterval(timer);
  }, [goal, focused, visible]);

  const written = goal.trim().length > 0;

  return (
    <div ref={ref} className="mx-auto max-w-[48rem]">
      <p className="mx-auto max-w-[30ch] text-balance text-center font-display text-display-md text-white">
        Running a company is no longer the hard part. <span className="text-white/45">Choosing its Goal is.</span>
      </p>

      <figure className="mt-12 rounded-[1.75rem] bg-white px-7 pb-7 pt-7 text-ink shadow-lifted transition-shadow duration-300 focus-within:shadow-[0_0_0_5px_rgb(255_255_255/0.22)] sm:px-10 sm:pb-9 sm:pt-9">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label htmlFor={id} className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-500">
            Goal · written by the board
          </label>
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-400">Your company · day 0</span>
        </div>

        <div className="relative mt-6">
          <textarea
            id={id}
            value={goal}
            onChange={(event) => setGoal(event.target.value.replace(/\s*\n\s*/g, " "))}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            maxLength={GOAL_LIMIT}
            rows={3}
            aria-describedby={`${id}-hint`}
            className={`relative z-10 block h-[4.4em] w-full resize-none bg-transparent text-ink focus:outline-none sm:h-[3.3em] ${GOAL_TYPE}`}
          />
          {/* Four lines on a phone and three from there up: room for the longest Goal on the wall. */}
          {!goal && (
            <p
              key={example}
              aria-hidden
              className={`settle pointer-events-none absolute inset-0 overflow-hidden text-ink-300 ${GOAL_TYPE}`}
            >
              {EXAMPLES[example]}
            </p>
          )}
          <span id={`${id}-hint`} className="sr-only">
            One sentence: a direction and a number. Nothing you write leaves this page.
          </span>
        </div>

        <figcaption className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-line pt-5">
          <Avatar initials="You" size="sm" className="!bg-ink !text-white !ring-ink" />
          <span className="min-w-0 flex-1 text-[13.5px] leading-5 text-ink-600">
            {written
              ? "Signed by you. On day 0, an AI CEO’s Soul opens with this sentence, and the company writes everything else."
              : "A direction and a number, in one sentence. The company writes everything else."}
          </span>
          <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-400">Illustrative · nothing is sent</span>
        </figcaption>
      </figure>
    </div>
  );
}
