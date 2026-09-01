import type { ReactNode } from "react";
import { Nav } from "@/sections/Nav";
import { Footer, InstallCta } from "@/sections/Footer";
import { PageHero } from "@/sections/HeroKit";
import {
  ActionStrip,
  Band,
  Body,
  Container,
  Field,
  Heading,
  Lede,
  Plate,
  Rail,
  Row,
  Sheet,
  TextLink,
} from "@/sections/Kit";
import { PRODUCTS, type ProductDef } from "@/products/data";
import { ProductPrototype, type PrototypeCrop } from "@/products/ProductPrototype";

/**
 * The product detail page. Fourteen routes render it.
 *
 * ## What was deleted, and why restyling it was not an option
 *
 * The old page opened with a pill badge carrying a pastel icon tile in the
 * product's own hue, a two-tone headline, and a four-tick checklist in a
 * rounded card whose divider classes were computed from each item's index
 * against the column count — a hack that existed only so Paid Marketing's
 * fifth check did not render as a borderless orphan. Under it came a grid of
 * bordered feature cards that lifted on hover, a night band with an aurora
 * wash, and a `<details>` accordion under the heading "Frequently asked."
 *
 * The features are rules-separated `Row`s now, and a row is correct at one
 * item or at nine, which is what removes the reason the orphan hack existed
 * rather than fixing it. The checklist is gone outright: four claims with
 * green ticks beside them is the least evidential shape a fact can take, and
 * everything the checks said is already in the rail's mono fields or in a
 * feature row.
 *
 * ## The problem this page has that the others do not
 *
 * Fourteen pages, one layout, and — since the accents went — no colour to
 * tell them apart. Two things do the work instead, and neither is decoration:
 *
 *   1. **Every page leads with its own concrete detail.** The headline, the
 *      rail's fields and the three section headings are written per product
 *      in `PAGES` below, out of what that product actually does: a cron line
 *      for AI Employees, `ENG-42` for Tasks, 25 MB for Workspace, the 30
 *      second / 5,000 row cap for Explore. A generated headline would have
 *      produced fourteen identical sentences with a noun swapped, which is
 *      the failure mode being avoided.
 *   2. **Every page shows a different amount of the prototype.** Each crop is
 *      the tallest one still shorter than that product's own mock, measured
 *      rather than guessed, so the figure is always a window onto a screen
 *      that continues past it and never a box with dead space at the bottom.
 *      The result is that the picture at the top of each page is a visibly
 *      different shape rather than the same rectangle fourteen times.
 */

type PageCopy = {
  /** The h1. One clause, at most nine words, carrying a number or a name. */
  title: string;
  /** Rail gutter fields. Strings the software emitted, kept under ~20 chars
      so Martian Mono does not push the line off a 375px screen. */
  fields: string[];
  /** Sheet 02's heading. */
  does: string;
  /** Sheet 03's heading. */
  staff: string;
  /** The figure caption under the prototype. */
  caption: string;
  crop: PrototypeCrop;
};

