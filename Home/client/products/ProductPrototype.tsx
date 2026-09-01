import { useEffect, useState } from "react";
import { PRODUCTS, type ProductDef } from "@/products/data";
import { productPreview } from "@/products/previews";
import { LogoMark } from "@/components/Logo";
import { Mark, type MarkState } from "@/components/Marks";
import { primaryUseCaseForProduct, SHOWCASE_USE_CASES } from "@/products/useCases";
import { Chip, DEPT_FULL, type Dept } from "@/sections/Kit";

/**
 * The product prototype — a picture of the running app, inside a `Pane`.
 *
 * This is the one animated mock on the marketing site and it survives the
 * revamp, because it is doing a job prose cannot: it shows an AI Employee
 * getting three steps into a piece of work and then stopping at the third
 * because a person is needed. What it is no longer allowed to be is a
 * *screenshot in a glow*. The frame it used to carry — a 2xl radius, a
 * 75px-blur drop shadow, a pulsing emerald "Live" pill, an emerald tick on
 * every finished step and a floating white activity card with a second
 * shadow — was six separate ways of saying "this is important" and none of
 * them said what it was. All six are gone.
 *
 * ## HEADCOUNT: the picture is the whole argument in miniature
 *
 * The mock draws no frame of its own any more. `ProductPage` mounts it in a
 * `Pane` carrying the page's 3px department edge, which is how every picture
 * of the application is mounted on this site; a border here as well would be
 * two frames around one thing.
 *
 * Inside, the inversion is drawn three times over:
 *
 *   - **The department is in colour.** The identity row carries a `Chip` in
 *     the product's own department hue, and the step timer draws in the same
 *     hue, because the timer is the machine working.
 *   - **The human is in black, and nothing else is.** The fascia used to be
 *     `ink` — app chrome borrowing the one value reserved for a person, which
 *     put two black objects in a 22rem picture and cost the strip below its
 *     meaning. It is paper now. The only ink inside this mock is the step
 *     that needs someone: the strip across the foot of the stage, and the
 *     step cell under it, both invert to `ink` the moment the story reaches
 *     a Decision or an Approval.
 *   - **State is drawn, not iconified.** The four lucide glyphs this file
 *     used (`Check`, `Clock3`, `LockKeyhole`, `Sparkles`) are replaced by the
 *     Marks, which encode Run / Decision / Approval / Standdown rather than
 *     decorating them.
 *
 * Mono stays a predicate: the clock and the step index are set in the data
 * face because the software emitted them; the prose beside them is not.
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
 * Which department each product belongs to. Colour is the org chart.
 *
 * This is the binding the whole product surface is coloured from — the page's
 * hero chip, its row spines, this mock's pane edge and step timer — so it
 * lives in one table rather than being repeated per page. It is exported from
 * here rather than from `products/data.ts` because that file is asserted on by
 * `tests/catalogue.test.ts` and is out of this pass's scope; it belongs beside
 * `PRODUCT_CLOCK` in any case, since both are facts about how a product is
 * *drawn* rather than about what it does.
 *
 * Six of the fourteen name their own department and need no argument. The
 * other eight are placed by whose work they hold, and the test of a placement
 * is the 24-hour board in `Board.tsx`: if the lane that owns the hue would
 * plausibly file a Run under this product, the binding is right.
 *
 *   ai-employees → operations   the roster, its cron and its transcripts are
 *                               the instance operating itself, which is the
 *                               Operations lane (archives, probes, the sweep)
 *   pipelines    → operations   the plumbing between the other thirteen, run
 *                               on the same lane's schedule
 *   tasks        → workspace    a board is where the team coordinates, and the
 *                               Workspace lane is already threads and tickets
 *   notes        → repositories a Repository is strategy and policy documents
 *                               as much as code (AGENTS.md §3); Notes is the
 *                               same material under the same Grants
 *   resources    → repositories the company library, filed in the same lane
 *   bases        → revenue      the shipped templates lead with a CRM, and a
 *                               Base is where a revenue team keeps its rows
 *   customers    → revenue      Contacts, Deals and accounts are one lane
 *   explore      → finance      the dashboards a company closes a month on;
 *                               Explore's own figure is June at $48,220
 *
 * Nothing on this site may use a hue for a mood, so a product that fitted no
 * department would have to go without one rather than borrow the nearest.
 * None does.
 */
