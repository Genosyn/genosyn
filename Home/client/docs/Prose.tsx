import type { CSSProperties, ReactNode } from "react";
import { findPageMeta } from "@/docs/nav";
import { Link } from "@/lib/router";

/**
 * The docs reading surface.
 *
 * Fifty-seven pages share these primitives, and the rule governing them is
 * narrower than the one in sections/Kit.tsx: **the docs take the palette and
 * the type and none of the furniture.** No sheet numbers, no rail, no board,
 * no strips, no amber. All of those say "look at the structure", which is the
 * right instruction on a landing page and the wrong one on a page somebody
 * opened because a Run failed at 03:17.
 *
 * So this file does not import the Kit's layout vocabulary, and that is a
 * decision rather than an oversight. It is not a second design system either:
 * every value below is a token from tailwind.config.ts or one of the five
 * `.t-*` classes in index.css, so the docs are repainted by the same warm ramp
 * as the marketing site. What they do not inherit is a band, because a reading
 * column has different needs from a band.
 *
 * Three things did carry over intact.
 *
 * 1. **Mono is a predicate.** `.t-data` marks a string the software emitted or
 *    ingested, and nothing else. It is why `KeyList` decides per row instead of
 *    setting every term in mono: `GENOSYN_PORT` is a literal, "Approval" is a
 *    word, and the old list set both in the same face.
 * 2. **A rule is a boundary.** An H2 opens with a hairline rather than with
 *    whitespace alone, and a code block is a figure mounted on recessed ground
 *    — the same construction as `Plate`, minus the numbered caption.
 * 3. **Radius 0, no shadow, one ramp.** There is no hue on this surface at
 *    all, not even the signal. Nothing inside a paragraph is a Decision or an
 *    Approval; the words are, and they say so.
 */

/**
 * Emphasis inside prose, and why it is an inline style.
 *
 * `font-variation-settings` is an inherited property, and on the element that
 * inherits it it beats `font-weight`. Now that `P`, `UL` and `OL` carry
 * `.t-body` (wght 400), a `<span class="font-medium">` inside one renders at
 * 400 on every browser that has Archivo: the bold would silently stop
 * existing. The axis has to be restated on the child.
 *
 * A `.t-strong` rule beside the other `.t-*` classes in index.css is the right
 * home for this and is where it should move the next time that file is opened.
 * This pass does not own it, and a single declaration inside one shared
 * component is not the per-call-site inline style the Kit warns about.
 */
const EMPHASIS: CSSProperties = { fontVariationSettings: '"wdth" 100, "wght" 650' };

/**
 * Is this string something the software emitted or ingested?
 *
 * The mono predicate, applied to `KeyList` terms. Roughly a fifth of the 200
 * terms across the docs are literals — `GENOSYN_PORT`, `browser_fill_vault`,
 * `security.encryptionSecret` — and the rest are ordinary nouns: "Approval",
 * "Company", "Gmail", "80+ GB VRAM". The old list set all of them in mono,
 * which is exactly the habit that made data on this site look decorative.
 *
 * The test is deliberately conservative: one token, and it carries a dot or an
 * underscore. "Follow-ups" and "OS" stay prose, which is what a wider rule
 * (any all-caps token, any hyphen) would have got wrong. A term the heuristic
 * misses simply reads as a heading, which is a far cheaper failure than a
 * sentence set in Martian Mono.
 */
function isEmitted(term: string): boolean {
  return /^\S+$/.test(term) && /[._]/.test(term);
}

type WithId = { children: ReactNode; id?: string };

/**
 * The page header.
 *
 * The `eyebrow` prop is still accepted and is no longer rendered. On all 57
 * pages it restated the sidebar section the reader was already standing in —
 * "Brains & tools" above a page reached by clicking "Brains & tools" — which
 * is the same job the Kit deleted `Eyebrow` for. The prop stays in the type so
 * the pages compile unchanged and so a later pass can strip the call sites in
 * one sweep; it is not destructured, because an unused binding is an eslint
 * error and a `_eyebrow` alias would only look like an accident.
 *
 * The header carries no bottom rule. It had one, and against the hairline an
 * H2 now opens with it produced two parallel lines forty pixels apart at the
 * top of every page — a boundary drawn twice, which reads as a mistake. The
 * first H2 does the separating; a title at display size does not need help.
 */
