import { ArrowRight, Check, Github, ShieldCheck } from "lucide-react";
import { GITHUB_URL } from "@/lib/constants";
import { Link } from "@/lib/router";
import { CompanyPreview } from "@/sections/CompanyPreview";

const PROOF = ["MIT licensed", "Self-hosted", "Any AI model", "Human approvals"];

export function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-slate-200 bg-white">
      <div aria-hidden className="marketing-grid pointer-events-none absolute inset-0 opacity-65" />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-48 left-1/2 h-[42rem] w-[68rem] -translate-x-1/2 rounded-full bg-slate-200/70 blur-3xl"
      />

      <div className="relative mx-auto max-w-[90rem] px-5 pb-14 pt-12 sm:px-6 sm:pb-18 sm:pt-16 lg:pb-20 lg:pt-20">
        <div className="grid gap-12 lg:grid-cols-[0.8fr_1.2fr] lg:items-center lg:gap-14 xl:gap-20">
          <div className="mx-auto max-w-2xl text-center lg:mx-0 lg:text-left">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-full border border-slate-300 bg-white/90 px-3.5 py-1.5 text-[11px] font-semibold text-slate-700 shadow-[0_1px_2px_rgba(15,23,42,0.06)] backdrop-blur transition hover:border-slate-400 hover:text-slate-950"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Open source · Self-hosted
              <span className="text-slate-300">·</span>v{__APP_VERSION__}
              <ArrowRight className="h-3.5 w-3.5" />
            </a>

            <h1 className="mt-7 text-balance text-[3.35rem] font-semibold leading-[0.96] tracking-[-0.058em] text-slate-950 sm:text-[4.6rem] lg:text-[4.9rem] xl:text-[5.35rem]">
              Put people and AI on the{" "}
              <span className="text-slate-500">same operating system.</span>
            </h1>

            <p className="mx-auto mt-6 max-w-xl text-pretty text-base leading-7 text-slate-600 sm:text-lg sm:leading-8 lg:mx-0">
              Give AI Employees real roles, shared company context, scheduled work, and clear human
              guardrails—all in one workspace you control.
            </p>

            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row lg:justify-start">
              <a
                href="#quickstart"
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-slate-950 px-5 py-3 text-sm font-semibold text-white shadow-[0_8px_20px_-10px_rgba(15,23,42,0.8)] transition hover:-translate-y-0.5 hover:bg-slate-800 hover:shadow-md sm:w-auto"
              >
                Install Genosyn
                <ArrowRight className="h-4 w-4" />
              </a>
              <Link
                href="/products"
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 shadow-[0_1px_2px_rgba(15,23,42,0.05)] transition hover:-translate-y-0.5 hover:border-slate-400 hover:bg-slate-50 hover:shadow-sm sm:w-auto"
              >
                See how it works
                <ArrowRight className="h-4 w-4 text-slate-400" />
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

            <ul className="mx-auto mt-7 grid max-w-lg grid-cols-2 gap-x-4 gap-y-2 text-left text-[11px] font-medium text-slate-500 lg:mx-0">
              {PROOF.map((item) => (
                <li key={item} className="inline-flex items-center gap-1.5">
                  <Check className="h-3.5 w-3.5 text-slate-950" />
                  {item}
                </li>
              ))}
            </ul>
          </div>

          <div className="relative mx-auto w-full max-w-3xl">
            <div className="mb-3 flex items-center justify-between px-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
              <span>Northstar Labs · Live workspace</span>
              <span className="inline-flex items-center gap-1.5 text-emerald-700">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                Work moving now
              </span>
            </div>
            <CompanyPreview compact />
            <div className="absolute -bottom-5 right-3 hidden items-center gap-3 rounded-xl border border-slate-200 bg-white px-3.5 py-3 shadow-[0_18px_45px_-20px_rgba(15,23,42,0.45)] sm:flex lg:-right-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-950 text-white">
                <ShieldCheck className="h-4 w-4" />
              </span>
              <span>
                <span className="block text-[10px] font-semibold text-slate-900">
                  Human control stays visible
                </span>
                <span className="mt-0.5 block text-[9px] text-slate-500">
                  3 changes waiting for review
                </span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
