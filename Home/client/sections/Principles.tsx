type Rule = {
  number: string;
  title: string;
  body: string;
  rule: string;
};

const RULES: Rule[] = [
  {
    number: "i",
    title: "One database, one source of truth.",
    body: "Souls, skills, routines, and run logs all live on database rows. Back it up with one command. Restore it with another. Migrate SQLite → Postgres without losing a line. There is no second store, no cache to drift, no S3 bucket to forget.",
    rule: "if it can fit in one place, it does.",
  },
  {
    number: "ii",
    title: "Scheduled, not chatty.",
    body: "Routines on a cron beat another bot in another channel. Kick off the work at 7am. Read what shipped at 9. The roster goes quiet between runs. Nobody is trying to start a conversation. Nobody is asking how it can help today.",
    rule: "the loudest tool in the room is wrong.",
  },
  {
    number: "iii",
    title: "Your server, your keys.",
    body: "SQLite on a laptop. Postgres in prod. The model credentials you already pay for. No vendor lock, no usage metering, no sales call to expand seats. The whole runtime fits in one Docker container on hardware you control.",
    rule: "the company is yours. so is the runtime.",
  },
  {
    number: "iv",
    title: "Markdown all the way down.",
    body: "Soul, skills, routines, briefs, run logs — every document an employee touches is plain text you can read, edit, diff, and grep. No proprietary format. No prompt console. If you can write in Notion, you can run an employee.",
    rule: "if it cannot be diffed, it cannot be trusted.",
  },
];

export function Principles() {
  return (
    <section id="house-rules" className="border-b border-ink bg-bone">
      <div className="mx-auto max-w-[1200px] px-6 pt-20 pb-20 sm:pb-24">
        <div className="grid items-end gap-10 md:grid-cols-[minmax(0,1fr)_minmax(0,2.4fr)]">
          <div className="flex items-baseline gap-4 font-mono text-[11px] uppercase tracking-[0.22em] text-ink-soft">
            <span className="text-ink">§ 06</span>
            <span className="text-ink-mute">/</span>
            <span>house rules</span>
          </div>
          <div>
            <h2 className="text-[clamp(2rem,4.4vw,3.5rem)] font-medium leading-[1] tracking-[-0.025em] text-ink">
              The four
              <span className="serif-italic text-accent"> we won&apos;t budge on.</span>
            </h2>
            <p className="mt-6 max-w-2xl text-lg leading-[1.55] text-ink-soft">
              Genosyn is opinionated on purpose. These are the calls we made
              early, kept through every refactor, and will fight to keep when
              someone proposes a fifth option.
            </p>
          </div>
        </div>

        <ol className="mt-14 grid grid-cols-1 gap-0 border-t border-ink lg:grid-cols-2">
          {RULES.map((r, i) => (
            <li
              key={r.title}
              className={`flex flex-col gap-5 border-b border-ink px-0 py-10 lg:px-10 ${
                i % 2 === 0 ? "lg:border-r lg:border-ink" : ""
              }`}
            >
              <div className="flex items-baseline gap-4">
                <span className="serif-italic text-[3.5rem] leading-none text-accent">
                  {r.number}.
                </span>
                <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-ink-soft">
                  rule {String(i + 1).padStart(2, "0")}
                </span>
              </div>
              <h3 className="font-serif text-[clamp(1.6rem,2.6vw,2.25rem)] leading-[1.1] text-ink">
                {r.title}
              </h3>
              <p className="max-w-xl text-base leading-[1.65] text-ink-soft">{r.body}</p>
              <blockquote className="mt-2 border-l-2 border-accent pl-4 font-serif text-lg italic text-ink">
                &ldquo;{r.rule}&rdquo;
              </blockquote>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
