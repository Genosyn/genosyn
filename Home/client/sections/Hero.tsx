import { ArrowRight, CheckCircle2, Github, Star } from "lucide-react";
import { GITHUB_URL } from "@/lib/constants";
import { ProductPrototype } from "@/products/ProductPrototype";

const CHECKS = ["MIT licensed", "Self-hosted", "Your models", "Your data"];

export function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-zinc-100 bg-zinc-50/60">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[720px] bg-[radial-gradient(55%_65%_at_72%_8%,rgba(148,163,184,0.18),transparent_72%)]"
      />
      <div
        aria-hidden
        className="bg-grid-soft pointer-events-none absolute inset-x-0 top-0 h-[720px] opacity-40 [mask-image:linear-gradient(to_bottom,black,transparent_80%)]"
      />

      <div className="relative mx-auto max-w-[88rem] px-5 pb-16 pt-12 sm:px-6 sm:pb-20 sm:pt-16 lg:pb-24 lg:pt-20">
        <div className="grid items-center gap-12 lg:grid-cols-[0.78fr_1.22fr] lg:gap-10 xl:gap-16">
          <div className="max-w-xl">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="group inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-3.5 py-1.5 text-xs font-medium text-zinc-700 shadow-card transition hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-lift"
            >
              <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
              Open source
              <span className="text-zinc-300">/</span>
              <span className="text-zinc-500">v{__APP_VERSION__}</span>
              <ArrowRight className="h-3.5 w-3.5 text-zinc-400 transition group-hover:translate-x-0.5" />
            </a>

            <h1 className="mt-7 text-balance text-[2.8rem] font-semibold leading-[0.98] tracking-[-0.05em] text-zinc-950 sm:text-[3.8rem] lg:text-[4rem] xl:text-[4.6rem]">
              Your company, already <span className="text-zinc-500">in motion.</span>
            </h1>

            <p className="mt-6 max-w-lg text-pretty text-lg leading-[1.65] text-zinc-600">
              Genosyn is one workspace where Members and{" "}
              <span className="font-medium text-zinc-950">AI employees</span> run the company
              together. Give each employee a Soul, Skills, and scheduled Routines—then watch the
              work move.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <a
                href="#quickstart"
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-zinc-950 px-6 py-3 text-sm font-semibold text-white shadow-lift transition hover:bg-zinc-800 sm:w-auto"
              >
                Run it on your server
                <ArrowRight className="h-4 w-4" />
              </a>
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-6 py-3 text-sm font-semibold text-zinc-800 shadow-card transition hover:border-zinc-300 hover:bg-zinc-50 sm:w-auto"
              >
                <Github className="h-4 w-4" />
                Star on GitHub
              </a>
            </div>

            <ul className="mt-8 grid grid-cols-2 gap-x-4 gap-y-2 text-xs font-medium text-zinc-500 sm:flex sm:flex-wrap">
              {CHECKS.map((check) => (
                <li key={check} className="inline-flex items-center gap-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                  {check}
                </li>
              ))}
            </ul>
          </div>

          <div className="relative min-w-0">
            <div
              aria-hidden
              className="pointer-events-none absolute -inset-x-8 -inset-y-10 -z-10 rounded-[3rem] bg-white/80 blur-2xl"
            />
            <div className="mb-3 flex items-center justify-between px-1">
              <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-500">
                Click any product. The tour keeps moving.
              </span>
              <span className="hidden items-center gap-1.5 text-[10px] font-medium text-zinc-400 sm:inline-flex">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                Live company
              </span>
            </div>
            <ProductPrototype compact />
          </div>
        </div>
      </div>
    </section>
  );
}
