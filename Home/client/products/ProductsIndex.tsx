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
  Rail,
  Row,
  Sheet,
} from "@/sections/Kit";
import { PRODUCTS, PRODUCT_CATEGORIES, type ProductDef } from "@/products/data";
import { ROLES } from "@/roles/data";

/**
 * The products index.
 *
 * What it was: a pill badge, a two-tone headline, a four-tick checklist, one
 * "flagship" card carrying a live prototype, and then a grid of fourteen
 * hover-lifting cards, each led by a pastel icon tile in its own hue. The
 * roles index was the same page with different nouns.
 *
 * Two things changed and the second follows from the first.
 *
 * **The accents are gone**, so the page can no longer differentiate by
 * colour. That sounds like a loss and is not: fourteen hues told the reader
 * fourteen things were different without saying how. A row has to earn its
 * distinction with information instead.
 *
 * **So each row carries what the product is and who works inside it.** The
 * "who" is not written by hand — it is read out of `roles/data.ts`, where
 * every role already declares the products its day happens in. That makes the
 * third column a fact the site cannot get wrong, and it turns the index into
 * the one thing a catalogue is actually for: telling you which of these
 * fourteen things you would touch.
 */
export function ProductsIndex() {
  return (
    <div className="min-h-screen bg-paper-100 text-zinc-900">
      <Nav />
      <main>
        <PageHero
          sheet="01 / Products"
          fields={[
            `${PRODUCTS.length} PRODUCTS`,
            `${PRODUCT_CATEGORIES.length} CATEGORIES`,
            "APACHE-2.0",
          ]}
          title={`${PRODUCTS.length} products ship in one Genosyn install.`}
          // The lede opened on "An AI Employee finishes only what your systems
          // let it finish", which is the aphorism shape the copy rules forbid:
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
              <ActionStrip href="/docs" trailing="Docs" className="-mt-px">
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

/**
 * Column widths, shared by the header and every row so the two stay in step.
 *
 * The grid only exists from `lg`. Below that the three cells stack, which is
 * the honest projection at 375px: three columns squeezed into a phone is a
 * table nobody can read, and the summary column is prose that needs a measure.
 */
const COLUMNS = "gap-x-6 gap-y-1.5 lg:grid-cols-[13rem_minmax(0,1fr)_12rem]";

/**
 * Row cells set their own colour, so they also have to answer the row's hover
 * inversion — `Row` puts `group` on the link and flips the text on itself,
 * which cannot reach a child that has already declared a colour of its own.
 */
const INVERT = "group-hover:!text-paper-50";

function Catalogue() {
  return (
    <Band id="catalogue" tone="paper" pad="m">
      <Container>
        {/* Fields are counts, in digits. "ONE DATABASE" spelled out was the
            heading's claim repeated in mono, which is exactly the "mono as
            texture on a marketing sentence" the Kit rules out; every other
            field on the site is a numeral or an identifier. */}
        <Rail sheet="02 / Catalogue" fields={["1 DATABASE", "1 AUDIT TRAIL"]}>
          <Heading as="h2" className="max-w-[22ch]">
            {`${PRODUCT_CATEGORIES.length} categories share one database and one permission model.`}
          </Heading>

          <div className="mt-12">
            <div className={`hidden w-full px-1 pb-2 lg:grid ${COLUMNS}`}>
              <Sheet>Product</Sheet>
              <Sheet>What it is</Sheet>
              <Sheet>Worked by</Sheet>
            </div>

            {PRODUCT_CATEGORIES.map((category) => {
              const products = PRODUCTS.filter((product) => product.category === category);
              if (products.length === 0) return null;

              return (
                <section key={category} aria-label={category} className="mt-12 first:mt-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 pb-3">
                    <Sheet>{category}</Sheet>
                    <Field>
                      {`${products.length} ${products.length === 1 ? "PRODUCT" : "PRODUCTS"}`}
                    </Field>
                  </div>

                  {products.map((product, index) => (
                    <ProductRow key={product.slug} product={product} opens={index === 0} />
                  ))}
                </section>
              );
            })}
          </div>
        </Rail>
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
 */
function ProductRow({ product, opens }: { product: ProductDef; opens: boolean }) {
  return (
    <Row href={`/products/${product.slug}`} className={opens ? "!border-t-paper-400" : ""}>
      <div className={`grid w-full min-w-0 ${COLUMNS}`}>
        <Body className={`!text-[1.0625rem] !leading-6 !text-zinc-950 ${INVERT}`}>
          {product.name}
        </Body>
        <Body className={INVERT}>{product.summary}</Body>
        <div className="lg:text-right">
          <Sheet className={INVERT}>{workedBy(product.slug)}</Sheet>
        </div>
      </div>
    </Row>
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
  if (names.length <= 2) return names.join(" · ");
  return `${names.slice(0, 2).join(" · ")} + ${names.length - 2} more`;
}
