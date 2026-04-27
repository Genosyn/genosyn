import { GITHUB_URL, ROADMAP_URL } from "@/lib/constants";
import { Logo } from "@/components/Logo";

const ISSUES_URL = `${GITHUB_URL}/issues`;

export function Footer() {
  return (
    <footer className="bg-bone-page text-ink">
      <div className="border-b border-ink bg-ink text-bone-card">
        <div className="mx-auto max-w-[1200px] px-6 py-20 sm:py-24">
          <div className="grid items-end gap-10 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] md:gap-16">
            <div>
              <div className="flex items-baseline gap-4 font-mono text-[11px] uppercase tracking-[0.22em] text-bone-card/55">
                <span className="text-bone-card">colophon</span>
                <span className="text-bone-card/30">/</span>
                <span>open the door</span>
              </div>
              <h2 className="mt-6 text-[clamp(2.4rem,6vw,5rem)] font-medium leading-[0.96] tracking-[-0.03em] text-bone-card">
                Meet your first
                <br />
                <span className="serif-italic text-accent">AI employee.</span>
              </h2>
              <p className="mt-6 max-w-lg text-lg leading-[1.55] text-bone-card/75">
                One command pulls the image and starts Genosyn on{" "}
                <code className="font-mono text-amber-200">localhost:8471</code>.
                Write their Soul. Schedule their first routine. Read what they shipped.
              </p>
            </div>
            <div className="flex flex-col items-start gap-3 md:items-end">
              <pre className="w-full overflow-x-auto border border-bone-card/20 bg-bone-card/[0.04] px-4 py-3 font-mono text-[13px] leading-[1.6] text-bone-card md:max-w-md">
                <code>
                  <span className="text-bone-card/45">$ </span>
                  curl -fsSL{" "}
                  <span className="text-amber-200">genosyn.com/install.sh</span> | bash
                </code>
              </pre>
              <div className="flex w-full flex-wrap gap-3 md:justify-end">
                <a
                  href={GITHUB_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 border border-bone-card bg-bone-card px-5 py-3 font-mono text-[12px] uppercase tracking-[0.16em] text-ink transition hover:bg-accent hover:border-accent hover:text-bone-card"
                >
                  <span aria-hidden>↘</span>
                  view on github
                </a>
                <a
                  href={ROADMAP_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 border border-bone-card/40 px-5 py-3 font-mono text-[12px] uppercase tracking-[0.16em] text-bone-card transition hover:border-accent hover:text-accent"
                >
                  read the roadmap
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-[1200px] px-6 py-10">
        <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3 text-ink">
            <Logo className="h-5 w-auto" />
            <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-ink-soft">
              © {new Date().getFullYear()} HackerBay, Inc. · built in the open
            </span>
          </div>
          <nav className="flex flex-wrap items-center gap-6 font-mono text-[11px] uppercase tracking-[0.22em] text-ink-soft">
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="hover:text-accent">
              github
            </a>
            <a href={ROADMAP_URL} target="_blank" rel="noreferrer" className="hover:text-accent">
              roadmap
            </a>
            <a href={ISSUES_URL} target="_blank" rel="noreferrer" className="hover:text-accent">
              issues
            </a>
            <a href="/install.sh" className="hover:text-accent">
              install.sh
            </a>
            <span className="tabular text-ink-mute">v0.2.0</span>
          </nav>
        </div>
        <p className="mt-6 max-w-3xl font-mono text-[11px] leading-[1.7] text-ink-mute">
          disclaimer · this software is vibecoded. open source, MIT licensed,
          provided without warranty of any kind. read the script before piping
          it. run it on hardware you control. do not put a brand-new AI
          employee in charge of payroll on a tuesday.
        </p>
      </div>
    </footer>
  );
}
