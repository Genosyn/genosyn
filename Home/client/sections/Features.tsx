type Spec = {
  field: string;
  value: string;
  note: string;
};

const SPECS: Spec[] = [
  {
    field: "language",
    value: "TypeScript, end to end",
    note: "App and home are React + Express + TypeORM. No JS files, no transpile-only deps.",
  },
  {
    field: "database",
    value: "SQLite today, Postgres tomorrow",
    note: "One config flag. Same entities, same migrations, same queries — pick the driver that fits your scale.",
  },
  {
    field: "auth",
    value: "bcrypt + cookie-session",
    note: "No JWT. No Auth0. No third-party identity vendor with your members in their database.",
  },
  {
    field: "ai brain",
    value: "claude-code · codex · opencode",
    note: "Bring your own keys. Assign a model per employee or per routine. Costs land on the provider's invoice.",
  },
  {
    field: "scheduler",
    value: "node-cron",
    note: "Standard cron expressions. Routines fire in-process, write a Run row, and exit. No queue, no broker.",
  },
  {
    field: "data on disk",
    value: "./data/",
    note: "One folder. App.sqlite, employee credentials, run artifacts. Tar it up — that is your backup.",
  },
  {
    field: "deployment",
    value: "one Docker container",
    note: "8471/tcp. A volume. Nothing else to wire up. The CLI manages the lifecycle on the operator's host.",
  },
  {
    field: "license",
    value: "MIT",
    note: "Read it, fork it, run it on your own iron. No CLA, no premium tier hidden behind a feature flag.",
  },
];

export function Features() {
  return (
    <section id="platform" className="border-b border-ink bg-bone-page">
      <div className="mx-auto max-w-[1200px] px-6 pt-20 pb-20 sm:pb-24">
        <div className="grid items-end gap-10 md:grid-cols-[minmax(0,1fr)_minmax(0,2.4fr)]">
          <div className="flex items-baseline gap-4 font-mono text-[11px] uppercase tracking-[0.22em] text-ink-soft">
            <span className="text-ink">§ 03</span>
            <span className="text-ink-mute">/</span>
            <span>the platform</span>
          </div>
          <div>
            <h2 className="text-[clamp(2rem,4.4vw,3.5rem)] font-medium leading-[1] tracking-[-0.025em] text-ink">
              No surprises in the spec sheet.
              <br />
              <span className="serif-italic text-accent">No vendor in the critical path.</span>
            </h2>
            <p className="mt-6 max-w-2xl text-lg leading-[1.55] text-ink-soft">
              We picked one option for every load-bearing decision. Here&apos;s the
              full bill of materials. No marketing tier required to read it.
            </p>
          </div>
        </div>

        <div className="mt-12 border-t border-ink">
          {SPECS.map((s, i) => (
            <SpecRow key={s.field} spec={s} index={i} />
          ))}
        </div>
      </div>
    </section>
  );
}

function SpecRow({ spec, index }: { spec: Spec; index: number }) {
  return (
    <div className="grid grid-cols-1 gap-2 border-b border-ink/15 px-0 py-6 transition hover:bg-bone md:grid-cols-[80px_minmax(0,1fr)_minmax(0,1.4fr)] md:gap-8">
      <div className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.22em] text-ink-soft md:flex-col md:items-start md:gap-1">
        <span className="tabular text-ink-mute">
          {String(index + 1).padStart(2, "0")}
        </span>
        <span>{spec.field}</span>
      </div>
      <div className="font-serif text-2xl leading-[1.15] text-ink md:text-3xl">
        {spec.value}
      </div>
      <p className="max-w-xl text-base leading-[1.6] text-ink-soft">{spec.note}</p>
    </div>
  );
}
