import { Nav } from "@/sections/Nav";
import { Footer, InstallCta } from "@/sections/Footer";
import { PageHero } from "@/sections/HeroKit";
import { Link } from "@/lib/router";
import { Reveal } from "@/components/Reveal";
import {
  ActionStrip,
  Band,
  Body,
  Chip,
  Container,
  Field,
  Head,
  Sheet,
  type Dept,
} from "@/sections/Kit";
import { PRODUCTS, PRODUCT_CATEGORIES, type ProductDef } from "@/products/data";
import { ROLES } from "@/roles/data";

/**
 * The products index.
 *
 * What it was: a pill badge, a two-tone headline, a four-tick checklist, one
 * "flagship" card carrying a live prototype, and then a grid of fourteen
 * hover-lifting cards, each led by a pastel icon tile in its own hue. Fourteen
 * hues told a reader fourteen things were different without saying how, and
 * the roles index was the same page with different nouns in it.
 *
 * In HEADCOUNT the page is a catalogue of rows, and colour does one job:
 *
 * **Every row carries the department it belongs to** — a 3px spine on the left
 * edge and a chip naming it, in the same seven hues this site uses everywhere
 * else. So Customers and Revenue are visibly one department while Explore and
 * Pipelines are another, which is the fact a reader is actually after: not
 * "these are fourteen things" but "these are seven departments' worth of * surfaces". The hue is never per-product and never a mood.
 *
 * **And every row says who works inside it.** The "who" is not written by hand
 * — it is read out of `roles/data.ts`, where every role already declares the
 * products its day happens in, so the last column is a fact the site cannot
 * get wrong.
 *
 * There is deliberately no illustration per row. A catalogue that needs a
 * picture beside each entry is a catalogue whose entries do not differ.
 */
export function ProductsIndex() {
  return (
    <div className="min-h-screen bg-ground text-ink">
      <Nav />
      <main>
        <PageHero
          eyebrow="Products"
          fields={[
            `${PRODUCTS.length} PRODUCTS`,
            `${DEPT_COUNT} DEPARTMENTS`,
            `${PRODUCT_CATEGORIES.length} CATEGORIES`,
            "APACHE-2.0",
          ]}
          title={`${PRODUCTS.length} products ship in one Genosyn install.`}
          // The lede opened on "An AI Employee finishes only what your systems // let it finish", which is the aphorism shape the copy rules forbid:
          // an abstraction as subject, a general truth, no artefact. It is
          // replaced by what a reader can go and check — a Grant, a Run, a row
          // on the audit trail.
          lede={
            <>
              An AI Employee works inside these the way a colleague works inside your tools. A Grant
              decides which records it reaches. Every Run leaves a row on the audit trail, so you
              can read back what it changed.
            </>
          }
          actions={
            <>
              {/* Short enough to survive `ActionStrip`'s truncation at 375px:
                  a primary control that ends in an ellipsis is not a control. */}
              <ActionStrip href="/products/ai-employees" trailing="Product">
                Start with AI Employees
              </ActionStrip>
              <ActionStrip href="/docs" trailing="Docs">
                Read the documentation
              </ActionStrip>
            </>
          }
        />

        <Catalogue />

        <InstallCta />
      </main>
      <Footer />
    </div>
  );
}

/* -------------------------------------------------------------------------
   Which department a product belongs to
------------------------------------------------------------------------- */

/**
 * The department each product is a surface of.
 *
 * Six products are a department outright — Finance, Email, Revenue,
 * Marketing, Workspace, Repositories are the same seven-lane org chart the
 * rest of the site is drawn from. The other eight are assigned to the
 * department whose work happens inside them, and the two groupings that are
 * not self-evident are these:
 *
 *   - **Tasks and Notes are Workspace.** The board and the notebooks are
 *     where a team's shared work is written down; every role on the roster
 *     that declares Notes also declares Workspace.
 *   - **Bases, Resources, Pipelines and Explore are Operations.** They are
 *     the machine room — the stores, the automation over them, and the
 *     queries over that. Operations on the wall is the same idea: probes,
 *     queue depth, the archive job.
 *
 * A per-product hue was the rejected alternative and it is what the old page
 * did. Fourteen hues are not a legend, they are decoration: the reader cannot
 * hold fourteen meanings, and the seventh time a hue appears meaning nothing
 * in particular the whole system stops being readable.
 *
 * `ai-employees` is absent on purpose — see `ProductRow`.
 */
const PRODUCT_DEPT: Record<string, Dept> = {
  workspace: "workspace",
  tasks: "workspace",
  notes: "workspace",
  bases: "operations",
  resources: "operations",
  pipelines: "operations",
  explore: "operations",
  marketing: "marketing",
  revenue: "revenue",
  customers: "revenue",
  email: "email",
  finance: "finance",
  repositories: "repositories",
};

/** Counted rather than typed, so the hero cannot drift from the table. */
const DEPT_COUNT = new Set(Object.values(PRODUCT_DEPT)).size;

/**
 * The seven departments in wall order, for the one row that is all of them.
 *
 * `people` is not here and never is outside `/roles/recruiter`: it is the
 * eighth hue and no product is a People surface.
 */
const ALL_DEPTS: Dept[] = [
  "email",
  "finance",
  "repositories",
  "revenue",
  "workspace",
  "marketing",
  "operations",
];

/** The department's name as a reader would say it, for the chip. */
const DEPT_NAME: Record<Dept, string> = {
  finance: "Finance",
  repositories: "Repositories",
  marketing: "Marketing",
  workspace: "Workspace",
  email: "Email",
  revenue: "Revenue",
  operations: "Operations",
  people: "People",
};

