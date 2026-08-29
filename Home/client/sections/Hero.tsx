import { ArrowRight, Github, ShieldCheck } from "lucide-react";
import { GITHUB_URL } from "@/lib/constants";
import { CompanyPreview } from "@/sections/CompanyPreview";
import { Accent, Button, Display, Lede } from "@/sections/Kit";

/**
 * The landing hero.
 *
 * It is centred and full-bleed rather than the two-column layout every other
 * page hero uses. Two reasons: the claim is four words long and deserves the
 * whole width, and the product mock — the actual evidence for the claim — was
 * squeezed into a 550px column before, which made the thing the page is
 * selling the smallest element on the screen.
 */

const PROOF = [
  "Runs unattended, on schedule",
  "Escalates by exception",
  "Any AI model, your own keys",
  "Self-hosted · Apache 2.0 licensed",
];

export function Hero() {
  return (
    <section className="grain relative isolate overflow-hidden bg-paper-50">
      <div aria-hidden className="pointer-events-none absolute inset-0 aurora animate-drift" />
      <div aria-hidden className="pointer-events-none absolute inset-0 paper-grid" />

      <div className="relative z-10 mx-auto max-w-[88rem] px-5 pb-20 pt-16 sm:px-8 sm:pb-24 sm:pt-24 lg:pb-28">
        <div className="mx-auto flex max-w-4xl flex-col items-center text-center">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="group inline-flex items-center gap-2.5 rounded-full border border-stone-900/[0.10] bg-white/85 py-1.5 pl-3 pr-3 text-xs font-semibold text-stone-600 shadow-card backdrop-blur transition hover:border-flame-300 hover:text-flame-700"
          >
            <span aria-hidden className="preview-live h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Open source
            <span aria-hidden className="h-1 w-1 rounded-full bg-flame-400" />
            Self-hosted
            <span aria-hidden className="h-1 w-1 rounded-full bg-flame-400" />
            <span className="text-stone-500">v{__APP_VERSION__}</span>
            <ArrowRight
              aria-hidden
              className="h-3.5 w-3.5 transition group-hover:translate-x-0.5"
            />
            <span className="sr-only">{"(opens in a new tab)"}</span>
          </a>

          <Display className="mt-8 text-[clamp(2.75rem,8.2vw,6rem)]">
            Companies can now <Accent>run themselves.</Accent>
          </Display>

          <Lede className="mt-7 max-w-3xl text-balance">
            Genosyn is the operating system for autonomous companies. AI Employees hold real roles,
            work through the night on their own schedule, and bring you only the decisions that
            actually need a human.
          </Lede>

          <div className="mt-10 flex w-full flex-col items-center gap-3 sm:w-auto sm:flex-row sm:flex-wrap sm:justify-center">
            <Button href="/#quickstart">
              Build an autonomous company
              <ArrowRight aria-hidden className="h-4 w-4" />
            </Button>
            <Button href="/#autonomy" variant="secondary">
              Watch a day it ran alone
              <ArrowRight aria-hidden className="h-4 w-4 text-flame-500" />
            </Button>
            <Button href={GITHUB_URL} external variant="ghost">
              <Github aria-hidden className="h-4 w-4" />
              GitHub
            </Button>
          </div>

          <ul className="mt-11 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-xs font-semibold text-stone-500">
            {PROOF.map((item, index) => (
              <li key={item} className="flex items-center gap-3">
                {index > 0 && <span aria-hidden className="h-1 w-1 rounded-full bg-flame-400" />}
                {item}
              </li>
            ))}
          </ul>
        </div>

        <ProductStage />
      </div>
    </section>
  );
}

/**
 * The product mock, given the full container width and lit from beneath. It is
 * the only screenshot on the page, so it gets the space and the glow rather
 * than sharing a row with the headline.
 */
function ProductStage() {
  return (
    <div className="relative mt-16 sm:mt-20">
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-x-10 -top-12 bottom-0 -z-10 rounded-[4rem] bg-[radial-gradient(60%_50%_at_50%_0%,rgba(255,122,69,0.28),transparent_70%)] blur-2xl"
      />

      <div className="mb-4 flex flex-col gap-2 px-1 text-[11px] font-semibold text-stone-500 sm:flex-row sm:items-center sm:justify-between">
        <span className="truncate">Northstar Labs · Tuesday, 09:30</span>
        <span className="inline-flex shrink-0 items-center gap-2 text-emerald-700">
          <span aria-hidden className="preview-live h-1.5 w-1.5 rounded-full bg-emerald-500" />
          18 Routines ran before anyone signed in
        </span>
      </div>

      <div className="relative">
        <CompanyPreview />

        <div className="absolute -bottom-6 right-3 hidden items-center gap-3 rounded-2xl border border-stone-900/[0.08] bg-white/95 px-4 py-3 shadow-raise backdrop-blur-xl sm:flex lg:-right-4">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-flame-50 text-flame-600 ring-1 ring-inset ring-flame-200">
            <ShieldCheck aria-hidden className="h-4 w-4" />
          </span>
          <span>
            <span className="block text-[11px] font-semibold text-stone-900">
              You are in the loop by exception
            </span>
            <span className="mt-0.5 block font-mono text-[10px] text-stone-500">
              3 decisions waiting · everything else shipped
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
