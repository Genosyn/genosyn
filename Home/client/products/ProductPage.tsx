import { ArrowUpRight, Check } from "lucide-react";
import { Reveal, useReveal } from "@/components/Reveal";
import { SIGN_UP_URL } from "@/lib/constants";
import { iconFor } from "@/lib/icons";
import { Link } from "@/lib/router";
import { PRODUCTS, type ProductDef } from "@/products/data";
import { PRODUCT_HOLDS, PRODUCT_ICON, productDept, workedBy } from "@/products/meta";
import { ProductPrototype, type PrototypeCrop } from "@/products/ProductPrototype";
import { getUseCasesForProduct } from "@/products/useCases";
import { FaqSection } from "@/sections/Faq";
import { ClosingCta, Footer } from "@/sections/Footer";
import {
  Button,
  Container,
  DEPT_DOT,
  DEPT_LABEL,
  GridFill,
  NightPanel,
  Section,
  SectionHead,
  StateTag,
  TextLink,
} from "@/sections/Kit";
import { Nav } from "@/sections/Nav";

/**
 * Per-product headings for the lower bands, the crop of the mock, and the one
 * stop a product's story ends on, when it ends on one. Each is a checkable
 * sentence about the product rather than a slogan.
 */
type PageCopy = {
  does: string;
  staff: string;
  caption: string;
  crop: PrototypeCrop;
  stop?: { kind: "decision" | "approval"; line: string };
};

const PAGES: Record<string, PageCopy> = {
  "ai-employees": {
    does: "Six pieces make one AI Employee.",
    staff: "OpenCode runs the AI work.",
    caption: "An AI Employee mid-Run at 06:00, one exception stacked.",
    crop: "screen",
    stop: { kind: "decision", line: "One exception is waiting for a Member to answer." },
  },
  workspace: {
    does: "Workspace runs on one WebSocket hub.",
    staff: "An @mention pulls an employee into the thread.",
    caption: "A channel at 09:12, with an AI Employee answering in it.",
    crop: "panel",
  },
  tasks: {
    does: "Six statuses run backlog to done.",
    staff: "Employees move work to in_review.",
    caption: "The board at 08:15, one todo held in review.",
    crop: "panel",
    stop: { kind: "approval", line: "The todo is sitting in a human reviewer's queue." },
  },
  bases: {
    does: "Five templates ship, from CRM to Applicant Tracker.",
    staff: "Granted employees get 21 Base tools.",
    caption: "A Base at 07:30, filtered to renewal risk.",
    crop: "panel",
  },
  notes: {
    does: "Search returns 50 hits, newest first.",
    staff: "Employees search Notes before writing one.",
    caption: "A page at 02:20, edited by an AI Employee.",
    crop: "band",
  },
  resources: {
    does: "Five source formats ingest into one library.",
    staff: "Mira cited the billing guide in her Run.",
    caption: "The library at 01:10, one billing guide extracted.",
    crop: "band",
  },
  pipelines: {
    does: "Five trigger kinds start a Pipeline.",
    staff: "Stripe reported a payment over $1,000.",
    caption: "A Pipeline at 03:40, one branch matched.",
    crop: "band",
  },
  explore: {
    does: "Six chart types render as SVG.",
    staff: "An employee meets the same 30-second cap.",
    caption: "A dashboard at 08:50: June closed at $48,220.",
    crop: "panel",
  },
  marketing: {
    does: "Every spend increase waits for a Member.",
    staff: "A Brand Search increase stopped at the Approval.",
    caption: "A budget change at 10:05, held at the Approval.",
    crop: "screen",
    stop: { kind: "approval", line: "Brand Search wants another $400 a day, and it is held." },
  },
  revenue: {
    does: "Deals and Contacts share one timeline.",
    staff: "A Sequence waits for a human Send.",
    caption: "A Deal at 06:35, one Sequence queued and unsent.",
    crop: "screen",
    stop: { kind: "approval", line: "A Sequence is queued and nothing has sent." },
  },
  email: {
    does: "Three grant levels gate one mailbox.",
    staff: "Mira drafted 31 replies overnight.",
    caption: "The inbox at 05:45, three replies drafted and unsent.",
    crop: "panel",
    stop: { kind: "approval", line: "Three replies are drafted and none have sent." },
  },
  customers: {
    does: "Contracts upload to 25 MB each.",
    staff: "Northstar moved to Watch with two reasons.",
    caption: "An account at 07:05: Northstar Labs, moved to Watch.",
    crop: "band",
  },
  finance: {
    does: "Three statements close from one ledger.",
    staff: "41 of 42 charges matched themselves.",
    caption: "The ledger at 04:05, one charge left to classify.",
    crop: "panel",
    stop: { kind: "decision", line: "One £42 charge needs a Member to classify it." },
  },
  repositories: {
    does: "One Work session leaves one branch and one report.",
    staff: "Sam left the branch for a human.",
    caption: "A diff at 05:10, waiting on a human merge.",
    crop: "panel",
    stop: { kind: "approval", line: "The branch is waiting on a human merge." },
  },
};

