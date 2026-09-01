import type { ReactNode } from "react";
import { Nav } from "@/sections/Nav";
import { Footer, InstallCta } from "@/sections/Footer";
import { Mark } from "@/components/Marks";
import {
  ActionStrip,
  Band,
  Body,
  Chip,
  Container,
  type Dept,
  Display,
  Field,
  Head,
  Lede,
  Pane,
  Row,
  Sheet,
  TextLink,
} from "@/sections/Kit";
import { PRODUCTS, type ProductDef } from "@/products/data";
import { PRODUCT_DEPT, ProductPrototype, type PrototypeCrop } from "@/products/ProductPrototype";

/**
 * The product detail page. Fourteen routes render it.
 *
 * ## The problem this page has, and how HEADCOUNT solves it
 *
 * Fourteen pages share one layout, and until now nothing but the nouns told
 * them apart. Two earlier attempts at a fix are still visible in the file and
 * both were right as far as they went: every page leads with a concrete
 * detail written per product in `PAGES`, and every page crops the prototype to
 * a different height so the picture at the top is a different shape fourteen
 * times.
 *
 * HEADCOUNT adds the thing neither could: **each product belongs to a
 * department, and the department is a colour.** The binding lives in
 * `PRODUCT_DEPT` and it is used exactly three times on this page — the hero
 * chip, the 3px spine down the two row stacks, and the pane edge under the
 * prototype. Finance is bottle green on every one of its surfaces, Email is
 * blue on every one of its, and a reader who has decoded the wall on the
 * landing page arrives here already knowing what the colour means.
 *
 * The rule that makes it work rather than decorate: **a hue only ever means
 * its department.** So the headline is never coloured, the FAQ rows carry no
 * spine (a reader's question belongs to no department), and the cross-links
 * at the foot carry *their own* products' hues rather than this page's —
 * which turns the tail of the page into a small org chart.
 *
 * ## The one thing on the page with no hue
 *
 * Seven of the fourteen products stop for a person somewhere. Those pages
 * print the stop as an ink block beside the "who works it" heading, in the
 * same near-black the wall's eighth cell uses. The other seven print nothing
 * there, because inventing a stop for a product that does not have one would
 * be the only actually dishonest thing this page could do.
 *
 * ## What was deleted, and why restyling it was not an option
 *
 * The old page opened with a pill badge carrying a pastel icon tile in the
 * product's own hue, a two-tone headline, and a four-tick checklist in a
 * rounded card whose divider classes were computed from each item's index
 * against the column count — a hack that existed only so Paid Marketing's
 * fifth check did not render as a borderless orphan. Under it came a grid of
 * bordered feature cards that lifted on hover, a band with an aurora wash,
 * and a `<details>` accordion under the heading "Frequently asked."
 *
 * The features are rules-separated `Row`s now, and a row is correct at one
 * item or at nine, which is what removes the reason the orphan hack existed
 * rather than fixing it. The checklist is gone outright: four claims with
 * green ticks beside them is the least evidential shape a fact can take.
 */

type PageCopy = {
  /** The h1. One clause, at most nine words, carrying a number or a name. */
  title: string;
  /** Emitted data for the hero's closing strip. Never a claim. */
  fields: string[];
  /** The "what it does" band's heading. */
  does: string;
  /** The "who works it" band's heading. */
  staff: string;
  /** The figure caption under the prototype. */
  caption: string;
  crop: PrototypeCrop;
  /**
   * The moment in this product a person still has to clear, if there is one.
   *
   * It is copied from that product's own prototype story rather than written
   * fresh, so the ink block on the page and the ink strip inside the picture
   * beside it say the same thing. Six of the seven are verbatim; Paid
   * Marketing's joins the story's second and third steps, because "the * increase is held" is not a sentence on its own without the amount.
   *
   * Nothing enforces the copy — `PRODUCT_STORIES` is private to
   * `ProductPrototype.tsx` and this is a second literal — so if a story's last
   * step is reworded, the matching line here has to be reworded with it.
   * Deriving it instead was rejected because it would export the story table
   * for one string and would silently overwrite the Paid Marketing exception.
   *
   * Seven products have a stop; the other seven leave this undefined and print
   * nothing, which is the honest answer rather than a softer sentence.
   */
  stop?: { kind: "decision" | "approval"; line: string };
};

