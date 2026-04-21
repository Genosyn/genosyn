import { ArrowUpRight, FileText, Star } from "lucide-react";
import { GITHUB_URL, ROADMAP_URL } from "@/lib/constants";

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[640px] bg-gradient-to-b from-indigo-50/70 to-transparent" />
      <div className="relative mx-auto max-w-6xl px-6 pt-16 pb-20 sm:pt-20 sm:pb-24">
        <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:gap-16">
          <div className="text-center lg:text-left">
            <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 shadow-sm">
              <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" />
              Open source · Self-hostable · MIT
            </div>
            <h1 className="mt-6 text-5xl font-semibold tracking-tight text-slate-900 sm:text-6xl lg:text-[4.25rem] lg:leading-[1.05]">
              Run companies<br className="hidden sm:block" /> autonomously.
            </h1>
            <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-slate-600 lg:mx-0">
              Genosyn is a roster of AI employees. Each has a written <b className="font-semibold text-slate-900">Soul</b>,
              a set of <b className="font-semibold text-slate-900">Skills</b>, and{" "}
              <b className="font-semibold text-slate-900">Routines</b> on a cron. Hire them, read what they
              shipped, keep the markdown in your repo.
            </p>
            <div className="mt-10 flex flex-col items-center gap-3 sm:flex-row lg:justify-start">
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500 sm:w-auto"
              >
                <Star className="h-4 w-4" />
                Star on GitHub
              </a>
              <a
                href={ROADMAP_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-800 shadow-sm transition hover:border-slate-300 hover:text-slate-900 sm:w-auto"
              >
                Read the roadmap
                <ArrowUpRight className="h-4 w-4" />
              </a>
            </div>
          </div>
          <SoulPreview />
        </div>
      </div>
    </section>
  );
}

function SoulPreview() {
  return (
    <div className="relative mx-auto w-full max-w-xl lg:max-w-none">
      <div
        aria-hidden
        className="absolute -inset-x-8 -inset-y-10 -rotate-1 rounded-[2rem] bg-gradient-to-br from-indigo-200/40 via-white to-slate-200/40 blur-2xl"
      />
      <div className="relative rounded-2xl border border-slate-200 bg-white shadow-xl shadow-slate-900/[0.04]">
        <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
          <span className="h-2.5 w-2.5 rounded-full bg-slate-200" />
          <span className="h-2.5 w-2.5 rounded-full bg-slate-200" />
          <span className="h-2.5 w-2.5 rounded-full bg-slate-200" />
          <div className="ml-3 flex min-w-0 items-center gap-1.5 text-xs font-medium text-slate-500">
            <FileText className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">alex-brand · Soul</span>
          </div>
        </div>
        <div className="space-y-4 px-6 py-5 font-mono text-[13px] leading-6 text-slate-600">
          <div>
            <div className="text-slate-900"># Alex Brand</div>
            <div className="text-slate-500">Senior brand writer.</div>
          </div>
          <div>
            <div className="font-semibold text-slate-900">## Role</div>
            <div>Owns voice. Ships one newsletter every Friday.</div>
          </div>
          <div>
            <div className="font-semibold text-slate-900">## Values</div>
            <div>- Concrete over clever.</div>
            <div>- Shorter is braver.</div>
            <div>- Cite the source or drop the claim.</div>
          </div>
          <div>
            <div className="font-semibold text-slate-900">## Never</div>
            <div>- Write &ldquo;in today&rsquo;s fast-paced world.&rdquo;</div>
            <div>- Promise features not on the roadmap.</div>
          </div>
        </div>
      </div>
    </div>
  );
}
