import { useEffect, useRef, useState } from "react";
import { Boxes, Cpu, Github, HardDrive, RefreshCw, type LucideIcon } from "lucide-react";
import { GITHUB_URL, INSTALL_DOCS_PATH } from "@/lib/constants";
import { Button, Container, Section, SectionHead, TextLink } from "@/sections/Kit";

const INSTALL_COMMAND = "curl -fsSL https://genosyn.com/install.sh | bash";

type Line = { kind: "cmd" | "step" | "done" | "quiet"; text: string; gap?: boolean };

/** The installer's own output, on a host where Docker is already running. */
const TRANSCRIPT: Line[] = [
  { kind: "cmd", text: INSTALL_COMMAND },
  { kind: "step", text: "Downloading genosyn CLI from https://genosyn.com/genosyn" },
  { kind: "done", text: "Installed genosyn CLI." },
  { kind: "step", text: "Pulling ghcr.io/genosyn/app:latest" },
  { kind: "step", text: "Starting 'genosyn' on port 8471" },
  { kind: "done", text: "Genosyn is running." },
  { kind: "quiet", text: "Updates automatic, daily at 03:17 local time" },
  { kind: "quiet", text: "Open     http://localhost:8471", gap: true },
  { kind: "quiet", text: "Logs     genosyn logs -f" },
  { kind: "quiet", text: "Upgrade  genosyn upgrade" },
];

const FACTS: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: Github,
    title: "Apache 2.0",
    body: "Read every line, fork it, and run five hundred AI Employees. Every product and Integration ships in the one release.",
  },
  {
    icon: HardDrive,
    title: "One container, one volume",
    body: "The database, every Soul, Skill, Routine and Run, and the encrypted credentials live in one Docker volume on your disk.",
  },
  {
    icon: Cpu,
    title: "Your model, your keys",
    body: "Anthropic, OpenAI, or any OpenAI-compatible endpoint — Ollama, vLLM, llama.cpp. Tokens are billed by your provider, never by us.",
  },
  {
    icon: RefreshCw,
    title: "Upgrades itself at 03:17",
    body: "The CLI upgrades nightly and keeps the old container until the new one answers. Kubernetes gets an official Helm chart.",
  },
];

export function OpenSource() {
  return (
    <Section id="open-source" space="md">
      <Container>
        <div className="grid items-start gap-14 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:gap-16">
          <div className="min-w-0">
            <SectionHead
              align="left"
              kicker="Open source"
              title={
                <>
                  Yours to run, on your own hardware.
                </>
              }
              lede="One command installs the whole platform on any machine with Docker. It sends no telemetry, and everyone gets the same software under the same licence, free."
            />
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Button href={INSTALL_DOCS_PATH} variant="ink" arrow>
                Read the install guide
              </Button>
              <Button href={GITHUB_URL} external variant="outline">
                <Github aria-hidden className="h-4 w-4" />
                View on GitHub
              </Button>
            </div>
          </div>

          <Terminal />
        </div>

        <ul className="mt-16 grid gap-px overflow-hidden rounded-3xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
          {FACTS.map((fact) => (
            <li key={fact.title} className="bg-paper-raised p-6">
              <fact.icon aria-hidden className="h-5 w-5 text-ink" strokeWidth={1.6} />
              <p className="mt-5 text-[15.5px] font-medium text-ink">{fact.title}</p>
              <p className="mt-2 text-[14px] leading-6 text-ink-600">{fact.body}</p>
            </li>
          ))}
        </ul>

        <div className="mt-8 flex flex-wrap items-center gap-x-8 gap-y-3">
          <TextLink href="/docs/self-hosting">Where the data lives</TextLink>
          <TextLink href="/docs/kubernetes">Kubernetes and Helm</TextLink>
          <TextLink href="/docs/cli">Every genosyn command</TextLink>
        </div>
      </Container>
    </Section>
  );
}

/**
 * The install transcript, typed out when it scrolls into view. The full text
 * is in the prerendered markup; the animation only hides and reveals it.
 */
function Terminal() {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(TRANSCRIPT.length);
  const [typed, setTyped] = useState(INSTALL_COMMAND.length);

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        setShown(0);
        setTyped(0);
        let t = 250;
        for (let i = 1; i <= INSTALL_COMMAND.length; i++) {
          timers.push(setTimeout(() => setTyped(i), t));
          t += 22;
        }
        t += 350;
        for (let line = 1; line <= TRANSCRIPT.length; line++) {
          timers.push(setTimeout(() => setShown(line), t));
          t += TRANSCRIPT[line - 1]?.kind === "step" ? 520 : 160;
        }
      },
      { threshold: 0.4 },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      timers.forEach(clearTimeout);
    };
  }, []);

  return (
    <div ref={ref} className="relative isolate min-w-0">
      <div aria-hidden className="absolute -inset-2 -z-10 rounded-[2rem] bg-ink/[0.04] sm:-inset-5" />
      <div className="overflow-hidden rounded-[1.4rem] border border-black bg-night shadow-lifted">
        <div className="flex items-center gap-3 border-b border-white/[0.08] px-4 py-3">
          <span className="flex gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
            <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
            <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
          </span>
          <span className="mx-auto flex items-center gap-2 font-mono text-[11px] text-night-faint">
            <Boxes aria-hidden className="h-3.5 w-3.5" />
            genosyn install
          </span>
          <span className="w-10" />
        </div>
        <div className="scrollbar-none overflow-x-auto px-5 py-5 font-mono text-[12px] leading-[1.9] sm:px-6 sm:text-[12.5px]">
          <div className="min-w-max">
            {TRANSCRIPT.map((line, index) => {
              const visible = index === 0 || index < shown;
              const text = index === 0 ? line.text.slice(0, typed) : line.text;
              return (
                <div
                  key={line.text}
                  className={`${line.gap ? "mt-4" : ""} ${visible ? "" : "invisible"} ${
                    line.kind === "done" ? "text-white" : line.kind === "cmd" ? "text-white" : "text-night-muted"
                  }`}
                >
                  {line.kind === "cmd" && <span className="mr-2 text-white/35">$</span>}
                  {line.kind === "step" && <span className="mr-2 text-white/35">→</span>}
                  {line.kind === "done" && <span className="mr-2 text-moss-400">✓</span>}
                  {text}
                  {index === 0 && typed < INSTALL_COMMAND.length && (
                    <span aria-hidden className="ml-0.5 inline-block h-[1.05em] w-[0.55em] animate-blink bg-white/80 align-[-0.15em]" />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