const PAGES: Record<string, PageCopy> = {
  "ai-employees": {
    title: "Fourteen role templates ship with Genosyn.",
    fields: ["14 TEMPLATES", "0 6 * * *"],
    does: "Six pieces make one AI Employee.",
    staff: "Genosyn owns the model loop.",
    caption: "An AI Employee mid-Run at 06:00, one exception stacked.",
    crop: "screen",
    stop: { kind: "decision", line: "One exception is waiting for a Member to answer." },
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
    stop: { kind: "approval", line: "The todo is sitting in a human reviewer's queue." },
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
    stop: { kind: "approval", line: "Brand Search wants another $400 a day, and it is held." },
  },
  revenue: {
    title: "The Deal timeline fills itself from Gmail.",
    fields: ["READ<WRITE<SEND", "DRAFTS QUEUE", "5-FIELD CRON"],
    does: "Deals and Contacts share one timeline.",
    staff: "A Sequence waits for a human Send.",
    caption: "A Deal at 06:35, one Sequence queued and unsent.",
    crop: "screen",
    stop: { kind: "approval", line: "A Sequence is queued and nothing has sent." },
  },
  email: {
    title: "Gmail syncs both ways in about a minute.",
    fields: ["~1 MIN FRESH", "NO PUB/SUB", "READ<DRAFT<SEND"],
    does: "Three grant levels gate one mailbox.",
    staff: "Mira drafted 31 replies overnight.",
    caption: "The inbox at 05:45, three replies drafted and unsent.",
    crop: "panel",
    stop: { kind: "approval", line: "Three replies are drafted and none have sent." },
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
    stop: { kind: "decision", line: "One £42 charge needs a Member to classify it." },
  },
  repositories: {
    title: "Repositories clones any git URL into Genosyn.",
    fields: ["AES-256-GCM", "GIT INIT", "BUBBLEWRAP"],
    does: "One work session leaves one branch and one report.",
    staff: "Sam left the branch for a human.",
    caption: "A diff at 05:10, waiting on a human merge.",
    crop: "panel",
    stop: { kind: "approval", line: "The branch is waiting on a human merge." },
  },
};

/**
 * The fallback exists because `PRODUCTS` is data and this table is copy, and
 * a product added to one without the other must still render a page rather
 * than crash the prerenderer. It is deliberately dull: a page that falls
 * through to it is visibly unfinished, which is the correct signal. It
 * carries no `stop`, because a stop nobody wrote is a stop that is not there.
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
  const dept = PRODUCT_DEPT[product.slug] ?? "operations";

  return (
    <div className="min-h-screen bg-ground text-ink">
      <Nav />
      <main>
        <ProductHero product={product} page={page} dept={dept} />
        <WhatItDoes product={product} page={page} dept={dept} />
        <WithEmployees product={product} page={page} dept={dept} />
        <Questions product={product} />
        <MoreProducts current={product} />

        <InstallCta />
      </main>
      <Footer />
    </div>
  );
}

/* -------------------------------------------------------------------------
   The hero
------------------------------------------------------------------------- */

/**
 * The opening band, composed here rather than taken from `PageHero`.
 *
 * `PageHero` types its eyebrow as a `string`, and this page's eyebrow is a
 * department `Chip` — the first and loudest place a reader is told which of
 * the seven this product belongs to. Rather than reach into a shared
 * component owned by another part of the revamp, the band is composed from
 * the Kit directly and keeps `PageHero`'s proportions exactly: the same
 * `lg` split, the same `gap-x-16`, the same hairline-topped strip of emitted
 * data closing the band. So the two index pages and the fourteen detail pages
 * still open on the same shape; only this one names a department.
 */
function ProductHero({ product, page, dept }: { product: ProductDef; page: PageCopy; dept: Dept }) {
  return (
    <Band tone="ground" pad="m" rule={false}>
      <Container>
        <div className="mb-5">
          <Chip dept={dept}>{dept}</Chip>
        </div>

        <div className="grid gap-x-16 gap-y-10 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:items-start">
          <div className="min-w-0">
            <Display as="h1" className="max-w-[20ch]">
              {page.title}
            </Display>

            <div className="mt-7 min-w-0">
              <Lede>{product.intro}</Lede>

              {/* The breadcrumb keeps its landmark and its label. It sits
                  under the lede rather than over the headline because the
                  eyebrow slot is spent on the department. */}
              <nav
                aria-label="Breadcrumb"
                className="mt-8 flex flex-wrap items-baseline gap-x-4 gap-y-2"
              >
                <TextLink href="/products">All products</TextLink>
                <Sheet>{product.category}</Sheet>
              </nav>

              {/* The install band at the foot of this page carries the same
                  offer, so the strip goes to the guide rather than scrolling
                  the reader four screens to find it. */}
              <div className="mt-6 max-w-[34rem]">
                <ActionStrip href="/docs/install" trailing="Guide">
                  Install Genosyn
                </ActionStrip>
                {/* Notes and Resources have no docs page of their own yet, so
                    the label has to promise the index, not a page. */}
                <ActionStrip href={product.docsPath ?? "/docs"} trailing="Docs" className="-mt-px">
                  {product.docsPath ? `Read the ${product.name} docs` : "Read the documentation"}
                </ActionStrip>
              </div>
            </div>
          </div>

          <div className="min-w-0">
            <ProductFigure product={product} page={page} dept={dept} />
          </div>
        </div>

        <div className="mt-12 flex flex-wrap items-baseline gap-x-8 gap-y-2 border-t border-hairline pt-4">
          {page.fields.map((field) => (
            <Field key={field}>{field}</Field>
          ))}
        </div>
      </Container>
    </Band>
  );
}