/* -------------------------------------------------------------------------
   The catalogue
------------------------------------------------------------------------- */

/**
 * Column widths, shared by the header and every row so the two stay in step.
 *
 * The department sits second rather than last: the chip is what makes the 3px
 * spine on the left edge legible, and a legend four columns away from the
 * thing it explains is not a legend. The grid only exists from `lg` — below
 * that the cells stack, which is the honest projection at 375px, because the
 * summary column is prose that needs a measure.
 */
const COLUMNS = "gap-x-6 gap-y-2 lg:grid-cols-[13rem_8rem_minmax(0,1fr)_11rem]";

/**
 * Row cells set their own colour, so they also have to answer the row's hover
 * inversion — `Row` puts `group` on the link and flips the text on itself,
 * which cannot reach a child that has already declared a colour of its own.
 * The chip is deliberately left out of it: it is a department fill carrying
 * white, and it stays that on ink the way a department stays itself.
 */
function Catalogue() {
  return (
    <Band id="catalogue" tone="ground" pad="m">
      <Container>
        <Head
          eyebrow="Catalogue"
          title={`${PRODUCT_CATEGORIES.length} categories share one database and one permission model.`}
          lede={
            <>
              The marker and the chip on each row name the department a product belongs to, so
              Customers and Revenue read as one department and Explore and Pipelines as another. The
              last column is read off the roster, so it names the roles that would actually touch
              it.
            </>
          }
          // Counts in digits, and both are emitted rather than argued.
          // "ONE DATABASE" spelled out was the heading's claim repeated in
          // mono, which is the "mono as texture on a marketing sentence" the
          // Kit rules out.
          aside={
            <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
              <Field>1 DATABASE</Field>
              <Field>1 AUDIT TRAIL</Field>
            </div>
          }
        />

        <div className="mt-10">
          <div className={`hidden w-full px-4 pb-2 lg:grid ${COLUMNS}`}>
            <Sheet>Product</Sheet>
            <Sheet>Department</Sheet>
            <Sheet>What it is</Sheet>
            <Sheet>Worked by</Sheet>
          </div>

          {PRODUCT_CATEGORIES.map((category) => {
            const products = PRODUCTS.filter((product) => product.category === category);
            if (products.length === 0) return null;

            return (
              <section
                key={category}
                aria-label={category}
                className="mt-5 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm first:mt-0"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-slate-100 bg-slate-50/80 px-4 py-3">
                  <span className="text-sm font-semibold text-slate-900">{category}</span>
                  <Field>
                    {`${products.length} ${products.length === 1 ? "PRODUCT" : "PRODUCTS"}`}
                  </Field>
                </div>

                <Reveal stagger={45} className="divide-y divide-slate-100">
                  {products.map((product) => (
                    <ProductRow key={product.slug} product={product} />
                  ))}
                </Reveal>
              </section>
            );
          })}
        </div>
      </Container>
    </Band>
  );
}

/**
 * One product.
 *
 * `opens` promotes the top border of a group's first row from a hairline to
 * the structural weight, which is how a group boundary is drawn without a
 * second element: a `Rule` placed above the row would sit under the row's own
 * `-mt-px` and disappear, and giving it room instead draws a double line.
 *
 * AI Employees is the exception in every column, because it is not a
 * department — it is what staffs all seven. Its spine is therefore all seven
 * hues in wall order, and where the others carry a chip it carries a mono
 * label instead. It deliberately does not get an ink chip: ink means a human
 * is needed, and this row is the machine.
 */
function ProductRow({ product }: { product: ProductDef }) {
  const dept = PRODUCT_DEPT[product.slug];

  return (
    <Link
      href={`/products/${product.slug}`}
      className="group block px-4 py-4 transition-colors hover:bg-slate-50 focus-visible:bg-indigo-50/60"
    >
      <div className={`grid w-full min-w-0 ${COLUMNS}`}>
        <Body className="!text-[1rem] !font-semibold !leading-6 !text-slate-900 group-hover:!text-indigo-700">
          {product.name}
        </Body>

        <div className="min-w-0">
          {dept ? (
            <Chip dept={dept}>{DEPT_NAME[dept]}</Chip>
          ) : (
            <span className="inline-flex rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 ring-1 ring-inset ring-indigo-200">
              {`All ${ALL_DEPTS.length}`}
            </span>
          )}
        </div>

        <Body className="!text-slate-600">{product.summary}</Body>

        <div className="lg:text-right">
          <span className="text-xs font-medium text-slate-500">{workedBy(product.slug)}</span>
        </div>
      </div>
    </Link>
  );
}

/**
 * Which roles work inside a product, read from the roster rather than written
 * here twice.
 *
 * Two names then a count: the list is the point up to about twenty
 * characters, after which it is a wall. Workspace is worked by all eight and
 * would otherwise set the column width for the whole table.
 *
 * AI Employees is the one product no role declares, because it is the thing
 * every role is. The cell says so as a count rather than as a sentence: this
 * string is set in `Sheet`, which is the condensed uppercase label face, and
 * "EVERY ROLE ON THE ROSTER" is a marketing sentence wearing a column header's
 * clothes.
 */
function workedBy(slug: string): string {
  const names = ROLES.filter((role) => role.products.includes(slug)).map((role) => role.short);
  if (names.length === 0) return `All ${ROLES.length} roles`;
  if (names.length <= 2) return names.join("·");
  return `${names.slice(0, 2).join("·")} + ${names.length - 2} more`;
}
