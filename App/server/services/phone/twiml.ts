/**
 * TwiML — the XML a call webhook answers Twilio with. A handful of verbs is
 * all a conversation needs: say something, listen for speech, press keys,
 * ring someone else, wait, and hang up.
 *
 * Everything that reaches a document goes through {@link escapeXml}: spoken
 * text is written by a model and URLs carry ids, and an unescaped `<` in
 * either would end the call with a parse error instead of a sentence.
 */

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export type TwimlVerb = string;

export function response(...verbs: TwimlVerb[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${verbs.join("")}</Response>`;
}

export function say(text: string, voice: { id: string; language: string }): TwimlVerb {
  if (!text.trim()) return "";
  return `<Say voice="${escapeXml(voice.id)}" language="${escapeXml(voice.language)}">${escapeXml(text)}</Say>`;
}

/**
 * Listen for speech, optionally while something is being said. Nesting the
 * `<Say>` inside the `<Gather>` is what lets a caller interrupt the employee
 * mid-sentence, the way people do on a phone.
 *
 * `actionOnEmptyResult` makes Twilio call back even when nobody spoke, so
 * silence is the engine's decision rather than Twilio quietly moving on to the
 * next verb and ending the call.
 */
export function gather(args: {
  action: string;
  language: string;
  /** Seconds to wait for the other side to start speaking. */
  timeoutSec: number;
  prompt?: TwimlVerb;
}): TwimlVerb {
  return (
    `<Gather input="speech" action="${escapeXml(args.action)}" method="POST"` +
    ` language="${escapeXml(args.language)}" speechTimeout="auto" timeout="${Math.round(args.timeoutSec)}"` +
    ` speechModel="phone_call" enhanced="true" actionOnEmptyResult="true">` +
    (args.prompt ?? "") +
    `</Gather>`
  );
}

/** DTMF tones on the line — `0-9`, `*`, `#`, and `w` for a half-second pause. */
export function playDigits(digits: string): TwimlVerb {
  const safe = digits.replace(/[^0-9*#wW]/g, "");
  return safe ? `<Play digits="${safe}"/>` : "";
}

export function pause(seconds: number): TwimlVerb {
  return `<Pause length="${Math.max(1, Math.round(seconds))}"/>`;
}

export function redirect(url: string): TwimlVerb {
  return `<Redirect method="POST">${escapeXml(url)}</Redirect>`;
}

export function hangup(): TwimlVerb {
  return "<Hangup/>";
}

/** Refuse a call before it is answered; the caller hears a busy tone. */
export function reject(): TwimlVerb {
  return '<Reject reason="busy"/>';
}

/** Ring another phone. `answerOnBridge` keeps the caller hearing ringing, not silence. */
export function dial(number: string, timeoutSec = 25): TwimlVerb {
  return `<Dial answerOnBridge="true" timeout="${Math.round(timeoutSec)}"><Number>${escapeXml(number)}</Number></Dial>`;
}

/** An empty answer — what an incoming text gets, since replies go out through the API. */
export function emptyResponse(): string {
  return response();
}
