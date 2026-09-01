import { PRODUCTS } from "@/products/data";
import { CompanyPreview } from "@/sections/CompanyPreview";
import type { Dept } from "@/sections/Kit";
import {
  Band,
  Body,
  Chip,
  Container,
  Field,
  Head,
  Plate,
  Row,
  Sheet,
  TextLink,
} from "@/sections/Kit";

/**
 * The product band — an index, and the place the legend is stated.
 *
 * What was here: a centred header, a bordered slab with a radial wash in one
 * corner, six products as tiles with pastel icon squares that grew on hover, a
 * green-ticked checklist beside them, and the other eight products demoted to
 * a row of pill chips underneath. Two problems, and only the second one is
 * about styling.
 *
 * The first is editorial. Fourteen products either matter or they do not; a
 * layout that features six and reduces eight to garnish is a layout that has
 * not decided, and the chips read as an admission that the suite is padded.
 * They are all listed here, in one structure, in the order data.ts declares
 * them — so the answer to "what is actually in this thing" takes one screen
 * and no clicks.
 *
 * The second is that a set of things on this site is a stack of rows sharing
 * one hairline, never a grid of bordered boxes.
 *
 * ## Why this band carries the legend
 *
 * HEADCOUNT's claim is that colour is the org chart, and this band states it
 * twice: Fig. 7's sidebar names all seven departments, and the index below
 * names the product each one owns. The wall in the hero spends all seven hues
 * without spelling one of them out, and Claims names only the one department
 * it is showing at that second, so this band is where a reader gets the key.
 *
 * So every row gets its department twice: as the 3px spine on its
 * left edge, which is what makes the column scannable at arm's length, and as
 * a `Chip` under the product name, which is what makes it decodable. Four
 * seconds after this band scrolls into view a reader should be able to read
 * the wall in the hero without a key.
 *
 * `product.accent` and `productIcon` are still deliberately not read. Those
 * fields carry fourteen pastel ring colours and fourteen glyphs, which is
 * fourteen hues meaning "this is a different one" — the exact decoration this
 * system replaced. The hue here comes from the department and nowhere else.
 */

/**
 * Every product's department. This is the org chart, so it is a fixed map
 * rather than anything derived from `product.category`: the categories in
 * data.ts ("Essentials", "Knowledge", "The core") are shelving for the product
 * index, and shelving is not an org chart.
 *
 * Two judgement calls, both worth arguing with:
 *
 * - **Knowledge is Workspace.** Notes, Resources and Tasks are where the
 *   company keeps what it knows and what it owes, alongside its chat. Filing
 *   them anywhere else would have meant inventing an eighth hue for a
 *   department nobody staffs.
 * - **Analytics and automation are Operations.** Bases, Explore, Pipelines
 *   and AI Employees are the machinery the company is run *with* rather than a
 *   line of business. Operations is the largest cell in this map for the same
 *   reason it is the largest cell in most real org charts.
 *
 * `people` is absent on purpose. It is bound to /roles/recruiter, which has no
 * Board lane, and Notes is worked by the AI Recruiter — which is precisely the
 * near-miss the reservation exists to stop. Notes is Workspace.
 *
 * A slug added to data.ts without a line here renders with no spine and no
 * chip, which is honest. Guessing a hue would put a product in a department it
 * is not in.
 */
const DEPARTMENT: Record<string, Dept | undefined> = {
  "ai-employees": "operations",
  workspace: "workspace",
  tasks: "workspace",
  bases: "operations",
  notes: "workspace",
  resources: "workspace",
  pipelines: "operations",
  explore: "operations",
  marketing: "marketing",
  revenue: "revenue",
  email: "email",
  customers: "revenue",
  finance: "finance",
  repositories: "repositories",
};

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
 * departments, because the department is already on the row twice and a reader
 * deciding whether this is for them is looking for a job. AI Employees takes
 * "Every role" for the obvious reason: it is the thing the other thirteen are
 * worked by.
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
 * fourteen rows, which is what makes the columns line up down the page. The
 * first column is sized to hold REPOSITORIES — the longest chip in the set —
 * without wrapping it onto a second line.
 *
 * Below `sm` it collapses to a single column: three columns of prose at 375px
 * is four words per line.
 */
