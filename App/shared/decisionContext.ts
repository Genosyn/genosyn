/**
 * The context on a Decision or a work review, as stored and as read back.
 *
 * Intake stores one markdown string: the asking employee's reason for needing a
 * human, under a fixed heading, then the context it wrote. The review cards
 * split the two apart again, so the reason reads as its own step and the
 * context as labelled sections instead of one block of prose.
 *
 * Shared between client and server so the card that takes the string apart
 * reads exactly the format the intake writes.
 */

export const HUMAN_DECISION_HEADING = "Why this needs a human decision";

/**
 * The stored form. The reason comes first so it survives bounded previews, and
 * it stays one paragraph: the first blank line is where a reader ends it, so a
 * reason written as several paragraphs keeps its line breaks without its later
 * paragraphs being read as context.
 */
export function formatHumanDecisionContext(reason: string, context: string): string {
  const paragraph = reason.trim().replace(/\n[ \t]*(?:\n[ \t]*)+/g, "\n");
  return `## ${HUMAN_DECISION_HEADING}\n${paragraph}\n\n${context}`.trim();
}

export type DecisionContextSection = {
  /** The heading or lead-in the employee wrote ("What happened"), or null for prose before any. */
  label: string | null;
  /** The section's markdown, without its label. */
  body: string;
};

export type DecisionContext = {
  /** Why a human must decide; null on rows written without a stated reason. */
  reason: string | null;
  sections: DecisionContextSection[];
};

const REASON_HEADING = new RegExp(`^#{1,6}[ \\t]+${HUMAN_DECISION_HEADING}[ \\t]*:?[ \\t]*$`, "i");
const HEADING = /^#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const BOLD_LEAD = /^(\*\*|__)(.+?)\1(.*)$/;
// A colon followed by a space or the end of the line, so a URL or a clock time
// never reads as a label.
const PLAIN_LEAD = /^(\p{Lu}[^:]{0,47}):(?:[ \t]+(.*))?$/u;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * A short phrase rather than a sentence that happens to contain a colon. Two
 * letters is a quoted mail header ("Re:", "To:"), not a section.
 */
function isLabel(text: string, strict: boolean): boolean {
  if (text.length < 3 || text.length > 60 || words(text) > (strict ? 6 : 8)) return false;
  return !(strict ? /[.,;!?"“”`*_[\]<>=#@|{}\\]/ : /[.;!?`[\]<>=#|{}\\]/).test(text);
}

function leadingLabel(line: string): { label: string; rest: string } | null {
  const heading = HEADING.exec(line);
  if (heading) {
    const label = heading[1]
      .replace(/^(\*\*|__)(.+)\1$/, "$2")
      .replace(/:$/, "")
      .trim();
    return label ? { label, rest: "" } : null;
  }
  const bold = BOLD_LEAD.exec(line);
  if (bold) {
    const inner = bold[2].trim();
    const after = bold[3].trim();
    let label: string | null = null;
    let rest = "";
    if (inner.endsWith(":")) {
      label = inner.slice(0, -1).trim();
      rest = after;
    } else if (after.startsWith(":")) {
      label = inner;
      rest = after.slice(1).trim();
    } else if (!after) {
      // A bold line on its own is the employee's heading.
      label = inner;
    }
    return label && isLabel(label, false) ? { label, rest } : null;
  }
  const plain = PLAIN_LEAD.exec(line);
  if (plain && isLabel(plain[1].trim(), true)) {
    return { label: plain[1].trim(), rest: (plain[2] ?? "").trim() };
  }
  return null;
}

/**
 * Split a stored context back into its reason and its sections.
 *
 * A section starts at a markdown heading, a bold lead-in (`**Risk:**`), or a
 * short capitalized label at the start of a line (`What happened: …`), which is
 * how employees structure a context without being told to. Anything before the
 * first label is a section with no label. Fenced code is never split.
 */
export function parseDecisionContext(markdown: string | null | undefined): DecisionContext {
  const lines = (markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  let start = 0;
  while (start < lines.length && !lines[start].trim()) start++;

  let reason: string | null = null;
  if (start < lines.length && REASON_HEADING.test(lines[start])) {
    let end = start + 1;
    while (end < lines.length && lines[end].trim()) end++;
    reason =
      lines
        .slice(start + 1, end)
        .join("\n")
        .trim() || null;
    start = end;
  }

  const drafts: { label: string | null; lines: string[] }[] = [];
  const current = () => {
    if (drafts.length === 0) drafts.push({ label: null, lines: [] });
    return drafts[drafts.length - 1];
  };
  let fence: string | null = null;
  for (const line of lines.slice(start)) {
    const marker = FENCE.exec(line)?.[1] ?? null;
    if (fence) {
      current().lines.push(line);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      fence = marker;
      current().lines.push(line);
      continue;
    }
    const lead = leadingLabel(line);
    if (lead) {
      drafts.push({ label: lead.label, lines: lead.rest ? [lead.rest] : [] });
      continue;
    }
    current().lines.push(line);
  }

  const sections = drafts
    .map(({ label, lines: body }) => ({ label, body: body.join("\n").trim() }))
    .filter((section) => section.body);
  return { reason, sections };
}
