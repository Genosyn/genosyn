import type { ReactNode } from "react";
import { findPageMeta } from "@/docs/nav";
import { Link } from "@/lib/router";

/**
 * The docs reading surface — HEADCOUNT, minus the furniture.
 *
 * Fifty-seven pages share these primitives, and the rule governing them is
 * narrower than the one in sections/Kit.tsx: **the docs take the palette and
 * the type and none of the marketing furniture.** No tiles, no chips, no
 * department hue anywhere on this surface. All of those say "look at the * structure", which is the right instruction on a landing page and the wrong
 * one on a page somebody opened because a Run failed at 03:17.
 *
 * Colour is the org chart, and a paragraph is not a department. There is
 * exactly one place a hue is allowed in the docs and it is the sidebar section
 * spine in DocsShell.tsx, because those sections are literally named after the
 * departments. Inside the reading column the palette collapses to the six
 * neutrals, which is what makes the one black thing on the page mean something.
 *
 * Four things carry over from the Kit intact.
 *
 * 1. **Mono is a predicate.** `.t-data` marks a string the software emitted or
 *    ingested, and nothing else. It is why `KeyList` decides per row instead of
 *    setting every term in mono: `GENOSYN_PORT` is a literal, "Approval" is a
 *    word, and the old list set both in the same face.
 * 2. **A rule is a boundary.** An H2 opens with a hairline rather than with
 *    whitespace alone, and a code block is a figure mounted on a white pane —
 *    the same construction as `Pane`, minus the department edge.
 * 3. **The human is in black.** Nothing in a paragraph is a Decision or an
 *    Approval, so ink is spent here on exactly one thing: a Caution, which is
 *    the one callout that means *a person has to be careful*. It gets the 3px
 *    spine; the two informational kinds get 1px.
 * 4. **Radius 0, no shadow, no float.** Depth is a 1px seam or a spine.
 */

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
 * sentence set in Spline Sans Mono.
 */
function isEmitted(term: string): boolean {
  return /^\S+$/.test(term) && /[._]/.test(term);
}

type WithId = { children: ReactNode; id?: string };

/**
 * The page header.
 *
 * `t-h2` rather than `t-hero`: the hero face belongs to the one h1 on the
 * landing page, and a reference title set at hero weight would be shouting the
 * filename at somebody who is already here and reading.
 *
 * The `eyebrow` prop is still accepted and is no longer rendered. On all 57
 * pages it restated the sidebar section the reader was already standing in —
 * "Brains & tools" above a page reached by clicking "Brains & tools" — and the
 * sidebar now marks that section with a department spine, so the eyebrow is
 * restating a thing the reader can see in their peripheral vision. The prop
 * stays in the type so the pages compile unchanged; it is not destructured,
 * because an unused binding is an eslint error and a `_eyebrow` alias would
 * only look like an accident.
 *
 * The header carries no bottom rule. It had one, and against the hairline an
 * H2 now opens with it produced two parallel lines forty pixels apart at the
 * top of every page — a boundary drawn twice, which reads as a mistake. The
 * first H2 does the separating; a title at display size does not need help.
 */
export function PageHeader({ title, lead }: { eyebrow?: string; title: string; lead?: ReactNode }) {
  return (
    <header>
      <h1 className="t-h2 text-balance text-[clamp(2.125rem,4.4vw,3rem)] text-ink">{title}</h1>
      {lead && <p className="mt-5 max-w-[58ch] text-[1.125rem] leading-[1.55] text-ink2">{lead}</p>}
    </header>
  );
}

/**
 * Section headings.
 *
 * These are now the Kit's own ramp — `t-h2` for a section, `t-h3` for a
 * subsection — rather than the two hand-rolled `font-semibold` sizes that were
 * here. The previous pass had an argument for keeping the display face out of
 * the docs, and it was a real argument about the *old* face: Archivo at wdth
 * 118 every four paragraphs turned a reference page into a poster. Bricolage
 * at wdth 95 is barely condensed, and using the same two classes the marketing
 * bands use is what stops the docs reading as a second design system wearing
 * the first one's colours.
 *
 * The hairline above stays. It is the boundary; the size is the hierarchy.
 */
export function H2({ children, id }: WithId) {
  return (
    <h2
      id={id}
      className="t-h2 mt-14 scroll-mt-24 border-t border-hairline pt-8 text-balance text-[1.625rem] text-ink"
    >
      {children}
    </h2>
  );
}

export function H3({ children, id }: WithId) {
  return (
    <h3 id={id} className="t-h3 mt-10 scroll-mt-24 text-[1.125rem] text-ink">
      {children}
    </h3>
  );
}

