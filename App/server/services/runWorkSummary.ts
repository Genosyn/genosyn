import type { Run } from "../db/entities/Run.js";
import { redactSensitiveText } from "./approvalRedaction.js";

/** A preview of reported work, never a replacement for Checks or a verdict. */
export const RUN_WORK_SUMMARY_MAX_CHARS = 280;
const TRANSCRIPT_TAIL_CHARS = 64 * 1024;
const runtimeTag =
  /\[(?:tool(?::[^\]\r\n]+)?|tokens|tools|compact|model|repos|repositories|checks|retry|warn|error|timeout|skipped)\]/g;
const sentenceSegments = new Intl.Segmenter("en", { granularity: "sentence" });
const boilerplate =
  /^(?:(?:run |work |routine )?(?:summary|outcome|results?|details)|done|completed|here(?:'s| is) (?:the |a )?(?:summary|report))[:.!]?$/i;

function withoutCode(text: string): string {
  return text.replace(
    /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*(?:\n|$)|$(?![\s\S]))/gm,
    "",
  );
}

/** Keep readable prose and its first two sentences, without carrying a report into Home. */
export function conciseWorkSummary(text: string): string | null {
  // Normalize labels before redaction: otherwise `**Password:** value` can
  // have its closing emphasis mistaken for the value being scrubbed.
  const redacted = redactSensitiveText(
    withoutCode(text)
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(?<!\w)_([^\n]+?)_(?!\w)/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1"),
  );
  const lines = withoutCode(redacted)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .split(/\r?\n/)
    .map((line) => line.trim());
  const blocks: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    const block = paragraph.join(" ").trim();
    if (block && !boilerplate.test(block))
      blocks.push(/[.!?…。！？:]$/.test(block) ? block : `${block}.`);
    paragraph = [];
  };
  for (const line of lines) {
    if (!line || /^(?:\||[{}]|\[tool|[-*_]{3,}$)/i.test(line)) {
      flush();
      continue;
    }
    const heading = /^#{1,6}\s/.test(line);
    if (heading || /^(?:[-*+]\s+|\d+[.)]\s+)/.test(line)) flush();
    const plain = line
      .replace(/^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, "")
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .trim();
    if (boilerplate.test(plain)) {
      flush();
      continue;
    }
    paragraph.push(plain);
    if (heading) flush();
  }
  flush();
  // Markdown can separate a credential label from its value. Scrub again
  // after removing formatting, before any sentence or character truncation.
  const prose = redactSensitiveText(blocks.join(" ")).replace(/\s+/g, " ").trim();
  if (!prose) return null;
  const sentences: string[] = [];
  for (const part of sentenceSegments.segment(prose)) {
    if (!boilerplate.test(part.segment.trim())) sentences.push(part.segment);
    if (sentences.length === 2) break;
  }
  const summary = sentences.join("").trim();
  if (!summary) return null;
  if (summary.length <= RUN_WORK_SUMMARY_MAX_CHARS) return summary;
  const prefix = summary.slice(0, RUN_WORK_SUMMARY_MAX_CHARS - 1);
  const space = prefix.lastIndexOf(" ");
  // Keep a long unbroken word bounded too, without splitting a surrogate pair.
  return (
    (space > prefix.length / 2
      ? prefix.slice(0, space)
      : prefix.replace(/[\uD800-\uDBFF]$/, "")
    ).trimEnd() + "…"
  );
}

/**
 * Read the final assistant prose from older as well as newly persisted Runs.
 * Tool activity invalidates preceding planning text: a Run ending on a tool
 * result has no final report. Trailing usage/check/retry framing is not prose.
 * Usage can start in the middle of a physical line after a streamed answer.
 */
function finalReport(log: string): string {
  let tail = log.slice(-TRANSCRIPT_TAIL_CHARS);
  if (log.length > tail.length) {
    const boundary = tail.indexOf("\n");
    if (boundary < 0) return "";
    tail = tail.slice(boundary + 1);
  }
  const lines = withoutCode(tail).replace(runtimeTag, "\n$&").split(/\r?\n/);
  let report: string[] = [];
  let separated = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (
      /^\[(?:tool(?::[^\]]+)?|tools|compact|model|repos|repositories)\]/.test(line) ||
      /^\[….*(?:omitted|truncated).*…\]/.test(line)
    ) {
      report = [];
      separated = false;
    } else if (/^\[(?:tokens|checks|retry|warn|error|timeout|skipped)\]/.test(line)) {
      separated = true;
    } else if (
      /^\[\d{4}-\d\d-\d\dT.*\] run started$/.test(line) ||
      /^(?:routine|employee|company|model|cron|trigger|missed)=/.test(line)
    ) {
      // Runner header, including Runs which never reached an AI Model.
      continue;
    } else {
      if (separated) report = [];
      separated = false;
      report.push(raw);
    }
  }
  return report.join("\n");
}

export function runWorkSummary(
  run: Pick<Run, "status" | "logContent" | "outcomeNote">,
): string | null {
  // Partial text can sound conclusive before a timeout or interrupted tool.
  if (run.status !== "completed") return null;
  // New Runs retain the known final model response separately from streamed
  // commentary. JSON keeps the marker on one line even for multiline reports.
  const records = (run.logContent ?? "").slice(-TRANSCRIPT_TAIL_CHARS).split(/\r?\n/);
  for (let index = records.length - 1; index >= 0; index--) {
    if (!records[index].startsWith("[work-summary] ")) continue;
    try {
      const value: unknown = JSON.parse(records[index].slice("[work-summary] ".length));
      if (value === null || typeof value === "string") {
        return conciseWorkSummary(value ?? "") || conciseWorkSummary(run.outcomeNote ?? "");
      }
    } catch {
      // A truncated historical marker is not a final report.
    }
    return conciseWorkSummary(run.outcomeNote ?? "");
  }
  return (
    conciseWorkSummary(finalReport(run.logContent ?? "")) ||
    conciseWorkSummary(run.outcomeNote ?? "")
  );
}

/** Persist only a bounded, already redacted report alongside the full transcript. */
export function workSummaryLogLine(finalText: string): string {
  return `\n[work-summary] ${JSON.stringify(conciseWorkSummary(finalText))}`;
}
