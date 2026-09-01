import type { ReactNode } from "react";
import { Link } from "@/lib/router";
import { ArrowEast, Mark, type MarkState } from "@/components/Marks";

/**
 * The marketing design kit — "Night Board".
 *
 * Every marketing page composes these, and the rule the file exists to
 * enforce is unchanged from the version before it: a section never invents
 * its own surface, label, heading ramp or control skin. What changed is what
 * those primitives are.
 *
 * The site is an operations board. Left-to-right is time, a bar's width is a
 * duration, a rule is a boundary, and one colour marks the row that needs a
 * person. Three consequences run through everything below:
 *
 * 1. **A set of things is a stack of rows, not a grid of cards.** `Row` is the
 *    workhorse; there is no `Panel`. Cards were doing two jobs — grouping and
 *    signalling importance — and a hairline plus a column does the first
 *    without pretending to do the second.
 *
 * 2. **Contrast is width, not weight.** `Display`, `Sheet` and `Body` set the
 *    Archivo axes through the `.t-*` classes in index.css and nowhere else.
 *
 * 3. **Mono is a predicate, not a texture.** `Field` is for strings the
 *    software emitted or ingested — a timestamp, a Run ref, a count, a cron
 *    line, a command. It is never flavour on a sentence. The previous site had
 *    68 mono spans on marketing prose, which is what made the data look
 *    decorative rather than real.
 */

/* -------------------------------------------------------------------------
   Surfaces
------------------------------------------------------------------------- */

export type BandTone = "paper" | "raised" | "night";

/**
 * Vertical rhythm, and the rule for choosing it.
 *
 * The previous site had one padding value on all eight bands, which is why it
 * had no dynamics: nothing got more room because it mattered more. The rule
 * here is a condition rather than a preference — **a band gets `l` only if it
 * contains a timetable.** Everything else is `m`, a strip band is `xs`, and
 * `s` is for the tail of a page (FAQ, footer nav). Without that sentence this
 * drifts back to uniform inside a month.
 *
 * The padding is ASYMMETRIC, and that is the second half of the rule: a band
 * declares how much air it OPENS with, and always closes with about half. When
 * both halves were equal every boundary was the sum of two independent
 * decisions and nobody had chosen the gap — the Hero closed with 176px and
 * Roles opened with 176px, so the most important seam on the page was 353px of
 * empty paper that neither band had asked for. Now the band above owns the
 * seam and the numbers are readable: Hero to Roles is 96 + 176.
 */
export type BandPad = "xs" | "s" | "m" | "l" | "none";

const BAND_TONE: Record<BandTone, string> = {
  paper: "bg-paper-100 text-zinc-700",
  raised: "bg-paper-50 text-zinc-700",
  night: "on-night bg-night-950 text-zinc-400",
};

/**
 * The rhythm ladder. A band declares how much air it OPENS with and how much
 * it CLOSES with, from the same four steps, and the seam between two bands is
 * the close of the one above plus the open of the one below.
 *
 * Independent open and close is the whole point. When the two were locked
 * together the page only ever produced two values — 176px and 112px, a ratio
 * of 1.57 — so it had metre and no dynamics: nothing was loud and nothing was
 * quiet. The hero in particular opened with 176px of empty paper above its own
 * headline and pushed the board, which is the entire proof, 150px below the
 * fold at a normal laptop height. A headline is what opens a publication, so
 * the hero now opens on `xs` and closes on `l`.
 */
const BAND_OPEN: Record<BandPad, string> = {
  none: "",
  xs: "pt-8 sm:pt-10",
  s: "pt-12 sm:pt-16 lg:pt-[4.5rem]",
  m: "pt-16 sm:pt-20 lg:pt-28",
  l: "pt-20 sm:pt-28 lg:pt-44",
};

const BAND_CLOSE: Record<BandPad, string> = {
  none: "",
  xs: "pb-6",
  s: "pb-8 sm:pb-10",
  m: "pb-10 sm:pb-12 lg:pb-16",
  l: "pb-16 sm:pb-20 lg:pb-24",
};

