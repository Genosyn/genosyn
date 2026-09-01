import { useEffect, useState } from "react";
import { PRODUCTS, type ProductDef } from "@/products/data";
import { productPreview } from "@/products/previews";
import { LogoMark } from "@/components/Logo";
import { Mark, type MarkState } from "@/components/Marks";
import { primaryUseCaseForProduct, SHOWCASE_USE_CASES } from "@/products/useCases";

/**
 * The product prototype — a picture of the running app, on a plate.
 *
 * This is the one animated mock on the marketing site and it survives the
 * revamp, because it is doing a job prose cannot: it shows an AI Employee
 * getting three steps into a piece of work and then stopping at the third
 * because a person is needed. What it is no longer allowed to be is a
 * *screenshot in a glow*. The frame it used to carry — a 2xl radius, a
 * 75px-blur drop shadow, a pulsing emerald "Live" pill, an emerald tick on
 * every finished step and a floating white activity card with a second
 * shadow — was six separate ways of saying "this is important" and none of
 * them said what it was. All six are gone. `ProductPage` mounts what is left
 * inside a `Plate`, so it reads as a numbered figure in a document.
 *
 * Three rules govern the inside now, and they are the site's rules rather
 * than this file's:
 *
 *   - **Warm neutrals only.** The emerald, the cool `#f8fafc` stage and the
 *     per-product pastel ring are mapped onto the paper ramp. The single
 *     exception is the story step that needs a person, which takes signal
 *     amber as a fill carrying near-black text.
 *   - **Mono is a predicate.** The clock and the step index are set in the
 *     data face because the software emitted them. The prose beside them is
 *     not.
 *   - **State is drawn, not iconified.** The four lucide glyphs this file
 *     used (`Check`, `Clock3`, `LockKeyhole`, `Sparkles`) are replaced by the
 *     Marks, which encode Run / Decision / Approval / Standdown rather than
 *     decorating them.
 *
 * Two structural things are load-bearing and must not be lost:
 *
 *   - `tests/catalogue.test.ts` asserts this file **never renders a nested
 *     `<main>`**. The mock is mounted inside the page's own `<main>`, and a
 *     second one is an HTML conformance error that leaves a screen reader two
 *     "main" regions to choose between. The chrome is `aria-hidden` under one
 *     `sr-only` sentence instead.
 *   - The `prototype-*` classes still live in `index.css` and still own the
 *     containment, the stage height and the step timer bar.
 */

type PrototypeStory = {
  label: string;
  detail: string;
  /**
   * What the app is showing at this step. Only `decision` and `approval` take
   * colour; a Run is the ordinary case and is drawn in ink.
   */
  state: MarkState;
};

const STORY_DURATION_MS = 3200;

/**
 * How much of the mock a page shows.
 *
 * Fourteen product pages that no longer have a hue each are at real risk of
 * reading as one page with the nouns swapped, and the honest fix is not to
 * reintroduce fourteen accents — it is to show fourteen different pictures.
 * So each page picks a crop, and the choice is measured rather than felt:
 * every preview was measured at its drawn width, and a page takes the tallest
 * crop that is still *shorter* than its own preview. A crop taller than the
 * content is not a crop, it is a box with a hole in the bottom of it, and
 * that is what the old fixed 29rem stage produced on eleven of the fourteen.
 *
 * The heights are fixed rather than min/max pairs for the same reason: the
 * mock is a window onto a screen that continues past it, and a window that
 * resizes itself to whatever is behind it is a panel.
 *
 * The `!` matters. `.prototype-stage` is plain CSS declared after
 * `@tailwind utilities`, so an unprefixed `min-h-*` would lose to it.
 */
export type PrototypeCrop = "band" | "panel" | "screen";

