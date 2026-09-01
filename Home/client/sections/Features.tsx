import { PRODUCTS } from "@/products/data";
import { CompanyPreview } from "@/sections/CompanyPreview";
import {
  Band,
  Body,
  Container,
  Heading,
  Lede,
  Plate,
  Rail,
  Row,
  Sheet,
  TextLink,
} from "@/sections/Kit";

/**
 * The product band — an index, not a showcase.
 *
 * What was here: a centred header, a `` bordered slab with a radial
 * wash in one corner, six products as tiles with pastel icon squares that grew
 * on hover, a green-ticked checklist beside them, and the other eight products
 * demoted to a row of pill chips underneath. Two problems, and only the second
 * one is about styling.
 *
 * The first is editorial. Fourteen products either matter or they do not; a
 * layout that features six and reduces eight to garnish is a layout that has
 * not decided, and the chips read as an admission that the suite is padded.
 * They are all listed here, in one structure, in the order data.ts declares
 * them — so the answer to "what is actually in this thing" takes one screen
 * and no clicks.
 *
 * The second is that a set of things on this site is a stack of
 * rules-separated rows with a fixed column structure, never a grid of bordered
 * boxes. Three columns: what it is called, what it holds, and which role lives
 * in it. `product.accent` and `productIcon` are deliberately not read — the
 * fields stay in data.ts for the product pages, but fourteen hues and fourteen
 * glyphs were carrying no information here beyond "this is a different one",
 * which the row above and below already says.
 */

/**
 * The middle column, written here rather than taken from `product.summary`.
 *
 * The summaries are 25-to-35-word sentences built for a card and a meta
 * description; fourteen of them stacked is a wall nobody reads, and truncating
 * them mid-clause is worse than writing short. So each product gets the
 * records it actually holds — the nouns you would see in its sidebar — which
 * is the honest answer to "what is it" at index length. Every one of these is
 * checked against the product's own entry in data.ts; do not add a noun here
 * that the product page does not claim.
 */
const HOLDS: Record<string, string | undefined> = {
  "ai-employees": "Souls, Skills, Routines, and every Run transcribed",
  workspace: "Channels, DMs, and file uploads",
  tasks: "Projects and todos, assignable to a person or an employee",
  bases: "Multi-table workspaces with typed fields and saved views",
  notes: "Markdown pages in nested notebooks",
  resources: "URLs, PDFs, EPUBs, and transcripts, searchable once ingested",
  pipelines: "Triggers, branches, delays, and an ask-an-employee node",
  explore: "SQL saved as Charts, pinned to Dashboards",
  marketing: "Campaigns, Creative, Experiments, and a monthly Budget",
  revenue: "Contacts, Deals, Sequences, and product Signals",
  email: "Gmail threads, inbound rules, and read, draft, or send Grants",
  customers: "Accounts, contracts, ACV, and statements with aging",
  finance: "Invoices, bills, a double-entry ledger, and period close",
  repositories: "Git repositories, browser edits, and work sessions",
};

/**
 * The right column — the worked role that spends its day in each product.
 *
 * These are names from the shipped roster (roles/data.ts) rather than
 * departments, because a reader deciding whether this is for them is looking
 * for a job, not a category. AI Employees takes "Every role" for the obvious
 * reason: it is the thing the other thirteen are worked by.
 */
const WORKED_BY: Record<string, string | undefined> = {
  "ai-employees": "Every role",
  workspace: "AI Executive Assistant",
  tasks: "AI Executive Assistant",
  bases: "AI Analyst",
  notes: "AI Recruiter",
  resources: "AI Support Rep",
  pipelines: "AI Engineer",
  explore: "AI Analyst",
  marketing: "AI Marketer",
  revenue: "AI SDR",
  email: "AI SDR",
  customers: "AI Support Rep",
  finance: "AI Bookkeeper",
  repositories: "AI Engineer",
};

/**
 * One grid template, declared once and used by the column header and all
 * fourteen rows, which is what makes the columns line up down the page. Below
 * `sm` it collapses to a single column: three columns of prose at 375px is
 * four words per line.
 */
const COLUMNS =
  "grid w-full grid-cols-1 items-baseline gap-x-6 gap-y-1 sm:grid-cols-[9.5rem_minmax(0,1fr)_8.5rem] lg:grid-cols-[12rem_minmax(0,1fr)_11rem]";

export function Features() {
  return (
    <Band id="platform" tone="paper" pad="m">
      <Container>
        <Rail sheet="07 / Where the work happens" fields={["14 PRODUCTS", "8 WORKED ROLES"]}>
          {/* The headline names a row in Fig. 1 and a product in the index
              below it, so the three parts of the band point at each other
              instead of each restating the band's title. */}
          <Heading as="h2" className="max-w-[18ch]">
            Mira reconciled 42 payments inside Finance.
          </Heading>

          <Lede className="mt-7">
            An AI Employee works where the records are. Genosyn ships fourteen products for it to
            work in, from team chat to a double-entry ledger, and an employee reads and writes the
            same rows a Member does. You decide which ones, one Grant at a time.
          </Lede>

          <Plate
            className="mt-12"
            figure="Fig. 1"
            caption="Northstar Labs at 09:31. Eighteen Runs finished overnight; two Decisions and one Approval are waiting."
          >
            <CompanyPreview />
          </Plate>

          <div className="mt-14">
            {/* The header is not a Row — it carries no rule of its own, and the
                first row's own hairline is the boundary under it. */}
            <div className={`${COLUMNS} px-1 pb-3`}>
              <Sheet>Product</Sheet>
              <Sheet className="hidden sm:inline">What it holds</Sheet>
              <Sheet className="hidden sm:inline">Worked by</Sheet>
            </div>

            {PRODUCTS.map((product) => (
              <Row key={product.slug} href={`/products/${product.slug}`}>
                <div className={COLUMNS}>
                  <Sheet className="!text-[12px] !text-zinc-950 group-hover:!text-paper-50">
                    {product.name}
                  </Sheet>
                  {/* A product added to data.ts without a line here still
                      renders something true rather than an empty column. */}
                  <Body className="group-hover:text-paper-50">
                    {HOLDS[product.slug] ?? product.summary}
                  </Body>
                  <Sheet className="group-hover:!text-paper-50">
                    {WORKED_BY[product.slug] ?? product.category}
                  </Sheet>
                </div>
              </Row>
            ))}
          </div>

          <div className="mt-10">
            <TextLink href="/products">The product index</TextLink>
          </div>
        </Rail>
      </Container>
    </Band>
  );
}
