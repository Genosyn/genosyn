import type { ReactNode } from "react";
import { Reveal } from "@/components/Reveal";
import { Container, Kicker, Lede } from "@/sections/Kit";

/**
 * The opening band of every page that is not the landing page: kicker, one
 * serif headline, a lede, actions, and an optional picture beside them.
 */
export function PageHero({
  kicker,
  title,
  lede,
  actions,
  aside,
  meta,
  children,
}: {
  kicker?: ReactNode;
  title: ReactNode;
  lede?: ReactNode;
  actions?: ReactNode;
  /** A picture or a small table, beside the copy from `lg` up. */
  aside?: ReactNode;
  /** A quiet line of facts under the actions. */
  meta?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="relative pb-16 pt-12 sm:pb-20 sm:pt-16 lg:pb-24 lg:pt-20">
      <Container>
        <div
          className={`grid gap-x-16 gap-y-14 ${
            aside ? "lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:items-center" : ""
          }`}
        >
          <div className="min-w-0">
            {kicker && (
              <Reveal>
                <Kicker>{kicker}</Kicker>
              </Reveal>
            )}
            <Reveal delay={60}>
              <h1
                className={`mt-6 text-balance font-display text-display-xl text-ink ${aside ? "max-w-[15ch]" : "max-w-[18ch]"}`}
              >
                {title}
              </h1>
            </Reveal>
            {lede && (
              <Reveal delay={120}>
                <Lede className="mt-7">{lede}</Lede>
              </Reveal>
            )}
            {actions && (
              <Reveal delay={180} className="mt-9 flex flex-wrap items-center gap-3">
                {actions}
              </Reveal>
            )}
            {meta && (
              <Reveal delay={220} className="mt-8">
                {meta}
              </Reveal>
            )}
          </div>
          {aside && (
            <Reveal delay={160} className="min-w-0">
              {aside}
            </Reveal>
          )}
        </div>
        {children}
      </Container>
    </section>
  );
}
