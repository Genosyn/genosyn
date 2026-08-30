import { useEffect } from "react";
import { ArrowRight } from "lucide-react";
import { Nav } from "@/sections/Nav";
import { Hero } from "@/sections/Hero";
import { Autonomy } from "@/sections/Autonomy";
import { Primitives } from "@/sections/Primitives";
import { Features } from "@/sections/Features";
import { HowItWorks } from "@/sections/HowItWorks";
import { CliShowcase } from "@/sections/CliShowcase";
import { Footer, InstallCta } from "@/sections/Footer";
import { Enterprise } from "@/sections/Enterprise";
import { Pricing } from "@/sections/Pricing";
import { DocsApp } from "@/docs/DocsApp";
import { ProductsIndex } from "@/products/ProductsIndex";
import { ProductPage } from "@/products/ProductPage";
import { findProduct } from "@/products/data";
import { Link, usePathname } from "@/lib/router";
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

  return <Landing />;
}

function Landing() {
  return (
    <div className="min-h-screen bg-paper-100 text-stone-800">
      <Nav />
      <main>
        <Hero />
        <Autonomy />
        <HowItWorks />
        <Primitives />
        <Features />
        <CliShowcase />
        <InstallCta />
      </main>
      <Footer />
    </div>
  );
}

function EnterprisePage() {
  return (
    <div className="min-h-screen bg-paper-100 text-stone-800">
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
    <div className="min-h-screen bg-paper-100 text-stone-800">
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

function ProductNotFound() {
  return (
    <div className="min-h-screen bg-paper-100 text-stone-800">
      <Nav />
      <main className="mx-auto flex max-w-7xl flex-col items-center px-6 py-32 text-center">
        <div className="text-xs font-semibold text-bloom-600">404</div>
        <h1 className="mt-4 text-4xl font-semibold tracking-[-0.03em] text-stone-900">
          No product lives here.
        </h1>
        <p className="mt-4 max-w-md text-base leading-relaxed text-stone-600">
          The page you were looking for does not exist — but every tool Genosyn ships is one click
          away.
        </p>
        <Link
          href="/products"
          className="mt-8 inline-flex items-center gap-2 rounded-xl bg-bloom-500 px-5 py-3.5 text-sm font-semibold text-white shadow-card transition hover:bg-bloom-600"
        >
          Browse all products
          <ArrowRight className="h-4 w-4" />
        </Link>
      </main>
      <Footer />
    </div>
  );
}
