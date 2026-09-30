import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { useReveal } from "@/components/Reveal";
import { SIGN_UP_URL } from "@/lib/constants";
import { iconFor } from "@/lib/icons";
import { Link } from "@/lib/router";
import { PRODUCT_CATEGORIES, PRODUCTS, type ProductDef } from "@/products/data";
import { PRODUCT_ICON, productDept, workedBy } from "@/products/meta";
import { CompanyPreview } from "@/sections/CompanyPreview";
import { ClosingCta, Footer } from "@/sections/Footer";
import { Button, Container, DEPT_DOT, Em, FactRow, Section } from "@/sections/Kit";
import { Nav } from "@/sections/Nav";
import { PageHero } from "@/sections/PageHero";

export function ProductsIndex() {
  return (
    <div className="min-h-screen overflow-x-clip bg-paper text-ink">
      <Nav />
      <main>
        <PageHero
          kicker="Products"
          title={
            <>
              Everything the work needs, <Em>in one install.</Em>
            </>
          }
          lede="An AI Employee works inside these the way a colleague works inside your tools. A Grant decides which records it reaches, and every Run leaves a trail you can read back."
          actions={
            <>
              <Button href={SIGN_UP_URL} variant="ink" arrow>
                Start free
              </Button>
              <Button href="/docs" variant="outline">
                Read the docs
              </Button>
            </>
          }
          meta={
            <FactRow
              items={[
                `${PRODUCTS.length} products`,
                `${PRODUCT_CATEGORIES.length} categories`,
                "1 database",
                "Apache 2.0",
              ]}
            />
          }
        >
          <div className="relative isolate mt-16">
            <div aria-hidden className="dot-paper absolute -inset-x-3 -inset-y-6 -z-10 rounded-[2.5rem] sm:-inset-x-8 sm:-inset-y-10" />
            <div className="overflow-hidden rounded-[1.5rem] border border-black/10 bg-white shadow-lifted">
              <CompanyPreview />
            </div>
          </div>
        </PageHero>

        <Catalogue />
        <ClosingCta />
      </main>
      <Footer />
    </div>
  );
}

function Catalogue() {
  const [category, setCategory] = useState<string | null>(null);
  const grid = useReveal<HTMLUListElement>(0, 40);
  const categories = PRODUCT_CATEGORIES.filter((name) => PRODUCTS.some((product) => product.category === name));
  const shown = category ? PRODUCTS.filter((product) => product.category === category) : PRODUCTS;
  return (
    <Section id="catalogue" tone="raised" space="md" rule>
      <Container>
        <div className="flex flex-wrap items-end justify-between gap-6">
          <h2 className="font-display text-display-md text-ink">
            The catalogue <Em>{`· ${PRODUCTS.length}`}</Em>
          </h2>
          <div role="group" aria-label="Filter by category" className="flex flex-wrap gap-2">
            {[null, ...categories].map((name) => {
              const active = category === name;
              return (
                <button
                  key={name ?? "all"}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setCategory(name)}
                  className={`h-9 rounded-full border px-4 text-[13.5px] transition-colors ${
                    active
                      ? "border-ink bg-ink text-white"
                      : "border-line bg-paper text-ink-600 hover:border-line-strong hover:text-ink"
                  }`}
                >
                  {name ?? "All"}
                </button>
              );
            })}
          </div>
        </div>
        <ul ref={grid} className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((product) => (
            <li key={product.slug} className="min-w-0">
              <ProductCard product={product} />
            </li>
          ))}
        </ul>
      </Container>
    </Section>
  );
}

function ProductCard({ product }: { product: ProductDef }) {
  const Icon = PRODUCT_ICON[product.slug] ?? iconFor(product.icon);
  const roles = workedBy(product.slug);
  return (
    <Link
      href={`/products/${product.slug}`}
      className="lift group flex h-full flex-col rounded-3xl border border-line bg-paper p-6 hover:border-line-strong hover:bg-white hover:shadow-lifted sm:p-7"
    >
      <span className="flex items-center justify-between">
        <span className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-ink text-white">
            <Icon aria-hidden className="h-[18px] w-[18px]" strokeWidth={1.7} />
          </span>
          <span>
            <span className="flex items-center gap-2 text-[17px] font-medium tracking-[-0.01em] text-ink">
              {product.name}
              <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${DEPT_DOT[productDept(product.slug)]}`} />
            </span>
            <span className="mt-0.5 block font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-400">
              {product.category}
            </span>
          </span>
        </span>
        <ArrowUpRight aria-hidden className="nudge-up h-5 w-5 text-ink-300 group-hover:text-ink" />
      </span>
      <span className="mt-6 font-display text-[1.3rem] leading-[1.25] tracking-[-0.01em] text-ink">{product.tagline}</span>
      <span className="mt-3 text-[14.5px] leading-6 text-ink-600">{product.summary}</span>
      <span className="mt-auto pt-6 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-400">
        {roles.length === 0
          ? "Every role"
          : `Worked by ${roles.slice(0, 2).join(", ")}${roles.length > 2 ? ` +${roles.length - 2}` : ""}`}
      </span>
    </Link>
  );
}