export function PageHeader({ title, lead }: { eyebrow?: string; title: string; lead?: ReactNode }) {
  return (
    <header>
      <h1 className="t-display text-balance text-[clamp(2.1rem,4.6vw,3.1rem)] leading-[1.05] text-zinc-950">
        {title}
      </h1>
      {lead && (
        <p className="t-body mt-5 max-w-[60ch] text-[1.0625rem] leading-[1.6] text-zinc-700">
          {lead}
        </p>
      )}
    </header>
  );
}

/**
 * Section headings, in plain Archivo.
 *
 * `.t-display` belongs to the page title and stops there. A width-118 headline
 * every four paragraphs turns a reference page into a poster, and at H3 size
 * the wide axis stops being legible as emphasis at all. The hairline above an
 * H2 is doing the work the extra width used to: it is a boundary, drawn.
 */
export function H2({ children, id }: WithId) {
  return (
    <h2
      id={id}
      className="mt-14 scroll-mt-24 border-t border-paper-300 pt-8 text-balance text-[1.5rem] font-semibold leading-[1.2] tracking-[-0.015em] text-zinc-950"
    >
      {children}
    </h2>
  );
}

export function H3({ children, id }: WithId) {
  return (
    <h3
      id={id}
      className="mt-9 scroll-mt-24 text-[1.0625rem] font-semibold leading-[1.35] text-zinc-950"
    >
      {children}
    </h3>
  );
}

export function P({ children }: { children: ReactNode }) {
  return <p className="t-body mt-5 text-[0.9375rem] leading-[1.75] text-zinc-700">{children}</p>;
}

export function Strong({ children }: { children: ReactNode }) {
  return (
    <span className="text-zinc-950" style={EMPHASIS}>
      {children}
    </span>
  );
}

/* A square marker, because nothing else on the site is round and a bullet is
   the last place a circle would survive a review. `list-disc` is deliberately
   absent rather than overridden: two utilities setting `list-style-type` would
   resolve by whichever Tailwind emitted last, which is not a thing to depend
   on. */
export function UL({ children }: { children: ReactNode }) {
  return (
    <ul className="t-body mt-5 ml-5 space-y-2 text-[0.9375rem] leading-[1.7] text-zinc-700 marker:text-zinc-600 [list-style-type:square]">
      {children}
    </ul>
  );
}

export function OL({ children }: { children: ReactNode }) {
  return (
    <ol className="t-body mt-5 ml-5 list-decimal space-y-2 text-[0.9375rem] leading-[1.7] text-zinc-700 marker:text-zinc-600">
      {children}
    </ol>
  );
}

export function LI({ children }: { children: ReactNode }) {
  return <li className="pl-1">{children}</li>;
}

/**
 * Inline literals.
 *
 * 12px rather than the 13px it replaces: Martian Mono is a wide face and sets
 * about 15% larger than Archivo at the same size, so matching numbers makes
 * the code look bigger than the sentence carrying it. `break-words` is load
 * bearing — the longest inline string in the docs is 85 characters, and at
 * 375px the reading column is roughly 40.
 */
export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="t-data break-words bg-paper-200 px-1 py-0.5 text-[12px] text-zinc-900">
      {children}
    </code>
  );
}

/**
 * A code block, mounted like a figure.
 *
 * It was a near-black slab with a 12px radius and a drop shadow. It is now the
 * recessed paper ground a `Plate` uses, with a structural rule and the
 * language in a mono field along the top. Dropping the dark plane was the
 * point: night is reserved for the one band on the landing page where the
 * argument goes dark, and spending it forty times across a reference section
 * costs it whatever it meant.
 *
 * The two sizes are a fitting decision, not a taste one. At 375px the column
 * is about 327px wide; Martian Mono at 12.5px with the `.t-data` tracking fits
 * roughly 34 characters, and most `bash` lines here are longer. 11.5px buys
 * about six more and stays above the 11px floor, the tracking comes down to
 * 0.02em because 0.06em is spacing meant for a short uppercase field rather
 * than for forty characters of shell, and the `<pre>` scrolls on its own axis
 * for what still does not fit. The page itself never scrolls sideways.
 */
