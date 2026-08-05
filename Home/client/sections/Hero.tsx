import { ArrowRight, Check, Github } from "lucide-react";
import { GITHUB_URL } from "@/lib/constants";
import { Link } from "@/lib/router";
import { CompanyPreview } from "@/sections/CompanyPreview";

const PROOF = ["MIT licensed", "Self-hosted", "Any AI model", "Human approvals"];

export function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-slate-200 bg-slate-50">
      <div aria-hidden className="marketing-grid pointer-events-none absolute inset-0 opacity-75" />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[38rem] bg-[radial-gradient(circle_at_50%_5%,rgba(224,231,255,0.95),rgba(248,250,252,0)_68%)]"
      />

      <div className="relative mx-auto max-w-[88rem] px-5 pb-16 pt-14 sm:px-6 sm:pb-20 sm:pt-20 lg:pb-24">
        <div className="mx-auto max-w-4xl text-center">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-white/85 px-3.5 py-1.5 text-[11px] font-semibold text-indigo-700 shadow-sm backdrop-blur transition hover:border-indigo-300 hover:bg-white"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" />
            Open source and self-hosted
            <span className="text-indigo-200">·</span>
            v{__APP_VERSION__}
            <ArrowRight className="h-3.5 w-3.5" />
          </a>

          <h1 className="mt-7 text-balance text-[3.1rem] font-semibold leading-[0.98] tracking-[-0.055em] text-slate-950 sm:mt-8 sm:text-[4.8rem] lg:text-[5.8rem]">
            The company operating system for <span className="text-indigo-600">people and AI.</span>
          </h1>

          <p className="mx-auto mt-6 max-w-3xl text-pretty text-base leading-7 text-slate-600 sm:text-xl sm:leading-8">
            Give AI Employees clear roles, shared tools, scheduled work, and human guardrails.
            Genosyn keeps the people, context, and work together in one workspace you control.
          </p>

          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a
              href="#quickstart"
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500 sm:w-auto"
            >
              Install Genosyn
              <ArrowRight className="h-4 w-4" />
            </a>
            <Link
              href="/products"
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-slate-400 hover:bg-slate-50 sm:w-auto"
            >
              Explore the product
            </Link>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 px-3 py-3 text-sm font-medium text-slate-500 transition hover:text-slate-900"
            >
              <Github className="h-4 w-4" />
              GitHub
            </a>
          </div>

          <ul className="mt-7 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[11px] font-medium text-slate-500">
            {PROOF.map((item) => (
              <li key={item} className="inline-flex items-center gap-1.5">
                <Check className="h-3.5 w-3.5 text-indigo-600" />
                {item}
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-12 sm:mt-16">
          <CompanyPreview />
        </div>
      </div>
    </section>
  );
}
