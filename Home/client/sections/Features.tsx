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

/** The complete product index, paired with an app-like company dashboard preview. */

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

        <div className="mt-14 space-y-2">
          {/* The header uses the same grid as every row so all three columns align. */}
          <div className={`${COLUMNS} !mb-1 px-4 pb-2`}>
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
                    <span className="block text-[15px] font-medium text-slate-900 group-hover:text-indigo-700">
                      {product.name}
                    </span>
                    {dept && (
                      <span className="mt-2 block">
                        <Chip dept={dept}>{dept}</Chip>
                      </span>
                    )}
                  </span>
                  {/* A new product still gets truthful fallback copy until its concise label lands. */}
                  <Body>{HOLDS[product.slug] ?? product.summary}</Body>
                  <span className="text-[15px] leading-[1.6] text-slate-500">
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
