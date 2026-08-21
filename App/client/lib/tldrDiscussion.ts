import type { TldrItem } from "./api";

/** Direct Chat accepts 8,000 characters; keep this much free for the Member's question. */
export const TLDR_DISCUSSION_QUESTION_RESERVE_CHARS = 2_000;
export const TLDR_DISCUSSION_MESSAGE_MAX_CHARS = 8_000;

/**
 * Build the reviewable draft used when a Member opens a TLDR discussion.
 *
 * The generated recap is deliberately not copied into Member-authored text.
 * The same-company link lets the server provide it through a read-only,
 * discussion-only tool result, preserving the TLDR's untrusted-data boundary.
 */
export function tldrDiscussionStarterPrompt(
  item: Pick<TldrItem, "id">,
  companySlug: string,
): string {
  return [
    "Discuss company TLDR",
    "",
    `I’d like to discuss this [TLDR](/c/${companySlug}/tldrs#tldr-${item.id}).`,
    "",
    "Please read it first, then identify the most important point, the biggest uncertainty, and what may need follow-up. This first turn is for discussion only—do not take action.",
    "",
    "My question: ",
  ].join("\n");
}
