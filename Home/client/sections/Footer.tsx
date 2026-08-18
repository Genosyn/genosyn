import { ArrowRight, Github } from "lucide-react";
import { GITHUB_URL, ROADMAP_URL } from "@/lib/constants";
import { Logo } from "@/components/Logo";
import { Link } from "@/lib/router";

const PRODUCT_LINKS = [
  ["AI Employees", "/products/ai-employees"],
  ["Workspace", "/products/workspace"],
  ["Tasks", "/products/tasks"],
  ["Revenue", "/products/revenue"],
  ["Finance", "/products/finance"],
  ["Repositories", "/products/repositories"],
] as const;

const RESOURCE_LINKS = [
  ["Documentation", "/docs"],
  ["Install guide", "/docs/install"],
  ["Self-hosting", "/docs/self-hosting"],
  ["CLI reference", "/docs/cli"],
  ["Enterprise", "/enterprise"],
] as const;

export function InstallCta() {
  return (
    <section className="bg-white">
      <div className="mx-auto max-w-7xl px-5 py-16 sm:px-6 sm:py-20">
        <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 px-6 py-12 text-center shadow-[0_28px_70px_-36px_rgba(15,23,42,0.5)] sm:px-12 sm:py-16">
          <div aria-hidden className="marketing-dots pointer-events-none absolute inset-0 opacity-20" />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.22),transparent_68%)]"
          />
          <div className="relative mx-auto max-w-2xl">
            <h2 className="text-balance text-3xl font-semibold tracking-[-0.035em] text-white sm:text-4xl">
              Put your first AI Employee to work.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-sm leading-6 text-slate-200 sm:text-base">
              Install Genosyn, choose an AI Model, define the role, and schedule the first Routine.
              The rest of the company can grow from there.
            </p>
            <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <a
                href="/#quickstart"
                className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-white px-5 py-3 text-sm font-semibold text-slate-800 shadow-sm transition hover:-translate-y-0.5 hover:bg-slate-100 sm:w-auto"
              >
                Install Genosyn
                <ArrowRight className="h-4 w-4" />
              </a>
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-white/25 bg-white/5 px-5 py-3 text-sm font-semibold text-white transition hover:-translate-y-0.5 hover:bg-white/10 sm:w-auto"
              >
                <Github className="h-4 w-4" />
                Star on GitHub
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-slate-200 bg-slate-50">
      <div className="mx-auto max-w-7xl px-5 pb-10 pt-12 sm:px-6 sm:pt-14">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.5fr_1fr_1fr_1fr]">
          <div>
            <Logo className="h-7 w-auto text-slate-900" />
            <p className="mt-4 max-w-sm text-sm leading-6 text-slate-500">
              The open-source, self-hostable company operating system for people and AI Employees.
            </p>
            <div className="mt-5 inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-medium text-slate-500">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              MIT licensed · v{__APP_VERSION__}
            </div>
          </div>

          <FooterColumn title="Product" links={PRODUCT_LINKS} />
          <FooterColumn title="Resources" links={RESOURCE_LINKS} />

          <nav aria-label="Project">
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
              Project
            </div>
            <ul className="mt-4 space-y-2.5 text-sm">
              <li>
                <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="text-slate-600 hover:text-slate-950">
                  GitHub
                </a>
              </li>
              <li>
                <a href={ROADMAP_URL} target="_blank" rel="noreferrer" className="text-slate-600 hover:text-slate-950">
                  Roadmap
                </a>
              </li>
              <li>
                <a href={`${GITHUB_URL}/issues`} target="_blank" rel="noreferrer" className="text-slate-600 hover:text-slate-950">
                  Issues
                </a>
              </li>
              <li>
                <a href="/install.sh" className="text-slate-600 hover:text-slate-950">
                  install.sh
                </a>
              </li>
            </ul>
          </nav>
        </div>

        <div className="mt-12 flex flex-col gap-4 border-t border-slate-200 pt-6 text-[11px] leading-5 text-slate-400 sm:flex-row sm:items-center sm:justify-between">
          <span>© {__BUILD_YEAR__} HackerBay, Inc. · Built in the open.</span>
          <span className="max-w-2xl sm:text-right">
            Some parts of this software are AI generated. Use at your own risk. Open source and
            provided without warranty.
          </span>
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({
  title,
  links,
}: {
  title: string;
  links: ReadonlyArray<readonly [string, string]>;
}) {
  return (
    <nav aria-label={title}>
      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
        {title}
      </div>
      <ul className="mt-4 space-y-2.5 text-sm">
        {links.map(([label, href]) => (
          <li key={href}>
            <Link href={href} className="text-slate-600 transition hover:text-slate-950">
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
