import { instructionsTextProblem, type InstructionsTextLimits } from "./instructionsText.js";

/**
 * Customer channels — a channel on an external chat surface (today a Slack
 * channel, usually a Slack Connect one the company shares with a customer)
 * linked to one Customer. The AI Employee working it reads every message,
 * writes notes onto that Customer's timeline, and may answer in the channel
 * from instructions a Member wrote.
 *
 * Shared by the server and the client so the reply modes, their wording and
 * the instruction limits cannot drift apart.
 */

/**
 * When the AI Employee posts in the channel.
 *
 *  - `notes` — never. It reads and takes notes.
 *  - `mentions` — when someone @-mentions it, in the thread they asked in.
 *  - `questions` — also, unprompted, to a question from someone outside the
 *    company's own Slack workspace, when its instructions cover the answer.
 */
export type CustomerChannelReplyMode = "notes" | "mentions" | "questions";

export const CUSTOMER_CHANNEL_REPLY_MODES: readonly CustomerChannelReplyMode[] = [
  "notes",
  "mentions",
  "questions",
];

export const DEFAULT_CUSTOMER_CHANNEL_REPLY_MODE: CustomerChannelReplyMode = "mentions";

export const CUSTOMER_CHANNEL_REPLY_MODE_COPY: Record<
  CustomerChannelReplyMode,
  { title: string; detail: string }
> = {
  notes: {
    title: "Only take notes",
    detail: "It reads the channel and never posts in it.",
  },
  mentions: {
    title: "Answer when @-mentioned",
    detail: "Anyone in the channel can ask it something by name.",
  },
  questions: {
    title: "Answer customer questions",
    detail:
      "Also answers questions from people outside your Slack workspace that its instructions cover.",
  },
};

/** A page of instructions, and a hard bound on what reaches every reply prompt. */
export const CUSTOMER_CHANNEL_INSTRUCTIONS_LIMITS: InstructionsTextLimits = {
  maxLength: 8_000,
  maxLines: 80,
};

export function customerChannelInstructionsProblem(value: string): string | null {
  return instructionsTextProblem(value, CUSTOMER_CHANNEL_INSTRUCTIONS_LIMITS);
}
