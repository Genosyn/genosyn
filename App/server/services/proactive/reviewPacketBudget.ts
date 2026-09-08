/** Smaller than the agent loop's minimum tool-result limit, including JSON whitespace. */
export const WORK_REVIEW_PACKET_MAX_CHARS = 7_500;

type ReviewItem = Record<string, unknown> & { truncatedFields: string[] };
type ReviewSection = { items: ReviewItem[]; truncated: boolean };

type WorkReviewPacket = {
  runs: ReviewSection;
  lessons: ReviewSection;
  revisions: { pending: ReviewSection; decided: ReviewSection };
  mailHandovers: ReviewSection;
  repositoryWorkSessions: ReviewSection;
  participatingRoutines?: ReviewSection;
  participatingRuns?: ReviewSection;
};

// These fields already contain excerpts, not complete source documents. Human
// reviewNote, identifiers, evidence IDs, statuses and verdicts are never shortened.
const EXCERPT_FIELDS = [
  "routineName",
  "ownerName",
  "outcomeNote",
  "summary",
  "cause",
  "advice",
  "targetLabel",
  "rationale",
  "errorMessage",
  "proposedBodyExcerpt",
  "title",
  "error",
] as const;

function serializedLength(value: unknown): number {
  // The MCP text envelope and bare-payload fallback both use this representation.
  return JSON.stringify(value, null, 2).length;
}

function shortenExcerpts(sections: ReviewSection[], cap: number): void {
  for (const section of sections) {
    for (const item of section.items) {
      for (const field of EXCERPT_FIELDS) {
        const value = item[field];
        if (typeof value !== "string" || value.length <= cap) continue;
        item[field] =
          value
            .slice(0, cap - 1)
            .replace(/[\uD800-\uDBFF]$/, "")
            .trimEnd() + "…";
        if (!item.truncatedFields.includes(field)) item.truncatedFields.push(field);
      }
    }
  }
}

/**
 * Keep the read-only snapshot valid JSON below the runtime's clipping threshold.
 * Sources already arrive newest first. Prefer complete newest rows from every
 * source; only then shorten marked excerpts. In particular, a large Run history
 * must not hide the pending proposals and human feedback later in the packet.
 */
export function boundWorkReviewPacket<T extends WorkReviewPacket>(packet: T): T {
  const bounded = structuredClone(packet);
  if (serializedLength(bounded) <= WORK_REVIEW_PACKET_MAX_CHARS) return bounded;

  Object.assign(bounded, {
    packetBudget: {
      maxChars: WORK_REVIEW_PACKET_MAX_CHARS,
      truncated: true,
      note: "Newest items retained. Omitted rows set section.truncated; shortened excerpts appear in truncatedFields. Own proposals and human reviewNote take priority over shared Routine details. Read current source records before proposing.",
    },
  });
  const sections = [
    bounded.runs,
    bounded.lessons,
    bounded.revisions.pending,
    bounded.revisions.decided,
    bounded.mailHandovers,
    bounded.repositoryWorkSessions,
    ...(bounded.participatingRoutines ? [bounded.participatingRoutines] : []),
    ...(bounded.participatingRuns ? [bounded.participatingRuns] : []),
  ];

  const removeOldest = (minimumItems: number): boolean => {
    const largest = sections
      .filter((section) => section.items.length > minimumItems)
      .sort((a, b) => serializedLength(b.items) - serializedLength(a.items))[0];
    if (!largest) return false;
    largest.items.pop();
    largest.truncated = true;
    return true;
  };

  while (serializedLength(bounded) > WORK_REVIEW_PACKET_MAX_CHARS && removeOldest(1)) {
    // Remove complete oldest rows before shortening the remaining source excerpts.
  }
  for (const cap of [240, 160, 100, 60, 30]) {
    if (serializedLength(bounded) <= WORK_REVIEW_PACKET_MAX_CHARS) return bounded;
    shortenExcerpts(sections, cap);
  }

  // Participation extends the packet; it must not displace the employee's
  // own pending changes or human feedback. Preserve the compact receipt before
  // shared Run detail, and mark any omitted section for a later focused read.
  for (const optional of [bounded.participatingRuns, bounded.participatingRoutines]) {
    while (optional?.items.length && serializedLength(bounded) > WORK_REVIEW_PACKET_MAX_CHARS) {
      optional.items.pop();
      optional.truncated = true;
    }
  }

  // Defensive fallback for an unexpectedly oversized future field. Preserve
  // complete field semantics by omitting its whole row, with the section flag,
  // instead of cutting an ID, verdict or human feedback into misleading text.
  while (serializedLength(bounded) > WORK_REVIEW_PACKET_MAX_CHARS && removeOldest(0)) {
    // The section shells remain visible even when an individual row cannot fit.
  }
  if (serializedLength(bounded) > WORK_REVIEW_PACKET_MAX_CHARS) {
    throw new Error("Own-work review metadata exceeds the packet budget");
  }
  return bounded;
}
