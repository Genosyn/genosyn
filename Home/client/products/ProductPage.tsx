import { ArrowRight, BookOpen, CheckCircle2, ChevronDown } from "lucide-react";
import { Nav } from "@/sections/Nav";
import { Footer, InstallCta } from "@/sections/Footer";
import { SectionEyebrow } from "@/sections/Primitives";
import {
  HeroActions,
  HeroBadge,
  HeroBadgeDot,
  HeroButton,
  HeroCopy,
  HeroGrid,
  HeroLede,
  HeroPanel,
  HeroSection,
  HeroTagline,
  HeroTitle,
} from "@/sections/HeroKit";
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
        <HeroSection>
          <HeroGrid>
            <HeroCopy>
              <nav
                aria-label="Breadcrumb"
                className="flex items-center gap-2 text-xs font-medium text-slate-500"
              >
                <Link href="/products" className="transition hover:text-slate-950">
                  Products
                </Link>
                <span aria-hidden className="text-slate-400">
                  /
                </span>
                <span>{product.category}</span>
              </nav>

              <div className="mt-6">
                <HeroBadge
                  className="pl-1.5"
                  leading={
                    <span
                      aria-hidden
                      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ring-1 ${product.accent}`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                  }
                >
                  {product.name}
                  <HeroBadgeDot />
                  <span className="font-medium text-slate-500">Built into Genosyn</span>
                </HeroBadge>
              </div>

              <HeroTitle>{product.tagline}</HeroTitle>
              <HeroTagline>{product.taglineAccent}</HeroTagline>
              <HeroLede>{product.intro}</HeroLede>

              <HeroActions>
                <HeroButton href="/#quickstart">
                  Install Genosyn
                  <ArrowRight aria-hidden className="h-4 w-4" />
                </HeroButton>
                {/* Notes and Resources have no page of their own yet, so the
                    label has to promise the index, not a page. */}
                <HeroButton href={product.docsPath ?? "/docs"} variant="secondary">
                  <BookOpen aria-hidden className="h-4 w-4" />
                  {product.docsPath ? "Read the docs" : "Browse the docs"}
                </HeroButton>
              </HeroActions>
            </HeroCopy>

            <HeroPanel label={`${product.name} · Live product story`} status="Running">
              <ProductPrototype product={product} compact />
            </HeroPanel>
          </HeroGrid>

          <ul className="mt-12 grid overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm sm:grid-cols-2 lg:grid-cols-4">
            {product.checks.map((check, index) => (
              // Dividers are derived from the item's index against the column
              // count at each breakpoint (1 / 2 / 4), so a list whose length is
              // not a multiple of four still wraps into a properly ruled row.
              // Paid Marketing ships five checks; the old nth-child rules left
              // its fifth item as a borderless orphan with a stray left rule.
              <li
                key={check}
                className={[
                  "flex items-center gap-3 border-slate-200 px-4 py-3.5 text-xs font-medium text-slate-600",
                  index >= 1 ? "border-t" : "",
                  index >= 2 ? "sm:border-t" : "sm:border-t-0",
                  index % 2 === 1 ? "sm:border-l" : "sm:border-l-0",
                  index >= 4 ? "lg:border-t" : "lg:border-t-0",
                  index % 4 === 0 ? "lg:border-l-0" : "lg:border-l",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <span
                  aria-hidden
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-950"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                </span>
                <span>
                  <span aria-hidden className="block text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="mt-0.5 block">{check}</span>
                </span>
              </li>
            ))}
          </ul>
        </HeroSection>

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
