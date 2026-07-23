import { ArrowRight, Github, Terminal } from "lucide-react";
import { GITHUB_URL, ROADMAP_URL } from "@/lib/constants";
import { Logo } from "@/components/Logo";
import { Link } from "@/lib/router";

const ISSUES_URL = `${GITHUB_URL}/issues`;

export function InstallCta() {
  return (
    <section className="relative bg-white">
      <div className="mx-auto max-w-7xl px-6 pt-16">
        <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-zinc-950 via-zinc-900 to-zinc-950 px-8 py-14 text-center sm:px-12 sm:py-20">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.18),transparent_65%)]"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.05)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.05)_1px,transparent_1px)] bg-[size:36px_36px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]"
          />

          <div className="relative">
            <h2 className="text-balance text-4xl font-semibold tracking-[-0.02em] text-white sm:text-5xl">
              Meet your first AI employee.
            </h2>
            <p className="mx-auto mt-4 max-w-lg text-base leading-relaxed text-zinc-300">
              One command pulls the image and starts Genosyn on{" "}
              <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[12px] text-white">
                localhost:8471
              </code>
              . Write their soul. Schedule their first routine.
            </p>

            <div className="mx-auto mt-8 flex max-w-xl items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-left font-mono text-[13px] text-zinc-200 shadow-card">
              <Terminal className="h-4 w-4 text-zinc-300" />
              <span className="text-zinc-500">$</span>
              <span className="truncate">curl -fsSL genosyn.com/install.sh | bash</span>
            </div>

            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-white px-6 py-3 text-sm font-semibold text-zinc-950 shadow-lift transition hover:bg-zinc-100 sm:w-auto"
              >
                <Github className="h-4 w-4" />
                Star on GitHub
              </a>
              <a
                href="/#quickstart"
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-white/15 px-6 py-3 text-sm font-semibold text-white transition hover:bg-white/5 sm:w-auto"
              >
                See quickstart
                <ArrowRight className="h-4 w-4" />
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

type FooterLink = { href: string; label: string; external?: boolean };

const PRODUCT_LINKS: FooterLink[] = [
  { href: "/products/ai-employees", label: "AI Employees" },
  { href: "/products/workspace", label: "Workspace" },
  { href: "/products/tasks", label: "Tasks" },
  { href: "/products/bases", label: "Bases" },
  { href: "/products/notes", label: "Notes" },
  { href: "/products/resources", label: "Resources" },
  { href: "/products/pipelines", label: "Pipelines" },
  { href: "/products/explore", label: "Explore" },
  { href: "/products/revenue", label: "Revenue" },
  { href: "/products/email", label: "Email" },
  { href: "/products/customers", label: "Customers" },
  { href: "/products/finance", label: "Finance" },
  { href: "/products/code", label: "Code Repositories" },
];

const FOOTER_COLUMNS: Array<{ label: string; links: FooterLink[] }> = [
  {
    label: "Resources",
    links: [
      { href: "/docs", label: "Docs" },
      { href: "/docs/install", label: "Install" },
      { href: "/docs/cli", label: "CLI reference" },
      { href: "/docs/self-hosting", label: "Self-hosting" },
      { href: "/enterprise", label: "Enterprise" },
    ],
  },
  {
    label: "Project",
    links: [
      { href: GITHUB_URL, label: "GitHub", external: true },
      { href: ROADMAP_URL, label: "Roadmap", external: true },
      { href: ISSUES_URL, label: "Issues", external: true },
      { href: "/install.sh", label: "install.sh" },
      { href: "/llms.txt", label: "llms.txt" },
    ],
  },
];

function FooterLinkItem({ link }: { link: FooterLink }) {
  if (link.external) {
    return (
      <li>
        <a
          href={link.href}
          target="_blank"
          rel="noreferrer"
          className="text-zinc-600 transition hover:text-zinc-950"
        >
          {link.label}
        </a>
      </li>
    );
  }
  return (
    <li>
      <Link href={link.href} className="text-zinc-600 transition hover:text-zinc-950">
        {link.label}
      </Link>
    </li>
  );
}

export function Footer() {
  return (
    <footer className="relative bg-white">
      <div className="mx-auto max-w-7xl px-6 pt-14 pb-16">
        <div className="grid grid-cols-2 gap-x-6 gap-y-10 border-t border-zinc-100 pt-10 sm:grid-cols-4 lg:grid-cols-6">
          <div className="col-span-2 pr-8">
            <Logo className="h-6 w-auto text-zinc-800" />
            <p className="mt-4 max-w-xs text-xs leading-relaxed text-zinc-500">
              The open-source, self-hostable platform for running companies
              with AI employees. One container, your keys, your data.
            </p>
          </div>
          <nav aria-label="Products" className="col-span-2">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
              Products
            </div>
            <ul className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-[13px]">
              {PRODUCT_LINKS.map((link) => (
                <FooterLinkItem key={link.label} link={link} />
              ))}
            </ul>
          </nav>
          {FOOTER_COLUMNS.map((col) => (
            <nav key={col.label} aria-label={col.label}>
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
                {col.label}
              </div>
              <ul className="mt-3 space-y-2 text-[13px]">
                {col.links.map((link) => (
                  <FooterLinkItem key={link.label} link={link} />
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-12 flex flex-col items-center justify-between gap-6 border-t border-zinc-100 pt-8 text-xs text-zinc-500 sm:flex-row">
          <span>© {__BUILD_YEAR__} HackerBay, Inc. · Built in the open.</span>
          <span className="font-mono text-zinc-400">v{__APP_VERSION__}</span>
        </div>
        <p className="mt-6 text-center text-[11px] leading-relaxed text-zinc-400 sm:text-left">
          Disclaimer: some parts of this software are AI generated. Use at your own risk. Open source and provided without warranty of any kind.
        </p>
      </div>
    </footer>
  );
}
