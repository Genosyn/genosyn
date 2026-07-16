import { ArrowRight, BookOpen, CheckCircle2, ChevronDown } from "lucide-react";
import { Nav } from "@/sections/Nav";
import { Footer, InstallCta } from "@/sections/Footer";
import { SectionEyebrow } from "@/sections/Primitives";
import { Link } from "@/lib/router";
import { PRODUCTS, type ProductDef } from "@/products/data";
import { productIcon } from "@/products/productIcons";
import { productPreview } from "@/products/previews";

export function ProductPage({ product }: { product: ProductDef }) {
  const Preview = productPreview(product.slug);
  const Icon = productIcon(product.icon);

  return (
    <div className="min-h-screen bg-white text-zinc-950">
      <Nav />
      <main>
        {/* ───────────────────────────── Hero ───────────────────────────── */}
        <section className="relative overflow-hidden bg-white">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[560px] bg-[radial-gradient(60%_80%_at_50%_0%,rgba(15,23,42,0.05),transparent_70%)]"
          />
          <div className="mx-auto max-w-7xl px-6 pt-12 pb-16 sm:pt-16 sm:pb-20">
            <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
              <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-xs font-medium text-zinc-500">
                <Link href="/products" className="transition hover:text-zinc-900">
                  Products
                </Link>
                <span className="text-zinc-300">/</span>
                <span className="text-zinc-700">{product.category}</span>
              </nav>

              <div
                className={`mt-6 flex h-12 w-12 items-center justify-center rounded-2xl ring-1 ${product.accent}`}
              >
                <Icon className="h-6 w-6" />
              </div>

              <h1 className="mt-5 text-balance font-semibold leading-[1.06] tracking-[-0.03em] text-zinc-950 text-[2.5rem] sm:text-[3.25rem]">
                {product.tagline}{" "}
                <span className="text-zinc-500">{product.taglineAccent}</span>
              </h1>

              <p className="mt-6 max-w-2xl text-balance text-lg leading-[1.6] text-zinc-600">
                {product.intro}
              </p>

              <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row">
                <a
                  href="/#quickstart"
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-zinc-950 px-6 py-3 text-sm font-semibold text-white shadow-lift transition hover:bg-zinc-800 sm:w-auto"
                >
                  Get started for free
                  <ArrowRight className="h-4 w-4" />
                </a>
                <Link
                  href={product.docsPath ?? "/docs"}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-6 py-3 text-sm font-semibold text-zinc-800 shadow-card transition hover:border-zinc-300 hover:bg-zinc-50 sm:w-auto"
                >
                  <BookOpen className="h-4 w-4" />
                  Read the docs
                </Link>
              </div>

              <ul className="mt-9 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs font-medium text-zinc-500">
                {product.checks.map((c) => (
                  <li key={c} className="inline-flex items-center gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5 text-zinc-700" />
                    {c}
                  </li>
                ))}
              </ul>
            </div>

            {Preview && (
              <div className="relative mx-auto mt-14 max-w-5xl">
                <div
                  aria-hidden
                  className="pointer-events-none absolute -inset-x-8 -inset-y-12 -z-10 rounded-[3rem] bg-gradient-to-b from-zinc-100/60 via-white to-white blur-2xl"
                />
                <Preview />
              </div>
            )}
          </div>
        </section>

        {/* ─────────────────────────── Features ─────────────────────────── */}
        <section className="border-t border-zinc-100 bg-white">
          <div className="mx-auto max-w-7xl px-6 py-20 sm:py-24">
            <div className="mx-auto max-w-2xl text-center">
              <SectionEyebrow>What ships in the box</SectionEyebrow>
              <h2 className="mt-4 text-balance text-3xl font-semibold tracking-[-0.02em] text-zinc-950 sm:text-4xl">
                {product.name}, in detail.
              </h2>
            </div>
            <div className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {product.features.map((f) => {
                const FeatureIcon = productIcon(f.icon);
                return (
                  <article
                    key={f.title}
                    className="group flex flex-col rounded-2xl border border-zinc-200 bg-white p-6 shadow-card transition hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-lift"
                  >
                    <div
                      className={`flex h-10 w-10 items-center justify-center rounded-xl ring-1 transition group-hover:scale-105 ${product.accent}`}
                    >
                      <FeatureIcon className="h-5 w-5" />
                    </div>
                    <h3 className="mt-5 text-base font-semibold text-zinc-950">
                      {f.title}
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-zinc-600">
                      {f.body}
                    </p>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        {/* ──────────────────────── With AI employees ───────────────────── */}
        <section className="bg-white">
          <div className="mx-auto max-w-7xl px-6 pb-20 sm:pb-24">
            <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-zinc-950 via-zinc-900 to-zinc-950 px-8 py-12 sm:px-12 sm:py-16">
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.14),transparent_65%)]"
              />
              <div className="relative grid grid-cols-1 gap-10 lg:grid-cols-5">
                <div className="lg:col-span-2">
                  <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-[11px] font-medium text-zinc-300">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                    With AI employees
                  </span>
                  <h2 className="mt-4 text-balance text-2xl font-semibold tracking-[-0.02em] text-white sm:text-3xl">
                    {product.employees.heading}
                  </h2>
                  <p className="mt-4 text-sm leading-relaxed text-zinc-400">
                    {product.employees.body}
                  </p>
                </div>
                <div className="space-y-4 lg:col-span-3">
                  {product.employees.bullets.map((b) => (
                    <div
                      key={b.title}
                      className="rounded-2xl border border-white/10 bg-white/[0.04] p-5"
                    >
                      <h3 className="text-sm font-semibold text-white">{b.title}</h3>
                      <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">
                        {b.body}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ─────────────────────────────── FAQ ──────────────────────────── */}
        <section className="border-t border-zinc-100 bg-white">
          <div className="mx-auto max-w-3xl px-6 py-20 sm:py-24">
            <div className="text-center">
              <SectionEyebrow>Questions</SectionEyebrow>
              <h2 className="mt-4 text-balance text-3xl font-semibold tracking-[-0.02em] text-zinc-950 sm:text-4xl">
                Frequently asked.
              </h2>
            </div>
            <div className="mt-10 space-y-3">
              {product.faqs.map((f) => (
                <details
                  key={f.q}
                  className="group rounded-2xl border border-zinc-200 bg-white shadow-card open:shadow-lift"
                >
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-6 py-4 text-[15px] font-semibold text-zinc-900 [&::-webkit-details-marker]:hidden">
                    {f.q}
                    <ChevronDown className="h-4 w-4 shrink-0 text-zinc-400 transition group-open:rotate-180" />
                  </summary>
                  <p className="px-6 pb-5 text-sm leading-relaxed text-zinc-600">
                    {f.a}
                  </p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* ────────────────────────── More products ─────────────────────── */}
        <section className="border-t border-zinc-100 bg-zinc-50/50">
          <div className="mx-auto max-w-7xl px-6 py-16 sm:py-20">
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="text-xl font-semibold tracking-[-0.01em] text-zinc-950">
                More in the box
              </h2>
              <Link
                href="/products"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-zinc-600 transition hover:text-zinc-950"
              >
                All products
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
            <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {relatedProducts(product).map((p) => {
                const RelIcon = productIcon(p.icon);
                return (
                  <Link
                    key={p.slug}
                    href={`/products/${p.slug}`}
                    className="group flex flex-col rounded-2xl border border-zinc-200 bg-white p-5 shadow-card transition hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-lift"
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className={`flex h-8 w-8 items-center justify-center rounded-lg ring-1 ${p.accent}`}
                      >
                        <RelIcon className="h-4 w-4" />
                      </span>
                      <span className="text-sm font-semibold text-zinc-950">
                        {p.name}
                      </span>
                    </div>
                    <p className="mt-3 line-clamp-2 text-[12.5px] leading-relaxed text-zinc-600">
                      {p.summary}
                    </p>
                    <span className="mt-3 inline-flex items-center gap-1 text-[11px] font-semibold text-zinc-500 transition group-hover:text-zinc-900">
                      Learn more
                      <ArrowRight className="h-3 w-3 transition group-hover:translate-x-0.5" />
                    </span>
                  </Link>
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

function relatedProducts(current: ProductDef): ProductDef[] {
  const others = PRODUCTS.filter((p) => p.slug !== current.slug);
  const sameCategory = others.filter((p) => p.category === current.category);
  const rest = others.filter((p) => p.category !== current.category);
  return [...sameCategory, ...rest].slice(0, 4);
}
