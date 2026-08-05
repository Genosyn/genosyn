import { ArrowRight, CheckCircle2 } from "lucide-react";
import { Nav } from "@/sections/Nav";
import { Footer, InstallCta } from "@/sections/Footer";
import { SectionEyebrow } from "@/sections/Primitives";
import { Link } from "@/lib/router";
import { PRODUCTS, PRODUCT_CATEGORIES, type ProductDef } from "@/products/data";
import { productIcon } from "@/products/productIcons";
import { ProductPrototype } from "@/products/ProductPrototype";

const CHECKS = [
  "Built into one workspace",
  "Shared by Members and AI Employees",
  "Self-hosted on your infrastructure",
];

export function ProductsIndex() {
  const flagship = PRODUCTS.find((product) => product.slug === "ai-employees");

  return (
    <div className="min-h-screen bg-white text-slate-950">
      <Nav />
      <main>
        <section className="relative overflow-hidden border-b border-slate-200 bg-white">
          <div aria-hidden className="marketing-grid pointer-events-none absolute inset-0 opacity-60" />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-[34rem] bg-[radial-gradient(circle_at_50%_0%,rgba(226,232,240,0.78),transparent_70%)]"
          />
          <div className="relative mx-auto max-w-7xl px-5 pb-20 pt-14 sm:px-6 sm:pt-20">
            <div className="mx-auto max-w-4xl text-center">
              <SectionEyebrow>Genosyn products</SectionEyebrow>
              <h1 className="mt-6 text-balance text-[3rem] font-semibold leading-[1] tracking-[-0.05em] text-slate-950 sm:text-[4.7rem]">
                One system for the whole company.
              </h1>
              <p className="mx-auto mt-6 max-w-3xl text-pretty text-base leading-7 text-slate-600 sm:text-lg sm:leading-8">
                Chat, work, knowledge, automation, analytics, revenue, finance, and code—connected
                by one company model and available to every role you authorize.
              </p>
              <ul className="mt-7 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[11px] font-medium text-slate-500">
                {CHECKS.map((item) => (
                  <li key={item} className="inline-flex items-center gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5 text-slate-950" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>

            {flagship && <Flagship product={flagship} />}
          </div>
        </section>

        <section className="bg-white">
          <div className="mx-auto max-w-7xl px-5 py-20 sm:px-6 sm:py-24">
            <div className="space-y-16">
              {PRODUCT_CATEGORIES.map((category) => {
                const products = PRODUCTS.filter(
                  (product) => product.category === category && product.slug !== "ai-employees",
                );
                if (products.length === 0) return null;
                return (
                  <div key={category}>
                    <div className="flex items-center gap-4">
                      <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                        {category}
                      </h2>
                      <span className="h-px flex-1 bg-slate-200" />
                      <span className="text-[10px] font-medium text-slate-400">
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
    <div className="mt-14 overflow-hidden rounded-2xl border border-slate-200 bg-white p-2 shadow-[0_26px_70px_-36px_rgba(15,23,42,0.45)] sm:mt-16 sm:p-3">
      <div className="grid gap-8 rounded-xl bg-slate-950 p-6 sm:p-8 lg:grid-cols-[0.62fr_1.38fr] lg:items-center">
        <div>
          <span className={`flex h-10 w-10 items-center justify-center rounded-lg ring-1 ${product.accent}`}>
            <Icon className="h-5 w-5" />
          </span>
          <div className="mt-5 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-300">
            The core of Genosyn
          </div>
          <h2 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-white">
            {product.name}
          </h2>
          <p className="mt-3 text-sm leading-6 text-slate-400">{product.summary}</p>
          <Link
            href={`/products/${product.slug}`}
            className="mt-6 inline-flex items-center gap-2 rounded-md bg-white px-4 py-2.5 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-white/10 transition hover:-translate-y-px hover:bg-slate-100"
          >
            Explore AI Employees
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
      className="group flex min-h-56 flex-col rounded-xl border border-slate-200 bg-slate-50 p-5 transition duration-200 hover:-translate-y-0.5 hover:border-slate-300 hover:bg-white hover:shadow-md"
    >
      <div className="flex items-start justify-between">
        <span className={`flex h-9 w-9 items-center justify-center rounded-lg ring-1 ${product.accent}`}>
          <Icon className="h-4 w-4" />
        </span>
        <ArrowRight className="h-4 w-4 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-950" />
      </div>
      <h3 className="mt-5 text-base font-semibold text-slate-900">{product.name}</h3>
      <p className="mt-2 flex-1 text-sm leading-6 text-slate-600">{product.summary}</p>
      <span className="mt-5 text-[11px] font-semibold text-slate-950">Explore product</span>
    </Link>
  );
}