export const PRODUCT_DEPT: Record<string, Dept> = {
  "ai-employees": "operations",
  workspace: "workspace",
  tasks: "workspace",
  bases: "revenue",
  notes: "repositories",
  resources: "repositories",
  pipelines: "operations",
  explore: "finance",
  marketing: "marketing",
  revenue: "revenue",
  email: "email",
  customers: "revenue",
  finance: "finance",
  repositories: "repositories",
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
  // The fallback is Operations rather than nothing: an unbound product would
  // otherwise draw a colourless mock, and a missing hue reads as a design
  // decision rather than as the missing table entry it is.
  const dept = PRODUCT_DEPT[activeProduct.slug] ?? "operations";

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
    // No border of its own. The `Pane` this is mounted in draws the 1px frame
    // and the 3px department edge, and two frames around one picture is the
    // "screenshot in a card" move the revamp deleted everywhere else.
    <section
      aria-label={`Animated ${activeProduct.name} product preview`}
      className={`prototype-shell pointer-events-none select-none overflow-hidden bg-surface ${className}`}
    >
      {/* The one sentence a screen reader gets. Everything below it is a
          picture of a UI, so it is hidden rather than narrated cell by cell. */}
      <span className="sr-only">
        Genosyn running a {activeUseCase.role} use case in {activeProduct.name}.
      </span>

      <div aria-hidden>
        <PrototypeFascia clock={clock} />

        {/* The identity row, and the one place the department is named in
            words. The chip carries the department rather than the product,
            because the hue has to mean the same thing here as it does on the
            wall and in the row spines below the fold — a product-coloured chip
            would be fourteen hues meaning fourteen products, which is the
            legend this system replaced.

            Beside it is the use case's role rather than the product name. Six
            of the fourteen products are named after their own department, so
            printing both gave "FINANCE · Finance" on nearly half the pages;
            the product is named in the figure caption and the headline
            already, and who is at the keyboard is the fact this row was
            missing. */}
        <div className="flex h-11 items-center gap-2.5 border-b border-hairline px-3">
          <Chip dept={dept} className="shrink-0">
            {dept}
          </Chip>
          <span className="min-w-0 truncate text-[11px] text-ink">{activeUseCase.role}</span>
          {/* The Approval mark is ink even here, at 10px: it is the state that
              needs a person, and it takes no hue anywhere on this site. */}
          <span className="ml-auto hidden shrink-0 items-center gap-1.5 text-ink sm:flex">
            <Mark state="approval" className="h-2.5 w-2.5" />
            <span className="t-field text-[10px]">Approvals on</span>
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

        <div className="grid grid-cols-3 border-t border-hairline">
          {stories.map((candidate, index) => (
            <StoryStep
              key={candidate.label}
              story={candidate}
              index={index}
              storyIndex={storyIndex}
              ticking={motionEnabled}
              dept={dept}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * The mock's own fascia: whose install this is, and what time it is there.
 *
 * It was `ink`, drawn the way the site's own header is. That was wrong under
 * HEADCOUNT for a reason that is not aesthetic: ink is the value reserved for
 * the human, and a near-black bar of chrome at the top of the picture meant
 * the ink strip at the bottom — the step that actually needs a person — was
 * the second black thing a reader found rather than the only one. Paper with
 * a hairline under it says "chrome" perfectly well and costs the argument
 * nothing.
 *
 * The emerald "Live" pill that used to sit on the right is gone — a pulsing
 * dot next to the word "Live" was an assertion with nothing behind it, and a
 * clock is a fact.
 */
function PrototypeFascia({ clock }: { clock: string }) {
  return (
    <div className="flex min-w-0 items-center gap-3 border-b border-hairline bg-ground px-3 py-2">
      <LogoMark className="h-4 w-4 shrink-0 text-ink" />
      <span className="t-field min-w-0 truncate text-[10px] text-ink">Northstar Labs</span>
      <span className="t-data ml-auto shrink-0 text-[10px] leading-none text-muted">{clock}</span>
    </div>
  );
}

/**
 * The line across the foot of the stage.
 *
 * It used to be a floating white card with a rounded corner and a shadow,
 * which is the "badge over a screenshot" move the revamp deleted everywhere
 * else. It is now a full-width strip anchored to the bottom rule of the
 * stage — and when the step is one only a person can clear, the whole strip
 * inverts to ink. It is now the only black object in the picture, which is
 * the whole argument of the site happening inside a 22rem-wide figure.
 */
function StoryLine({ story, clock }: { story: PrototypeStory; clock: string }) {
  const human = story.state === "decision" || story.state === "approval";

  return (
    <div
      className={`absolute inset-x-0 bottom-0 flex items-center gap-2.5 border-t px-3 py-2 ${
        human ? "border-ink bg-ink text-ground" : "border-rule bg-surface text-ink"
      }`}
    >
      <Mark state={story.state} className={`h-3 w-3 ${human ? "" : "text-ink2"}`} />
      <span className="min-w-0">
        <span className="t-field block text-[10px]">{story.label}</span>
        <span
          className={`mt-0.5 block truncate text-[11px] leading-4 ${
            human ? "text-ground/85" : "text-muted"
          }`}
        >
          {story.detail}
        </span>
      </span>
      <span
        className={`t-data ml-auto shrink-0 text-[10px] leading-none ${
          human ? "text-ground/70" : "text-muted"
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
 * Run mark now, because that is what a finished step is.
 *
 * Three cells meeting on 1px seams, and the state is carried by the fill:
 *
 *   - A step that needs a person is **ink** — inverted outright while it is
 *     the live one, and set in full-strength ink before the story reaches it,
 *     so a reader can see the stop coming two cells away. Every product whose
 *     story ends in a Decision or an Approval therefore ends dark, and the
 *     seven that do not, do not. That difference is real and it is the one
 *     thing about a product a buyer most wants to know.
 *   - The timer under the live step draws in the **department hue**, because
 *     the timer is the machine working. On the inverted cell it drops to
 *     paper: an ochre or a bottle green on near-black is a 2px line nobody
 *     can see, and a progress bar that cannot be seen is not one.
 */
function StoryStep({
  story,
  index,
  storyIndex,
  ticking,
  dept,
}: {
  story: PrototypeStory;
  index: number;
  storyIndex: number;
  ticking: boolean;
  dept: Dept;
}) {
  const current = index === storyIndex;
  const done = index < storyIndex;
  const human = story.state === "decision" || story.state === "approval";

  const skin = current
    ? human
      ? "bg-ink text-ground"
      : "bg-ground text-ink"
    : human
      ? "text-ink"
      : "text-muted";

  return (
    <div
      className={`relative min-w-0 border-l border-hairline px-2.5 py-2.5 first:border-l-0 ${skin}`}
    >
      <span className="flex items-center gap-1.5">
        <Mark state={done ? "run" : story.state} className="h-2.5 w-2.5 shrink-0" />
        {/* The index is dropped on the narrowest screens: three cells across
            375px leave the label about nine characters, and an ordinal is the
            part a reader can infer from position. */}
        <span className="t-data hidden shrink-0 text-[9px] leading-none sm:inline">
          {String(index + 1).padStart(2, "0")}
        </span>
        <span className="t-field min-w-0 truncate text-[10px]">{story.label}</span>
      </span>
      {current && ticking && (
        <span
          className={`prototype-progress absolute inset-x-0 bottom-0 h-0.5 origin-left ${
            human ? "bg-ground" : DEPT_FULL[dept]
          }`}
        />
      )}
    </div>
  );
}