const CROP: Record<PrototypeCrop, string> = {
  band: "!min-h-[13rem] !max-h-[13rem] sm:!min-h-[14rem] sm:!max-h-[14rem]",
  panel: "!min-h-[16rem] !max-h-[16rem] sm:!min-h-[18rem] sm:!max-h-[18rem]",
  screen: "!min-h-[20rem] !max-h-[20rem] sm:!min-h-[24rem] sm:!max-h-[24rem]",
};

/**
 * The width the mock is drawn at, and why it is fixed rather than fluid.
 *
 * The plate lives in the hero's aside column, which is about 480px wide at
 * every viewport past `xl` — the container is capped at 82rem, so it does not
 * get wider on a 27-inch screen. `previews.tsx` sizes itself off the
 * *viewport*, though, so at 1440px it lays out its three-column desktop grid
 * inside that 480px box and the figures collide with their own labels.
 *
 * Forcing the design width from `lg` up and letting the plate clip the
 * overflow fixes that, and it is the more honest picture anyway: what you are
 * looking at is a crop of a wider screen, which is what it always was. Each
 * crop takes a different width, so the fourteen pages differ in how much of
 * the app they show as well as how much of its height. Below `lg` the mock is
 * fluid, because there the preview's own mobile layout is the right one.
 */
const STAGE_WIDTH: Record<PrototypeCrop, string> = {
  band: "lg:w-[34rem]",
  panel: "lg:w-[38rem]",
  screen: "lg:w-[43rem]",
};

/**
 * The clock in each mock's fascia.
 *
 * It used to read 08:42 on all fourteen pages. Now it is the hour that
 * product's work actually happens at on the board — Finance reconciles at
 * 04:05, Email triages at 05:45, Paid Marketing waits until someone is awake
 * to approve a spend increase. It is the cheapest possible differentiator and
 * it is also true to the argument the rest of the site makes.
 */
const PRODUCT_CLOCK: Record<string, string> = {
  "ai-employees": "06:00",
  workspace: "09:12",
  tasks: "08:15",
  bases: "07:30",
  notes: "02:20",
  resources: "01:10",
  pipelines: "03:40",
  explore: "08:50",
  marketing: "10:05",
  revenue: "06:35",
  email: "05:45",
  customers: "07:05",
  finance: "04:05",
  repositories: "05:10",
};

/**
 * `previews.tsx` still files the Repositories mock under its old `code` key.
 * That file belongs to another pass, so the mapping is corrected here rather
 * than renamed there; when the key moves, this entry can go.
 */
const PREVIEW_ALIAS: Record<string, string> = {
  repositories: "code",
};

