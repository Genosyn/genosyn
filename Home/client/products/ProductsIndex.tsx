import { ArrowRight, BookOpen, CheckCircle2 } from "lucide-react";
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
          <div
            aria-hidden
            className="marketing-grid pointer-events-none absolute inset-0 opacity-60"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -top-48 left-1/2 h-[42rem] w-[68rem] -translate-x-1/2 rounded-full bg-slate-200/70 blur-3xl"
          />
          <div className="relative mx-auto max-w-[90rem] px-5 pb-16 pt-12 sm:px-6 sm:pb-20 sm:pt-16 lg:pt-20">
            <div className="grid gap-12 lg:grid-cols-[0.72fr_1.28fr] lg:items-center lg:gap-14 xl:gap-20">
              <div className="mx-auto max-w-2xl text-center lg:mx-0 lg:text-left">
                <SectionEyebrow>Genosyn products</SectionEyebrow>
                <h1 className="mt-6 text-balance text-[3.25rem] font-semibold leading-[0.98] tracking-[-0.055em] text-slate-950 sm:text-[4.55rem] lg:text-[4.8rem]">
                  Every team. Every tool.{" "}
                  <span className="text-slate-500">One company system.</span>
                </h1>
                <p className="mx-auto mt-6 max-w-xl text-pretty text-base leading-7 text-slate-600 sm:text-lg sm:leading-8 lg:mx-0">
                  Bring chat, work, knowledge, automation, analytics, revenue, finance, and code
                  into one operating model shared by Members and AI Employees.
                </p>

                <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row lg:justify-start">
                  <Link
                    href="/products/ai-employees"
                    className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-slate-950 px-5 py-3 text-sm font-semibold text-white shadow-[0_8px_20px_-10px_rgba(15,23,42,0.8)] transition hover:-translate-y-0.5 hover:bg-slate-800 hover:shadow-md sm:w-auto"
                  >
                    Explore AI Employees
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                  <Link
                    href="/docs"
                    className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-400 hover:bg-slate-50 sm:w-auto"
                  >
                    <BookOpen className="h-4 w-4" />
                    Browse the docs
                  </Link>
                </div>

                <ul className="mx-auto mt-7 grid max-w-lg gap-2 text-left text-[11px] font-medium text-slate-500 sm:grid-cols-2 lg:mx-0">
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
          </div>
        </section>

        <section id="product-catalog" className="bg-white">
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
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 p-2 shadow-[0_32px_80px_-38px_rgba(15,23,42,0.65)] sm:p-3">
      <div className="rounded-xl border border-white/10 bg-slate-950 p-3 sm:p-4">
        <div className="mb-4 flex flex-col gap-4 px-1 sm:flex-row sm:items-center">
          <span
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ring-1 ${product.accent}`}
          >
            <Icon className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
              The core of Genosyn
            </div>
            <h2 className="mt-1 text-lg font-semibold tracking-[-0.02em] text-white">
              AI Employees working across the company
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
      className="group flex min-h-56 flex-col rounded-xl border border-slate-200 bg-slate-50 p-5 transition duration-200 hover:-translate-y-0.5 hover:border-slate-300 hover:bg-white hover:shadow-md"
    >
      <div className="flex items-start justify-between">
        <span
          className={`flex h-9 w-9 items-center justify-center rounded-lg ring-1 ${product.accent}`}
        >
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