/**
 * A full-bleed band.
 *
 * Bands are grouped by meaning rather than alternated. The landing page runs
 * paper / paper / paper / NIGHT / paper / paper: exactly one tone change,
 * placed where the argument actually goes dark. The previous checkerboard
 * (white, tint, white, night, white, tint…) was the fallback rule you apply
 * when you have no reason of your own.
 */
export function Band({
  id,
  tone = "paper",
  pad = "m",
  open,
  close,
  rule = true,
  className = "",
  children,
}: {
  id?: string;
  tone?: BandTone;
  /** Shorthand: sets both open and close to the same step. */
  pad?: BandPad;
  /** Air above the content. Overrides `pad`. */
  open?: BandPad;
  /** Air below it. Overrides `pad`. */
  close?: BandPad;
  rule?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className={`relative ${BAND_TONE[tone]} ${
        rule && tone !== "night" ? "border-t border-paper-400" : ""
      } ${className}`}
    >
      {/* The spine. Positioned on the same arithmetic the rail uses — the
          container's inline padding plus the 9.5rem gutter — so it lands under
          every rail's left edge and continues through the band padding and
          behind any instrument that breaks out of the rail. Opaque surfaces
          (the board, a plate) occlude it, which reads correctly: a rule
          passing behind an instrument rather than stopping at it. */}
      <span
        aria-hidden
        className={`pointer-events-none absolute inset-y-0 hidden w-px lg:block ${
          tone === "night" ? "bg-night-600" : "bg-paper-400"
        }`}
        style={{
          left: "calc(max((100% - 82rem) / 2, 0px) + clamp(1.25rem, 4vw, 3rem) + 9.5rem)",
        }}
      />
      <div className={`relative ${BAND_OPEN[open ?? pad]} ${BAND_CLOSE[close ?? pad]}`}>
        {children}
      </div>
    </section>
  );
}

/**
 * The one container width.
 *
 * 82rem, narrower than the 88rem it replaces, so a measure is a measure. The
 * inline padding is a clamp rather than a breakpoint step because the rail's
 * vertical rule has to land in the same place at every width or it stops
 * being one line.
 */
export function Container({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`mx-auto w-full max-w-[82rem] px-[clamp(1.25rem,4vw,3rem)] ${className}`}>
      {children}
    </div>
  );
}

/**
 * The rail — the site-wide layout primitive and the thing that holds it
 * together.
 *
 * A fixed gutter column carries the sheet number and whatever mono fields the
 * band has (a date, a count, a Run ref); the content column carries a 1px
 * structural rule down its left edge. Because every band uses the identical
 * grid, that rule is continuous from the header to the footer — one unbroken
 * vertical line down the whole document. It replaces the Eyebrow component's
 * 27 call sites and its 8 hand-inlined copies, and unlike an eyebrow it has a
 * job on bands that have nothing to announce.
 *
 * Below `lg` the gutter collapses and its contents move inline above the
 * content, because a 9.5rem gutter on a 375px screen is not a gutter.
 */
