import { type ReactNode } from "react";

export function Primitives() {
  return (
    <section id="primitives" className="border-b border-ink bg-bone-page">
      <SectionHeader
        index="§ 01"
        kicker="primitives"
        title={
          <>
            Three things an employee needs.
            <br />
            <span className="serif-italic text-accent">All of them, in markdown.</span>
          </>
        }
        body="Soul says who they are. Skills describe what they know. Routines are when they work. The whole employee fits in three editable text fields — no opaque prompt, no hidden config."
      />

      <div className="border-t border-ink">
        <PrimitiveRow
          number="01"
          name="Soul"
          tag="constitution"
          headline="A constitution, not a prompt."
          body="One document the whole roster lives by — values, voice, what the employee will refuse. Edit it like you would a job description. There is no other prompt."
          artifact={<SoulArtifact />}
        />
        <PrimitiveRow
          number="02"
          name="Skills"
          tag="playbooks"
          headline="Reusable playbooks."
          body="A skill is a markdown file the employee reads when its name comes up. Compose them across employees, share them between teams, version them in git."
          artifact={<SkillsArtifact />}
          flip
        />
        <PrimitiveRow
          number="03"
          name="Routines"
          tag="cron"
          headline="Work, on a cron."
          body="A routine is a brief plus a schedule. Genosyn fires it on time, captures every word the employee said, and writes the output to a Run log you can read line by line."
          artifact={<RoutinesArtifact />}
        />
      </div>
    </section>
  );
}

function SectionHeader({
  index,
  kicker,
  title,
  body,
}: {
  index: string;
  kicker: string;
  title: ReactNode;
  body: string;
}) {
  return (
    <div className="mx-auto max-w-[1200px] px-6 pt-20 pb-14">
      <div className="grid items-end gap-10 md:grid-cols-[minmax(0,1fr)_minmax(0,2.4fr)]">
        <div className="flex items-baseline gap-4 font-mono text-[11px] uppercase tracking-[0.22em] text-ink-soft">
          <span className="text-ink">{index}</span>
          <span className="text-ink-mute">/</span>
          <span>{kicker}</span>
        </div>
        <div>
          <h2 className="text-[clamp(2rem,4.4vw,3.5rem)] font-medium leading-[1] tracking-[-0.025em] text-ink">
            {title}
          </h2>
          <p className="mt-6 max-w-2xl text-lg leading-[1.55] text-ink-soft">{body}</p>
        </div>
      </div>
    </div>
  );
}

function PrimitiveRow({
  number,
  name,
  tag,
  headline,
  body,
  artifact,
  flip,
}: {
  number: string;
  name: string;
  tag: string;
  headline: string;
  body: string;
  artifact: ReactNode;
  flip?: boolean;
}) {
  return (
    <article className="border-b border-ink last:border-b-0">
      <div className="mx-auto grid max-w-[1200px] grid-cols-1 gap-10 px-6 py-16 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] md:gap-14 md:py-20">
        <div className={flip ? "md:order-2" : undefined}>
          <div className="flex items-baseline gap-3 font-mono text-[11px] uppercase tracking-[0.22em] text-accent">
            <span className="tabular text-[40px] font-normal leading-none text-ink">
              {number}
            </span>
            <span className="text-ink">/ {name}</span>
            <span aria-hidden className="text-ink-mute">·</span>
            <span className="text-ink-soft">{tag}</span>
          </div>
          <h3 className="mt-6 max-w-md font-serif text-[clamp(1.75rem,3vw,2.5rem)] leading-[1.05] text-ink">
            {headline}
          </h3>
          <p className="mt-4 max-w-md text-base leading-[1.65] text-ink-soft">{body}</p>
        </div>
        <div className={flip ? "md:order-1" : undefined}>{artifact}</div>
      </div>
    </article>
  );
}

function ArtifactFrame({
  filename,
  children,
  light,
}: {
  filename: string;
  children: ReactNode;
  light?: boolean;
}) {
  return (
    <figure className="w-full">
      <figcaption className="flex items-center justify-between border-b border-ink pb-2 font-mono text-[10px] uppercase tracking-[0.22em] text-ink-soft">
        <span>{filename}</span>
        <span className="text-ink-mute">markdown</span>
      </figcaption>
      <div
        className={
          light
            ? "border border-ink bg-bone-card px-5 py-5 font-mono text-[12.5px] leading-[1.7]"
            : "border border-ink bg-ink px-5 py-5 font-mono text-[12.5px] leading-[1.7] text-bone-card"
        }
      >
        {children}
      </div>
    </figure>
  );
}

