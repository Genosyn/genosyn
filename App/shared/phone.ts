/**
 * Phone numbers: the Twilio numbers a company reserves and gives to its AI
 * Employees, so each can text, receive texts (verification codes included),
 * answer calls and place them.
 *
 * Shared between client and server so the settings form, the API's zod
 * schemas and the call engine agree on the same modes, voices and limits — a
 * voice the form offers and the engine does not know would silently fall back
 * to another one on a live call.
 */
import {
  instructionsTextProblem,
  normalizeInstructionsText,
  type InstructionsTextLimits,
} from "./instructionsText.js";

/**
 * What happens when someone calls the number.
 *
 *  - `answer`  — the AI Employee picks up and talks, following the number's
 *                instructions.
 *  - `forward` — the call rings a person's phone instead.
 *  - `decline` — the call is refused before it rings.
 */
export type PhoneCallMode = "answer" | "forward" | "decline";
export const PHONE_CALL_MODES: readonly PhoneCallMode[] = ["answer", "forward", "decline"];

/**
 * What happens when someone texts the number.
 *
 *  - `inbox` — the text is kept for the AI Employee to read. Nothing is sent
 *              back, which is what a verification code needs.
 *  - `reply` — the AI Employee also answers each text, following the number's
 *              instructions.
 */
export type PhoneTextMode = "inbox" | "reply";
export const PHONE_TEXT_MODES: readonly PhoneTextMode[] = ["inbox", "reply"];

export type PhoneVoice = {
  /** Twilio `<Say voice>` value. */
  id: string;
  label: string;
  /** BCP-47 tag for both `<Say>` and speech recognition on `<Gather>`. */
  language: string;
};

/**
 * The voices an AI Employee can speak with on a call. Amazon Polly neural
 * voices through Twilio: they sound natural on a phone line and need no
 * account setup. The recognizer listens in the same language as the voice.
 */
export const PHONE_VOICES: readonly PhoneVoice[] = [
  { id: "Polly.Joanna-Neural", label: "Joanna — US English, female", language: "en-US" },
  { id: "Polly.Matthew-Neural", label: "Matthew — US English, male", language: "en-US" },
  { id: "Polly.Ruth-Neural", label: "Ruth — US English, female", language: "en-US" },
  { id: "Polly.Stephen-Neural", label: "Stephen — US English, male", language: "en-US" },
  { id: "Polly.Amy-Neural", label: "Amy — British English, female", language: "en-GB" },
  { id: "Polly.Brian-Neural", label: "Brian — British English, male", language: "en-GB" },
  { id: "Polly.Olivia-Neural", label: "Olivia — Australian English, female", language: "en-AU" },
  { id: "Polly.Kajal-Neural", label: "Kajal — Indian English, female", language: "en-IN" },
];

export const DEFAULT_PHONE_VOICE = PHONE_VOICES[0].id;

export function phoneVoice(id: string | null | undefined): PhoneVoice {
  return PHONE_VOICES.find((voice) => voice.id === id) ?? PHONE_VOICES[0];
}

/** Outbound texts an AI Employee may send from one number in 24 hours. */
export const DEFAULT_DAILY_TEXT_LIMIT = 50;
/** Outbound calls an AI Employee may place from one number in 24 hours. */
export const DEFAULT_DAILY_CALL_LIMIT = 10;
/** The highest either limit can be set to — a typo must not mean "unlimited". */
export const MAX_DAILY_PHONE_LIMIT = 1_000;

/** The first thing said on an answered call. */
export const MAX_PHONE_GREETING_LENGTH = 300;

/** A page of instructions, and a hard bound on what reaches every call prompt. */
export const PHONE_INSTRUCTIONS_LIMITS: InstructionsTextLimits = {
  maxLength: 4_000,
  maxLines: 40,
};

/** One text. Twilio concatenates up to ten segments; longer bodies are refused. */
export const MAX_TEXT_MESSAGE_LENGTH = 1_600;

/** What an AI Employee writes about why it is calling. */
export const MAX_CALL_BRIEF_LENGTH = 4_000;
/** The sentence said when an outbound call connects. */
export const MAX_CALL_OPENING_LENGTH = 400;

export function normalizePhoneInstructions(value: string): string {
  return normalizeInstructionsText(value);
}

export function phoneInstructionsProblem(value: string): string | null {
  return instructionsTextProblem(value, PHONE_INSTRUCTIONS_LIMITS);
}