export function Rail({
  sheet,
  fields,
  margin,
  head,
  night = false,
  className = "",
  children,
}: {
  /** e.g. "02 / NIGHT SHIFT". Names the band without a heading. */
  sheet?: string;
  /** Mono field lines: a date, a count, a Run ref. */
  fields?: string[];
  /**
   * The margin column, at 1280px and above.
   *
   * Without it the right third of every band was structurally unreachable: the
   * rail was a two-column grid, so a heading stopped around 540px into a
   * 1024px content column and the outer ~470px could not hold anything. The
   * page alternated narrow-left and full-bleed with nothing in between, which
   * is why it read as a column of prose with pictures under it rather than as
   * a designed spread. This is where marginalia, running counts and figure
   * captions live; below `xl` it collapses and renders after the content.
   */
  margin?: ReactNode;
  /**
   * Content that spans the measure AND the margin.
   *
   * A headline is the one thing that should not be narrowed by adding a margin
   * column. Without this the hero's measure drops from 1024px to 712px and the
   * headline gains two lines, which is the opposite of what the third column
   * was added to achieve. Anything here sits on its own grid row across
   * columns two and three; the margin then starts beside the content below it.
   */
  head?: ReactNode;
  night?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const quiet = night ? "text-zinc-400" : "text-zinc-600";

  return (
    <div className={`rail ${margin ? "rail-3" : ""} ${className}`}>
      {head && (
        <>
          {/* An empty gutter cell so the head lands in column two, not one. */}
          <div aria-hidden className="hidden lg:block" />
          <div className="xl:col-span-2">{head}</div>
        </>
      )}
      <div className={`hidden pr-6 text-right lg:block ${quiet}`}>
        {sheet && <div className="t-cond text-[11px] uppercase tracking-field">{sheet}</div>}
        {fields?.map((field) => (
          <div key={field} className="t-data mt-2 text-[11px] leading-4">
            {field}
          </div>
        ))}
      </div>
      <div className="border-l-0 pl-0 lg:pl-10">
        {(sheet || fields?.length) && (
          <div className={`mb-6 flex flex-wrap items-baseline gap-x-4 gap-y-1 lg:hidden ${quiet}`}>
            {sheet && <span className="t-cond text-[11px] uppercase tracking-field">{sheet}</span>}
            {fields?.map((field) => (
              <span key={field} className="t-data text-[11px]">
                {field}
              </span>
            ))}
          </div>
        )}
        {children}
        {margin && <div className="mt-10 xl:hidden">{margin}</div>}
      </div>
      {margin && <div className="rail-margin hidden pl-10 xl:block">{margin}</div>}
    </div>
  );
}

/**
 * A plate — how a picture of the product gets mounted.
 *
 * The product mocks are cool-white screenshots of a real UI and this site is
 * warm paper; dropping one straight onto the page reads as a foreign object.
 * A plate makes that deliberate instead: recessed ground, a 1px structural
 * rule, no radius, and a numbered caption in the note face underneath. It
 * stops being a screenshot floating in a glow and becomes a figure in a
 * document, which is also the honest description of what it is.
 */
export function Plate({
  figure,
  caption,
  night = false,
  className = "",
  children,
}: {
  /** e.g. "Fig. 3". */
  figure: string;
  caption: string;
  night?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <figure className={className}>
      <div
        className={`border p-2 sm:p-3 ${
          night ? "border-night-600 bg-night-850" : "border-paper-400 bg-paper-200"
        }`}
      >
        {children}
      </div>
      <figcaption
        className={`mt-3 flex flex-wrap items-baseline gap-x-3 ${
          night ? "text-zinc-400" : "text-zinc-600"
        }`}
      >
        <span className="t-data text-[11px] uppercase tracking-field">{figure}</span>
        <span className="t-note text-[15px] leading-6">{caption}</span>
      </figcaption>
    </figure>
  );
}

/* -------------------------------------------------------------------------
   Type
------------------------------------------------------------------------- */

/**
 * The headline ramp, and the rule that governs what may be set in it.
 *
 * **Every headline contains a number, a clock time, or a proper noun, is one
 * clause, and is at most nine words.** That is a form constraint rather than
 * a style note, and it is doing the work an editor would otherwise have to do
 * by hand: it mechanically forbids the antithesis ("Not a prompt. A role that
 * can run unattended."), the negation-definition, the aphorism ("Autonomy
 * stops at the edge of the tools.") and the triad ("Your company. Your
 * infrastructure. Your keys.") — every one of which needs an abstraction as
 * its subject, and all of which the previous site was built from.
 *
 * There is no two-tone variant, and that is the point. The old `Accent` /
 * `Muted` pair encoded a real insight — de-emphasis has to be *darker*, never
 * lighter — but it hard-coded the antithesis sentence into the type system, so
 * every heading on the site came out the same rhetorical shape. One tone, one
 * clause, and the emphasis lives in the words.
 */
export function Display({
  as: Tag = "h1",
  /**
   * `page` is every page's h1. `hero` is the landing page's, and only that.
   *
   * The ramp used to be 4.75rem against Heading's 2.6rem — a ratio of 1.83,
   * which is a heading ramp, not a hero, and it is exactly why the first
   * screen read as tasteful rather than arresting. `hero` resolves to 120px at
   * 1440 against Heading's 41.6px, a ratio of 2.88, so the page finally has
   * one object with real scale on it.
   *
   * Leading is responsive because it has to be: 0.88 on a four-line 48px
   * mobile headline collides the descenders of "payments" with the ascenders
   * on the line below.
   */
  scale = "page",
  night = false,
  className = "",
  children,
}: {
  as?: "h1" | "h2";
  scale?: "page" | "hero";
  night?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const ramp =
    scale === "hero"
      ? // Greedy, not balanced. `.t-display` sets `text-wrap: balance`, which is
        // right for a two-line section heading and wrong here: the headline is
        // 2,893px of type in a 1,024px measure, so balancing spreads it over
        // four short lines where packing gives three fuller ones.
        //
        // The cap is 6.25rem rather than the 7.5rem the size ramp would like,
        // and the constraint is arithmetic rather than taste: at 120px the
        // words are simply too wide to pack. "42 Stripe payments" alone
        // measures 1,183px against a 1,024px measure, so greedy wrapping
        // cannot reach three lines however the rest falls. At 100px it is
        // 985px and the headline sets as three full lines. 100 against
        // Heading's 41.6 is still a ratio of 2.4, where the old ramp was 1.83.
        "text-[clamp(2.75rem,7vw,6.25rem)] leading-[1.0] tracking-[-0.035em] [text-wrap:initial] sm:leading-[0.9]"
      : "text-[clamp(2.75rem,7vw,6rem)] leading-[1.0] tracking-[-0.03em] sm:leading-[0.92]";
  return (
    <Tag className={`t-display ${ramp} ${night ? "text-paper-50" : "text-zinc-950"} ${className}`}>
      {children}
    </Tag>
  );
}

/** Section headings — one step down from Display, same rule. */
export function Heading({
  as: Tag = "h2",
  night = false,
  className = "",
  children,
}: {
  as?: "h2" | "h3";
  night?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tag
      className={`t-display text-[clamp(1.75rem,3.2vw,2.6rem)] leading-[1.04] ${
        night ? "text-paper-50" : "text-zinc-950"
      } ${className}`}
    >
      {children}
    </Tag>
  );
}

/**
 * A sub-heading inside a band.
 *
 * The ramp had a hole in it. `Heading` is 41.6px and was doing double duty as
 * both a band's own heading and the heading of an item inside that band, so
 * several bands had no internal hierarchy at all — the band's argument and its
 * parts were the same size. The evidence was six `!text-[1.0625rem]` overrides
 * scattered across five files, which is the type system telling you a step is
 * missing rather than a call site being unusual.
 */
export function Subhead({
  as: Tag = "h3",
  night = false,
  className = "",
  children,
}: {
  as?: "h3" | "h4";
  night?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tag
      className={`t-display text-[clamp(1.125rem,1.6vw,1.375rem)] leading-[1.35] tracking-[-0.01em] ${
        night ? "text-paper-50" : "text-zinc-950"
      } ${className}`}
    >
      {children}
    </Tag>
  );
}

/**
 * A condensed uppercase label — column headers, lane owners, sheet numbers.
 *
 * This is not the old `Eyebrow`. An eyebrow announced the band the reader was
 * already looking at, fifteen times a page. A `Sheet` names a column or a lane
 * inside a structure, which is a job that actually needs doing.
 */
export function Sheet({
  night = false,
  className = "",
  children,
}: {
  night?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={`t-cond text-[11px] uppercase tracking-field ${
        night ? "text-zinc-400" : "text-zinc-600"
      } ${className}`}
    >
      {children}
    </span>
  );
}

/**
 * A mono field — and the predicate that decides whether something is one.
 *
 * Mono is permitted only for a string the software literally emitted or
 * ingested: a timestamp, a Run ref, a cron line, a count, a shell command, a
 * state name. It is never applied to a marketing sentence for texture. That
 * one test is what makes the timestamps on this site read as real data rather
 * than as a typographic effect, and it is why "3 Routines · 4 Skills" set in
 * mono was wrong on the old site while "04:05" is right on this one.
 *
 * 11px is the hard floor — Martian Mono is a wide face and goes uncomfortable
 * below it — and a field never carries more than one line.
 */
export function Field({
  night = false,
  className = "",
  children,
}: {
  night?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={`t-data text-[11px] leading-4 ${
        night ? "text-zinc-400" : "text-zinc-600"
      } ${className}`}
    >
      {children}
    </span>
  );
}

export function Lede({
  night = false,
  className = "",
  children,
}: {
  night?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <p
      className={`t-body max-w-[46ch] text-[1.1875rem] leading-[1.55] ${
        night ? "text-zinc-300" : "text-zinc-700"
      } ${className}`}
    >
      {children}
    </p>
  );
}

export function Body({
  night = false,
  className = "",
  children,
}: {
  night?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <p
      className={`t-body text-[0.9375rem] leading-[1.7] ${
        night ? "text-zinc-300" : "text-zinc-700"
      } ${className}`}
    >
      {children}
    </p>
  );
}

/**
 * The note face — italic Newsreader, and the only voice on the site with a
 * different skeleton from everything else.
 *
 * It exists because a width axis alone is one voice squashed, not two. It has
 * exactly three jobs: figure captions, margin notes, and the signed colophon.
 * Anywhere else it is decoration and should not be used.
 */
export function Note({
  night = false,
  className = "",
  children,
}: {
  night?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <p
      className={`t-note text-[1.0625rem] leading-[1.6] ${
        night ? "text-zinc-300" : "text-zinc-700"
      } ${className}`}
    >
      {children}
    </p>
  );
}

/* -------------------------------------------------------------------------
   Controls
------------------------------------------------------------------------- */

/**
 * An action strip.
 *
 * The primary control on the site is a full-width rule-bounded strip, not a
 * pill. Strips stack with `-mt-px` so a run of them shares one rule between
 * each pair, which is how a form or a menu is drawn on an instrument.
 *
 * Hover has exactly one behaviour site-wide and it applies only to real
 * links: the strip inverts. No translate, no shadow, no arrow slide — the
 * previous site had roughly twenty-five elements that jumped when the pointer
 * crossed them, which means the gesture signalled nothing.
 */
export function ActionStrip({
  href,
  external,
  mono = false,
  trailing,
  night = false,
  className = "",
  children,
}: {
  href: string;
  external?: boolean;
  /** True when the strip's content is a command or another emitted string. */
  mono?: boolean;
  /** Right-hand affordance — a word, not a glyph. */
  trailing?: ReactNode;
  night?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const skin = night
    ? "border-night-600 text-paper-50 hover:bg-paper-50 hover:text-zinc-950"
    : "border-paper-400 text-zinc-950 hover:bg-zinc-950 hover:text-paper-50";
  const classes = `group flex min-h-[3.25rem] w-full items-center justify-between gap-4 border px-4 transition-colors duration-100 ${skin} ${className}`;

  const inner = (
    <>
      <span className={`min-w-0 truncate ${mono ? "t-data text-[13px]" : "t-body text-[15px]"}`}>
        {children}
      </span>
      {trailing && (
        <span className="t-cond shrink-0 text-[11px] uppercase tracking-field">{trailing}</span>
      )}
    </>
  );

  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={classes}>
        {inner}
        <span className="sr-only">{"(opens in a new tab)"}</span>
      </a>
    );
  }

  return (
    <Link href={href} className={classes}>
      {inner}
    </Link>
  );
}

/** A text link that reads as the section's next step. */
export function TextLink({
  href,
  external,
  night = false,
  className = "",
  children,
}: {
  href: string;
  external?: boolean;
  night?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const classes = `t-cond group inline-flex items-center gap-2 border-b pb-1 text-[12px] uppercase tracking-field transition-colors ${
    night
      ? "border-night-600 text-paper-50 hover:border-paper-50"
      : "border-paper-400 text-zinc-950 hover:border-zinc-950"
  } ${className}`;
  const inner = (
    <>
      {children}
      <ArrowEast className="h-3 w-3" />
    </>
  );
  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={classes}>
        {inner}
        <span className="sr-only">{"(opens in a new tab)"}</span>
      </a>
    );
  }
  return (
    <Link href={href} className={classes}>
      {inner}
    </Link>
  );
}