const PRODUCT_STORIES: Record<string, PrototypeStory[]> = {
  "ai-employees": [
    {
      label: "Routine started",
      detail: "Mira opened the daily reconciliation brief.",
      state: "run",
    },
    {
      label: "Working inside Grants",
      detail: "42 Stripe charges matched against the ledger.",
      state: "run",
    },
    {
      label: "Decision stacked",
      detail: "One exception is waiting for a Member to answer.",
      state: "decision",
    },
  ],
  workspace: [
    {
      label: "Mention received",
      detail: "Alex joined #marketing and read the thread.",
      state: "run",
    },
    {
      label: "Drafting in channel",
      detail: "The Friday digest is assembling from shared files.",
      state: "run",
    },
    {
      label: "Reply posted",
      detail: "The draft went back to the channel.",
      state: "run",
    },
  ],
  tasks: [
    {
      label: "Todo assigned",
      detail: "Sam picked up the checkout reliability review.",
      state: "run",
    },
    {
      label: "Work in progress",
      detail: "Logs and the latest deployment are being read.",
      state: "run",
    },
    {
      label: "Moved to in_review",
      detail: "The todo is sitting in a human reviewer's queue.",
      state: "approval",
    },
  ],
  bases: [
    {
      label: "Record changed",
      detail: "A customer moved from Trial to Pro.",
      state: "run",
    },
    {
      label: "View refreshed",
      detail: "Renewal risk and MRR recalculated across 118 rows.",
      state: "run",
    },
    {
      label: "Team notified",
      detail: "The account owner got a Workspace message.",
      state: "run",
    },
  ],
  notes: [
    {
      label: "Brief opened",
      detail: "Alex found the launch narrative in shared Notes.",
      state: "run",
    },
    {
      label: "Page updated",
      detail: "Research and customer language went into the draft.",
      state: "run",
    },
    {
      label: "Change journaled",
      detail: "The edit is attributed and the old version kept.",
      state: "run",
    },
  ],
  resources: [
    {
      label: "Source added",
      detail: "A billing guide was saved to the company library.",
      state: "run",
    },
    {
      label: "Content extracted",
      detail: "The PDF body is searchable by every AI Employee.",
      state: "run",
    },
    {
      label: "Resource cited",
      detail: "Mira linked the source from her reconciliation Run.",
      state: "run",
    },
  ],
  pipelines: [
    {
      label: "Trigger received",
      detail: "Stripe reported a payment over $1,000.",
      state: "run",
    },
    {
      label: "Branch matched",
      detail: "The high-value customer path was selected.",
      state: "run",
    },
    {
      label: "Nodes finished",
      detail: "The record updated and the team was notified.",
      state: "run",
    },
  ],
  explore: [
    {
      label: "Query running",
      detail: "Monthly recurring revenue is loading from Postgres.",
      state: "run",
    },
    {
      label: "Chart refreshed",
      detail: "June closed at $48,220, up 8.4%.",
      state: "run",
    },
    {
      label: "Dashboard shared",
      detail: "The operating view is live for the company.",
      state: "run",
    },
  ],
  marketing: [
    {
      label: "Spend reviewed",
      detail: "Alex compared campaign cost per acquisition with target.",
      state: "run",
    },
    {
      label: "Change proposed",
      detail: "Brand Search wants another $400 a day.",
      state: "run",
    },
    {
      label: "Approval waiting",
      detail: "The increase is held until a Member ticks it.",
      state: "approval",
    },
  ],
  revenue: [
    {
      label: "Signal fired",
      detail: "Acme crossed the high-intent usage threshold.",
      state: "run",
    },
    {
      label: "Context assembled",
      detail: "The Contact, the Deal and the timeline were read.",
      state: "run",
    },
    {
      label: "Approval waiting",
      detail: "A Sequence is queued and nothing has sent.",
      state: "approval",
    },
  ],
  email: [
    {
      label: "Inbox triaged",
      detail: "Mira found 31 messages needing a reply.",
      state: "run",
    },
    {
      label: "Drafts prepared",
      detail: "Customer context came from Customers and Notes.",
      state: "run",
    },
    {
      label: "Approval waiting",
      detail: "Three replies are drafted and none have sent.",
      state: "approval",
    },
  ],
  customers: [
    {
      label: "Health recalculated",
      detail: "Usage and support activity were combined.",
      state: "run",
    },
    {
      label: "Risk detected",
      detail: "Northstar moved to Watch with two reasons.",
      state: "run",
    },
    {
      label: "Owner notified",
      detail: "A recovery todo landed on the account team.",
      state: "run",
    },
  ],
  finance: [
    {
      label: "Payments imported",
      detail: "42 Stripe charges arrived for reconciliation.",
      state: "run",
    },
    {
      label: "Ledger matched",
      detail: "41 entries matched with no human typing.",
      state: "run",
    },
    {
      label: "Decision stacked",
      detail: "One £42 charge needs a Member to classify it.",
      state: "decision",
    },
  ],
  repositories: [
    {
      label: "Repository opened",
      detail: "Sam inspected the failing checkout service.",
      state: "run",
    },
    {
      label: "Patch prepared",
      detail: "The Checks pass and the diff is readable.",
      state: "run",
    },
    {
      label: "Approval waiting",
      detail: "The branch is waiting on a human merge.",
      state: "approval",
    },
  ],
};