const PAGES: Record<string, PageCopy> = {
  "ai-employees": {
    title: "Fourteen role templates ship with Genosyn.",
    fields: ["14 TEMPLATES", "0 6 * * *"],
    does: "Six pieces make one AI Employee.",
    staff: "Genosyn owns the model loop.",
    caption: "An AI Employee mid-Run at 06:00, one exception stacked.",
    crop: "screen",
  },
  workspace: {
    title: "An @mention pulls Alex into #marketing.",
    fields: ["25 MB PER FILE", "30,000 CHARS"],
    does: "Workspace runs on one WebSocket hub.",
    staff: "Alex reads the last 20 messages.",
    caption: "A channel at 09:12, with an AI Employee answering in it.",
    crop: "panel",
  },
  tasks: {
    title: "Projects mint short IDs like ENG-42.",
    fields: ["6 STATUSES", "5 PRIORITIES", "ENG-42"],
    does: "Six statuses run backlog to done.",
    staff: "Employees move work to in_review.",
    caption: "The board at 08:15, one todo held in review.",
    crop: "panel",
  },
  bases: {
    title: "Bases ships eleven field types today.",
    fields: ["11 FIELD TYPES", "5 TEMPLATES", "21 BASE TOOLS"],
    does: "Five templates ship, from CRM to Applicant Tracker.",
    staff: "Granted employees get 21 Base tools.",
    caption: "A Base at 07:30, filtered to renewal risk.",
    crop: "panel",
  },
  notes: {
    title: "Notes cascades Grants down the page tree.",
    fields: ["200,000 CHARS", "READ<WRITE", "SOFT DELETE"],
    does: "Search returns 50 hits, newest first.",
    staff: "Employees search Notes before writing one.",
    caption: "A page at 02:20, edited by an AI Employee.",
    crop: "band",
  },
  resources: {
    title: "Five source formats ingest into one library.",
    fields: ["5 FORMATS", "FULL-TEXT SEARCH", "READ<EDIT<DELETE"],
    does: "Resources attaches a source to Gmail by slug.",
    staff: "Mira cited the billing guide in her Run.",
    caption: "The library at 01:10, one billing guide extracted.",
    crop: "band",
  },
  pipelines: {
    title: "Pipelines runs 17 node types today.",
    fields: ["17 NODE TYPES", "4 FAMILIES", "20 INTEGRATIONS"],
    does: "Five trigger kinds start a Pipeline.",
    staff: "Stripe reported a payment over $1,000.",
    caption: "A Pipeline at 03:40, one branch matched.",
    crop: "band",
  },
  explore: {
    title: "Explore queries Postgres, MySQL and ClickHouse.",
    fields: ["30s / 5,000 ROWS", "6 VIZ TYPES", "12-COLUMN GRID"],
    does: "Six chart types render as SVG.",
    staff: "An employee meets the same 30-second cap.",
    caption: "A dashboard at 08:50: June closed at $48,220.",
    crop: "panel",
  },
  marketing: {
    title: "Paid Marketing runs Google, Meta and Reddit Ads.",
    fields: ["4 AD NETWORKS", "PER-CHANGE CAP", "DAILY + MONTHLY"],
    does: "Every spend increase waits for a Member.",
    staff: "A Brand Search increase stopped at the Approval.",
    caption: "A budget change at 10:05, held at the Approval.",
    crop: "screen",
  },
  revenue: {
    title: "The Deal timeline fills itself from Gmail.",
    fields: ["READ<WRITE<SEND", "DRAFTS QUEUE", "5-FIELD CRON"],
    does: "Deals and Contacts share one timeline.",
    staff: "A Sequence waits for a human Send.",
    caption: "A Deal at 06:35, one Sequence queued and unsent.",
    crop: "screen",
  },
  email: {
    title: "Gmail syncs both ways in about a minute.",
    fields: ["~1 MIN FRESH", "NO PUB/SUB", "READ<DRAFT<SEND"],
    does: "Three grant levels gate one mailbox.",
    staff: "Mira drafted 31 replies overnight.",
    caption: "The inbox at 05:45, three replies drafted and unsent.",
    crop: "panel",
  },
  customers: {
    title: "Statements age receivables into five buckets.",
    fields: ["5 AGING BUCKETS", "25 MB CONTRACTS", "PDF + PRINT"],
    does: "Contracts upload to 25 MB each.",
    staff: "Northstar moved to Watch with two reasons.",
    caption: "An account at 07:05: Northstar Labs, moved to Watch.",
    crop: "band",
  },
  finance: {
    title: "Genosyn keeps money as integer minor units.",
    fields: ["DOUBLE-ENTRY", "GAPLESS NUMBERS", "MINOR UNITS"],
    does: "Three statements close from one ledger.",
    staff: "41 of 42 charges matched themselves.",
    caption: "The ledger at 04:05, one charge left to classify.",
    crop: "panel",
  },
  repositories: {
    title: "Repositories clones any git URL into Genosyn.",
    fields: ["AES-256-GCM", "GIT INIT", "BUBBLEWRAP"],
    does: "One work session leaves one branch and one report.",
    staff: "Sam left the branch for a human.",
    caption: "A diff at 05:10, waiting on a human merge.",
    crop: "panel",
  },
};

/**
 * The fallback exists because `PRODUCTS` is data and this table is copy, and
 * a product added to one without the other must still render a page rather
 * than crash the prerenderer. It is deliberately dull: a page that falls
 * through to it is visibly unfinished, which is the correct signal.
 */