/**
 * Body.
 *
 * 16px, up from 15px, on the measure DocsShell sets. Fifteen was inherited
 * from a marketing page, where body text sits beside a headline and is read in
 * ten-word bursts; a page somebody reads for four minutes at a time gets the
 * larger size and the looser leading, and the measure came down to pay for it.
 */
export function P({ children }: { children: ReactNode }) {
  return <p className="mt-5 text-[1rem] leading-[1.7] text-ink2">{children}</p>;
}

/**
 * Emphasis inside prose.
 *
 * A plain weight utility, not an inline `font-variation-settings` style. The
 * previous face was set through the variable axis on `P` itself, so a nested
 * `font-medium` was overridden by the inherited axis and had to restate it;
 * Instrument Sans carries prose now, `P` sets no axis at all, and `wdth` is
 * not an axis Instrument Sans even has. So the whole inline-style workaround
 * was solving a problem that left with Archivo.
 */
export function Strong({ children }: { children: ReactNode }) {
  return <span className="font-semibold text-ink">{children}</span>;
}

/* A square marker, because nothing else on the site is round and a bullet is
   the last place a circle would survive a review. `list-disc` is deliberately
   absent rather than overridden: two utilities setting `list-style-type` would
   resolve by whichever Tailwind emitted last, which is not a thing to depend
   on. */
export function UL({ children }: { children: ReactNode }) {
  return (
    <ul className="mt-5 ml-5 space-y-2.5 text-[1rem] leading-[1.65] text-ink2 marker:text-muted [list-style-type:square]">
      {children}
    </ul>
  );
}

export function OL({ children }: { children: ReactNode }) {
  return (
    <ol className="mt-5 ml-5 list-decimal space-y-2.5 text-[1rem] leading-[1.65] text-ink2 marker:text-muted">
      {children}
    </ol>
  );
}

export function LI({ children }: { children: ReactNode }) {
  return <li className="pl-1">{children}</li>;
}

/**
 * Inline literals — and the fill is gone.
 *
 * It was `bg-ground` with a little padding, which is invisible: the docs page
 * *is* ground, so the tint was tinting paper with paper. The obvious repair is
 * to move the fill to `surface`, and that was rejected — a white lozenge in
 * the middle of a sentence is a chip, chips carry departments here, and a
 * department is not what `localhost:8471` is.
 *
 * So the face does the whole job, which is what "mono is a predicate" claimed
 * all along: a Spline Sans Mono run inside Instrument Sans is unmistakable
 * without a box, and it is one less rectangle on a page that has forty. 13px
 * rather than 12: Spline Sans Mono sets narrower than the Martian Mono the old
 * 12px was compensating for, and against a 16px sentence 12px now reads as
 * small rather than as data. `break-words` is load bearing — the longest
 * inline string in the docs is 85 characters, and at 375px the column is
 * roughly 40.
 */
export function Code({ children }: { children: ReactNode }) {
  return <code className="t-data break-words text-[13px] text-ink">{children}</code>;
}

/**
 * A code block, mounted like a figure.
 *
 * It was a near-black slab with a 12px radius and a drop shadow; then it was a
 * `ground` box on a `ground` page, which is the same invisibility the inline
 * `Code` fill had. It is now the Kit's `Pane` construction — white, one
 * hairline, no shadow, radius 0, the language in a mono field along a ruled
 * top edge — minus the 3px department edge, because a bash snippet does not
 * belong to Finance.
 *
 * The two sizes are a fitting decision, not a taste one. At 375px the column
 * is about 327px wide and most `bash` lines here are longer than that at 13px,
 * so the phone gets 12px and the `<pre>` scrolls on its own axis for what
 * still does not fit. The page itself never scrolls sideways.
 *
 * That sideways scroll is the reason for `tabIndex={0}`. The measure is 41rem
 * and the block does not break out of it, so on the longest `bash` lines here
 * the only way to read the end of the command is to scroll this box — and
 * Chrome and Safari do not put an overflow container in the tab order the way
 * Firefox does, so without the attribute a keyboard-only reader could not
 * reach the right-hand half of an install command at all. The Kit's brief
 * calls that out: a scroll is functionality, and functionality is operable
 * from a keyboard.
 *
 * The focus ring has to be written out here rather than inherited. The global
 * `:focus-visible` rule in index.css is scoped to `:where(a, button, input,
 * textarea, select, [role=button], [role=option])`, and a `<pre>` is none of
 * those, so a bare `tabIndex` would have bought keyboard reach and lost the
 * visible indicator — which trades one failure for another. The offset is
 * negative so the ring lands inside the white pane instead of straddling the
 * hairline, where ink on surface is 18.70:1. `role="region"` with a label was
 * rejected: a reference page carries up to a dozen of these, and a dozen new
 * landmarks is a worse screen-reader surface than none.
 */
