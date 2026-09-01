import type { ReactNode } from "react";
import { Band, Container, Display, Lede, Rail } from "@/sections/Kit";

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
 * as props. There is nothing to arrange, so there is nothing to arrange
 * differently: the sheet number, the mono fields, one Display headline, one
 * Lede, a stack of action strips, and an optional aside. Everything below it
 * is Kit.
 */
export function PageHero({
  sheet,
  fields,
  title,
  lede,
  actions,
  aside,
}: {
  /** e.g. "01 / Products". Names the sheet; there is no eyebrow any more. */
  sheet: string;
  /** Mono field lines for the rail gutter: counts, a licence, a version. */
  fields?: string[];
  /** One clause, at most nine words, carrying a number or a proper noun. */
  title: ReactNode;
  lede: ReactNode;
  /** A stack of `ActionStrip`s. Two, at most — never a row of three buttons. */
  actions?: ReactNode;
  /** A `Plate` or a small table. Sits beside the copy from `xl` up. */
  aside?: ReactNode;
}) {
  return (
    // `rule={false}` because a page hero is the first band under the fascia,
    // and a top rule there would double the header's own bottom border.
    // `pad="m"`: a hero is not a timetable, so it does not get `l`.
    <Band tone="paper" pad="m" rule={false}>
      <Container>
        <Rail sheet={sheet} fields={fields}>
          {/* The split waits until `xl`. Between 1024px and 1279px the rail
              gutter has already taken 9.5rem, so two columns there leave the
              headline about 26 characters of measure — worse than stacking. */}
          <div
            className={
              aside
                ? "grid gap-12 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] xl:items-start xl:gap-14"
                : ""
            }
          >
            <div className="min-w-0">
              <Display className="max-w-[20ch]">{title}</Display>
              <Lede className="mt-7">{lede}</Lede>
              {actions && <div className="mt-10 max-w-[34rem]">{actions}</div>}
            </div>
            {aside && <div className="min-w-0">{aside}</div>}
          </div>
        </Rail>
      </Container>
    </Band>
  );
}
