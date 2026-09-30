import { useEffect } from "react";
import type { ReactNode } from "react";
import { Nav } from "@/sections/Nav";
import { Hero } from "@/sections/Hero";
import { Integrations } from "@/sections/Integrations";
import { Roster } from "@/sections/Roster";
import { DayInLife } from "@/sections/DayInLife";
import { Anatomy } from "@/sections/Anatomy";
import { Guardrails } from "@/sections/Guardrails";
import { Platform } from "@/sections/Platform";
import { OpenSource } from "@/sections/OpenSource";
import { ClosingCta, Footer } from "@/sections/Footer";
import { Button, Container } from "@/sections/Kit";
import { DocsApp } from "@/docs/DocsApp";
import { ProductsIndex } from "@/products/ProductsIndex";
import { ProductPage } from "@/products/ProductPage";
import { findProduct } from "@/products/data";
import { RolesIndex } from "@/roles/RolesIndex";
import { RolePage } from "@/roles/RolePage";
import { findRole } from "@/roles/data";
import { usePathname } from "@/lib/router";
import { applyHead } from "@/lib/head";
import { findRouteHead } from "@/lib/siteMeta";

export function App() {
  const path = usePathname();

  // The prerendered HTML ships correct head tags for its route; this keeps
  // them truthful across client-side navigation.
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

  if (path.startsWith("/products")) {
    return <ProductsRoute path={path} />;
  }

  if (path.startsWith("/roles")) {
    return <RolesRoute path={path} />;
  }

  return <Landing />;
}

/** The landing page tells one night, then shows how it was built. */
function Landing() {
  return (
    <Page>
      <Hero />
      <Integrations />
      <Roster />
      <DayInLife />
      <Anatomy />
      <Guardrails />
      <Platform />
      <OpenSource />
      <ClosingCta />
    </Page>
  );
}

function Page({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen overflow-x-clip bg-paper text-ink">
      <Nav />
      <main>{children}</main>
      <Footer />
    </div>
  );
}

function slugOf(path: string, prefix: string): string {
  return path
    .replace(new RegExp(`^/${prefix}/?`), "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function ProductsRoute({ path }: { path: string }) {
  const slug = slugOf(path, "products");
  if (!slug) return <ProductsIndex />;
  const product = findProduct(slug);
  if (!product) return <NotFound kind="product" href="/products" cta="Browse every product" />;
  return <ProductPage product={product} />;
}

function RolesRoute({ path }: { path: string }) {
  const slug = slugOf(path, "roles");
  if (!slug) return <RolesIndex />;
  const role = findRole(slug);
  if (!role) return <NotFound kind="role" href="/roles" cta="Browse every role" />;
  return <RolePage role={role} />;
}

/** The in-app not-found panel for an unknown product or role slug. */
function NotFound({ kind, href, cta }: { kind: string; href: string; cta: string }) {
  return (
    <Page>
      <section className="py-28 sm:py-36">
        <Container>
          <p className="kicker inline-flex items-center gap-3 text-ink-500">
            <span aria-hidden className="h-px w-6 bg-ink" />
            404
          </p>
          <h1 className="mt-6 max-w-[16ch] text-balance font-display text-display-xl text-ink">
            {`No ${kind} lives here.`}
          </h1>
          <p className="mt-7 max-w-[48ch] text-[1.125rem] leading-[1.6] text-ink-600">
            The page does not exist. Everything Genosyn ships is one click away.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <Button href={href} variant="ink" arrow>
              {cta}
            </Button>
            <Button href="/" variant="outline">
              Back to the start
            </Button>
          </div>
        </Container>
      </section>
    </Page>
  );
}