/**
 * A phone number in E.164 form ("+15550101234"), or null when the input is not
 * one. People write numbers the way they say them, so spaces, dashes, dots and
 * brackets are dropped; the country code is required, because guessing one
 * would dial a stranger in another country.
 */
export function normalizePhoneNumber(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const compact = trimmed.replace(/[\s().-]/g, "");
  const withPlus = compact.startsWith("00") ? `+${compact.slice(2)}` : compact;
  if (!/^\+[1-9]\d{6,14}$/.test(withPlus)) return null;
  return withPlus;
}

/**
 * A number laid out for reading. North American numbers get the familiar
 * `+1 (555) 010-1234`; everything else keeps its country code apart and the
 * rest in groups, which is readable without a per-country numbering plan.
 * Anything that is not E.164 — a short code, an alphanumeric sender — is shown
 * as it arrived.
 */
export function formatPhoneNumber(value: string | null | undefined): string {
  const raw = (value ?? "").trim();
  if (!/^\+\d{7,15}$/.test(raw)) return raw;
  const nanp = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(raw);
  if (nanp) return `+1 (${nanp[1]}) ${nanp[2]}-${nanp[3]}`;
  const digits = raw.slice(1);
  // Country codes are one to three digits; two is the common case and only
  // shapes the spacing here, never the number itself.
  const cc = digits.slice(0, 2);
  const rest = digits.slice(2);
  // Grouped in fours from the right, so the short group leads: most national
  // formats put the area code first and keep the subscriber digits together.
  const groups: string[] = [];
  for (let end = rest.length; end > 0; end -= 4)
    groups.unshift(rest.slice(Math.max(0, end - 4), end));
  return `+${cc} ${groups.join(" ")}`;
}

const CODE_KEYWORDS =
  /code|otp|pin|passcode|password|verif|one[- ]time|2fa|security|log ?in|sign[- ]?in|confirm/gi;

/**
 * Likely one-time codes in a text, most plausible first: runs of 4–8 digits,
 * also when written in two halves ("123-456", "123 456"), plus the short
 * letter-and-digit codes some services send ("G-482913"). A code next to a
 * word like "code" or "verification" ranks first, and digits that are part of
 * a phone number ("call 1-800-555-0100") are never offered.
 *
 * A convenience for reading verification texts — the full body is always
 * returned beside it, so a miss costs a glance, not the code.
 */
export function extractVerificationCodes(body: string): string[] {
  const text = body.normalize("NFKC");
  const phoneSpans: Array<[number, number]> = [];
  for (const match of text.matchAll(/\+?\d[\d\s().-]{7,}\d/g)) {
    if (match[0].replace(/\D/g, "").length >= 9) {
      phoneSpans.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
    }
  }
  const keywords = [...text.matchAll(CODE_KEYWORDS)].map((match) => [
    match.index ?? 0,
    (match.index ?? 0) + match[0].length,
  ]);
  const best = new Map<string, { score: number; index: number }>();
  const consider = (code: string, index: number, length: number, base: number) => {
    if (phoneSpans.some(([start, end]) => index >= start && index < end)) return;
    const nearKeyword = keywords.some(
      ([start, end]) => Math.abs(index - end) <= 40 || Math.abs(start - (index + length)) <= 40,
    );
    const digits = code.replace(/\D/g, "").length;
    const score = base + (nearKeyword ? 4 : 0) + (digits === 6 ? 1 : 0);
    const previous = best.get(code);
    if (!previous || previous.score < score) best.set(code, { score, index });
  };
  for (const match of text.matchAll(/\b[A-Z]{1,3}-\d{4,8}\b/g)) {
    consider(match[0], match.index ?? 0, match[0].length, 1);
  }
  for (const match of text.matchAll(/(?<![\w+])(\d{3})[- ](\d{3})(?!\w)/g)) {
    consider(`${match[1]}${match[2]}`, match.index ?? 0, match[0].length, 0);
  }
  for (const match of text.matchAll(/(?<![\w+.,-])(\d{4,8})(?!\w|[.,]\d)/g)) {
    consider(match[1], match.index ?? 0, match[0].length, 0);
  }
  return [...best.entries()]
    .sort((a, b) => b[1].score - a[1].score || a[1].index - b[1].index)
    .map(([code]) => code)
    .slice(0, 5);
}
