import { ArrowUpRight } from "lucide-react";
import { useReveal } from "@/components/Reveal";
import { PRODUCTS } from "@/products/data";
import { PRODUCT_HOLDS, PRODUCT_ICON, productDept } from "@/products/meta";
import { Link } from "@/lib/router";
import { CompanyPreview } from "@/sections/CompanyPreview";
import { Container, DEPT_DOT, Em, Section, SectionHead } from "@/sections/Kit";

/** Where the work happens: one install, fourteen products, one database. */
export function Platform() {
  const frame = useReveal<HTMLDivElement>(60);
  const tiles = useReveal<HTMLUListElement>(0, 35);

  return (
    <Section id="platform" tone="raised" space="md" rule>
      <Container>
        <SectionHead
          kicker="Where the work happens"
          title={
            <>
              {`${PRODUCTS.length} products.`} <Em>One database.</Em>
            </>
          }
          lede="An AI Employee works where the records are: the same rows a Member edits, reached one Grant at a time. Nothing to sync, and no second system of record."
        />

        <div ref={frame} className="relative isolate mt-14">
          <div aria-hidden className="dot-paper absolute -inset-x-3 -inset-y-6 -z-10 rounded-[2.5rem] sm:-inset-x-8 sm:-inset-y-10" />
          <figure className="overflow-hidden rounded-[1.4rem] border border-black/10 bg-white shadow-lifted sm:rounded-[1.75rem]">
            <CompanyPreview />
          </figure>
          <p className="mt-4 text-center text-[12.5px] text-ink-500">
            Northstar Labs at 09:31, the morning after the night above. Illustrative.
          </p>
        </div>

        <ul ref={tiles} className="mt-16 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {PRODUCTS.map((product) => {
            const Icon = PRODUCT_ICON[product.slug];
            return (
              <li key={product.slug} className="min-w-0">
                <Link
                  href={`/products/${product.slug}`}
                  className="lift group flex h-full flex-col rounded-2xl border border-line bg-paper p-4 hover:border-line-strong hover:bg-white hover:shadow-soft sm:p-5"
                >
                  <span className="flex items-center justify-between">
                    <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-line bg-white">
                      {Icon && <Icon aria-hidden className="h-[17px] w-[17px] text-ink" strokeWidth={1.7} />}
                    </span>
                    <ArrowUpRight aria-hidden className="nudge-up h-4 w-4 text-ink-300 group-hover:text-ink" />
                  </span>
                  <span className="mt-4 flex items-center gap-2 text-[14.5px] font-medium tracking-[-0.005em] text-ink sm:mt-5 sm:text-[15.5px]">
                    {product.name}
                    <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${DEPT_DOT[productDept(product.slug)]}`} />
                  </span>
                  <span className="mt-1.5 hidden text-[13.5px] leading-5 text-ink-500 sm:block">
                    {PRODUCT_HOLDS[product.slug] ?? product.summary}
                  </span>
                </Link>
              </li>
            );
          })}
          <li className="col-span-2 min-w-0">
            <Link
              href="/products"
              className="lift group flex h-full min-h-[10.5rem] flex-col justify-between rounded-2xl bg-ink p-6 text-white hover:shadow-lifted"
            >
              <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-white/50">
                One install · one permission model
              </span>
              <span className="flex items-end justify-between gap-6">
                <span className="max-w-[26ch] font-display text-[1.75rem] leading-[1.1] tracking-[-0.015em]">
                  Every product, and the AI Employees that work in it.
                </span>
                <ArrowUpRight aria-hidden className="nudge-up h-5 w-5 shrink-0" />
              </span>
            </Link>
          </li>
        </ul>
      </Container>
    </Section>
  );
}