type ProductPrototypeProps = {
  product?: ProductDef;
  className?: string;
  /** How much of the mock to show. See `PrototypeCrop`. */
  crop?: PrototypeCrop;
};

export function ProductPrototype({
  product,
  className = "",
  crop = "panel",
}: ProductPrototypeProps) {
  const [showcaseIndex, setShowcaseIndex] = useState(0);
  const [storyIndex, setStoryIndex] = useState(0);
  const [motionEnabled, setMotionEnabled] = useState(true);

  const activeUseCase = product
    ? primaryUseCaseForProduct(product.slug)
    : SHOWCASE_USE_CASES[showcaseIndex];
  const activeProduct =
    product ??
    PRODUCTS.find((candidate) => candidate.slug === activeUseCase.primaryProductSlug) ??
    PRODUCTS[0];
  const stories = PRODUCT_STORIES[activeProduct.slug] ?? [];
  const story = stories[storyIndex] ?? stories[0];
  const Preview =
    productPreview(activeProduct.slug) ??
    productPreview(PREVIEW_ALIAS[activeProduct.slug] ?? activeProduct.slug);
  const clock = PRODUCT_CLOCK[activeProduct.slug] ?? "08:42";

  useEffect(() => {
    setShowcaseIndex(0);
    setStoryIndex(0);
  }, [product?.slug]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setMotionEnabled(false);
    }
  }, []);

  useEffect(() => {
    if (!motionEnabled || stories.length === 0) return;
    const timer = window.setTimeout(() => {
      if (storyIndex < stories.length - 1) {
        setStoryIndex((current) => current + 1);
        return;
      }

      setStoryIndex(0);
      if (!product) {
        setShowcaseIndex((current) => (current + 1) % SHOWCASE_USE_CASES.length);
      }
    }, STORY_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [motionEnabled, product, stories.length, storyIndex]);

  return (
    <section
      aria-label={`Animated ${activeProduct.name} product preview`}
      className={`prototype-shell pointer-events-none select-none overflow-hidden border border-paper-400 bg-paper-50 ${className}`}
    >
      {/* The one sentence a screen reader gets. Everything below it is a
          picture of a UI, so it is hidden rather than narrated cell by cell. */}
      <span className="sr-only">
        Genosyn running a {activeUseCase.role} use case in {activeProduct.name}.
      </span>

      <div aria-hidden>
        <PrototypeFascia clock={clock} />

        <div className="flex h-11 items-center gap-3 border-b border-paper-300 px-3">
          <span className="t-cond shrink-0 text-[11px] uppercase tracking-field text-zinc-950">
            {activeProduct.name}
          </span>
          <span className="t-body min-w-0 truncate text-[11px] text-zinc-600">
            {activeUseCase.role}
          </span>
          <span className="ml-auto hidden shrink-0 items-center gap-1.5 text-zinc-600 sm:flex">
            <Mark state="approval" className="h-2.5 w-2.5" />
            <span className="t-cond text-[10px] uppercase tracking-field">Approvals on</span>
          </span>
        </div>

        <div
          key={`${activeProduct.slug}-${showcaseIndex}`}
          // `overflow-hidden` on both axes, deliberately. `STAGE_WIDTH` forces
          // the mock to its design width from `lg` up and the plate clips it:
          // what you are looking at is a crop of a wider screen. Making it
          // scroll instead was tried and reverted — `scrollbar-none` would hide
          // the affordance, so a reader sees the same cut edge and now cannot
          // tell there is more, which is worse than an honest crop inside a
          // framed, numbered figure.
          className={`prototype-stage relative overflow-hidden ${CROP[crop]}`}
        >
          {Preview && (
            <div className={STAGE_WIDTH[crop]}>
              <Preview />
            </div>
          )}
          {story && <StoryLine story={story} clock={clock} />}
        </div>

        <div className="grid grid-cols-3 border-t border-paper-300">
          {stories.map((candidate, index) => (
            <StoryStep
              key={candidate.label}
              story={candidate}
              index={index}
              storyIndex={storyIndex}
              ticking={motionEnabled}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * The mock's own fascia, drawn the way the site's header is: near-black, a
 * wordmark, and facts in mono. The emerald "Live" pill that used to sit on
 * the right is gone — a pulsing dot next to the word "Live" was an assertion
 * with nothing behind it, and a clock is a fact.
 */
function PrototypeFascia({ clock }: { clock: string }) {
  return (
    <div className="flex min-w-0 items-center gap-3 bg-zinc-950 px-3 py-2">
      <LogoMark className="h-4 w-4 shrink-0 text-paper-50" />
      <span className="t-cond min-w-0 truncate text-[10px] uppercase tracking-field text-paper-50">
        Northstar Labs
      </span>
      <span className="t-data ml-auto shrink-0 text-[10px] leading-none text-zinc-400">
        {clock}
      </span>
    </div>
  );
}

/**
 * The line across the foot of the stage.
 *
 * It used to be a floating white card with a rounded corner and a shadow,
 * which is the "badge over a screenshot" move the revamp deleted everywhere
 * else. It is now a full-width strip anchored to the bottom rule of the
 * stage — and when the step is one only a person can clear, the strip is
 * amber carrying near-black text. That is the whole argument of the site
 * happening inside a 22rem-wide picture.
 */
function StoryLine({ story, clock }: { story: PrototypeStory; clock: string }) {
  const human = story.state === "decision" || story.state === "approval";

  return (
    <div
      className={`absolute inset-x-0 bottom-0 flex items-center gap-2.5 border-t px-3 py-2 ${
        human ? "border-signal-500 bg-signal-500 text-zinc-950" : "border-paper-400 bg-paper-50"
      }`}
    >
      <Mark state={story.state} className={`h-3 w-3 ${human ? "" : "text-zinc-700"}`} />
      <span className="min-w-0">
        <span
          className={`t-cond block text-[10px] uppercase tracking-field ${
            human ? "" : "text-zinc-950"
          }`}
        >
          {story.label}
        </span>
        <span
          className={`t-body mt-0.5 block truncate text-[11px] leading-4 ${
            human ? "" : "text-zinc-600"
          }`}
        >
          {story.detail}
        </span>
      </span>
      <span
        className={`t-data ml-auto shrink-0 text-[10px] leading-none ${
          human ? "" : "text-zinc-600"
        }`}
      >
        {clock}
      </span>
    </div>
  );
}

/**
 * One of the three steps under the stage.
 *
 * A finished step used to take an emerald tick in a pastel circle. It takes a
 * Run mark now, because that is what a finished step is, and the colour it
 * saved is spent on the step that actually needs someone.
 */
function StoryStep({
  story,
  index,
  storyIndex,
  ticking,
}: {
  story: PrototypeStory;
  index: number;
  storyIndex: number;
  ticking: boolean;
}) {
  const current = index === storyIndex;
  const done = index < storyIndex;

  return (
    <div
      className={`relative min-w-0 px-2.5 py-2.5 ${
        current ? "bg-paper-200 text-zinc-950" : "text-zinc-600"
      }`}
    >
      <span className="flex items-center gap-1.5">
        <Mark state={done ? "run" : story.state} className="h-2.5 w-2.5 shrink-0" />
        {/* The index is dropped on the narrowest screens: three cells across
            375px leave the label about nine characters, and an ordinal is the
            part a reader can infer from position. */}
        <span className="t-data hidden shrink-0 text-[9px] leading-none sm:inline">
          {String(index + 1).padStart(2, "0")}
        </span>
        <span className="t-cond min-w-0 truncate text-[10px] uppercase tracking-field">
          {story.label}
        </span>
      </span>
      {current && ticking && (
        <span className="prototype-progress absolute inset-x-0 bottom-0 h-0.5 origin-left bg-zinc-950" />
      )}
    </div>
  );
}