const COLUMNS =
  "grid w-full grid-cols-1 items-baseline gap-x-6 gap-y-2 sm:grid-cols-[10rem_minmax(0,1fr)_8.5rem] lg:grid-cols-[12.5rem_minmax(0,1fr)_11rem]";

export function Features() {
  return (
    <Band id="platform" tone="ground" open="s" close="s">
      <Container>
        {/* The eyebrow keeps the sheet number: App.tsx's band sequence is the
            document's table of contents and renumbering is how it breaks. */}
        <Head
          eyebrow="07 / Where work runs"
          title="Pax answered 31 support emails inside Email."
          lede="An AI Employee works where the records are. Genosyn ships fourteen products for it to work in, from team chat to a double-entry ledger, and an employee reads and writes the same rows a Member does. You decide which ones, one Grant at a time."
          aside={
            <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
              <Field>14 PRODUCTS</Field>
              <Field>7 DEPARTMENTS</Field>
              <Field>8 WORKED ROLES</Field>
            </div>
          }
        />

        <Plate
          className="mt-12"
          figure="Fig. 7"
          caption="Northstar Labs at 09:31. Eighteen Runs finished overnight, and three are waiting for a person."
        >
          <CompanyPreview />
        </Plate>

        <div className="mt-14">
          {/* The header is not a Row — it carries no rule of its own, and the
              first row's own hairline is the boundary under it. It is indented
              by the spine width so its labels sit on the same left edge as the
              row text below. */}
          <div className={`${COLUMNS} pb-3 pl-4`}>
            <Sheet>Product · Department</Sheet>
            <Sheet className="hidden sm:inline">What it holds</Sheet>
            <Sheet className="hidden sm:inline">Worked by</Sheet>
          </div>

          {PRODUCTS.map((product) => {
            const dept = DEPARTMENT[product.slug];
            return (
              <Row key={product.slug} href={`/products/${product.slug}`} dept={dept}>
                <div className={COLUMNS}>
                  <span className="min-w-0">
                    {/* A row head, at the same 15px `t-h3` the wall's panes
                        use. It was mono uppercase in the previous pass, which
                        made fourteen product names read as fourteen field
                        labels — mono is for strings the software emitted, and
                        "Paid Marketing" is not one. */}
                    <span className="t-h3 block text-[15px] text-ink group-hover:text-ground">
                      {product.name}
                    </span>
                    {dept && (
                      <span className="mt-2 block">
                        <Chip dept={dept}>{dept}</Chip>
                      </span>
                    )}
                  </span>
                  {/* A product added to data.ts without a line here still
                      renders something true rather than an empty column. */}
                  <Body className="group-hover:text-ground">
                    {HOLDS[product.slug] ?? product.summary}
                  </Body>
                  {/* Set in sans, not in `Sheet`. Two reasons, and the first
                      is the same one that moved the product name out of mono
                      a column to the left: "AI Executive Assistant" is a role
                      on the shipped roster, not a string the software emitted,
                      and mono is reserved for the latter. The second is that
                      `Sheet` is what the column HEADER is set in — a header
                      and its fourteen values in one identical uppercase mono
                      face gives the column no head at all. It stays `muted`,
                      the quietest value allowed to carry text, so the column
                      reads as subordinate to what it holds. */}
                  <span className="text-[15px] leading-[1.6] text-muted group-hover:text-ground">
                    {WORKED_BY[product.slug] ?? product.category}
                  </span>
                </div>
              </Row>
            );
          })}
        </div>

        <div className="mt-10">
          <TextLink href="/products">The product index</TextLink>
        </div>
      </Container>
    </Band>
  );
}
