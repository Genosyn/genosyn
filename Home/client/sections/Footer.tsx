import { ArrowRight, Github } from "lucide-react";
import { GITHUB_URL, ROADMAP_URL } from "@/lib/constants";
import { Logo } from "@/components/Logo";
import { Link } from "@/lib/router";
import { Container, Section } from "@/sections/Kit";

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
  ["Pricing", "/pricing"],
  ["Enterprise", "/enterprise"],
] as const;

/**
 * The closing call to action: the single most saturated element on the site.
 *
 * Everything above it is warm paper with one accent; ending on a full colour
 * field is what makes the last screen feel like an invitation rather than the
 * bottom of a document.
 */
export function InstallCta() {
  return (
    <Section divide={false}>
      <Container wide flush className="py-16 sm:py-20">
        <div className="on-night relative overflow-hidden rounded-[2rem] bg-gradient-to-br from-stone-900 to-night-850 px-6 py-14 text-center shadow-raise sm:px-12 sm:py-20">
          <div
            aria-hidden
            className="marketing-dots pointer-events-none absolute inset-0 opacity-15"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -top-24 right-0 h-80 w-80 rounded-full bg-violet-500/25 blur-3xl"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-28 -left-20 h-80 w-80 rounded-full bg-tide-500/25 blur-3xl"
          />
          <div className="relative mx-auto max-w-2xl">
            <h2 className="text-balance text-[clamp(2rem,4.4vw,3.25rem)] font-semibold leading-[1.04] tracking-[-0.04em] text-white">
              Build an autonomous company today.
            </h2>
            <p className="mx-auto mt-5 max-w-xl text-base leading-7 text-white/85">
              Install Genosyn, choose an AI Model, write the first role, and put it on a schedule.
              Tomorrow morning, one job runs without you. The company grows from there.
            </p>
            <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <a
                href="/#quickstart"
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-white px-6 py-3.5 text-sm font-semibold text-stone-900 shadow-lg transition duration-200 hover:-translate-y-0.5 hover:bg-paper-100 sm:w-auto"
              >
                Install Genosyn
                <ArrowRight aria-hidden className="h-4 w-4" />
              </a>
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-white/40 bg-white/10 px-6 py-3.5 text-sm font-semibold text-white backdrop-blur transition duration-200 hover:-translate-y-0.5 hover:bg-white/20 sm:w-auto"
              >
                <Github aria-hidden className="h-4 w-4" />
                Star on GitHub
                <span className="sr-only">{"(opens in a new tab)"}</span>
              </a>
            </div>
          </div>
        </div>
      </Container>
    </Section>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-stone-900/[0.08] bg-paper-200">
      <div className="mx-auto max-w-[88rem] px-5 pb-10 pt-14 sm:px-8 sm:pt-16">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.5fr_1fr_1fr_1fr]">
          <div>
            <Logo className="h-7 w-auto text-stone-900" />
            <p className="mt-5 max-w-sm text-sm leading-6 text-stone-600">
              The open-source, self-hostable operating system for autonomous companies.
            </p>
            <div className="mt-6 inline-flex items-center gap-2 rounded-full border border-stone-900/[0.10] bg-white px-3 py-1.5 text-[11px] font-semibold text-stone-600 shadow-card">
              <span aria-hidden className="preview-live h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Apache 2.0 licensed · v{__APP_VERSION__}
            </div>
          </div>

          <FooterColumn title="Product" links={PRODUCT_LINKS} />
          <FooterColumn title="Resources" links={RESOURCE_LINKS} />

          <nav aria-label="Project">
            <div className="text-[11px] font-semibold text-stone-500">
              Project
            </div>
            <ul className="mt-5 space-y-3 text-sm">
              <li>
                <a
                  href={GITHUB_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="text-stone-600 transition hover:text-tide-600"
                >
                  GitHub
                </a>
              </li>
              <li>
                <a
                  href={ROADMAP_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="text-stone-600 transition hover:text-tide-600"
                >
                  Roadmap
                </a>
              </li>
              <li>
                <a
                  href={`${GITHUB_URL}/issues`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-stone-600 transition hover:text-tide-600"
                >
                  Issues
                </a>
              </li>
              <li>
                <a href="/install.sh" className="text-stone-600 transition hover:text-tide-600">
                  install.sh
                </a>
              </li>
            </ul>
          </nav>
        </div>

        <div className="mt-14 flex flex-col gap-4 border-t border-stone-900/[0.08] pt-6 text-[11px] leading-5 text-stone-500 sm:flex-row sm:items-center sm:justify-between">
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
      <div className="text-[11px] font-semibold text-stone-500">
        {title}
      </div>
      <ul className="mt-5 space-y-3 text-sm">
        {links.map(([label, href]) => (
          <li key={href}>
            <Link href={href} className="text-stone-600 transition hover:text-tide-600">
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