/**
 * The prototype as a numbered figure.
 *
 * `Plate` would be the obvious primitive and is the wrong one here: it draws
 * its own 1px frame and takes no department, so using it would mean either a
 * mock with no hue or two nested frames around one picture. A `Pane` carries
 * the 3px department edge — the treatment the Kit reserves for "a picture of * the application" — and the caption is the same two-part figcaption `Plate`
 * prints, so the figure reads identically to every other one on the site.
 */
function ProductFigure({
  product,
  page,
  dept,
}: {
  product: ProductDef;
  page: PageCopy;
  dept: Dept;
}) {
  return (
    <figure>
      <Pane dept={dept}>
        <ProductPrototype product={product} crop={page.crop} />
      </Pane>
      <figcaption className="mt-3 flex flex-wrap items-baseline gap-x-3">
        <Sheet>Fig. 1</Sheet>
        <span className="text-[14px] italic leading-6 text-ink2">{page.caption}</span>
      </figcaption>
    </figure>
  );
}

/* -------------------------------------------------------------------------
   The row stacks
------------------------------------------------------------------------- */

/**
 * Column widths for the three tables on this page.
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
 * actually is.
 */
function RowTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-[1.0625rem] leading-6 text-ink">{children}</h3>;
}

/**
 * A spined stack of rows.
 *
 * `Row` puts a 3px department edge on its left when given a `dept`, and
 * because rows share their hairlines the edge runs unbroken from the first
 * row to the last: one continuous bar saying "all of this is Finance". That
 * is the Kit's stated shape for a set of things, and it is why this page
 * needs no card, no tile and no icon to make a list of six features look like
 * a list of six features.
 *
 * The header only exists from `lg`, and its padding has to match a spined
 * row's `pl-4` rather than an unspined row's `px-1`, or the column titles sit
 * 12px left of the column.
 */
function StackHeader({ columns, children }: { columns: string; children: ReactNode }) {
  return <div className={`hidden w-full pl-4 pb-2 lg:grid ${columns}`}>{children}</div>;
}

/**
 * The "what it does" band.
 *
 * Every feature is a row: an index, a name, and the sentence. There is no
 * card, no tile and no icon, and the important consequence is that the block
 * is correct at any length. Paid Marketing has five checks and Repositories
 * has six features; the old grid needed index arithmetic against three
 * different column counts to stop the leftovers rendering as orphans, and
 * this needs none, because a stack of rows has no leftovers.
 */
function WhatItDoes({ product, page, dept }: { product: ProductDef; page: PageCopy; dept: Dept }) {
  return (
    <Band id="what-it-does" tone="ground" pad="m">
      <Container>
        <Head
          eyebrow={`What it does · ${product.features.length} parts`}
          title={page.does}
          lede={product.summary}
        />

        <div className="mt-12">
          <StackHeader columns={FEATURE_COLUMNS}>
            <Sheet>No.</Sheet>
            <Sheet>Part</Sheet>
            <Sheet>What it is</Sheet>
          </StackHeader>

          {product.features.map((feature, index) => (
            <Row key={feature.title} dept={dept}>
              <div className={`grid w-full min-w-0 ${FEATURE_COLUMNS}`}>
                <Field>{String(index + 1).padStart(2, "0")}</Field>
                <RowTitle>{feature.title}</RowTitle>
                <Body>{feature.body}</Body>
              </div>
            </Row>
          ))}
        </div>
      </Container>
    </Band>
  );
}

/**
 * The "who works it" band.
 *
 * This band used to be near-black with an aurora wash over it, on all
 * fourteen pages — which is exactly how every page came to read as the same
 * sequence of slabs. It is a plain surface band now, and the near-black is
 * spent on the one thing that earns it: the stop.
 */
