import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { Container, Em, Section, SectionHead } from "@/sections/Kit";

export type QA = { q: string; a: string };

/**
 * Questions as native disclosure widgets: keyboard- and screen-reader-ready
 * without script, and every answer is in the prerendered markup for crawlers.
 */
export function FaqList({ items, className = "" }: { items: QA[]; className?: string }) {
  return (
    <div className={`border-t border-line ${className}`}>
      {items.map((item, index) => (
        <details key={item.q} className="group border-b border-line" open={index === 0}>
          <summary className="flex cursor-pointer list-none items-start justify-between gap-6 py-6 [&::-webkit-details-marker]:hidden">
            <span className="text-[17px] font-medium leading-7 tracking-[-0.01em] text-ink">{item.q}</span>
            <span
              aria-hidden
              className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-line-strong text-ink transition-transform duration-300 group-open:rotate-45 group-open:border-ink group-open:bg-ink group-open:text-white"
            >
              <Plus className="h-3.5 w-3.5" />
            </span>
          </summary>
          <p className="-mt-1 max-w-[70ch] pb-7 pr-12 text-[15.5px] leading-[1.7] text-ink-600">{item.a}</p>
        </details>
      ))}
    </div>
  );
}

/** A full questions band: heading on the left, the list on the right. */
export function FaqSection({
  title,
  items,
  footer,
}: {
  title?: ReactNode;
  items: QA[];
  footer?: ReactNode;
}) {
  return (
    <Section id="questions" space="md" rule>
      <Container>
        <div className="grid gap-12 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-20">
          <div>
            <SectionHead
              align="left"
              size="md"
              kicker="Questions"
              title={
                title ?? (
                  <>
                    Asked, <Em>and answered.</Em>
                  </>
                )
              }
            />
            {footer && <div className="mt-8">{footer}</div>}
          </div>
          <FaqList items={items} />
        </div>
      </Container>
    </Section>
  );
}
