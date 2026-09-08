/** Compact evidence for a daily review. A cue is never authority to act. */
export type ProactiveOpportunity = {
  id: string;
  kind: string;
  title: string;
  reason: string;
  updatedAt?: string | null;
  dueAt?: string | null;
  locator?: string;
  tools: string[];
};

export type ProactiveOpportunitySection = {
  items: ProactiveOpportunity[];
  truncated: boolean;
};

export const PROACTIVE_SECTION_LIMIT = 5;
export const PROACTIVE_PACKET_MAX_CHARS = 7_500;

/** Keep JSON readable below the runtime's minimum tool-result clipping limit. */
export function boundProactiveOpportunities<
  T extends {
    sections: Record<string, ProactiveOpportunitySection>;
  },
>(packet: T): T {
  const bounded = structuredClone(packet);
  const length = () => JSON.stringify(bounded, null, 2).length;
  for (const section of Object.values(bounded.sections)) {
    for (const item of section.items) {
      item.title = item.title.slice(0, 120);
      item.reason = item.reason.slice(0, 240);
    }
  }
  while (length() > PROACTIVE_PACKET_MAX_CHARS) {
    const largest = Object.values(bounded.sections)
      .filter((section) => section.items.length)
      .sort((a, b) => JSON.stringify(b.items).length - JSON.stringify(a.items).length)[0];
    if (!largest) throw new Error("Proactive work metadata exceeds the packet budget");
    largest.items.pop();
    largest.truncated = true;
  }
  return bounded;
}
