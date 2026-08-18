import { ArrowRight, CheckCircle2 } from "lucide-react";
import { Link } from "@/lib/router";
import { PRODUCTS } from "@/products/data";
import { productIcon } from "@/products/productIcons";
import { SectionEyebrow } from "@/sections/Primitives";

const FEATURED_SLUGS = ["workspace", "tasks", "revenue", "email", "finance", "repositories"];
const FEATURED = FEATURED_SLUGS.map((slug) => PRODUCTS.find((product) => product.slug === slug)).filter(
  (product): product is NonNullable<typeof product> => Boolean(product),
);

const SHARED_FOUNDATION = [
  "One company-wide identity and permissions model",
  "The same records for Members and AI Employees",
  "One approval queue for sensitive work",
  "One searchable history of what happened",
];

export function Features() {
  return (
    <section id="platform" className="bg-white">
      <div className="mx-auto max-w-7xl px-5 py-20 sm:px-6 sm:py-24 lg:py-28">
        <div className="mx-auto max-w-3xl text-center">
          <SectionEyebrow>The shared workspace</SectionEyebrow>
          <h2 className="mt-5 text-balance text-4xl font-semibold tracking-[-0.04em] text-slate-950 sm:text-5xl">
            The tools to run the company, already connected.
          </h2>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-7 text-slate-600 sm:text-lg">
            AI Employees do not live in a separate automation layer. They work in the same products,
            on the same records, with the same review queues as everyone else.
          </p>
        </div>

        <div className="mt-12 overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 shadow-sm">
          <div className="grid lg:grid-cols-[0.72fr_1.28fr]">
            <div className="border-b border-slate-200 bg-white p-6 sm:p-8 lg:border-b-0 lg:border-r">
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-950">
                Shared by design
              </div>
              <h3 className="mt-3 text-2xl font-semibold tracking-[-0.03em] text-slate-950">
                One operating context.
              </h3>
              <p className="mt-3 text-sm leading-6 text-slate-600">
                Stop copying context between chatbots and business systems. Genosyn gives every role
                a governed way to read, write, and hand off work.
              </p>
              <ul className="mt-6 space-y-3">
                {SHARED_FOUNDATION.map((item) => (
                  <li key={item} className="flex items-start gap-2.5 text-sm leading-5 text-slate-600">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-slate-950" />
                    {item}
                  </li>
                ))}
              </ul>
              <Link
                href="/products"
                className="mt-7 inline-flex items-center gap-2 rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800"
              >
                See every product
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>

            <div className="grid gap-px bg-slate-200 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURED.map((product) => {
                const Icon = productIcon(product.icon);
                return (
                  <Link
                    key={product.slug}
                    href={`/products/${product.slug}`}
                    className="group min-h-48 bg-slate-50 p-5 transition hover:bg-white hover:shadow-[inset_0_0_0_1px_rgba(148,163,184,0.28)]"
                  >
                    <div className="flex items-start justify-between">
                      <span
                        className={`flex h-9 w-9 items-center justify-center rounded-lg ring-1 ${product.accent}`}
                      >
                        <Icon className="h-4 w-4" />
                      </span>
                      <ArrowRight className="h-4 w-4 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-950" />
                    </div>
                    <h3 className="mt-5 text-sm font-semibold text-slate-900">{product.name}</h3>
                    <p className="mt-2 line-clamp-3 text-xs leading-5 text-slate-500">
                      {product.summary}
                    </p>
                  </Link>
                );
              })}
            </div>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-2 text-[11px] font-medium text-slate-500">
          {PRODUCTS.filter((product) => !FEATURED_SLUGS.includes(product.slug)).map((product) => (
            <Link
              key={product.slug}
              href={`/products/${product.slug}`}
              className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 transition hover:border-slate-300 hover:text-slate-800"
            >
              {product.name}
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
