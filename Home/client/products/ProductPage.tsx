import { ArrowRight, BookOpen, CheckCircle2, ChevronDown } from "lucide-react";
import { Nav } from "@/sections/Nav";
import { Footer, InstallCta } from "@/sections/Footer";
import { Eyebrow } from "@/sections/Kit";
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
    <div className="min-h-screen bg-white text-stone-900">
      <Nav />
      <main>
        <HeroSection>
          <HeroGrid>
            <HeroCopy>
              <nav
                aria-label="Breadcrumb"
                className="flex items-center gap-2 text-xs font-medium text-stone-500"
              >
                <Link href="/products" className="transition hover:text-tide-600">
                  Products
                </Link>
                <span aria-hidden className="text-stone-400">
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
                  <span className="font-medium text-stone-500">Built into Genosyn</span>
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

          <ul className="mt-12 grid overflow-hidden rounded-2xl border border-stone-900/[0.08] bg-white shadow-card sm:grid-cols-2 lg:grid-cols-4">
            {product.checks.map((check, index) => (
              // Dividers are derived from the item's index against the column
              // count at each breakpoint (1 / 2 / 4), so a list whose length is
              // not a multiple of four still wraps into a properly ruled row.
              // Paid Marketing ships five checks; the old nth-child rules left
              // its fifth item as a borderless orphan with a stray left rule.
              <li
                key={check}
                className={[
                  "flex items-center gap-3 border-stone-900/[0.08] px-4 py-3.5 text-xs font-medium text-stone-600",
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
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-paper-200 text-stone-900"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                </span>
                <span>
                  <span aria-hidden className="block text-[11px] font-semibold text-stone-500">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="mt-0.5 block">{check}</span>
                </span>
              </li>
            ))}
          </ul>
        </HeroSection>

        <section className="bg-paper-50">
          <div className="mx-auto max-w-[88rem] px-5 py-20 sm:px-8 sm:py-24 lg:py-32">
            <div className="mx-auto max-w-3xl text-center">
              <Eyebrow>{product.name} in practice</Eyebrow>
              <h2 className="mt-5 text-balance text-[clamp(1.75rem,3vw,2.5rem)] font-semibold leading-[1.08] tracking-[-0.035em] text-stone-900">
                Built around outcomes, not demos.
              </h2>
              <p className="mx-auto mt-6 max-w-2xl text-base leading-7 text-stone-600 sm:text-lg">
                Start with a real role and a real handoff. Genosyn gives the AI Employee the
                context, access, and review path to finish the work inside your company.
              </p>
            </div>
            <div className="mt-10 grid gap-4 lg:grid-cols-3">
              {useCases.map((useCase) => (
                <article
                  key={useCase.role}
                  className="rounded-2xl border border-stone-900/[0.08] bg-white p-5 transition hover:-translate-y-0.5 hover:border-stone-900/[0.14] hover:shadow-lift"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={`flex h-9 w-9 items-center justify-center rounded-lg text-[10px] font-bold ring-1 ${useCase.accent}`}
                    >
                      {useCase.initials}
                    </span>
                    <div>
                      <div className="text-[11px] font-semibold text-stone-400">
                        {useCase.team}
                      </div>
                      <h3 className="mt-0.5 text-sm font-semibold text-stone-900">
                        {useCase.role}
                      </h3>
                    </div>
                  </div>
                  <p className="mt-5 text-base leading-7 text-stone-600">{useCase.objective}</p>
                  <div className="mt-5 rounded-lg border border-stone-900/[0.08] bg-paper-200/70 px-3 py-2.5 text-[11px] font-medium leading-5 text-stone-800">
                    {useCase.outcome}
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="border-y border-stone-900/[0.07] bg-paper-200">
          <div className="mx-auto max-w-[88rem] px-5 py-20 sm:px-8 sm:py-24 lg:py-32">
            <div className="grid gap-10 lg:grid-cols-[0.66fr_1.34fr] lg:gap-16">
              <div>
                <Eyebrow>What ships</Eyebrow>
                <h2 className="mt-5 text-[clamp(1.75rem,3vw,2.5rem)] font-semibold leading-[1.08] tracking-[-0.035em] text-stone-900">
                  {product.name}, end to end.
                </h2>
                <p className="mt-5 text-base leading-7 text-stone-600">
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
                      className="rounded-2xl border border-stone-900/[0.08] bg-white p-5 shadow-card transition hover:-translate-y-0.5 hover:border-tide-300 hover:shadow-lift"
                    >
                      <span
                        className={`flex h-9 w-9 items-center justify-center rounded-lg ring-1 ${product.accent}`}
                      >
                        <FeatureIcon className="h-4 w-4" />
                      </span>
                      <h3 className="mt-4 text-sm font-semibold text-stone-900">{feature.title}</h3>
                      <p className="mt-2 text-xs leading-5 text-stone-500">{feature.body}</p>
                    </article>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        <section className="on-night relative isolate overflow-hidden bg-night-950 text-violet-100/70">
          <div aria-hidden className="pointer-events-none absolute inset-0 aurora-night" />
          <div className="mx-auto max-w-[88rem] px-5 py-20 sm:px-8 sm:py-24 lg:py-32">
            <div className="grid gap-10 lg:grid-cols-[0.72fr_1.28fr] lg:items-start lg:gap-16">
              <div>
                <span className="inline-flex items-center gap-2.5 text-sm font-semibold text-tide-300">
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-tide-300" />
                  With AI Employees
                </span>
                <h2 className="mt-5 text-balance text-[clamp(1.75rem,3vw,2.5rem)] font-semibold leading-[1.08] tracking-[-0.035em] text-white">
                  {product.employees.heading}
                </h2>
                <p className="mt-5 text-base leading-7 text-violet-100/70">{product.employees.body}</p>
              </div>
              <div className="space-y-3">
                {product.employees.bullets.map((bullet, index) => (
                  <article
                    key={bullet.title}
                    className="rounded-2xl border border-white/[0.10] bg-white/[0.05] p-6 shadow-panel"
                  >
                    <div className="flex items-start gap-4">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.08] text-xs font-semibold text-tide-300">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <div>
                        <h3 className="text-sm font-semibold text-white">{bullet.title}</h3>
                        <p className="mt-2 text-sm leading-6 text-violet-100/60">{bullet.body}</p>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="bg-paper-50">
          <div className="mx-auto max-w-3xl px-5 py-20 sm:px-8 sm:py-24 lg:py-28">
            <div className="text-center">
              <Eyebrow>Questions</Eyebrow>
              <h2 className="mt-5 text-[clamp(1.75rem,3vw,2.5rem)] font-semibold leading-[1.08] tracking-[-0.035em] text-stone-900">
                Frequently asked.
              </h2>
            </div>
            <div className="mt-9 space-y-2.5">
              {product.faqs.map((faq) => (
                <details
                  key={faq.q}
                  className="group rounded-2xl border border-stone-900/[0.08] bg-white open:bg-paper-100"
                >
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-sm font-semibold text-stone-900 [&::-webkit-details-marker]:hidden">
                    {faq.q}
                    <ChevronDown className="h-4 w-4 shrink-0 text-stone-400 transition group-open:rotate-180" />
                  </summary>
                  <p className="px-5 pb-5 text-sm leading-6 text-stone-600">{faq.a}</p>
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
    <section className="border-t border-stone-900/[0.07] bg-paper-200">
      <div className="mx-auto max-w-[88rem] px-5 py-16 sm:px-8 sm:py-20">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-lg font-semibold text-stone-900">Explore more products</h2>
          <Link
            href="/products"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-stone-900"
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
                className="group rounded-2xl border border-stone-900/[0.08] bg-white p-4 shadow-card transition hover:-translate-y-0.5 hover:border-tide-300 hover:shadow-lift"
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`flex h-8 w-8 items-center justify-center rounded-lg ring-1 ${product.accent}`}
                  >
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="text-sm font-semibold text-stone-900">{product.name}</span>
                  <ArrowRight className="ml-auto h-3.5 w-3.5 text-stone-300 transition group-hover:translate-x-0.5 group-hover:text-tide-600" />
                </div>
                <p className="mt-3 line-clamp-2 text-xs leading-5 text-stone-500">
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
