import { ArrowRight, Check } from "lucide-react";
import { Link } from "@/lib/router";
import { PRODUCTS } from "@/products/data";
import { productIcon } from "@/products/productIcons";
import { Button, Container, Eyebrow, Heading, Lede, Section } from "@/sections/Kit";

const FEATURED_SLUGS = ["workspace", "tasks", "revenue", "email", "finance", "repositories"];
const FEATURED = FEATURED_SLUGS.map((slug) =>
  PRODUCTS.find((product) => product.slug === slug),
).filter((product): product is NonNullable<typeof product> => Boolean(product));

const SHARED_FOUNDATION = [
  "One company-wide identity and permissions model",
  "The same records for Members and AI Employees",
  "One approval queue for sensitive work",
  "One searchable history of what happened",
];

/**
 * The product suite. Every product carries its own hue from products/data.ts,
 * which is what turns this from a grid of grey tiles into the most colourful
 * band on the page — appropriate, since the claim it supports is that the
 * whole company already lives in here.
 */
export function Features() {
  return (
    <Section id="platform">
      <Container wide>
        <div className="mx-auto max-w-3xl text-center">
          <div className="flex justify-center">
            <Eyebrow>Where the autonomy runs</Eyebrow>
          </div>
          <Heading className="mt-6">A company that runs itself needs a company to run.</Heading>
          <Lede className="mx-auto mt-6">
            Autonomy stops at the edge of the tools. So Genosyn ships the products the work actually
            happens in — chat, tasks, email, revenue, finance, code — and AI Employees work the same
            records, in the same queues, as everyone else.
          </Lede>
        </div>

        <div className="mt-14 overflow-hidden rounded-3xl border border-stone-900/[0.08] bg-white shadow-lift">
          <div className="grid lg:grid-cols-[0.72fr_1.28fr]">
            <div className="relative border-b border-stone-900/[0.08] bg-paper-100 p-7 sm:p-9 lg:border-b-0 lg:border-r">
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 bg-[radial-gradient(80%_60%_at_0%_0%,rgba(40,175,199,0.14),transparent_70%)]"
              />
              <div className="relative">
                <div className="text-[11px] font-semibold text-tide-600">
                  Shared by design
                </div>
                <h3 className="mt-3 text-3xl font-semibold tracking-[-0.03em] text-stone-900">
                  One operating context.
                </h3>
                <p className="mt-4 text-sm leading-6 text-stone-600">
                  An employee that has to ask you for context is not autonomous. Genosyn gives every
                  role a governed way to read, write, and hand work to the next employee.
                </p>
                <ul className="mt-7 space-y-3.5">
                  {SHARED_FOUNDATION.map((item) => (
                    <li key={item} className="flex items-start gap-3 text-sm leading-5 text-stone-700">
                      <span
                        aria-hidden
                        className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-tide-100 text-tide-600"
                      >
                        <Check className="h-3 w-3" />
                      </span>
                      {item}
                    </li>
                  ))}
                </ul>
                <Button href="/products" className="mt-8">
                  See every product
                  <ArrowRight aria-hidden className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="grid gap-px bg-stone-900/[0.08] sm:grid-cols-2 lg:grid-cols-3">
              {FEATURED.map((product) => {
                const Icon = productIcon(product.icon);
                return (
                  <Link
                    key={product.slug}
                    href={`/products/${product.slug}`}
                    className="group min-h-52 bg-white p-6 transition duration-200 hover:bg-paper-100"
                  >
                    <div className="flex items-start justify-between">
                      <span
                        className={`flex h-11 w-11 items-center justify-center rounded-xl ring-1 ring-inset transition group-hover:scale-105 ${product.accent}`}
                      >
                        <Icon aria-hidden className="h-5 w-5" />
                      </span>
                      <ArrowRight
                        aria-hidden
                        className="h-4 w-4 text-stone-300 transition group-hover:translate-x-0.5 group-hover:text-tide-500"
                      />
                    </div>
                    <h3 className="mt-6 text-base font-semibold text-stone-900">{product.name}</h3>
                    <p className="mt-2 line-clamp-3 text-[13px] leading-5 text-stone-500">
                      {product.summary}
                    </p>
                  </Link>
                );
              })}
            </div>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          {PRODUCTS.filter((product) => !FEATURED_SLUGS.includes(product.slug)).map((product) => {
            const Icon = productIcon(product.icon);
            return (
              <Link
                key={product.slug}
                href={`/products/${product.slug}`}
                className="inline-flex items-center gap-2 rounded-full border border-stone-900/[0.08] bg-white py-1.5 pl-1.5 pr-3.5 text-[12px] font-semibold text-stone-600 shadow-card transition hover:-translate-y-0.5 hover:border-tide-300 hover:text-stone-900 hover:shadow-lift"
              >
                <span
                  className={`flex h-6 w-6 items-center justify-center rounded-full ring-1 ring-inset ${product.accent}`}
                >
                  <Icon aria-hidden className="h-3 w-3" />
                </span>
                {product.name}
              </Link>
            );
          })}
        </div>
      </Container>
    </Section>
  );
}
