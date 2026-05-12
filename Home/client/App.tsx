import { useEffect } from "react";
import { Nav } from "@/sections/Nav";
import { Hero } from "@/sections/Hero";
import { Primitives } from "@/sections/Primitives";
import { DayInTheLife } from "@/sections/DayInTheLife";
import { Features } from "@/sections/Features";
import { HowItWorks } from "@/sections/HowItWorks";
import { CliShowcase } from "@/sections/CliShowcase";
import { Principles } from "@/sections/Principles";
import { Footer } from "@/sections/Footer";
import { DocsApp } from "@/docs/DocsApp";
import { usePathname } from "@/lib/router";

export function App() {
  const path = usePathname();

  useEffect(() => {
    if (path.startsWith("/docs")) return;
    document.title = "Genosyn — Run companies autonomously";
  }, [path]);

  if (path.startsWith("/docs")) {
    return <DocsApp />;
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
      </main>
      <Footer />
    </div>
  );
}
