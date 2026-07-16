import { useEffect } from "react";
import { ArrowRight } from "lucide-react";
import { Nav } from "@/sections/Nav";
import { Hero } from "@/sections/Hero";
import { Primitives } from "@/sections/Primitives";
import { DayInTheLife } from "@/sections/DayInTheLife";
import { Features } from "@/sections/Features";
import { HowItWorks } from "@/sections/HowItWorks";
import { CliShowcase } from "@/sections/CliShowcase";
import { Principles } from "@/sections/Principles";
import { Footer, InstallCta } from "@/sections/Footer";
import { Enterprise } from "@/sections/Enterprise";
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
      document.title = "Genosyn — Run companies autonomously";
    }
  }, [path]);

  if (path.startsWith("/docs")) {
    return <DocsApp />;
  }

  if (path.startsWith("/enterprise")) {
    return <EnterprisePage />;
  }

  if (path.startsWith("/products")) {
    return <ProductsRoute path={path} />;
  }

  return <Landing />;
}

function Landing() {
  return (
    <div className="min-h-screen bg-white text-zinc-950">
      <Nav />
      <main>
        <Hero />
        <Primitives />
        <DayInTheLife />
        <Features />
        <HowItWorks />
        <CliShowcase />
        <Principles />
        <InstallCta />
      </main>
      <Footer />
    </div>
  );
}

function EnterprisePage() {
  return (
    <div className="min-h-screen bg-white text-zinc-950">
      <Nav />
      <main>
        <Enterprise />
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
    <div className="min-h-screen bg-white text-zinc-950">
      <Nav />
      <main className="mx-auto flex max-w-7xl flex-col items-center px-6 py-32 text-center">
        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
          404
        </div>
        <h1 className="mt-4 text-3xl font-semibold tracking-[-0.02em] text-zinc-950">
          No product lives here.
        </h1>
        <p className="mt-3 max-w-md text-sm leading-relaxed text-zinc-600">
          The page you were looking for does not exist — but every tool Genosyn
          ships is one click away.
        </p>
        <Link
          href="/products"
          className="mt-8 inline-flex items-center gap-2 rounded-xl bg-zinc-950 px-6 py-3 text-sm font-semibold text-white shadow-lift transition hover:bg-zinc-800"
        >
          Browse all products
          <ArrowRight className="h-4 w-4" />
        </Link>
      </main>
      <Footer />
    </div>
  );
}
