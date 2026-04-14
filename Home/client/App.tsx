import { Nav } from "@/sections/Nav";
import { Hero } from "@/sections/Hero";
import { Features } from "@/sections/Features";
import { HowItWorks } from "@/sections/HowItWorks";
import { Quote } from "@/sections/Quote";
import { Footer } from "@/sections/Footer";

export function App() {
  return (
    <div className="min-h-screen bg-white text-slate-900">
      <Nav />
      <main>
        <Hero />
        <Features />
        <HowItWorks />
        <Quote />
      </main>
      <Footer />
    </div>
  );
}
