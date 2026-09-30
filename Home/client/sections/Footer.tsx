import type { ReactNode } from "react";
import { Github } from "lucide-react";
import { GITHUB_URL, INSTALL_DOCS_PATH } from "@/lib/constants";
import { Logo } from "@/components/Logo";
import { Link } from "@/lib/router";
import { Button, Container, CopyCommand, NightPanel, TextLink } from "@/sections/Kit";

const INSTALL_COMMAND = "curl -fsSL https://genosyn.com/install.sh | bash";

const COLUMNS: { title: string; links: [string, string][] }[] = [
  {
    title: "Product",
    links: [
      ["AI Employees", "/products/ai-employees"],
      ["Workspace", "/products/workspace"],
      ["Revenue", "/products/revenue"],
      ["Finance", "/products/finance"],
      ["Repositories", "/products/repositories"],
      ["All products", "/products"],
    ],
  },
  {
    title: "Roles",
    links: [
      ["AI SDR", "/roles/sdr"],
      ["AI Support Rep", "/roles/support"],
      ["AI Bookkeeper", "/roles/bookkeeper"],
      ["AI Engineer", "/roles/engineer"],
      ["AI Executive Assistant", "/roles/executive-assistant"],
      ["All roles", "/roles"],
    ],
  },
  {
    title: "Resources",
    links: [
      ["Documentation", "/docs"],
      ["Install guide", INSTALL_DOCS_PATH],
      ["Self-hosting", "/docs/self-hosting"],
      ["Kubernetes", "/docs/kubernetes"],
      ["CLI reference", "/docs/cli"],
      ["Vocabulary", "/docs/vocabulary"],
    ],
  },
  {
    title: "Company",
    links: [
      ["GitHub", GITHUB_URL],
      ["Releases", `${GITHUB_URL}/releases`],
      ["Issues", `${GITHUB_URL}/issues`],
      ["Contributing", `${GITHUB_URL}/blob/main/CONTRIBUTING.md`],
      ["Apache 2.0 license", `${GITHUB_URL}/blob/main/LICENSE`],
      ["install.sh", "/install.sh"],
    ],
  },
];

/**
 * The closing band on every marketing page: the night, once more, with the
 * way in.
 */
export function ClosingCta({
  title,
  lede = "Hire one AI Employee, give it one Routine, and read what it did in the morning. The whole product installs on your own hardware with one command, free for everyone.",
}: {
  title?: ReactNode;
  lede?: ReactNode;
}) {
  return (
    <div className="pb-2 pt-10 sm:pt-14">
      <NightPanel id="get-started" dawn={1}>
        <div className="mx-auto max-w-site px-5 py-20 text-center sm:px-8 sm:py-28 lg:px-12 lg:py-32">
          <p className="kicker inline-flex items-center gap-3 text-night-muted">
            <span aria-hidden className="h-px w-6 bg-white/50" />
            Get started
            <span aria-hidden className="h-px w-6 bg-white/50" />
          </p>
          <h2 className="mx-auto mt-7 max-w-[16ch] text-balance font-display text-display-xl text-white">
            {title ?? (
              <>
                Give tomorrow a head start.
              </>
            )}
          </h2>
          <p className="mx-auto mt-7 max-w-[46ch] text-pretty text-[1.0625rem] leading-[1.6] text-night-muted sm:text-[1.1875rem]">
            {lede}
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <Button href={INSTALL_DOCS_PATH} variant="paper" size="lg" arrow>
              Install Genosyn
            </Button>
            <Button href={GITHUB_URL} external variant="outline-night" size="lg">
              Read the source
            </Button>
          </div>
          <CopyCommand command={INSTALL_COMMAND} night className="mx-auto mt-5 max-w-[32rem] text-left" />
          <div className="mt-8 flex flex-wrap items-center justify-center gap-x-8 gap-y-3">
            <TextLink href="/docs/self-hosting" night>
              Self-hosting guide
            </TextLink>
            <TextLink href="/docs/kubernetes" night>
              Run it on Kubernetes
            </TextLink>
          </div>
        </div>
      </NightPanel>
    </div>
  );
}

export function Footer() {
  return (
    <footer className="relative overflow-hidden bg-paper">
      <Container className="pt-16 sm:pt-20">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,2fr)] lg:gap-16">
          <div className="max-w-sm">
            <Link href="/" aria-label="Genosyn home" className="inline-block text-ink transition-opacity hover:opacity-70">
              <Logo className="text-[15px]" />
            </Link>
            <p className="mt-6 max-w-[26ch] text-[1.2rem] font-medium leading-[1.4] tracking-[-0.015em] text-ink">
              The open-source workplace for AI Employees and the people they work for.
            </p>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="group mt-7 inline-flex items-center gap-2 rounded-full border border-line-strong px-4 py-2 text-[13px] font-medium text-ink transition-colors hover:bg-paper-raised"
            >
              <Github aria-hidden className="h-4 w-4" />
              Star Genosyn on GitHub
              <span className="sr-only">{"(opens in a new tab)"}</span>
            </a>
          </div>

          <div className="grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-4">
            {COLUMNS.map((column) => (
              <nav key={column.title} aria-label={column.title}>
                <p className="kicker text-ink-400">{column.title}</p>
                <ul className="mt-5 space-y-3">
                  {column.links.map(([label, href]) => (
                    <li key={href}>
                      <FooterLink href={href}>{label}</FooterLink>
                    </li>
                  ))}
                </ul>
              </nav>
            ))}
          </div>
        </div>

        <div className="mt-16 flex flex-col gap-4 border-t border-line py-7 text-[12.5px] leading-6 text-ink-500 sm:flex-row sm:items-start sm:justify-between">
          <p className="max-w-[62ch]">
            {`© ${__BUILD_YEAR__} HackerBay, Inc. Genosyn is open source under Apache 2.0 and provided without warranty. Some of it, and some of this site, was written with AI assistance — the source is public so you can check.`}
          </p>
          <p className="shrink-0 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-400">
            {`Genosyn v${__APP_VERSION__}`}
          </p>
        </div>
      </Container>

      {/* The wordmark, set large and cropped by the page edge. */}
      <div aria-hidden className="pointer-events-none select-none overflow-hidden">
        <p className="-mb-[0.24em] text-center font-display text-[21vw] leading-[0.8] tracking-[-0.055em] text-ink/[0.07]">
          Genosyn
        </p>
      </div>
    </footer>
  );
}

function FooterLink({ href, children }: { href: string; children: ReactNode }) {
  const className = "text-[14px] text-ink-600 transition-colors duration-150 hover:text-ink";
  if (href.startsWith("http")) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={className}>
        {children}
        <span className="sr-only">{"(opens in a new tab)"}</span>
      </a>
    );
  }
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}
