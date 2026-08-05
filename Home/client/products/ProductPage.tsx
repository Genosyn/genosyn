import { ArrowRight, BookOpen, CheckCircle2, ChevronDown } from "lucide-react";
import { Nav } from "@/sections/Nav";
import { Footer, InstallCta } from "@/sections/Footer";
import { SectionEyebrow } from "@/sections/Primitives";
import { Link } from "@/lib/router";
import { PRODUCTS, type ProductDef } from "@/products/data";
import { productIcon } from "@/products/productIcons";
import { ProductPrototype } from "@/products/ProductPrototype";
import { getUseCasesForProduct } from "@/products/useCases";

export function ProductPage({ product }: { product: ProductDef }) {
  const Icon = productIcon(product.icon);
  const useCases = getUseCasesForProduct(product.slug).slice(0, 3);

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
          <div className="relative mx-auto max-w-[90rem] px-5 pb-14 pt-10 sm:px-6 sm:pb-18 sm:pt-14 lg:pb-20 lg:pt-16">
            <div className="grid gap-12 lg:grid-cols-[0.78fr_1.22fr] lg:items-center lg:gap-14 xl:gap-20">
              <div className="mx-auto max-w-2xl lg:mx-0">
                <nav
                  aria-label="Breadcrumb"
                  className="flex items-center gap-2 text-xs font-medium text-slate-500"
                >
                  <Link href="/products" className="transition hover:text-slate-950">
                    Products
                  </Link>
                  <span className="text-slate-300">/</span>
                  <span>{product.category}</span>
                </nav>

                <div className="mt-7 inline-flex items-center gap-2.5 rounded-full border border-slate-200 bg-white py-1.5 pl-1.5 pr-3.5 text-[11px] font-semibold text-slate-800 shadow-sm">
                  <span
                    className={`flex h-7 w-7 items-center justify-center rounded-full ring-1 ${product.accent}`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  {product.name}
                  <span className="h-1 w-1 rounded-full bg-slate-300" />
                  <span className="font-medium text-slate-500">Built into Genosyn</span>
                </div>

                <h1 className="mt-6 text-balance text-[3.2rem] font-semibold leading-[0.98] tracking-[-0.055em] text-slate-950 sm:text-[4.4rem] lg:text-[4.7rem]">
                  {product.tagline}
                </h1>
                <p className="mt-4 max-w-xl text-balance text-xl font-medium leading-7 tracking-[-0.02em] text-slate-500 sm:text-2xl sm:leading-8">
                  {product.taglineAccent}
                </p>
                <p className="mt-5 max-w-2xl text-pretty text-sm leading-6 text-slate-600 sm:text-base sm:leading-7">
                  {product.intro}
                </p>
                <div className="mt-7 flex flex-col gap-3 sm:flex-row">
                  <a
                    href="/#quickstart"
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-950 px-5 py-3 text-sm font-semibold text-white shadow-[0_8px_20px_-10px_rgba(15,23,42,0.8)] transition hover:-translate-y-0.5 hover:bg-slate-800 hover:shadow-md"
                  >
                    Install Genosyn
                    <ArrowRight className="h-4 w-4" />
                  </a>
                  <Link
                    href={product.docsPath ?? "/docs"}
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-400 hover:bg-slate-50"
                  >
                    <BookOpen className="h-4 w-4" />
                    Read the docs
                  </Link>
                </div>
              </div>

              <div className="relative">
                <div className="mb-3 flex items-center justify-between px-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
                  <span>{product.name} · Live product story</span>
                  <span className="inline-flex items-center gap-1.5 text-emerald-700">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    Running
                  </span>
                </div>
                <ProductPrototype product={product} compact />
              </div>
            </div>

            <ul className="mt-10 grid overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm sm:grid-cols-2 lg:grid-cols-4">
              {product.checks.map((check, index) => (
                <li
                  key={check}
                  className="flex items-center gap-3 border-slate-200 px-4 py-3.5 text-[11px] font-medium text-slate-600 sm:[&:nth-child(even)]:border-l lg:border-l lg:first:border-l-0"
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-950">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  </span>
                  <span>
                    <span className="block text-[8px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="mt-0.5 block">{check}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="bg-white">
          <div className="mx-auto max-w-7xl px-5 py-20 sm:px-6 sm:py-24">
            <div className="mx-auto max-w-3xl text-center">
              <SectionEyebrow>{product.name} in practice</SectionEyebrow>
              <h2 className="mt-5 text-balance text-3xl font-semibold tracking-[-0.035em] text-slate-950 sm:text-4xl">
                Built around outcomes, not demos.
              </h2>
              <p className="mx-auto mt-4 max-w-2xl text-sm leading-6 text-slate-600 sm:text-base">
                Start with a real role and a real handoff. Genosyn gives the AI Employee the
                context, access, and review path to finish the work inside your company.
              </p>
            </div>
            <div className="mt-10 grid gap-4 lg:grid-cols-3">
              {useCases.map((useCase) => (
                <article
                  key={useCase.role}
                  className="rounded-xl border border-slate-200 bg-slate-50 p-5 transition hover:-translate-y-0.5 hover:border-slate-300 hover:bg-white hover:shadow-sm"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={`flex h-9 w-9 items-center justify-center rounded-lg text-[10px] font-bold ring-1 ${useCase.accent}`}
                    >
                      {useCase.initials}
                    </span>
                    <div>
                      <div className="text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-400">
                        {useCase.team}
                      </div>
                      <h3 className="mt-0.5 text-sm font-semibold text-slate-900">
                        {useCase.role}
                      </h3>
                    </div>
                  </div>
                  <p className="mt-4 text-sm leading-6 text-slate-600">{useCase.objective}</p>
                  <div className="mt-5 rounded-lg border border-slate-200 bg-slate-100/70 px-3 py-2.5 text-[11px] font-medium leading-5 text-slate-800">
                    {useCase.outcome}
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="border-y border-slate-200 bg-slate-50">
          <div className="mx-auto max-w-7xl px-5 py-20 sm:px-6 sm:py-24">
            <div className="grid gap-10 lg:grid-cols-[0.66fr_1.34fr] lg:gap-16">
              <div>
                <SectionEyebrow>What ships</SectionEyebrow>
                <h2 className="mt-5 text-3xl font-semibold tracking-[-0.035em] text-slate-950 sm:text-4xl">
                  {product.name}, end to end.
                </h2>
                <p className="mt-4 text-sm leading-6 text-slate-600">
                  Every capability is built into the same operating model, with company identity,
                  access, activity, and AI Employees already connected.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {product.features.map((feature) => {
                  const FeatureIcon = productIcon(feature.icon);
                  return (
                    <article
                      key={feature.title}
                      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md"
                    >
                      <span
                        className={`flex h-9 w-9 items-center justify-center rounded-lg ring-1 ${product.accent}`}
                      >
                        <FeatureIcon className="h-4 w-4" />
                      </span>
                      <h3 className="mt-4 text-sm font-semibold text-slate-900">{feature.title}</h3>
                      <p className="mt-2 text-xs leading-5 text-slate-500">{feature.body}</p>
                    </article>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        <section className="bg-slate-950 text-white">
          <div className="mx-auto max-w-7xl px-5 py-20 sm:px-6 sm:py-24">
            <div className="grid gap-10 lg:grid-cols-[0.72fr_1.28fr] lg:items-start lg:gap-16">
              <div>
                <span className="inline-flex items-center gap-2 rounded-full border border-slate-400/25 bg-slate-400/10 px-3 py-1 text-[11px] font-semibold text-slate-300">
                  <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
                  With AI Employees
                </span>
                <h2 className="mt-5 text-balance text-3xl font-semibold tracking-[-0.035em] text-white sm:text-4xl">
                  {product.employees.heading}
                </h2>
                <p className="mt-4 text-sm leading-6 text-slate-400">{product.employees.body}</p>
              </div>
              <div className="space-y-3">
                {product.employees.bullets.map((bullet, index) => (
                  <article
                    key={bullet.title}
                    className="rounded-xl border border-white/10 bg-white/[0.045] p-5"
                  >
                    <div className="flex items-start gap-4">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white/10 font-mono text-[10px] font-semibold text-slate-300">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <div>
                        <h3 className="text-sm font-semibold text-white">{bullet.title}</h3>
                        <p className="mt-1.5 text-sm leading-6 text-slate-400">{bullet.body}</p>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="bg-white">
          <div className="mx-auto max-w-3xl px-5 py-20 sm:px-6 sm:py-24">
            <div className="text-center">
              <SectionEyebrow>Questions</SectionEyebrow>
              <h2 className="mt-5 text-3xl font-semibold tracking-[-0.035em] text-slate-950 sm:text-4xl">
                Frequently asked.
              </h2>
            </div>
            <div className="mt-9 space-y-2.5">
              {product.faqs.map((faq) => (
                <details
                  key={faq.q}
                  className="group rounded-xl border border-slate-200 bg-white open:bg-slate-50"
                >
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-sm font-semibold text-slate-900 [&::-webkit-details-marker]:hidden">
                    {faq.q}
                    <ChevronDown className="h-4 w-4 shrink-0 text-slate-400 transition group-open:rotate-180" />
                  </summary>
                  <p className="px-5 pb-5 text-sm leading-6 text-slate-600">{faq.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <RelatedProducts current={product} />
        <InstallCta />
      </main>
      <Footer />
    </div>
  );
}

function RelatedProducts({ current }: { current: ProductDef }) {
  const related = [
    ...PRODUCTS.filter(
      (product) => product.slug !== current.slug && product.category === current.category,
    ),
    ...PRODUCTS.filter(
      (product) => product.slug !== current.slug && product.category !== current.category,
    ),
  ].slice(0, 4);

  return (
    <section className="border-t border-slate-200 bg-slate-50">
      <div className="mx-auto max-w-7xl px-5 py-16 sm:px-6">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-lg font-semibold text-slate-900">Explore more products</h2>
          <Link
            href="/products"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-950"
          >
            View all
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {related.map((product) => {
            const Icon = productIcon(product.icon);
            return (
              <Link
                key={product.slug}
                href={`/products/${product.slug}`}
                className="group rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md"
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`flex h-8 w-8 items-center justify-center rounded-lg ring-1 ${product.accent}`}
                  >
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="text-sm font-semibold text-slate-900">{product.name}</span>
                  <ArrowRight className="ml-auto h-3.5 w-3.5 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-950" />
                </div>
                <p className="mt-3 line-clamp-2 text-xs leading-5 text-slate-500">
                  {product.summary}
                </p>
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
}