export function Pre({ children, lang }: { children: ReactNode; lang?: string }) {
  return (
    <div className="mt-6 border border-paper-400 bg-paper-200">
      {lang && (
        <div className="t-data border-b border-paper-300 px-3 py-2 text-[11px] uppercase leading-none tracking-field text-zinc-600">
          {lang}
        </div>
      )}
      <pre className="overflow-x-auto px-3 py-3.5 sm:px-4">
        <code className="t-data block text-[11.5px] leading-[1.75] tracking-[0.02em] text-zinc-900 sm:text-[12.5px]">
          {children}
        </code>
      </pre>
    </div>
  );
}

/**
 * A callout, drawn in rule weights rather than in colour.
 *
 * The three kinds were a grey box, an amber box and an emerald box. Amber is
 * spoken for — it marks a Decision or an Approval and nothing else — and there
 * is no green on this site at all, so the distinction had to move somewhere
 * that costs no hue. It moved into the left rule, which is the one place the
 * design already distinguishes loud from quiet: a caution takes the near-black
 * structural rule, a note takes the mid-grey one, a tip takes a hairline.
 *
 * The kind word is printed as well, because a rule weight alone is not a label
 * and because a reader who cannot resolve 3.18:1 from 1.30:1 still has to know
 * which one this is.
 */
const CALLOUT_RULE: Record<"info" | "warn" | "tip", string> = {
  info: "border-paper-400",
  warn: "border-zinc-950",
  tip: "border-paper-300",
};

const CALLOUT_WORD: Record<"info" | "warn" | "tip", string> = {
  info: "Note",
  warn: "Caution",
  tip: "Tip",
};

export function Callout({
  children,
  kind = "info",
  title,
}: {
  children: ReactNode;
  kind?: "info" | "warn" | "tip";
  title?: string;
}) {
  return (
    <aside className={`mt-6 border-l-2 pl-4 sm:pl-5 ${CALLOUT_RULE[kind]}`}>
      <div className="t-cond text-[11px] uppercase leading-none tracking-field text-zinc-600">
        {CALLOUT_WORD[kind]}
      </div>
      {title && (
        <p className="mt-2 text-[0.9375rem] leading-[1.5] text-zinc-950" style={EMPHASIS}>
          {title}
        </p>
      )}
      <div className="t-body mt-2 text-[0.90625rem] leading-[1.7] text-zinc-700">{children}</div>
    </aside>
  );
}

/**
 * A term list.
 *
 * It was a white card with a 12px radius and a full border. It is now what a
 * set of things is on this site: rows sharing one hairline between each pair,
 * with no box around them. The term column is 13rem rather than 180px because
 * a term set in Martian Mono — `browser_submit_with_vault_totp` is the worst
 * case — needs the room, and it breaks rather than pushing the definition
 * column sideways.
 */
export function KeyList({ rows }: { rows: Array<{ term: string; def: ReactNode }> }) {
  return (
    <dl className="mt-6 border-t border-paper-300">
      {rows.map((r) => (
        <div
          key={r.term}
          className="grid grid-cols-1 gap-1 border-b border-paper-300 py-4 sm:grid-cols-[13rem_1fr] sm:gap-6"
        >
          <dt
            className={
              isEmitted(r.term)
                ? "t-data break-words text-[11.5px] leading-[1.55] text-zinc-700"
                : "break-words text-[0.9375rem] leading-[1.5] text-zinc-950"
            }
            style={isEmitted(r.term) ? undefined : EMPHASIS}
          >
            {r.term}
          </dt>
          <dd className="t-body text-[0.9375rem] leading-[1.7] text-zinc-700">{r.def}</dd>
        </div>
      ))}
    </dl>
  );
}

/* Inline links are carried by ink and an underline, not by weight: a bolder
   run inside a paragraph reads as emphasis, and a link is not emphasis. The
   underline sits on the structural rule colour so it is visible without
   competing with the sentence, and darkens to near-black on hover. */
const INLINE_LINK =
  "text-zinc-950 underline decoration-paper-400 decoration-1 underline-offset-[3px] transition-colors hover:decoration-zinc-950";

export function DocLink({ to, children }: { to: string; children?: ReactNode }) {
  const meta = findPageMeta(to);
  const label = children ?? meta?.title ?? to;
  return (
    <Link href={to} className={INLINE_LINK}>
      {label}
    </Link>
  );
}

export function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={INLINE_LINK}>
      {children}
      <span className="sr-only">{" (opens in a new tab)"}</span>
    </a>
  );
}
