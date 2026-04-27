import { GITHUB_URL } from "@/lib/constants";

type LogLine = {
  ts: string;
  src: string;
  body: string;
  tone?: "ok" | "warn" | "info" | "muted";
};

const LOG_LINES: LogLine[] = [
  { ts: "07:00", src: "mira-finance", body: "wake. routine=close-the-books", tone: "info" },
  { ts: "07:00", src: "mira-finance", body: "pulled 42 stripe charges, 0 anomalies", tone: "muted" },
  { ts: "07:01", src: "mira-finance", body: "shipped → #finance · sleep until tomorrow", tone: "ok" },
  { ts: "08:30", src: "alex-brand", body: "wake. routine=morning-brief", tone: "info" },
  { ts: "08:31", src: "alex-brand", body: "drafted 3 talking points from overnight news", tone: "muted" },
  { ts: "08:32", src: "alex-brand", body: "shipped → docs/brief-2026-04-28.md", tone: "ok" },
  { ts: "10:17", src: "sam-sre", body: "alert: p99 /checkout 940ms (threshold 600ms)", tone: "warn" },
  { ts: "10:17", src: "sam-sre", body: "paged #oncall · attaching trace…", tone: "muted" },
];

export function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-ink">
      <div className="mx-auto max-w-[1200px] px-6 pt-12 pb-16 sm:pt-16 sm:pb-24 lg:pt-20">
        <Dateline />

        <div className="mt-10 grid items-end gap-12 lg:mt-14 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)] lg:gap-16">
          <div>
            <h1 className="font-sans text-[clamp(2.6rem,7.4vw,5.75rem)] font-medium leading-[0.94] tracking-[-0.03em] text-ink">
              Run a company
              <br />
              <span className="serif-italic text-[1.05em] tracking-[-0.025em] text-accent">
                autonomously
              </span>
              <span className="text-accent">.</span>
            </h1>

            <p className="mt-8 max-w-xl text-lg leading-[1.55] text-ink-soft">
              Genosyn is a self-hostable runtime for hiring AI employees. Each one
              has a written <em className="serif-italic not-italic font-medium text-ink">Soul</em>,
              a small set of <em className="serif-italic not-italic font-medium text-ink">Skills</em>,
              and <em className="serif-italic not-italic font-medium text-ink">Routines</em> on a
              cron. They wake up, do their job, log what they shipped — and go quiet.
            </p>

            <div className="mt-10 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
              <a
                href="#quickstart"
                className="inline-flex items-center gap-3 border border-ink bg-ink px-5 py-3 font-mono text-[12px] uppercase tracking-[0.16em] text-bone-page transition hover:bg-accent hover:border-accent"
              >
                <span aria-hidden>↘</span>
                install in 30 seconds
              </a>
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 border-b border-ink pb-1 font-mono text-[12px] uppercase tracking-[0.16em] text-ink hover:text-accent hover:border-accent"
              >
                read the source <span aria-hidden>→</span>
              </a>
            </div>

            <dl className="mt-14 grid max-w-xl grid-cols-3 gap-x-6 gap-y-2 border-t border-ink pt-5 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-mute">
              <DefnPair label="license" value="mit" />
              <DefnPair label="store" value="sqlite → pg" />
              <DefnPair label="install" value="one command" />
            </dl>
          </div>

          <RunLog />
        </div>
      </div>
    </section>
  );
}

function Dateline() {
  return (
    <div className="flex items-center justify-between border-t border-ink pt-3 font-mono text-[11px] uppercase tracking-[0.22em] text-ink-soft">
      <div className="flex items-center gap-3">
        <span className="text-ink">Genosyn</span>
        <span aria-hidden className="text-ink-mute">·</span>
        <span>vol. zero</span>
        <span aria-hidden className="text-ink-mute">·</span>
        <span>apr 2026</span>
      </div>
      <div className="hidden items-center gap-3 sm:flex">
        <span className="hidden md:inline">a self-hosted runtime for ai employees</span>
        <span aria-hidden className="text-ink-mute">·</span>
        <span>v0.2.0</span>
      </div>
      <span className="font-mono text-[11px] tracking-[0.22em] sm:hidden">v0.2.0</span>
    </div>
  );
}

function DefnPair({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-ink-mute">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}

function RunLog() {
  return (
    <figure className="mx-auto w-full">
      <figcaption className="flex items-center justify-between border-b border-ink pb-2 font-mono text-[10px] uppercase tracking-[0.22em] text-ink-soft">
        <span>data/runs/today.log</span>
        <span className="flex items-center gap-1.5 text-accent">
          <span className="block h-1.5 w-1.5 rounded-full bg-accent" />
          live
        </span>
      </figcaption>
      <div className="border border-ink bg-ink/95 px-5 py-5 font-mono text-[12.5px] leading-[1.7] text-bone-card">
        {LOG_LINES.map((l, i) => (
          <LogRow key={i} line={l} />
        ))}
        <div className="mt-2 flex items-center gap-2 text-bone-card/50">
          <span aria-hidden>·</span>
          <span className="tabular">10:18</span>
          <span className="opacity-60">…tail -f</span>
          <BlinkCursor />
        </div>
      </div>
    </figure>
  );
}

function LogRow({ line }: { line: LogLine }) {
  const tone =
    line.tone === "warn"
      ? "text-amber-200"
      : line.tone === "ok"
      ? "text-emerald-300"
      : line.tone === "muted"
      ? "text-bone-card/65"
      : "text-bone-card";
  return (
    <div className="flex items-baseline gap-3">
      <span className="tabular shrink-0 text-bone-card/45">{line.ts}</span>
      <span className="shrink-0 text-bone-card/55">{line.src.padEnd(13, " ")}</span>
      <span className={tone}>{line.body}</span>
    </div>
  );
}

function BlinkCursor() {
  return (
    <span
      aria-hidden
      className="animate-blink inline-block h-3 w-1.5 translate-y-[1px] bg-accent"
    />
  );
}
