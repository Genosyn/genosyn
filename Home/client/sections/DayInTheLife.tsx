type Entry = {
  ts: string;
  who: string;
  routine: string;
  output: string;
  status: "shipped" | "running" | "queued";
};

const ENTRIES: Entry[] = [
  {
    ts: "06:59:58",
    who: "mira-finance",
    routine: "close-the-books",
    output: "wake. last run +24h",
    status: "shipped",
  },
  {
    ts: "07:00:14",
    who: "mira-finance",
    routine: "close-the-books",
    output: "stripe → 42 charges, 0 anomalies, $18,420.00 settled",
    status: "shipped",
  },
  {
    ts: "08:30:01",
    who: "alex-brand",
    routine: "morning-brief",
    output: "wake. routine triggered by cron 30 8 * * 1-5",
    status: "shipped",
  },
  {
    ts: "08:31:47",
    who: "alex-brand",
    routine: "morning-brief",
    output: "drafted 3 talking points → docs/brief-2026-04-28.md",
    status: "shipped",
  },
  {
    ts: "10:17:22",
    who: "sam-sre",
    routine: "watch-p99",
    output: "alert: p99 /checkout 940ms (threshold 600ms)",
    status: "running",
  },
  {
    ts: "10:17:23",
    who: "sam-sre",
    routine: "watch-p99",
    output: "paged #oncall · attaching trace abc123…",
    status: "running",
  },
  {
    ts: "14:00:00",
    who: "alex-brand",
    routine: "docs-freshness",
    output: "queued · waiting on slot",
    status: "queued",
  },
  {
    ts: "17:00:00",
    who: "alex-brand",
    routine: "weekly-digest",
    output: "scheduled · fires friday 17:00",
    status: "queued",
  },
];

export function DayInTheLife() {
  return (
    <section id="day" className="border-b border-ink bg-bone">
      <div className="mx-auto max-w-[1200px] px-6 pt-20 pb-20 sm:pb-24">
        <div className="grid items-end gap-10 md:grid-cols-[minmax(0,1fr)_minmax(0,2.4fr)]">
          <div className="flex items-baseline gap-4 font-mono text-[11px] uppercase tracking-[0.22em] text-ink-soft">
            <span className="text-ink">§ 02</span>
            <span className="text-ink-mute">/</span>
            <span>a typical tuesday</span>
          </div>
          <div>
            <h2 className="text-[clamp(2rem,4.4vw,3.5rem)] font-medium leading-[1] tracking-[-0.025em] text-ink">
              Scheduled, not chatty.
              <br />
              <span className="serif-italic text-accent">Quiet until something needs you.</span>
            </h2>
            <p className="mt-6 max-w-2xl text-lg leading-[1.55] text-ink-soft">
              Your roster works on crons. You see what ran, what shipped, what is
              queued. Open the log when you want to know what happened. Close it
              when you don&apos;t.
            </p>
          </div>
        </div>

        <figure className="mt-12">
          <figcaption className="flex flex-wrap items-center justify-between gap-3 border-b border-ink pb-2 font-mono text-[10px] uppercase tracking-[0.22em] text-ink-soft">
            <div className="flex items-center gap-3">
              <span className="text-ink">$ tail -f data/runs/today.log</span>
              <span aria-hidden className="text-ink-mute">·</span>
              <span>tue · apr 28 · 2026</span>
            </div>
            <div className="flex items-center gap-2 text-accent">
              <span className="block h-1.5 w-1.5 rounded-full bg-accent" />
              <span>3 employees on duty</span>
            </div>
          </figcaption>

          <div className="border border-ink bg-ink/95 font-mono text-[12.5px] text-bone-card">
            <div className="hidden grid-cols-[100px_minmax(0,1fr)_minmax(0,1fr)_minmax(0,2.5fr)_70px] gap-3 border-b border-bone-card/15 px-5 py-2 text-[10px] uppercase tracking-[0.18em] text-bone-card/55 md:grid">
              <span>time</span>
              <span>employee</span>
              <span>routine</span>
              <span>line</span>
              <span className="text-right">state</span>
            </div>
            {ENTRIES.map((e, i) => (
              <Row key={i} entry={e} last={i === ENTRIES.length - 1} />
            ))}
            <div className="flex items-center gap-2 border-t border-bone-card/10 px-5 py-3 text-bone-card/55">
              <span className="tabular">17:00:01</span>
              <span aria-hidden>·</span>
              <span className="opacity-75">…tail -f</span>
              <span aria-hidden className="animate-blink inline-block h-3 w-1.5 translate-y-[1px] bg-accent" />
            </div>
          </div>
        </figure>
      </div>
    </section>
  );
}

function Row({ entry, last }: { entry: Entry; last: boolean }) {
  const stateColor =
    entry.status === "shipped"
      ? "text-emerald-300"
      : entry.status === "running"
      ? "text-amber-200"
      : "text-bone-card/55";
  const lineColor =
    entry.status === "queued" ? "text-bone-card/55" : "text-bone-card";
  return (
    <div
      className={`grid grid-cols-[80px_minmax(0,1fr)] gap-3 px-5 py-2 md:grid-cols-[100px_minmax(0,1fr)_minmax(0,1fr)_minmax(0,2.5fr)_70px] ${
        last ? "" : "border-b border-bone-card/10"
      }`}
    >
      <span className="tabular text-bone-card/45">{entry.ts}</span>
      <div className="flex flex-col gap-0.5 md:hidden">
        <div className="flex items-center gap-2">
          <span className="text-bone-card/85">{entry.who}</span>
          <span aria-hidden className="text-bone-card/30">·</span>
          <span className="text-accent">{entry.routine}</span>
        </div>
        <div className={`${lineColor} truncate`}>{entry.output}</div>
        <div className={`text-[10px] uppercase tracking-[0.16em] ${stateColor}`}>
          {entry.status}
        </div>
      </div>
      <span className="hidden truncate text-bone-card/85 md:inline">{entry.who}</span>
      <span className="hidden truncate text-accent md:inline">{entry.routine}</span>
      <span className={`hidden truncate md:inline ${lineColor}`}>{entry.output}</span>
      <span
        className={`hidden text-right text-[10px] uppercase tracking-[0.18em] md:inline ${stateColor}`}
      >
        {entry.status}
      </span>
    </div>
  );
}
