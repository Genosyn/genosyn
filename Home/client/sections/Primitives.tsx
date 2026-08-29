import { BookHeart, CalendarClock, Check, KeyRound, Sparkles, type LucideIcon } from "lucide-react";
import { Container, Eyebrow, Heading, Lede, Panel, Section } from "@/sections/Kit";

type Primitive = {
  icon: LucideIcon;
  label: string;
  title: string;
  body: string;
  lines: string[];
  /** Icon tile skin. */
  tile: string;
  /** The card's coloured top edge, which is how the four read as a set. */
  edge: string;
  /** Bullet colour inside the document preview. */
  dot: string;
};

const PRIMITIVES: Primitive[] = [
  {
    icon: BookHeart,
    label: "Soul",
    title: "Who they are",
    body: "A readable constitution for judgment, voice, priorities, and the lines they will not cross alone.",
    lines: ["Be exact with financial data", "Surface uncertainty", "Never invent a number"],
    tile: "bg-rose-100 text-rose-700 ring-rose-200",
    edge: "from-rose-400 to-rose-300",
    dot: "bg-rose-400",
  },
  {
    icon: Sparkles,
    label: "Skills",
    title: "How they work",
    body: "Reusable markdown playbooks for the jobs your company repeats.",
    lines: ["reconcile-payments", "prepare-weekly-brief", "triage-inbox"],
    tile: "bg-violet-100 text-violet-700 ring-violet-200",
    edge: "from-violet-400 to-violet-300",
    dot: "bg-violet-400",
  },
  {
    icon: CalendarClock,
    label: "Routines",
    title: "When they work",
    body: "Cron-scheduled work that starts itself — a clear brief, a chosen AI Model, and a readable Run history.",
    lines: ["Morning brief · 08:30", "Reconcile · 07:00", "Digest · Fri 17:00"],
    tile: "bg-emerald-100 text-emerald-700 ring-emerald-200",
    edge: "from-emerald-400 to-emerald-300",
    dot: "bg-emerald-400",
  },
  {
    icon: KeyRound,
    label: "Grants",
    title: "What they can reach",
    body: "Explicit access to Connections, Notes, Bases, repositories, and other company resources.",
    lines: ["Finance connection", "Operations notebook", "Checkout repository"],
    tile: "bg-amber-100 text-amber-700 ring-amber-200",
    edge: "from-amber-400 to-amber-300",
    dot: "bg-amber-400",
  },
];

const TRAITS = ["Readable", "Portable", "Database-backed", "Auditable"];

/**
 * The four primitives an AI Employee is assembled from.
 *
 * Each one owns a hue and repeats it three times — icon tile, top edge, bullet
 * — so the set reads as four documents from the same drawer rather than four
 * unrelated feature cards.
 */
export function Primitives() {
  return (
    <Section tone="tint">
      <Container wide>
        <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:items-center lg:gap-16">
          <div>
            <Eyebrow>The autonomy model</Eyebrow>
            <Heading className="mt-6 max-w-xl">Not a prompt. A role that can run unattended.</Heading>
            <Lede className="mt-6 max-w-xl">
              Four plain, editable building blocks are what make unattended work safe: who they are,
              how they work, when they work, and what they can reach. Change any of them without
              rebuilding the system around it.
            </Lede>
            <div className="mt-8 flex flex-wrap gap-2">
              {TRAITS.map((item) => (
                <span
                  key={item}
                  className="inline-flex items-center gap-1.5 rounded-full border border-stone-900/[0.10] bg-white px-3 py-1.5 text-[11px] font-semibold text-stone-700 shadow-card"
                >
                  <Check aria-hidden className="h-3 w-3 text-ink-500" />
                  {item}
                </span>
              ))}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {PRIMITIVES.map((primitive) => (
              <Panel key={primitive.label} hover className="overflow-hidden">
                <span
                  aria-hidden
                  className={`block h-1 w-full bg-gradient-to-r ${primitive.edge}`}
                />
                <div className="p-6">
                  <div className="flex items-center gap-3">
                    <span
                      className={`flex h-10 w-10 items-center justify-center rounded-xl ring-1 ring-inset ${primitive.tile}`}
                    >
                      <primitive.icon aria-hidden className="h-4 w-4" />
                    </span>
                    <div>
                      <div className="text-[11px] font-semibold text-stone-500">
                        {primitive.label}
                      </div>
                      <h3 className="mt-0.5 text-sm font-semibold text-stone-900">
                        {primitive.title}
                      </h3>
                    </div>
                  </div>
                  <p className="mt-4 text-sm leading-6 text-stone-600">{primitive.body}</p>
                  <ul className="mt-5 space-y-2 rounded-xl bg-paper-200/70 p-3.5">
                    {primitive.lines.map((line) => (
                      <li
                        key={line}
                        className="flex items-center gap-2.5 font-mono text-[11px] text-stone-600"
                      >
                        <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${primitive.dot}`} />
                        {line}
                      </li>
                    ))}
                  </ul>
                </div>
              </Panel>
            ))}
          </div>
        </div>
      </Container>
    </Section>
  );
}