function pageFor(product: ProductDef): PageCopy {
  return (
    PAGES[product.slug] ?? {
      title: `${product.name} ships inside Genosyn.`,
      fields: ["APACHE-2.0", "SELF-HOSTED"],
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
    <div className="min-h-screen bg-paper-100 text-zinc-900">
      <Nav />
      <main>
        <PageHero
          sheet={`01 / ${product.name}`}
          fields={[product.category.toUpperCase(), ...page.fields]}
          title={page.title}
          lede={product.intro}
          actions={
            <>
              {/* The breadcrumb keeps its landmark and its label. It sits
                  under the lede rather than over the headline because
                  `PageHero` has one slot and the site has one opening move:
                  sheet number, headline, lede, then controls. */}
              <nav
                aria-label="Breadcrumb"
                className="mb-7 flex flex-wrap items-baseline gap-x-4 gap-y-2"
              >
                <TextLink href="/products">All products</TextLink>
                <Sheet>{product.category}</Sheet>
              </nav>

              {/* The install band at the foot of this page carries the same
                  offer, so the strip goes to the guide rather than scrolling
                  the reader four screens to find it. */}
              <ActionStrip href="/docs/install" trailing="Guide">
                Install Genosyn
              </ActionStrip>
              {/* Notes and Resources have no docs page of their own yet, so
                  the label has to promise the index, not a page. */}
              <ActionStrip href={product.docsPath ?? "/docs"} trailing="Docs" className="-mt-px">
                {product.docsPath ? `Read the ${product.name} docs` : "Read the documentation"}
              </ActionStrip>
            </>
          }
          aside={
            <Plate figure="Fig. 1" caption={page.caption}>
              <ProductPrototype product={product} crop={page.crop} />
            </Plate>
          }
        />

        <WhatItDoes product={product} page={page} />
        <WithEmployees product={product} page={page} />
        <Questions product={product} />
        <MoreProducts current={product} />

        <InstallCta />
      </main>
      <Footer />
    </div>
  );
}

/**
 * Column widths for the two tables on this page.
 *
 * The grid only exists from `lg`; below it the cells stack, which is the
 * honest projection at 375px. The index column is 2.5rem because a two-digit
 * mono field at 11px is about 26px wide and never grows.
 */
const FEATURE_COLUMNS = "gap-x-6 gap-y-2 lg:grid-cols-[2.5rem_14rem_minmax(0,1fr)]";
const FAQ_COLUMNS = "gap-x-6 gap-y-2 lg:grid-cols-[20rem_minmax(0,1fr)]";

/**
 * The name of a row, as a heading rather than as a paragraph.
 *
 * The old page set every feature title, every employee bullet and every FAQ
 * question in an `<h3>`, and the first draft of this rewrite lost all ten per
 * page by reaching for `Body` with three `!important` overrides on it. That is
 * a real regression and not a stylistic one: it is what a screen reader's
 * heading list is built from, and on fourteen pages it is the only structure
 * inside a band. This renders the same three type classes `Body` would have
 * resolved to — so nothing moves by a pixel — on the element the content
 * actually is. It composes from the index.css type ramp rather than inventing
 * one, which is what the Kit rule asks for when the Kit has no primitive.
 */
function RowTitle({ children }: { children: ReactNode }) {
  return <h3 className="t-body text-[1.0625rem] leading-6 text-zinc-950">{children}</h3>;
}

/**
 * Sheet 02 — what the product does.
 *
 * Every feature is a row: an index, a name, and the sentence. There is no
 * card, no tile and no icon, and the important consequence is that the block
 * is correct at any length. Paid Marketing has five checks and Repositories
 * has six features; the old grid needed index arithmetic against three
 * different column counts to stop the leftovers rendering as orphans, and
 * this needs none, because a stack of rows has no leftovers.
 */
function WhatItDoes({ product, page }: { product: ProductDef; page: PageCopy }) {
  return (
    <Band id="what-it-does" tone="paper" pad="m">
      <Container>
        <Rail sheet="02 / What it does" fields={[`${product.features.length} PARTS`]}>
          <Heading as="h2" className="max-w-[22ch]">
            {page.does}
          </Heading>
          <Lede className="mt-7">{product.summary}</Lede>

          <div className="mt-12">
            <div className={`hidden w-full px-1 pb-2 lg:grid ${FEATURE_COLUMNS}`}>
              <Sheet>No.</Sheet>
              <Sheet>Part</Sheet>
              <Sheet>What it is</Sheet>
            </div>

            {product.features.map((feature, index) => (
              <Row key={feature.title}>
                <div className={`grid w-full min-w-0 ${FEATURE_COLUMNS}`}>
                  <Field>{String(index + 1).padStart(2, "0")}</Field>
                  <RowTitle>{feature.title}</RowTitle>
                  <Body>{feature.body}</Body>
                </div>
              </Row>
            ))}
          </div>
        </Rail>
      </Container>
    </Band>
  );
}

/**
 * Sheet 03 — with AI Employees.
 *
 * This band used to be near-black with an aurora wash over it, on all
 * fourteen pages. Night is reserved for the section of the landing page that
 * is literally about work happening in the dark; spending it again here is
 * what made every page read as the same sequence of slabs. `raised` is the
 * one tone change this page gets, and it goes to the band carrying the
 * argument.
 */
function WithEmployees({ product, page }: { product: ProductDef; page: PageCopy }) {
  return (
    <Band id="with-employees" tone="raised" pad="m">
      <Container>
        <Rail sheet="03 / Who works it" fields={[`${product.employees.bullets.length} BEHAVIOURS`]}>
          <Heading as="h2" className="max-w-[22ch]">
            {page.staff}
          </Heading>
          <Lede className="mt-7">{product.employees.body}</Lede>

          <div className="mt-12">
            {product.employees.bullets.map((bullet, index) => (
              <Row key={bullet.title}>
                <div className={`grid w-full min-w-0 ${FEATURE_COLUMNS}`}>
                  <Field>{String(index + 1).padStart(2, "0")}</Field>
                  <RowTitle>{bullet.title}</RowTitle>
                  <Body>{bullet.body}</Body>
                </div>
              </Row>
            ))}
          </div>
        </Rail>
      </Container>
    </Band>
  );
}

/**
 * Sheet 04 — questions.
 *
 * The `<details>` accordion is gone along with its rotating chevron. Hiding
 * five short answers behind five clicks costs the reader every one of them
 * and buys nothing; printed open, they are a two-column table, which is what
 * a question and its answer are. `pad="s"` because this is the tail of the
 * page.
 */
function Questions({ product }: { product: ProductDef }) {
  return (
    <Band id="questions" tone="paper" pad="s">
      <Container>
        <Rail sheet="04 / Questions" fields={[`${product.faqs.length} ANSWERED`]}>
          <Heading as="h2" className="max-w-[22ch]">
            {`Readers ask ${product.faqs.length} questions about ${product.name}.`}
          </Heading>

          <div className="mt-10">
            {product.faqs.map((faq) => (
              <Row key={faq.q}>
                <div className={`grid w-full min-w-0 ${FAQ_COLUMNS}`}>
                  <RowTitle>{faq.q}</RowTitle>
                  <Body>{faq.a}</Body>
                </div>
              </Row>
            ))}
          </div>
        </Rail>
      </Container>
    </Band>
  );
}

/**
 * Sheet 05 — the rest of the catalogue.
 *
 * Same-category products first, because a reader on the Finance page is more
 * likely to want Revenue than Notes. The rows are links, so they take the
 * hover inversion, and the cells that set their own colour have to answer it
 * — `Row` puts `group` on the link and flips the text on itself, which cannot
 * reach a child that already declared a colour.
 */
function MoreProducts({ current }: { current: ProductDef }) {
  const related = [
    ...PRODUCTS.filter(
      (product) => product.slug !== current.slug && product.category === current.category,
    ),
    ...PRODUCTS.filter(
      (product) => product.slug !== current.slug && product.category !== current.category,
    ),
  ].slice(0, 4);

  const INVERT = "group-hover:!text-paper-50";

  return (
    <Band tone="paper" pad="s">
      <Container>
        <Rail sheet="05 / More products" fields={[`${PRODUCTS.length} IN TOTAL`]}>
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-3">
            <Heading as="h2" className="max-w-[22ch]">
              {`${related.length} more products share one database.`}
            </Heading>
            <TextLink href="/products">All products</TextLink>
          </div>

          <div className="mt-10">
            {related.map((product) => (
              <Row key={product.slug} href={`/products/${product.slug}`}>
                <div className={`grid w-full min-w-0 ${FAQ_COLUMNS}`}>
                  <Body className={`!text-[1.0625rem] !leading-6 !text-zinc-950 ${INVERT}`}>
                    {product.name}
                  </Body>
                  <Body className={INVERT}>{product.summary}</Body>
                </div>
              </Row>
            ))}
          </div>
        </Rail>
      </Container>
    </Band>
  );
}
