import { ArrowRight, CheckCircle2 } from "lucide-react";
import { Nav } from "@/sections/Nav";
import { Footer, InstallCta } from "@/sections/Footer";
import { SectionEyebrow } from "@/sections/Primitives";
import { Link } from "@/lib/router";
import { PRODUCTS, PRODUCT_CATEGORIES, type ProductDef } from "@/products/data";
import { productIcon } from "@/products/productIcons";

const CHECKS = [
  "All built in, on by default",
  "One container, one database",
  "Humans and AI share every tool",
  "MIT licensed",
];

export function ProductsIndex() {
  const flagship = PRODUCTS.find((p) => p.slug === "ai-employees");
  const rest = PRODUCT_CATEGORIES.flatMap((category) =>
    PRODUCTS.filter((p) => p.category === category && p.slug !== "ai-employees"),
  );

  return (
    <div className="min-h-screen bg-white text-zinc-950">
      <Nav />
      <main>
        <section className="relative overflow-hidden bg-white">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[480px] bg-[radial-gradient(60%_80%_at_50%_0%,rgba(15,23,42,0.05),transparent_70%)]"
          />
          <div className="mx-auto max-w-7xl px-6 pt-14 pb-16 sm:pt-20 sm:pb-20">
            <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
              <SectionEyebrow>Products</SectionEyebrow>
              <h1 className="mt-6 text-balance font-semibold leading-[1.05] tracking-[-0.03em] text-zinc-950 text-[2.75rem] sm:text-[3.5rem]">
                Everything a company runs on.{" "}
                <span className="text-zinc-500">In one box.</span>
              </h1>
              <p className="mt-6 max-w-2xl text-balance text-lg leading-[1.6] text-zinc-600">
                Genosyn is not just AI workers — it ships the chat, tasks, data,
                knowledge, automation, analytics, inbox, CRM, books, and code
                access a real company needs. Every tool is shared by humans and
                AI employees, on your own server.
              </p>
              <ul className="mt-9 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs font-medium text-zinc-500">
                {CHECKS.map((c) => (
                  <li key={c} className="inline-flex items-center gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5 text-zinc-700" />
                    {c}
                  </li>
                ))}
              </ul>
            </div>

            {flagship && <FlagshipCard product={flagship} />}

            <div className="mt-14 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {rest.map((p) => (
                <ProductCard key={p.slug} product={p} />
              ))}
            </div>
          </div>
        </section>

        <InstallCta />
      </main>
      <Footer />
    </div>
  );
}

function FlagshipCard({ product }: { product: ProductDef }) {
  const Icon = productIcon(product.icon);
  return (
    <Link
      href={`/products/${product.slug}`}
      className="group relative mx-auto mt-14 block max-w-5xl overflow-hidden rounded-3xl bg-gradient-to-br from-zinc-950 via-zinc-900 to-zinc-950 p-8 shadow-lift transition hover:-translate-y-0.5 sm:p-10"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.14),transparent_65%)]"
      />
      <div className="relative flex flex-col gap-6 sm:flex-row sm:items-center">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white/10 text-white ring-1 ring-white/15">
          <Icon className="h-6 w-6" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <h2 className="text-xl font-semibold text-white sm:text-2xl">
              {product.name}
            </h2>
            <span className="rounded-full border border-white/15 bg-white/5 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-300">
              The core
            </span>
          </div>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400">
            {product.summary}
          </p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-white/15 px-5 py-2.5 text-sm font-semibold text-white transition group-hover:bg-white/5">
          Meet them
          <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
        </span>
      </div>
    </Link>
  );
}

function ProductCard({ product }: { product: ProductDef }) {
  const Icon = productIcon(product.icon);
  return (
    <Link
      href={`/products/${product.slug}`}
      className="group flex flex-col rounded-2xl border border-zinc-200 bg-white p-6 shadow-card transition hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-lift"
    >
      <div className="flex items-start justify-between">
        <div
          className={`flex h-10 w-10 items-center justify-center rounded-xl ring-1 transition group-hover:scale-105 ${product.accent}`}
        >
          <Icon className="h-5 w-5" />
        </div>
        <span className="rounded-md bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-600 ring-1 ring-zinc-200/70">
          {product.category}
        </span>
      </div>
      <h3 className="mt-5 text-base font-semibold text-zinc-950">{product.name}</h3>
      <p className="mt-2 flex-1 text-sm leading-relaxed text-zinc-600">
        {product.summary}
      </p>
      <span className="mt-4 inline-flex items-center gap-1 text-xs font-semibold text-zinc-500 transition group-hover:text-zinc-900">
        Learn more
        <ArrowRight className="h-3 w-3 transition group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}
