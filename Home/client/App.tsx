import { useEffect } from "react";
import { Nav } from "@/sections/Nav";
import { Hero } from "@/sections/Hero";
import { Roles, Roster } from "@/sections/Roles";
import { Autonomy } from "@/sections/Autonomy";
import { Primitives } from "@/sections/Primitives";
import { Features } from "@/sections/Features";
import { HowItWorks } from "@/sections/HowItWorks";
import { CliShowcase } from "@/sections/CliShowcase";
import { Colophon, Footer, InstallCta } from "@/sections/Footer";
import { Enterprise } from "@/sections/Enterprise";
import { Pricing } from "@/sections/Pricing";
import { DocsApp } from "@/docs/DocsApp";
import { ProductsIndex } from "@/products/ProductsIndex";
import { ProductPage } from "@/products/ProductPage";
import { findProduct } from "@/products/data";
import { RolesIndex } from "@/roles/RolesIndex";
import { RolePage } from "@/roles/RolePage";
import { findRole } from "@/roles/data";
import { ActionStrip, Band, Container, Display, Lede, Rail } from "@/sections/Kit";
import { usePathname } from "@/lib/router";
import { applyHead } from "@/lib/head";
import { findRouteHead } from "@/lib/siteMeta";

export function App() {
  const path = usePathname();

  // The prerendered HTML ships correct head tags for the landing route; this
  // keeps them truthful across client-side navigation.
  useEffect(() => {
    const head = findRouteHead(path);
    if (head) {
      applyHead(head);
    } else {
      document.title = "Page not found · Genosyn";
    }
  }, [path]);

  if (path.startsWith("/docs")) {
    return <DocsApp />;
  }

  if (path.startsWith("/enterprise")) {
    return <EnterprisePage />;
  }

  if (path.startsWith("/pricing")) {
    return <PricingPage />;
  }

  if (path.startsWith("/products")) {
    return <ProductsRoute path={path} />;
  }

  if (path.startsWith("/roles")) {
    return <RolesRoute path={path} />;
  }

  return <Landing />;
}

/**
 * The landing page, in the order the argument is made.
 *
 * The old sequence was nine bands whose tones alternated white / tint / white /
 * / white / tint like a checkerboard — the fallback rule you apply when
 * nothing about the content tells you where to break. This one groups by
 * meaning and changes tone exactly once, at the band that is literally about
 * work happening in the dark:
 *
 *   01 One Tuesday          the claim, and the board that is its evidence
 *   02 A day on the roster  one role, hour by hour
 *   03 The roster           who else you can hire
 *   04 The shift      NIGHT. what actually ran while nobody was there
 *   05 What a role is made of
 *   06 Setting one up
 *   07 Where the work happens
 *   08 Your own hardware
 *   09 Install
 *   10 Colophon             the one place a person speaks
 *
 * The sheet numbers in each band's rail are that table of contents, which is
 * why they run in sequence and why adding a band means renumbering rather than
 * appending.
 */
function Landing() {
  return (
    <div className="min-h-screen bg-ground text-ink">
      <Nav />
      <main>
        <Hero />
        <Roles />
        <Roster />
        <Autonomy />
        <Primitives />
        <HowItWorks />
        <Features />
        <CliShowcase />
        <InstallCta sheet="09 / Install" />
        <Colophon sheet="10 / Colophon" />
      </main>
      <Footer />
    </div>
  );
}

function EnterprisePage() {
  return (
    <div className="min-h-screen bg-ground text-ink">
      <Nav />
      <main>
        <Enterprise />
      </main>
      <Footer />
    </div>
  );
}

function PricingPage() {
  return (
    <div className="min-h-screen bg-ground text-ink">
      <Nav />
      <main>
        <Pricing />
      </main>
      <Footer />
    </div>
  );
}

function ProductsRoute({ path }: { path: string }) {
  const slug = path
    .replace(/^\/products\/?/, "")
    .replace(/\/+$/, "")
    .toLowerCase();

  if (!slug) {
    return <ProductsIndex />;
  }

  const product = findProduct(slug);
  if (!product) {
    return <ProductNotFound />;
  }

  return <ProductPage product={product} />;
}

function RolesRoute({ path }: { path: string }) {
  const slug = path
    .replace(/^\/roles\/?/, "")
    .replace(/\/+$/, "")
    .toLowerCase();

  if (!slug) {
    return <RolesIndex />;
  }

  const role = findRole(slug);
  if (!role) {
    return <NotFound kind="role" href="/roles" cta="Browse every role" />;
  }

  return <RolePage role={role} />;
}

function ProductNotFound() {
  return <NotFound kind="product" href="/products" cta="Browse all products" />;
}

/** The in-app not-found panel for an unknown product or role slug. */
function NotFound({ kind, href, cta }: { kind: string; href: string; cta: string }) {
  return (
    <div className="min-h-screen bg-ground text-ink">
      <Nav />
      <main>
        <Band tone="ground" pad="l" rule={false}>
          <Container>
            <Rail sheet="404 / No such page" fields={["HTTP 404"]}>
              <Display className="max-w-[20ch]">{`No ${kind} lives at this address.`}</Display>
              <Lede className="mt-7">
                The page does not exist. Everything Genosyn ships is one click away.
              </Lede>
              <div className="mt-10 max-w-[34rem]">
                <ActionStrip href={href} trailing="Index">
                  {cta}
                </ActionStrip>
              </div>
            </Rail>
          </Container>
        </Band>
      </main>
      <Footer />
    </div>
  );
}
