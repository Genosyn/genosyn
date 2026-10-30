import {
  nextCheckText,
  unavailableReasonText,
  waitingWorkText,
  type PublicModelAvailability,
} from "../../shared/modelAvailability";

/**
 * What an AI Model card says while its model is unavailable — its service
 * can't be reached, is failing, is overloaded or keeps every key rate-limited
 * — and the work on it waits (`server/services/modelAvailability.ts`). Plain
 * functions of the server's view and a clock, so they run under `node --test`.
 */

export type ModelOutageNoticeText = {
  /** "Unavailable since 14:05. Its service is overloaded." */
  headline: string;
  /** The server's one line about the latest failure. */
  detail: string;
  /** What waits for it and what happens to that work. */
  work: string;
  /** "Next check in 4 min", or "Checking now…" while a check runs. */
  nextCheck: string;
  /** How many checks found it still unavailable, and when the last ran; null before the first. */
  checks: string | null;
};

function sinceText(iso: string, now: number): string {
  const at = new Date(iso);
  const time = at.getTime();
  if (!Number.isFinite(time)) return "a moment ago";
  const sameDay = new Date(now).toDateString() === at.toDateString();
  const clock = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay
    ? clock
    : `${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${clock}`;
}

function agoText(iso: string, now: number): string {
  const minutes = Math.floor(Math.max(0, now - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}

/** The notice for an unavailable model; null for one that is available. */
export function modelOutageNotice(
  availability: PublicModelAvailability | undefined,
  now: number,
): ModelOutageNoticeText | null {
  if (!availability || availability.state !== "unavailable") return null;
  const waiting = waitingWorkText(availability.waiting);
  const reason = unavailableReasonText(availability.reason);
  return {
    headline: `Unavailable since ${sinceText(availability.since, now)}. ${reason}.`,
    detail: availability.detail,
    work: waiting
      ? `${waiting}. AI work on it waits instead of failing and carries on by itself once it answers again.`
      : "AI work on it waits instead of failing and carries on by itself once it answers again.",
    nextCheck: availability.checking
      ? "Checking now…"
      : `Next check ${nextCheckText(availability.nextCheckAt, now)}`,
    checks:
      availability.checks > 0 && availability.lastCheckedAt
        ? `${availability.checks} ${availability.checks === 1 ? "check" : "checks"} found it still unavailable, the last ${agoText(availability.lastCheckedAt, now)}.`
        : null,
  };
}
