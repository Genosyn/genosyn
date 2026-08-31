import { ArrowRight, BookOpen } from "lucide-react";
import { Nav } from "@/sections/Nav";
import { Footer, InstallCta } from "@/sections/Footer";
import {
  HeroActions,
  HeroBadge,
  HeroBadgeDot,
  HeroButton,
  HeroCopy,
  HeroGrid,
  HeroLede,
  HeroProof,
  HeroSection,
  HeroTitle,
  HeroTitleMuted,
} from "@/sections/HeroKit";
import { Link } from "@/lib/router";
import { PRODUCTS, PRODUCT_CATEGORIES, type ProductDef } from "@/products/data";
import { productIcon } from "@/products/productIcons";
import { ProductPrototype } from "@/products/ProductPrototype";

const CHECKS = [
  "Built into one workspace",
  "Worked by Members and AI Employees alike",
  "Every product reachable by a Routine",
  "Self-hosted · Apache 2.0 licensed",
];

export function ProductsIndex() {
  const flagship = PRODUCTS.find((product) => product.slug === "ai-employees");

  return (
    <div className="min-h-screen bg-paper-100 text-zinc-800">
      <Nav />
      <main>
        <HeroSection>
          <HeroGrid>
            <HeroCopy>
              <HeroBadge>
                Genosyn products
                <HeroBadgeDot />
                <span className="font-medium text-zinc-500">{PRODUCTS.length} built in</span>
              </HeroBadge>
              <HeroTitle>
                Every tool an autonomous company{" "}
                <HeroTitleMuted>runs on.</HeroTitleMuted>
              </HeroTitle>
              <HeroLede>
                An AI Employee can only finish the jobs your systems let it finish. Chat, work,
                knowledge, automation, analytics, revenue, finance, and code all ship in the box —
                one operating model, worked by Members and AI Employees alike.
              </HeroLede>

              <HeroActions>
                <HeroButton href="/products/ai-employees">
                  Explore AI Employees
                  <ArrowRight aria-hidden className="h-4 w-4" />
                </HeroButton>
                <HeroButton href="/docs" variant="secondary">
                  <BookOpen aria-hidden className="h-4 w-4" />
                  Browse the docs
                </HeroButton>
              </HeroActions>

              <HeroProof items={CHECKS} />
            </HeroCopy>

            {flagship && <Flagship product={flagship} />}
          </HeroGrid>
        </HeroSection>

        <section id="product-catalog" className="bg-paper-50">
          <div className="mx-auto max-w-[88rem] px-5 py-20 sm:px-8 sm:py-24 lg:py-32">
            <div className="space-y-16">
              {PRODUCT_CATEGORIES.map((category) => {
                const products = PRODUCTS.filter(
                  (product) => product.category === category && product.slug !== "ai-employees",
                );
                if (products.length === 0) return null;
                return (
                  <div key={category}>
                    <div className="flex items-center gap-4">
                      <h2 className="text-sm font-semibold text-zinc-500">
                        {category}
                      </h2>
                      <span className="h-px flex-1 bg-zinc-200" />
                      <span className="text-[10px] font-medium text-zinc-400">
                        {products.length} {products.length === 1 ? "product" : "products"}
                      </span>
                    </div>
                    <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                      {products.map((product) => (
                        <ProductCard key={product.slug} product={product} />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <InstallCta />
      </main>
      <Footer />
    </div>
  );
}

function Flagship({ product }: { product: ProductDef }) {
  const Icon = productIcon(product.icon);
  return (
    <div className="on-night overflow-hidden rounded-3xl border border-night-700 bg-night-950 p-2 shadow-float sm:p-3">
      <div className="rounded-2xl border border-white/10 bg-night-950 p-3 sm:p-4">
        <div className="mb-4 flex flex-col gap-4 px-1 sm:flex-row sm:items-center">
          <span
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ring-1 ${product.accent}`}
          >
            <Icon className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <div className="text-[11px] font-semibold text-zinc-400">
              The core of Genosyn
            </div>
            <h2 className="mt-1 text-lg font-semibold tracking-[-0.02em] text-white">
              AI Employees running the company across every product
            </h2>
          </div>
          <Link
            href={`/products/${product.slug}`}
            className="inline-flex shrink-0 items-center gap-2 rounded-md border border-white/15 bg-white/10 px-3 py-2 text-xs font-semibold text-white transition hover:-translate-y-px hover:bg-white/15 sm:ml-auto"
          >
            View product
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
        <ProductPrototype product={product} compact />
      </div>
    </div>
  );
}

function ProductCard({ product }: { product: ProductDef }) {
  const Icon = productIcon(product.icon);
  return (
    <Link
      href={`/products/${product.slug}`}
      className="group flex min-h-56 flex-col rounded-2xl border border-zinc-200 bg-white p-6 shadow-card transition duration-200 hover:-translate-y-1 hover:border-zinc-300 hover:shadow-lift"
    >
      <div className="flex items-start justify-between">
        <span
          className={`flex h-9 w-9 items-center justify-center rounded-lg ring-1 ${product.accent}`}
        >
          <Icon className="h-4 w-4" />
        </span>
        <ArrowRight className="h-4 w-4 text-zinc-300 transition group-hover:translate-x-0.5 group-hover:text-zinc-950" />
      </div>
      <h3 className="mt-5 text-base font-semibold text-zinc-900">{product.name}</h3>
      <p className="mt-2 flex-1 text-sm leading-6 text-zinc-600">{product.summary}</p>
      <span className="mt-6 text-xs font-semibold text-zinc-900">Explore product</span>
    </Link>
  );
}