function WithEmployees({
  product,
  page,
  dept,
}: {
  product: ProductDef;
  page: PageCopy;
  dept: Dept;
}) {
  return (
    <Band id="with-employees" tone="surface" pad="m">
      <Container>
        <Head
          eyebrow={`Who works it · ${product.employees.bullets.length} behaviours`}
          title={page.staff}
          lede={product.employees.body}
          aside={page.stop && <Stop stop={page.stop} />}
        />

        <div className="mt-12">
          {product.employees.bullets.map((bullet, index) => (
            <Row key={bullet.title} dept={dept}>
              <div className={`grid w-full min-w-0 ${FEATURE_COLUMNS}`}>
                <Field>{String(index + 1).padStart(2, "0")}</Field>
                <RowTitle>{bullet.title}</RowTitle>
                <Body>{bullet.body}</Body>
              </div>
            </Row>
          ))}
        </div>
      </Container>
    </Band>
  );
}

/**
 * What is still waiting for a person.
 *
 * The one object on this page with no hue, in the same near-black the wall's
 * eighth cell uses, sitting beside a heading whose band is otherwise entirely
 * one department's colour. That contrast is the argument: the machine is in
 * colour and the human is in black, and on a product page the reader wants to
 * know precisely which of the two this product's last step belongs to.
 *
 * A Decision and an Approval are named apart rather than collapsed into
 * "waiting for you". AGENTS.md §3 is explicit that they are different events
 * — one the employee wrote, one the system interposed — and the Marks encode
 * the difference in geometry, so the label and the glyph agree.
 */
function Stop({ stop }: { stop: NonNullable<PageCopy["stop"]> }) {
  return (
    <div className="bg-ink p-4 text-ground">
      <div className="flex items-center gap-2">
        <Mark state={stop.kind} className="h-3 w-3" />
        <span className="t-field">{stop.kind === "decision" ? "Decision" : "Approval"}</span>
      </div>
      <p className="mt-3 max-w-[40ch] text-[15px] leading-6">{stop.line}</p>
    </div>
  );
}

/**
 * The questions.
 *
 * The `<details>` accordion is gone along with its rotating chevron. Hiding
 * five short answers behind five clicks costs the reader every one of them
 * and buys nothing; printed open, they are a two-column table, which is what
 * a question and its answer are.
 *
 * These rows carry no department spine, and the omission is the point: a
 * reader's question is not the department's property, and a hue that appeared
 * on every stack on the page would have stopped meaning anything by the third
 * one.
 */
function Questions({ product }: { product: ProductDef }) {
  return (
    <Band id="questions" tone="ground" pad="s">
      <Container>
        <Head
          eyebrow={`Questions · ${product.faqs.length} answered`}
          title={`Readers ask ${product.faqs.length} questions about ${product.name}.`}
        />

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
      </Container>
    </Band>
  );
}

/**
 * The rest of the catalogue, as a small org chart.
 *
 * Same-category products first, because a reader on the Finance page is more
 * likely to want Revenue than Notes.
 *
 * Each row takes **its own** product's department spine rather than this
 * page's, so the four rows carry three or four different hues depending on
 * which page you are standing on. It is the whole system in four rows: a
 * reader on `/products/notes` is told that Resources is filed with
 * Repositories alongside it and that Bases is filed with Revenue, without a
 * word being spent saying so.
 *
 * The rows are links, so they take the hover inversion, and the cells that
 * set their own colour have to answer it — `Row` puts `group` on the link and
 * flips the text on itself, which cannot reach a child that already declared
 * a colour. The spine deliberately survives the inversion: a department does
 * not stop being that department because a cursor is over it.
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

  const INVERT = "group-hover:!text-ground";

  return (
    <Band tone="ground" pad="s">
      <Container>
        <Head
          eyebrow={`More products · ${PRODUCTS.length} in total`}
          title={`${related.length} more products share one database.`}
          aside={<TextLink href="/products">All products</TextLink>}
        />

        <div className="mt-10">
          {related.map((product) => (
            <Row
              key={product.slug}
              href={`/products/${product.slug}`}
              dept={PRODUCT_DEPT[product.slug] ?? "operations"}
            >
              <div className={`grid w-full min-w-0 ${FAQ_COLUMNS}`}>
                <Body className={`!text-[1.0625rem] !leading-6 !text-ink ${INVERT}`}>
                  {product.name}
                </Body>
                <Body className={INVERT}>{product.summary}</Body>
              </div>
            </Row>
          ))}
        </div>
      </Container>
    </Band>
  );
}
