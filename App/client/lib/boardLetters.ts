import type {
  BoardLetterSummary,
  LetterFigure,
  LetterFigureGroup,
  LetterGoal,
  LetterTrace,
} from "./api";

/**
 * How a letter to the board is shown: its paragraphs with every number marked
 * by what the trace found, and the plain words for where it stands.
 *
 * The server decides everything here — the figures, the trace, the audit — and
 * this only arranges it. In particular nothing reads a missing opinion as a
 * clean one: a letter nobody audited says so in the same place a clean audit
 * would.
 */

export type LetterSegment =
  | { kind: "text"; text: string }
  | { kind: "traced"; text: string; figureKey: string }
  | { kind: "untraced"; text: string };

type Mark = { start: number; end: number; text: string; figureKey: string | null };

/**
 * The letter as paragraphs of segments. Offsets come from the server's trace
 * of this exact body; a mark whose text no longer sits at its offset is
 * dropped rather than drawn over the wrong words.
 */
export function letterParagraphs(body: string, trace: LetterTrace | null): LetterSegment[][] {
  const marks: Mark[] = [
    ...(trace?.traced ?? []).map((token) => ({ ...token, figureKey: token.figureKey })),
    ...(trace?.untraced ?? []).map((token) => ({ ...token, figureKey: null })),
  ]
    .filter(
      (mark) =>
        mark.start >= 0 &&
        mark.start < mark.end &&
        mark.end <= body.length &&
        body.slice(mark.start, mark.end) === mark.text,
    )
    .sort((a, b) => a.start - b.start);

  const segments: LetterSegment[] = [];
  let cursor = 0;
  for (const mark of marks) {
    if (mark.start < cursor) continue;
    if (mark.start > cursor) segments.push({ kind: "text", text: body.slice(cursor, mark.start) });
    segments.push(
      mark.figureKey
        ? { kind: "traced", text: mark.text, figureKey: mark.figureKey }
        : { kind: "untraced", text: mark.text },
    );
    cursor = mark.end;
  }
  if (cursor < body.length) segments.push({ kind: "text", text: body.slice(cursor) });

  const paragraphs: LetterSegment[][] = [[]];
  for (const segment of segments) {
    if (segment.kind !== "text") {
      paragraphs[paragraphs.length - 1].push(segment);
      continue;
    }
    segment.text.split(/\n[^\S\n]*\n\s*/).forEach((part, index) => {
      if (index > 0) paragraphs.push([]);
      if (part) paragraphs[paragraphs.length - 1].push({ kind: "text", text: part });
    });
  }
  return paragraphs
    .map((paragraph) => {
      const first = paragraph[0];
      const last = paragraph[paragraph.length - 1];
      if (first?.kind === "text") paragraph[0] = { kind: "text", text: first.text.trimStart() };
      if (last?.kind === "text") {
        paragraph[paragraph.length - 1] = { kind: "text", text: last.text.trimEnd() };
      }
      return paragraph.filter((segment) => segment.kind !== "text" || segment.text.length > 0);
    })
    .filter((paragraph) => paragraph.length > 0);
}

export type LetterTone = "good" | "warn" | "bad" | "neutral" | "working";

export type LetterBadge = { label: string; tone: LetterTone };

type BadgeInput = Pick<BoardLetterSummary, "status" | "auditStatus" | "findingsCount">;

/** Where the letter stands, with the audit's verdict once it has one. */
export function letterStatusBadge(letter: BadgeInput): LetterBadge {
  if (letter.status === "writing") return { label: "Being written", tone: "working" };
  if (letter.status === "auditing") return { label: "With the auditor", tone: "working" };
  if (letter.status === "failed") return { label: "Not written", tone: "bad" };
  switch (letter.auditStatus) {
    case "clean":
      return { label: "Audited · no exceptions", tone: "good" };
    case "exceptions":
      return {
        label: `Audited · ${letter.findingsCount} ${letter.findingsCount === 1 ? "exception" : "exceptions"}`,
        tone: "warn",
      };
    case "unverified":
      return { label: "Not audited", tone: "bad" };
    case "not_appointed":
      return { label: "No auditor appointed", tone: "neutral" };
    default:
      return { label: "Audit pending", tone: "working" };
  }
}

/** What the trace found, once there is prose to trace. */
export function traceBadge(
  letter: Pick<BoardLetterSummary, "status" | "untracedCount">,
): LetterBadge | null {
  if (letter.status !== "ready" && letter.status !== "auditing") return null;
  if (letter.untracedCount === 0) return { label: "Every number traced", tone: "good" };
  return {
    label: `${letter.untracedCount} ${letter.untracedCount === 1 ? "number" : "numbers"} untraced`,
    tone: "warn",
  };
}

export const FIGURE_GROUPS: ReadonlyArray<{
  group: Exclude<LetterFigureGroup, "goals">;
  title: string;
}> = [
  { group: "money", title: "Where the money went" },
  { group: "work", title: "The work" },
  { group: "decisions", title: "What waited for people" },
];

/** The figures under their headings, in the letter's order, leaving out empty groups. */
export function figureSections(
  figures: readonly LetterFigure[],
): Array<{ group: LetterFigureGroup; title: string; figures: LetterFigure[] }> {
  return FIGURE_GROUPS.map(({ group, title }) => ({
    group,
    title,
    figures: figures.filter((figure) => figure.group === group),
  })).filter((section) => section.figures.length > 0);
}

/** "6,200 of 1,000,000 roofs", "Achieved", or "No value yet". */
export function goalStandingLabel(goal: LetterGoal, figures: readonly LetterFigure[]): string {
  if (goal.status === "achieved") return "Achieved";
  if (goal.status === "missed") return "Missed";
  const current = figures.find((figure) => figure.key === `goal.${goal.id}.current`);
  const target = figures.find((figure) => figure.key === `goal.${goal.id}.target`);
  if (!current) return "No value reported yet";
  return `${current.display} of ${target?.display ?? goal.target.toLocaleString("en-US")}`;
}

/** A company-relative figure link as an in-app path, or null when it has none. */
export function figureLink(companySlug: string, figure: Pick<LetterFigure, "href">): string | null {
  if (!figure.href || !figure.href.startsWith("/")) return null;
  return `/c/${companySlug}${figure.href}`;
}
