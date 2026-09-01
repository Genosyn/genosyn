import type { ReactNode } from "react";
import { Band, Container, Display, Field, Lede } from "@/sections/Kit";

/**
 * The page hero — the top band of every marketing page that is not the
 * landing page.
 *
 * This file used to export eleven primitives (`HeroSection`, `HeroGrid`,
 * `HeroBadge`, `HeroTitle`, `HeroTitleMuted`, `HeroProof`, …) that between
 * them re-implemented half the Kit and hard-coded three things the site no
 * longer has: a pill badge with a pulsing dot, a two-tone headline, and a
 * four-item checklist with ticks in rounded tiles. Because they were
 * primitives rather than a composition, every page that used them inherited
 * that shape whether or not it suited the page — which is precisely how five
 * different pages ended up with an identical opening move.
 *
 * `PageHero` is one component instead, and it takes the band's whole content
 * as props: an eyebrow, one `t-h2` headline, one Lede, a stack of action
 * strips, an optional aside, and a closing strip of emitted data.
 *
 * ## What HEADCOUNT changed
 *
 * The rail is gone. The previous version mounted a 9.5rem gutter carrying a
 * sheet number, which cost every page a tenth of its width and — worse — set
 * the headline's measure to about 26 characters between 1024px and 1279px, so
 * the hero had to stay stacked until `xl` to stay readable. Without the
 * gutter the split can happen at `lg`, and the headline sits beside its own
 * explanation the way the landing masthead does.
 *
 * The mono fields are not gone, because they are the one thing on the page
 * the software actually emitted — 06:40 − 17:45, 9 RUNS, APACHE-2.0. They
 * move to a hairline-topped strip at the foot of the band, which gives the
 * hero a floor and stops two mono voices sharing one line with the eyebrow.
 *
 * There is no department hue in here on purpose. A hero states what the page
 * is; the hue belongs to the rows and panes underneath it, where it can mean
 * a department rather than decorate a headline.
 */
export function PageHero({
  eyebrow,
  sheet,
  fields,
  title,
  lede,
  actions,
  aside,
}: {
  /** The band's label: "Products", "Roster", a product name. */
  eyebrow?: string;
  /**
   * Deprecated alias for `eyebrow`, still passed by the product and role
   * pages as "01 / AI Employees". HEADCOUNT has no sheet numbering — the
   * pages are not a document set — so the "NN /" prefix is stripped rather
   * than printed. Kept as a prop so those pages keep compiling until they
   * are rewritten; pass `eyebrow` in anything new.
   */
  sheet?: string;
  /** Emitted data only — counts, clock ranges, a licence. Never a claim. */
  fields?: string[];
  /** One clause, at most nine words, carrying a number or a proper noun. */
  title: ReactNode;
  lede: ReactNode;
  /** A stack of `ActionStrip`s. Two, at most — never a row of three buttons. */
  actions?: ReactNode;
  /** A `Plate` or a small table. Sits beside the copy from `lg` up. */
  aside?: ReactNode;
}) {
  const label = eyebrow ?? (sheet ? sheet.replace(/^\d+\s*\/\s*/, "") : undefined);

  const headline = (
    <Display as="h1" className="max-w-[20ch]">
      {title}
    </Display>
  );

  // The copy block moves between the two columns depending on whether there
  // is an aside: with one, headline and copy share the left column and the
  // aside gets the right; without one, the headline and its explanation sit
  // side by side rather than leaving half the band empty.
  const copy = (
    <div className={aside ? "mt-7 min-w-0" : "min-w-0 lg:pt-2"}>
      <Lede>{lede}</Lede>
      {actions && <div className="mt-9 max-w-[34rem]">{actions}</div>}
    </div>
  );

  return (
    // `rule={false}` because a page hero is the first band under the fascia,
    // and a top rule there would double the header's own bottom border.
    // `pad="m"`: a hero is not a timetable, so it does not get `l`.
    <Band tone="ground" pad="m" rule={false}>
      <Container>
        {label && <div className="t-field mb-5 text-muted">{label}</div>}

        {/* `gap-y-10` is what separates the stacked halves below `lg`; above
            it the two columns are side by side and only `gap-x` applies. */}
        <div className="grid gap-x-16 gap-y-10 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:items-start">
          {aside ? (
            <div className="min-w-0">
              {headline}
              {copy}
            </div>
          ) : (
            headline
          )}
          {aside ? <div className="min-w-0">{aside}</div> : copy}
        </div>

        {fields && fields.length > 0 && (
          <div className="mt-12 flex flex-wrap items-baseline gap-x-8 gap-y-2 border-t border-hairline pt-4">
            {fields.map((field) => (
              <Field key={field}>{field}</Field>
            ))}
          </div>
        )}
      </Container>
    </Band>
  );
}