function SoulArtifact() {
  return (
    <ArtifactFrame filename="alex-brand · soul.md" light>
      <div className="text-ink">
        <span className="text-accent"># </span>Alex Brand
      </div>
      <div className="text-ink-soft">Senior brand writer. Late-thirties energy. Reads the room.</div>
      <div className="mt-3 text-ink">
        <span className="text-accent">## </span>Voice
      </div>
      <div className="text-ink-soft">- Concrete over clever.</div>
      <div className="text-ink-soft">- Shorter is braver.</div>
      <div className="text-ink-soft">- One specific noun per sentence, please.</div>
      <div className="mt-3 text-ink">
        <span className="text-accent">## </span>Never
      </div>
      <div className="text-ink-soft">- Promise features that have not shipped.</div>
      <div className="text-ink-soft">
        - Use the word <span className="text-ink">&ldquo;robust&rdquo;</span>. Ever.
      </div>
      <div className="mt-3 text-ink">
        <span className="text-accent">## </span>When unsure
      </div>
      <div className="text-ink-soft">Ask a member. Do not guess on legal copy.</div>
    </ArtifactFrame>
  );
}

function SkillsArtifact() {
  const rows = [
    { file: "write-weekly-digest.md", size: "1.2k", who: "alex-brand", tag: "writing" },
    { file: "triage-inbox.md", size: "640b", who: "shared", tag: "ops" },
    { file: "draft-release-notes.md", size: "2.1k", who: "alex-brand", tag: "writing" },
    { file: "reconcile-stripe.md", size: "3.0k", who: "mira-finance", tag: "finance" },
    { file: "page-oncall.md", size: "812b", who: "sam-sre", tag: "ops" },
  ];
  return (
    <figure className="w-full">
      <figcaption className="flex items-center justify-between border-b border-ink pb-2 font-mono text-[10px] uppercase tracking-[0.22em] text-ink-soft">
        <span>data/skills/</span>
        <span className="text-ink-mute">5 files · 7.7kb</span>
      </figcaption>
      <div className="border border-ink bg-bone-card font-mono text-[12.5px]">
        <div className="grid grid-cols-[minmax(0,1.6fr)_60px_minmax(0,1fr)_70px] gap-3 border-b border-ink/15 px-4 py-2 text-[10px] uppercase tracking-[0.16em] text-ink-mute">
          <span>file</span>
          <span className="text-right">size</span>
          <span>owner</span>
          <span>tag</span>
        </div>
        {rows.map((r, i) => (
          <div
            key={r.file}
            className={`grid grid-cols-[minmax(0,1.6fr)_60px_minmax(0,1fr)_70px] gap-3 px-4 py-2 ${
              i < rows.length - 1 ? "border-b border-ink/10" : ""
            }`}
          >
            <span className="truncate text-ink">{r.file}</span>
            <span className="tabular text-right text-ink-soft">{r.size}</span>
            <span className="truncate text-ink-soft">{r.who}</span>
            <span className="text-accent">{r.tag}</span>
          </div>
        ))}
      </div>
    </figure>
  );
}

function RoutinesArtifact() {
  const rows = [
    { cron: "0 7 * * *", who: "mira-finance", brief: "close the books" },
    { cron: "30 8 * * 1-5", who: "alex-brand", brief: "morning brief" },
    { cron: "*/15 * * * *", who: "sam-sre", brief: "watch p99" },
    { cron: "0 17 * * 5", who: "alex-brand", brief: "weekly digest" },
  ];
  return (
    <figure className="w-full">
      <figcaption className="flex items-center justify-between border-b border-ink pb-2 font-mono text-[10px] uppercase tracking-[0.22em] text-ink-soft">
        <span>$ genosyn routines list</span>
        <span className="text-ink-mute">crontab</span>
      </figcaption>
      <div className="border border-ink bg-ink font-mono text-[12.5px] text-bone-card">
        <div className="grid grid-cols-[140px_minmax(0,1fr)_minmax(0,1.4fr)] gap-3 border-b border-bone-card/15 px-4 py-2 text-[10px] uppercase tracking-[0.16em] text-bone-card/55">
          <span>cron</span>
          <span>employee</span>
          <span>brief</span>
        </div>
        {rows.map((r, i) => (
          <div
            key={r.brief}
            className={`grid grid-cols-[140px_minmax(0,1fr)_minmax(0,1.4fr)] gap-3 px-4 py-2 ${
              i < rows.length - 1 ? "border-b border-bone-card/10" : ""
            }`}
          >
            <span className="tabular text-amber-200">{r.cron}</span>
            <span className="truncate text-bone-card/85">{r.who}</span>
            <span className="truncate">{r.brief}</span>
          </div>
        ))}
      </div>
    </figure>
  );
}
