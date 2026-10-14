import type { EmployeeTemplate } from "./api";

/**
 * The Soul a person drafts by answering a few questions, on the hire flow's
 * "Customize the Soul first" path.
 *
 * Kept out of the page so the one rule worth a test can have one: nothing is
 * written into a Soul that the person did not say, unless it is a plain default
 * about how any good employee works. Links to a company's own playbooks cannot
 * be defaulted — a stand-in would sit in the Soul looking real — so Reference
 * material starts empty, and an empty one leaves its section out entirely.
 */

export type SoulAnswers = {
  mission: string;
  tone: string;
  autonomy: string;
  hardNos: string;
  reference: string;
};

export const EMPTY_ANSWERS: SoulAnswers = {
  mission: "",
  tone: "",
  autonomy: "",
  hardNos: "",
  reference: "",
};

export function defaultMission(role: string): string {
  const beat = role.trim();
  if (beat) {
    return `Be the team's ${beat.toLowerCase()} — own the day-to-day so the team can focus on the decisions only humans can make.`;
  }
  return `Own the day-to-day so the team can focus on the decisions only humans can make.`;
}

export function defaultTone(): string {
  return `Calm, concrete, and human. Short sentences, no corporate filler. Write like a person who has done this job for a decade — never "per my last email".`;
}

export function defaultAutonomy(role: string): string {
  const beat = role.trim().toLowerCase();
  const area = beat ? `${beat} work` : "your beat";
  return `Drafting, summarizing, researching, and triaging ${area}. Flag anything ambiguous early. Never send, publish, or commit money without human sign-off.`;
}

export function defaultHardNos(): string {
  return `Send or publish anything externally without a human sign-off.
Promise refunds, discounts, timelines, or policy changes on behalf of the team.
Share private or customer data with anyone who shouldn't have it.`;
}

/** The starter answers the About step shows. Reference material has none. */
export function defaultAnswers(role: string): SoulAnswers {
  return {
    mission: defaultMission(role),
    tone: defaultTone(),
    autonomy: defaultAutonomy(role),
    hardNos: defaultHardNos(),
    reference: "",
  };
}

/**
 * Build a fresh Soul body from the operator's About answers. The template's
 * own (server-side) soul is not consumed here — when the operator leaves the
 * About step blank, the caller skips generation and shows whatever the
 * server already stored at create-time (`GET /soul` returns the seeded
 * `AIEmployee.soulBody`). This keeps the generator predictable and
 * side-effect free.
 *
 * A Reference section is written only when the operator gave references.
 */
export function generateSoul(
  name: string,
  role: string,
  template: Pick<EmployeeTemplate, "tagline"> | null,
  answers: SoulAnswers,
): string {
  const mission = answers.mission.trim();
  const tone = answers.tone.trim();
  const autonomy = answers.autonomy.trim();
  const hardNos = answers.hardNos.trim();
  const reference = answers.reference.trim();

  const missionLine = mission || defaultMission(role);
  const toneLine = tone || defaultTone();
  const autonomyLine = autonomy || defaultAutonomy(role);
  const hardNosList = bulletize(hardNos || defaultHardNos());

  const identity = template
    ? `You are **${name}**, our ${role}. ${template.tagline}`
    : `You are **${name}**, our ${role}. You know the company, you know the team, and you know your beat.`;

  const sections = [
    `# ${name}'s Soul

> This is **${name}**'s constitution. Edit it whenever the brief changes — the
> Soul markdown is the source of truth ${name} reads before each run and conversation.`,
    `## Who you are
${identity}`,
    `## Your mission
${compact(missionLine)}`,
    `## How you work
- **Tone & voice:** ${compact(toneLine)}
- **Decisions you make without asking:** ${compact(autonomyLine)}
- **Decisions you always escalate:** anything involving money, legal risk, external communications, or anything in the "refuse" list below.`,
    `## What you refuse to do
${hardNosList}`,
    ...(reference
      ? [
          `## Reference material
${bulletize(reference)}`,
        ]
      : []),
  ];
  return `${sections.join("\n\n")}\n`;
}

function bulletize(s: string): string {
  const lines = s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.startsWith("-") || l.startsWith("*") ? l : `- ${l}`));
  return lines.join("\n");
}

function compact(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