/* -------------------------------------------------------------------------
   Fragments
------------------------------------------------------------------------- */

/**
 * A hairline, and the distinction that makes the grid work.
 *
 * `hair` separates; `structural` means something. Keeping those two apart is
 * what stops the page becoming uniformly ruled graph paper — a structural rule
 * clears 3:1 because the reader has to be able to see it, a hairline
 * deliberately does not because it is only tidying.
 */
export function Rule({
  weight = "hair",
  night = false,
  className = "",
}: {
  weight?: "hair" | "structural";
  night?: boolean;
  className?: string;
}) {
  const colour = night
    ? weight === "structural"
      ? "bg-night-600"
      : "bg-night-700"
    : weight === "structural"
      ? "bg-paper-400"
      : "bg-paper-300";
  return <span aria-hidden className={`block h-px w-full ${colour} ${className}`} />;
}

/**
 * A row — the replacement for the card, and the workhorse of the site.
 *
 * A set of things is rendered as rows sharing one rule between each pair, in
 * a fixed column structure, never as a grid of bordered boxes. Rows only take
 * the hover inversion when they are actually links.
 */
export function Row({
  href,
  external,
  night = false,
  className = "",
  children,
}: {
  href?: string;
  external?: boolean;
  night?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const base = `-mt-px flex items-start gap-x-6 gap-y-2 border-y px-1 py-5 ${
    night ? "border-night-700" : "border-paper-300"
  } ${className}`;

  if (!href) return <div className={base}>{children}</div>;

  const hover = night
    ? "transition-colors duration-100 hover:bg-paper-50 hover:text-zinc-950"
    : "transition-colors duration-100 hover:bg-zinc-950 hover:text-paper-50";

  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={`group ${base} ${hover}`}>
        {children}
        <span className="sr-only">{"(opens in a new tab)"}</span>
      </a>
    );
  }
  return (
    <Link href={href} className={`group ${base} ${hover}`}>
      {children}
    </Link>
  );
}

/**
 * A state mark with its word beside it.
 *
 * Amber appears here and in the board's 09:30 line and nowhere else. Its usage
 * rule is an accessibility rule: `#ffb000` on paper is 1.65:1, so on light
 * ground it is a *fill* carrying near-black text (10.31:1), never a text
 * colour. On night it inverts and may be text (10.75:1).
 */
export function StateTag({
  state,
  night = false,
  className = "",
  children,
}: {
  state: MarkState;
  night?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const human = state === "decision" || state === "approval";
  const skin = human
    ? night
      ? "text-signal-500"
      : "bg-signal-500 px-2 py-1 text-zinc-950"
    : night
      ? "text-zinc-300"
      : "text-zinc-700";

  return (
    <span
      className={`t-cond inline-flex items-center gap-1.5 text-[11px] uppercase tracking-field ${skin} ${className}`}
    >
      <Mark state={state} className="h-3 w-3" />
      {children}
    </span>
  );
}