function pageFor(product: ProductDef): PageCopy {
  return (
    PAGES[product.slug] ?? {
      does: `${product.features.length} parts of ${product.name} ship today.`,
      staff: `AI Employees work inside ${product.name}.`,
      caption: `${product.name}, mid-Run.`,
      crop: "panel",
    }
  );
}

export function ProductPage({ product }: { product: ProductDef }) {
  const page = pageFor(product);
  return (
    <div className="min-h-screen overflow-x-clip bg-paper text-ink">
      <Nav />
      <main>
        <Hero product={product} page={page} />
        <Features product={product} page={page} />
        <WithEmployees product={product} page={page} />
        <UseCases product={product} />
        <FaqSection
          title={
            <>
              {`Questions about ${product.name}`}
            </>
          }
          items={product.faqs}
          footer={
            <TextLink href={product.docsPath ?? "/docs"}>
              {product.docsPath ? `The ${product.name} docs` : "Read the documentation"}
            </TextLink>
          }
        />
        <MoreProducts current={product} />
        <ClosingCta />
      </main>
      <Footer />
    </div>
  );
}

function Hero({ product, page }: { product: ProductDef; page: PageCopy }) {
  const Icon = PRODUCT_ICON[product.slug] ?? iconFor(product.icon);
  const dept = productDept(product.slug);
  return (
    <section className="relative pb-20 pt-10 sm:pb-24 sm:pt-14 lg:pt-16">
      <Container>
        <Reveal>
          <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-[13.5px] text-ink-500">
            <Link href="/products" className="transition-colors hover:text-ink">
              Products
            </Link>
            <span aria-hidden className="text-ink-300">
              /
            </span>
            <span className="text-ink">{product.name}</span>
          </nav>
        </Reveal>

        <div className="mt-10 grid gap-x-14 gap-y-14 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] lg:items-center">
          <div className="min-w-0">
            <Reveal delay={40} className="flex items-center gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-ink text-white">
                <Icon aria-hidden className="h-5 w-5" strokeWidth={1.7} />
              </span>
              <span>
                <span className="block text-[15px] font-medium text-ink">{product.name}</span>
                <span className="mt-0.5 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-400">
                  <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${DEPT_DOT[dept]}`} />
                  {`${product.category} · ${DEPT_LABEL[dept]}`}
                </span>
              </span>
            </Reveal>
            <Reveal delay={90}>
              <h1 className="mt-8 text-balance font-display text-[clamp(2rem,3.4vw,2.9rem)] leading-[1.06] tracking-[-0.035em] text-ink">
                {product.tagline}
              </h1>
            </Reveal>
            <Reveal delay={120}>
              <p className="mt-4 text-balance text-[1.2rem] font-medium leading-[1.4] tracking-[-0.01em] text-ink-500">
                {product.taglineAccent}
              </p>
            </Reveal>
            <Reveal delay={160}>
              <p className="mt-5 max-w-[58ch] text-pretty text-[1rem] leading-[1.7] text-ink-600">{product.intro}</p>
            </Reveal>
            <Reveal delay={190} className="mt-8 flex flex-wrap gap-3">
              <Button href={SIGN_UP_URL} variant="ink" arrow>
                Start free
              </Button>
              <Button href={product.docsPath ?? "/docs"} variant="outline">
                {product.docsPath ? `Read the ${product.name} docs` : "Read the docs"}
              </Button>
            </Reveal>
            <Reveal delay={230}>
              <ul className="mt-8 grid gap-x-6 gap-y-2.5 border-t border-line pt-6 sm:grid-cols-2">
                {product.checks.map((check) => (
                  <li key={check} className="flex items-start gap-2 text-[14px] leading-5 text-ink-600">
                    <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-ink" strokeWidth={1.8} />
                    {check}
                  </li>
                ))}
              </ul>
            </Reveal>
          </div>

          <Reveal delay={160} className="relative isolate min-w-0">
            <div aria-hidden className="dot-paper absolute -inset-4 -z-10 rounded-[2.25rem] sm:-inset-6" />
            <figure>
              <div className="overflow-hidden rounded-[1.4rem] border border-black/10 bg-white shadow-lifted">
                <ProductPrototype product={product} crop={page.crop} />
              </div>
              <figcaption className="mt-4 text-center text-[12.5px] text-ink-500">{`${page.caption} Illustrative.`}</figcaption>
            </figure>
          </Reveal>
        </div>
      </Container>
    </section>
  );
}

function Features({ product, page }: { product: ProductDef; page: PageCopy }) {
  const grid = useReveal<HTMLUListElement>(0, 55);
  return (
    <Section id="features" tone="raised" space="md" rule>
      <Container>
        <SectionHead kicker="What it does" title={page.does} lede={product.summary} />
        <ul ref={grid} className="mt-14 grid gap-px overflow-hidden rounded-3xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
          {product.features.map((feature) => {
            const Icon = iconFor(feature.icon);
            return (
              <li key={feature.title} className="flex flex-col bg-paper-raised p-7">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-paper">
                  <Icon aria-hidden className="h-[18px] w-[18px] text-ink" strokeWidth={1.7} />
                </span>
                <h3 className="mt-6 text-[16.5px] font-medium leading-6 tracking-[-0.01em] text-ink">{feature.title}</h3>
                <p className="mt-2.5 text-[14.5px] leading-6 text-ink-600">{feature.body}</p>
              </li>
            );
          })}
          <GridFill count={product.features.length} />
        </ul>
      </Container>
    </Section>
  );
}

function WithEmployees({ product, page }: { product: ProductDef; page: PageCopy }) {
  const roles = workedBy(product.slug);
  return (
    <div className="pt-2">
      <NightPanel id="with-ai-employees" dawn={0.4}>
        <Container className="py-20 sm:py-24">
          <SectionHead night kicker="With AI Employees" title={page.staff} lede={product.employees.body} />
          <div className="mt-14 grid gap-4 md:grid-cols-3">
            {product.employees.bullets.map((bullet, index) => (
              <div key={bullet.title} className="rounded-3xl border border-white/10 bg-white/[0.035] p-7">
                <span className="font-mono text-[12px] text-white/40">{`0${index + 1}`}</span>
                <h3 className="mt-8 text-[16.5px] font-medium leading-6 text-white">{bullet.title}</h3>
                <p className="mt-2.5 text-[14.5px] leading-6 text-night-muted">{bullet.body}</p>
              </div>
            ))}
          </div>
          {(page.stop || roles.length > 0) && (
            <div className="mt-10 flex flex-wrap items-center justify-between gap-6 border-t border-white/10 pt-8">
              {page.stop ? (
                <p className="flex flex-wrap items-center gap-3 text-[15px] text-white">
                  <StateTag state={page.stop.kind} night>
                    {page.stop.kind === "decision" ? "Decision" : "Approval"}
                  </StateTag>
                  {page.stop.line}
                </p>
              ) : (
                <span />
              )}
              {roles.length > 0 && (
                <p className="text-[13.5px] text-night-muted">
                  {`Worked by ${roles.slice(0, 3).join(", ")}${roles.length > 3 ? ` and ${roles.length - 3} more` : ""}`}
                </p>
              )}
            </div>
          )}
        </Container>
      </NightPanel>
    </div>
  );
}

function UseCases({ product }: { product: ProductDef }) {
  const cases = getUseCasesForProduct(product.slug);
  const grid = useReveal<HTMLUListElement>(0, 70);
  if (cases.length === 0) return null;
  return (
    <Section id="use-cases" space="md">
      <Container>
        <SectionHead
          kicker="In practice"
          title={
            <>
              {`How teams put ${product.name} to work.`}
            </>
          }
        />
        <ul ref={grid} className="mt-14 grid gap-4 lg:grid-cols-3">
          {cases.map((useCase) => (
            <li key={useCase.role} className="flex flex-col rounded-3xl border border-line bg-paper-raised p-7">
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-paper-sunken font-mono text-[11px] font-medium text-ink-700 ring-1 ring-line">
                  {useCase.initials}
                </span>
                <span>
                  <span className="block text-[14.5px] font-medium text-ink">{useCase.role}</span>
                  <span className="block text-[12.5px] text-ink-500">{useCase.team}</span>
                </span>
              </div>
              <p className="mt-6 text-[1.15rem] font-semibold leading-[1.35] tracking-[-0.015em] text-ink">{useCase.objective}</p>
              <ol className="mt-6 space-y-3 border-t border-line pt-6">
                {useCase.steps.map((step, index) => (
                  <li key={step} className="flex gap-3 text-[14px] leading-5 text-ink-600">
                    <span className="w-5 shrink-0 font-mono text-[12px] text-ink-400">{index + 1}</span>
                    {step}
                  </li>
                ))}
              </ol>
              <p className="mt-auto pt-6 text-[13.5px] font-medium leading-5 text-ink">{`→ ${useCase.outcome}`}</p>
            </li>
          ))}
        </ul>
      </Container>
    </Section>
  );
}

function MoreProducts({ current }: { current: ProductDef }) {
  const grid = useReveal<HTMLUListElement>(0, 50);
  const related = [
    ...PRODUCTS.filter((product) => product.slug !== current.slug && product.category === current.category),
    ...PRODUCTS.filter((product) => product.slug !== current.slug && product.category !== current.category),
  ].slice(0, 4);
  return (
    <Section id="more" tone="raised" space="md" rule>
      <Container>
        <SectionHead
          kicker="More products"
          title={
            <>
              Same database, same permissions.
            </>
          }
          aside={<TextLink href="/products">{`All ${PRODUCTS.length} products`}</TextLink>}
        />
        <ul ref={grid} className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {related.map((product) => {
            const Icon = PRODUCT_ICON[product.slug] ?? iconFor(product.icon);
            return (
              <li key={product.slug}>
                <Link
                  href={`/products/${product.slug}`}
                  className="lift group flex h-full flex-col rounded-2xl border border-line bg-paper p-5 hover:border-line-strong hover:bg-white hover:shadow-soft"
                >
                  <span className="flex items-center justify-between">
                    <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-line bg-white">
                      <Icon aria-hidden className="h-[17px] w-[17px] text-ink" strokeWidth={1.7} />
                    </span>
                    <ArrowUpRight aria-hidden className="nudge-up h-4 w-4 text-ink-300 group-hover:text-ink" />
                  </span>
                  <span className="mt-5 text-[15.5px] font-medium text-ink">{product.name}</span>
                  <span className="mt-1.5 text-[13.5px] leading-5 text-ink-500">
                    {PRODUCT_HOLDS[product.slug] ?? product.summary}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </Container>
    </Section>
  );
}