export function Pre({ children, lang }: { children: ReactNode; lang?: string }) {
  return (
    <div className="mt-6 border border-hairline bg-surface">
      {lang && (
        <div className="t-field border-b border-hairline px-3 py-2.5 leading-none text-muted sm:px-4">
          {lang}
        </div>
      )}
      <pre
        tabIndex={0}
        className="overflow-x-auto px-3 py-3.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ink sm:px-4"
      >
        <code className="t-data block text-[12px] leading-[1.7] text-ink sm:text-[13px]">
          {children}
        </code>
      </pre>
    </div>
  );
}

/**
 * A callout, drawn in rule weights rather than in colour.
 *
 * The three kinds were a grey box, an amber box and an emerald box. There is
 * no hue available for them now — a hue means a department and a Caution is
 * not a department — so the distinction lives in the spine, which is the one
 * place the system already separates loud from quiet.
 *
 * A Caution takes the 3px ink spine, and that is the human-in-black rule doing
 * real work rather than being decorated onto a page: a Caution is the only
 * callout that means *a person has to be careful here*, so it gets the value
 * with no hue at all, at the weight the Kit reserves for a department edge. A
 * Note takes the 1px structural rule, a Tip takes a 1px hairline.
 *
 * The spine is absolutely positioned rather than a `border-l`, exactly as
 * `Row` and `Pane` do it in the Kit, so the three kinds share one text edge
 * instead of the 2px stagger a border-width swap would leave down a page that
 * mixes them.
 *
 * The kind word is printed as well, because a rule weight alone is not a label
 * and because a reader who cannot resolve 3.30:1 from 1.22:1 still has to know
 * which one this is.
 */
const CALLOUT_SPINE: Record<"info" | "warn" | "tip", string> = {
  info: "w-px bg-rule",
  warn: "w-[3px] bg-ink",
  tip: "w-px bg-hairline",
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
    <aside className="relative mt-6 pl-4 sm:pl-5">
      <span aria-hidden className={`absolute inset-y-0 left-0 ${CALLOUT_SPINE[kind]}`} />
      <div className="t-field leading-none text-muted">{CALLOUT_WORD[kind]}</div>
      {title && <p className="mt-2.5 text-[1rem] font-semibold leading-[1.45] text-ink">{title}</p>}
      <div className="mt-2 text-[0.9375rem] leading-[1.65] text-ink2">{children}</div>
    </aside>
  );
}

/**
 * A term list.
 *
 * It was a white card with a 12px radius and a full border. It is now what a
 * set of things is on this site: rows sharing one hairline between each pair,
 * with no box around them — the same construction as `Row`, without the
 * department spine a `Row` may carry, because these terms are not departments.
 *
 * The term column is 12rem. It was 13, and the measure came down when the body
 * went to 16px; the worst case is still a mono literal that breaks rather than
 * pushing the definition column sideways.
 */
export function KeyList({ rows }: { rows: Array<{ term: string; def: ReactNode }> }) {
  return (
    <dl className="mt-6 border-t border-hairline">
      {rows.map((r) => (
        <div
          key={r.term}
          className="grid grid-cols-1 gap-1 border-b border-hairline py-4 sm:grid-cols-[12rem_1fr] sm:gap-6"
        >
          <dt
            className={
              isEmitted(r.term)
                ? "t-data break-words text-[12.5px] leading-[1.5] text-ink"
                : "break-words text-[1rem] font-semibold leading-[1.45] text-ink"
            }
          >
            {r.term}
          </dt>
          <dd className="text-[1rem] leading-[1.65] text-ink2">{r.def}</dd>
        </div>
      ))}
    </dl>
  );
}

/* Inline links are carried by ink and an underline, not by weight: a bolder
   run inside a paragraph reads as emphasis, and a link is not emphasis. The
   underline sits on the structural rule colour so it is visible without
   competing with the sentence, and darkens to ink on hover.

   Both halves of this used to name colours that no longer exist —
   `decoration-paper-400` and `decoration-zinc-950` survived the token swap as
   dead classes, so every link in the docs was underlined in full ink and the
   hover did nothing at all. */
const INLINE_LINK =
  "text-ink underline decoration-rule decoration-1 underline-offset-[3px] transition-colors hover:decoration-ink";

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
      <span className="sr-only">{"(opens in a new tab)"}</span>
    </a>
  );
}
