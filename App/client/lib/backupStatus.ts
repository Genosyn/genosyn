import type {
  BackupCopy,
  BackupDestination,
  BackupHistoryItem,
  BackupSchedule,
  BackupVerification,
} from "./api";

/**
 * What Admin → Backups says, in plain words, worked out from what the server
 * sends. Kept apart from the page so every sentence it can show is pinned by
 * a test: the status summary at the top (are we backed up, when was the last
 * good backup, where does it live, is anything wrong), where each backup in
 * History lives, how each off-box destination is doing, and the one-line
 * summary of what sits behind Advanced.
 *
 * Nothing here guesses. A backup taken before copies were recorded says its
 * copies are "not recorded" until daily verification has looked, and a running
 * backup this server isn't writing is one that didn't finish.
 */

/** How a line reads: fine, worth a look, wrong, under way, or by the way. */
export type Tone = "ok" | "warn" | "error" | "working" | "muted";

/** Locale and time zone to format in; the browser's own when left out. */
export type FormatOptions = { locale?: string; timeZone?: string };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// ── Words ────────────────────────────────────────────────────────────────

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

// ── Times ────────────────────────────────────────────────────────────────

function parse(iso: string | Date): Date | null {
  const at = iso instanceof Date ? iso : new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** The calendar day `at` falls on, where it is being read. */
function dayNumber(at: Date, opts: FormatOptions): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: opts.timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return Math.round(Date.UTC(part("year"), part("month") - 1, part("day")) / DAY_MS);
}

/** "03:00" or "3:00 AM", as the reader's locale writes a time. */
export function formatClock(iso: string | Date, opts: FormatOptions = {}): string {
  const at = parse(iso);
  if (!at) return "";
  return at.toLocaleTimeString(opts.locale, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: opts.timeZone,
  });
}

/** "today", "yesterday", "tomorrow", "Mon 20 Oct", or "20 Oct 2025" for another year. */
export function formatDay(iso: string | Date, now: Date, opts: FormatOptions = {}): string {
  const at = parse(iso);
  if (!at) return "";
  const offset = dayNumber(at, opts) - dayNumber(now, opts);
  if (offset === 0) return "today";
  if (offset === -1) return "yesterday";
  if (offset === 1) return "tomorrow";
  const sameYear =
    new Intl.DateTimeFormat("en-US", { timeZone: opts.timeZone, year: "numeric" }).format(at) ===
    new Intl.DateTimeFormat("en-US", { timeZone: opts.timeZone, year: "numeric" }).format(now);
  return at.toLocaleDateString(opts.locale, {
    weekday: sameYear ? "short" : undefined,
    day: "numeric",
    month: "short",
    year: sameYear ? undefined : "numeric",
    timeZone: opts.timeZone,
  });
}

/** "Today at 03:00", "Mon 20 Oct at 03:00". */
export function formatWhen(iso: string | Date, now: Date, opts: FormatOptions = {}): string {
  return capitalize(formatWhenInline(iso, now, opts));
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago", "3 weeks ago", "4 months ago". */
export function formatAge(iso: string | Date, now: Date): string {
  const at = parse(iso);
  if (!at) return "";
  const elapsed = Math.max(0, now.getTime() - at.getTime());
  if (elapsed < MINUTE_MS) return "just now";
  if (elapsed < HOUR_MS) return `${plural(Math.floor(elapsed / MINUTE_MS), "minute")} ago`;
  if (elapsed < DAY_MS) return `${plural(Math.floor(elapsed / HOUR_MS), "hour")} ago`;
  const days = Math.floor(elapsed / DAY_MS);
  if (days < 14) return `${plural(days, "day")} ago`;
  if (days < 60) return `${plural(Math.floor(days / 7), "week")} ago`;
  return `${plural(Math.floor(days / 30), "month")} ago`;
}

/** An hour of the day as the reader's locale writes it: "03:00" or "3:00 AM". */
export function formatHour(hour: number, opts: FormatOptions = {}): string {
  return new Date(Date.UTC(2026, 0, 1, hour, 0)).toLocaleTimeString(opts.locale, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Every day at 03:00", "Every Monday at 03:00", "On day 1 of every month at 03:00". */
export function describeSchedule(
  schedule: Pick<BackupSchedule, "frequency" | "hour" | "dayOfWeek" | "dayOfMonth">,
  opts: FormatOptions = {},
): string {
  const at = formatHour(schedule.hour, opts);
  if (schedule.frequency === "weekly") {
    return `Every ${WEEKDAYS[schedule.dayOfWeek] ?? "week"} at ${at}`;
  }
  if (schedule.frequency === "monthly")
    return `On day ${schedule.dayOfMonth} of every month at ${at}`;
  return `Every day at ${at}`;
}

/**
 * When the schedule next fires, in the schedule's own time zone — the one its
 * hour is set in — so "Every day at 03:00 (UTC) · Next: Tomorrow at 03:00"
 * never reads as two different times. Null while it is off.
 */
export function formatNextRun(
  schedule: Pick<BackupSchedule, "enabled" | "nextRunAt" | "timeZone">,
  now: Date,
  opts: FormatOptions = {},
): string | null {
  if (!schedule.enabled || !schedule.nextRunAt) return null;
  try {
    return formatWhen(schedule.nextRunAt, now, { ...opts, timeZone: schedule.timeZone });
  } catch {
    // A zone this browser doesn't know: the reader's own is still true.
    return formatWhen(schedule.nextRunAt, now, opts);
  }
}

// ── Reasons ──────────────────────────────────────────────────────────────

/** A failure's reason in plain words, and the raw message behind it when they differ. */
export type PlainReason = { text: string; technical: string | null };

/** Raw errors from this server's own disk while a backup is written. */
const SERVER_REASONS: Array<[RegExp, string]> = [
  [
    /\bENOSPC\b|no space left on device/i,
    "The server ran out of disk space. Free some space, or keep fewer backups here under Advanced.",
  ],
  [
    /\bEDQUOT\b|disk quota exceeded/i,
    "The server's disk quota ran out. Free some space, or keep fewer backups here under Advanced.",
  ],
  [/\bEROFS\b|read-only file system/i, "The backup folder is on a disk Genosyn can only read."],
  [
    /\bEACCES\b|\bEPERM\b|permission denied|operation not permitted/i,
    "Genosyn isn't allowed to write to the backup folder.",
  ],
  [/\bEIO\b|input\/output error/i, "The disk reported an error while the backup was written."],
  [
    /\bEMFILE\b|\bENFILE\b|too many open files/i,
    "Too many files were open at once. Try again, or restart Genosyn.",
  ],
  [/\bENOMEM\b|out of memory/i, "The server ran out of memory while writing the backup."],
  [/\bENOENT\b|no such file or directory/i, "A file went missing while the backup was written."],
];

/** Raw errors from reaching, or writing to, an off-box destination. */
const DESTINATION_REASONS: Array<[RegExp, string]> = [
  [
    /\bENOSPC\b|no space left on device/i,
    "The destination ran out of space. Free some there, or turn on off-box retention under Advanced.",
  ],
  [/\bEDQUOT\b|disk quota exceeded/i, "The destination's quota ran out."],
  [/\bEROFS\b|read-only file system/i, "The destination can only be read, not written to."],
  [
    /All configured authentication methods failed|permission denied \(publickey/i,
    "The destination refused the username, password or key.",
  ],
  [
    /\bEACCES\b|\bEPERM\b|permission denied|operation not permitted/i,
    "Genosyn isn't allowed to write to the destination's folder.",
  ],
  [/\bENOTDIR\b|not a directory|\bEEXIST\b/i, "The destination's folder is a file, not a folder."],
  [/\bENOTFOUND\b|\bEAI_AGAIN\b|getaddrinfo/i, "The destination's host name couldn't be found."],
  [
    /\bECONNREFUSED\b|connection refused/i,
    "The destination refused the connection. Check its host and port.",
  ],
  [
    /\bEHOSTUNREACH\b|\bENETUNREACH\b|host is unreachable|network is unreachable/i,
    "The destination couldn't be reached on the network.",
  ],
  [
    /\bETIMEDOUT\b|timed out while waiting for handshake|keepalive timeout/i,
    "The destination stopped answering.",
  ],
  [
    /\bECONNRESET\b|\bEPIPE\b|socket hang up|connection lost before handshake/i,
    "The connection to the destination dropped.",
  ],
  [/\bEIO\b|input\/output error/i, "The destination reported a read or write error."],
  [
    /\bENOENT\b|no such file or directory/i,
    "The destination's folder isn't there. If it is a mounted share, is it still mounted?",
  ],
  [/NT_STATUS_[A-Z_]+/, "The SMB share refused the request."],
];

/**
 * What went wrong, in words an owner reads: "ENOSPC: no space left on device,
 * write" is "The server ran out of disk space…", with the raw message kept as
 * the technical detail. Genosyn's own messages are sentences already and pass
 * through untouched. Null when there is no reason at all.
 */
export function plainReason(
  raw: string | null | undefined,
  where: "server" | "destination",
): PlainReason | null {
  const message = (raw ?? "").trim();
  if (!message) return null;
  for (const [pattern, text] of where === "server" ? SERVER_REASONS : DESTINATION_REASONS) {
    if (pattern.test(message)) return { text, technical: message };
  }
  return { text: message, technical: null };
}

/** `text` as one sentence: exactly one closing full stop. */
function asSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** What each kind of backup is, for the label beside it. */
export const KIND_HINT: Record<BackupHistoryItem["kind"], string> = {
  scheduled: "Taken on the schedule set under Automatic backups.",
  manual: "Taken when someone pressed Back up now.",
  uploaded: "Uploaded under Advanced, from a backup made elsewhere.",
};

// ── One backup ───────────────────────────────────────────────────────────

export const KIND_LABEL: Record<BackupHistoryItem["kind"], string> = {
  scheduled: "Automatic",
  manual: "Manual",
  uploaded: "Uploaded",
};

function inFlight(copy: Pick<BackupCopy, "status">): boolean {
  return copy.status === "pending" || copy.status === "copying";
}

/** Whether anything is under way that the page should follow. */
export function isBusy(backups: BackupHistoryItem[]): boolean {
  return backups.some((backup) => backup.inProgress || backup.copies.some(inFlight));
}

/**
 * The backup this server's run is on — being written, or copied off-box once
 * written — if any. Back up now waits for it: a second press would only join it.
 */
export function activeRun(backups: BackupHistoryItem[]): BackupHistoryItem | null {
  return backups.find((backup) => backup.inProgress) ?? null;
}

/** Where the archive itself is. */
export type ServerPlace = {
  state: "on" | "gone" | "writing" | "unfinished" | "failed";
  label: string;
  tone: Tone;
};

export function serverPlace(backup: BackupHistoryItem): ServerPlace {
  if (backup.status === "failed") return { state: "failed", label: "Failed", tone: "error" };
  if (backup.status === "running") {
    return backup.inProgress
      ? { state: "writing", label: "Being written…", tone: "working" }
      : { state: "unfinished", label: "Didn't finish", tone: "error" };
  }
  return backup.onServer
    ? { state: "on", label: "On this server", tone: "ok" }
    : { state: "gone", label: "No longer on this server", tone: "muted" };
}

export type CopyState =
  | BackupCopy["status"]
  /** Recorded all along, and never sent there. */
  | "not-copied"
  /** Taken before copies were recorded, and verification hasn't looked. */
  | "not-recorded";

/** One backup's copy on one destination, in words. */
export type CopyView = {
  destinationId: string;
  name: string;
  state: CopyState;
  tone: Tone;
  /** "On Synology", "Copying to Synology…". */
  label: string;
  /** The reason it isn't there, or when it got there; null when the label says it all. */
  detail: string | null;
  /** The destination's raw message, when `detail` puts it in plain words. */
  technical: string | null;
  /** Offer Try again: the copy didn't arrive, and the backup is still here to send. */
  canRetry: boolean;
};

/**
 * Each off-box copy of `backup`, in the destinations' own order: every
 * destination with a record of this backup, and every enabled one without —
 * which was never sent there, or, for a backup from before copies were
 * recorded, isn't known. A paused destination with no record says nothing
 * worth saying, so it is left out.
 */
export function copyViews(
  backup: BackupHistoryItem,
  destinations: BackupDestination[],
  now: Date,
  opts: FormatOptions = {},
): CopyView[] {
  if (backup.status !== "completed") return [];
  const records = new Map(backup.copies.map((copy) => [copy.destinationId, copy]));
  const views: CopyView[] = [];
  for (const dest of destinations) {
    const copy = records.get(dest.id);
    if (copy) {
      views.push(recordedCopy(backup, dest, copy, now, opts));
    } else if (dest.enabled) {
      views.push(unrecordedCopy(backup, dest));
    }
  }
  return views;
}

function recordedCopy(
  backup: BackupHistoryItem,
  dest: BackupDestination,
  copy: BackupCopy,
  now: Date,
  opts: FormatOptions,
): CopyView {
  const base = { destinationId: dest.id, name: dest.name, canRetry: false, technical: null };
  switch (copy.status) {
    case "copied":
      return {
        ...base,
        state: "copied",
        tone: "ok",
        label: `On ${dest.name}`,
        detail: copy.copiedAt
          ? `Copied ${formatWhenInline(copy.copiedAt, now, opts)}`
          : copy.checkedAt
            ? `Found there by daily verification ${formatWhenInline(copy.checkedAt, now, opts)}`
            : null,
      };
    case "copying":
      return {
        ...base,
        state: "copying",
        tone: "working",
        label: `Copying to ${dest.name}…`,
        detail: copy.startedAt ? `Started ${formatAge(copy.startedAt, now)}` : null,
      };
    case "pending":
      return {
        ...base,
        state: "pending",
        tone: "working",
        label: `Waiting to copy to ${dest.name}`,
        detail: "It goes as soon as the copy before it finishes.",
      };
    case "failed": {
      const reason = plainReason(copy.error, "destination");
      return {
        ...base,
        state: "failed",
        tone: "error",
        label: `Not on ${dest.name}: the copy failed`,
        detail: reason?.text ?? null,
        technical: reason?.technical ?? null,
        canRetry: backup.onServer,
      };
    }
    case "missing":
      return {
        ...base,
        state: "missing",
        tone: "warn",
        label: `Not on ${dest.name}`,
        detail: copy.checkedAt
          ? `Daily verification didn't find it there ${formatWhenInline(copy.checkedAt, now, opts)}.`
          : null,
        canRetry: backup.onServer,
      };
    case "removed":
    default:
      return {
        ...base,
        state: "removed",
        tone: "muted",
        label: `Removed from ${dest.name}`,
        detail: "Off-box retention deleted it there.",
      };
  }
}

function unrecordedCopy(backup: BackupHistoryItem, dest: BackupDestination): CopyView {
  const base = {
    destinationId: dest.id,
    name: dest.name,
    canRetry: false,
    technical: null,
    tone: "muted" as const,
  };
  if (!backup.copiesTracked) {
    return {
      ...base,
      state: "not-recorded",
      label: `${dest.name}: not recorded`,
      detail:
        "Taken before Genosyn recorded where copies go. Verify now, under Advanced, looks on every destination.",
    };
  }
  let detail: string | null = null;
  if (new Date(dest.createdAt).getTime() > new Date(backup.createdAt).getTime()) {
    detail = `Taken before ${dest.name} was added.`;
  } else if (backup.kind === "uploaded") {
    detail = "Uploaded backups aren't copied off-box on their own.";
  }
  return { ...base, state: "not-copied", label: `Not copied to ${dest.name}`, detail };
}

/** {@link formatWhen} mid-sentence: "today at 03:00", "Sun 11 Oct at 03:00". */
export function formatWhenInline(iso: string | Date, now: Date, opts: FormatOptions = {}): string {
  const at = parse(iso);
  if (!at) return "";
  return `${formatDay(at, now, opts)} at ${formatClock(at, opts)}`;
}

/**
 * Where a backup lives, as one sentence: "On this server and Synology.",
 * "Only on this server: the copy to Synology failed.", "Only on Synology: it
 * is no longer on this server."
 */
export function locationSentence(backup: BackupHistoryItem, copies: CopyView[]): string {
  if (backup.status === "failed") {
    return `Not saved: ${plainReason(backup.errorMessage, "server")?.text ?? "no reason was recorded"}`;
  }
  if (backup.status === "running") {
    return backup.inProgress
      ? "Being written on this server…"
      : "Genosyn stopped while writing it, so there is nothing to restore.";
  }
  const names = (state: CopyState | CopyState[]) => {
    const states = Array.isArray(state) ? state : [state];
    return copies.filter((copy) => states.includes(copy.state)).map((copy) => copy.name);
  };
  const copied = names("copied");
  const moving = names(["copying", "pending"]);
  const failed = names("failed");
  const missing = names("missing");
  const unknown = names("not-recorded");
  if (backup.onServer) {
    if (copied.length > 0) return `On ${joinNames(["this server", ...copied])}.`;
    if (moving.length > 0) return `On this server, and being copied to ${joinNames(moving)}.`;
    if (failed.length > 0) return `Only on this server: the copy to ${joinNames(failed)} failed.`;
    if (missing.length > 0) return `Only on this server: it is no longer on ${joinNames(missing)}.`;
    if (unknown.length > 0) return "On this server. Where its off-box copies went wasn't recorded.";
    return "Only on this server.";
  }
  if (copied.length > 0) return `Only on ${joinNames(copied)}: it is no longer on this server.`;
  if (unknown.length > 0) {
    return "No longer on this server, and where its off-box copies went wasn't recorded.";
  }
  return "No longer on this server, and not on any off-box destination.";
}

// ── Destinations ─────────────────────────────────────────────────────────

export type DestinationHealth = {
  tone: Tone;
  label: string;
  /** The destination's own reason when something is wrong, in plain words. */
  detail: string | null;
  /** The raw message, when `detail` puts it in plain words. */
  technical: string | null;
  /** Backups aren't reaching it: the status summary says so too. */
  failing: boolean;
};

export function destinationHealth(
  dest: BackupDestination,
  now: Date,
  opts: FormatOptions = {},
): DestinationHealth {
  const quiet = { detail: null, technical: null };
  if (dest.configError) {
    return {
      tone: "error",
      label: "Its settings can't be read",
      detail:
        "Its saved password can't be decrypted (was the encryption key changed?). Edit it and enter the password again.",
      technical: null,
      failing: dest.enabled,
    };
  }
  if (!dest.enabled) {
    return {
      tone: "muted",
      label: "Paused",
      detail: "New backups aren't copied here.",
      technical: null,
      failing: false,
    };
  }
  const reason = plainReason(dest.lastError, "destination");
  const lastCopy = dest.lastSyncedAt
    ? `the last copy arrived ${formatAge(dest.lastSyncedAt, now)}`
    : "no copy has arrived yet";
  if (dest.failingSince) {
    return {
      tone: "error",
      label: `Copies failing since ${formatWhenInline(dest.failingSince, now, opts)}`,
      detail: [reason ? asSentence(reason.text) : null, asSentence(capitalize(lastCopy))]
        .filter(Boolean)
        .join(" "),
      technical: reason?.technical ?? null,
      failing: true,
    };
  }
  if (dest.lastStatus === "error") {
    return {
      tone: "error",
      label: "Last test failed",
      detail: reason?.text ?? null,
      technical: reason?.technical ?? null,
      failing: true,
    };
  }
  if (dest.lastSyncedAt) {
    return {
      tone: "ok",
      label: `Working · last copy ${formatAge(dest.lastSyncedAt, now)}`,
      ...quiet,
      failing: false,
    };
  }
  if (dest.lastStatus === "ok") {
    return { tone: "ok", label: "Connected · nothing copied yet", ...quiet, failing: false };
  }
  return { tone: "muted", label: "Not tested yet", ...quiet, failing: false };
}

// ── The status summary ───────────────────────────────────────────────────

export type BackupIssue = { key: string; tone: "error" | "warn"; text: string };

export type BackupSummary = {
  tone: "ok" | "warn" | "error" | "working";
  headline: string;
  /** What is under way right now, if anything. */
  activity: string | null;
  /** The newest backup there is to restore from, here or off-box. */
  lastGood: BackupHistoryItem | null;
  lastGoodText: string;
  whereText: string;
  scheduleText: string;
  nextText: string | null;
  verifiedText: string;
  issues: BackupIssue[];
};

/** Verification problems shown in the summary; the rest are under Advanced. */
const MAX_VERIFICATION_ISSUES = 3;

/** How old the last good backup may be, past the schedule's own period, before it's worth saying. */
const STALE_GRACE_MS = 12 * HOUR_MS;

const PERIOD_MS: Record<BackupSchedule["frequency"], number> = {
  daily: DAY_MS,
  weekly: 7 * DAY_MS,
  monthly: 31 * DAY_MS,
};

/**
 * The status summary at the top of the page. `destinations`, `schedule` and
 * `verification` may still be loading (or have failed to): the summary says
 * what it can from the rest and never invents the missing part.
 */
export function summarizeBackups(
  input: {
    backups: BackupHistoryItem[];
    destinations: BackupDestination[] | null;
    schedule: BackupSchedule | null;
    /** undefined while loading; null before the first verification. */
    verification: BackupVerification | null | undefined;
    now: Date;
  },
  opts: FormatOptions = {},
): BackupSummary {
  const { backups, destinations, schedule, verification, now } = input;
  // Being written. A run copying its finished backup off-box counts as copying.
  const running =
    backups.find((backup) => backup.inProgress && backup.status === "running") ?? null;
  const copying = backups.find((backup) => backup.copies.some(inFlight)) ?? null;
  const lastGood =
    backups.find(
      (backup) =>
        backup.status === "completed" &&
        (backup.onServer || backup.copies.some((copy) => copy.status === "copied")),
    ) ?? null;

  const issues: BackupIssue[] = [];
  const newerThanLastGood = (backup: BackupHistoryItem) =>
    !lastGood || new Date(backup.createdAt).getTime() > new Date(lastGood.createdAt).getTime();
  const latest = backups.find((backup) => !backup.inProgress && backup.kind !== "uploaded");
  if (latest && newerThanLastGood(latest)) {
    if (latest.status === "failed") {
      issues.push({
        key: "last-failed",
        tone: "error",
        text: `The last backup failed: ${plainReason(latest.errorMessage, "server")?.text ?? "no reason was recorded"}`,
      });
    } else if (latest.status === "running") {
      issues.push({
        key: "last-unfinished",
        tone: "error",
        text: "The last backup didn't finish: Genosyn stopped while writing it.",
      });
    }
  }

  for (const dest of destinations ?? []) {
    if (!dest.enabled) continue;
    if (dest.configError) {
      issues.push({
        key: `settings:${dest.id}`,
        tone: "error",
        text: `${dest.name}'s settings can't be read. Edit it and enter its password again.`,
      });
    } else if (dest.failingSince || dest.lastStatus === "error") {
      const since = dest.failingSince
        ? ` since ${formatWhenInline(dest.failingSince, now, opts)}`
        : "";
      const reason = plainReason(dest.lastError, "destination");
      issues.push({
        key: `failing:${dest.id}`,
        tone: "error",
        text: `Backups aren't reaching ${dest.name}${since}${reason ? `: ${reason.text}` : "."}`,
      });
    }
  }

  const problems = (verification?.areas ?? []).flatMap((area) =>
    area.problems.filter((problem) => problem.key !== "schedule-off"),
  );
  for (const problem of problems.slice(0, MAX_VERIFICATION_ISSUES)) {
    issues.push({
      key: `verification:${problem.key}`,
      tone: problem.severity,
      text: problem.message,
    });
  }
  if (problems.length > MAX_VERIFICATION_ISSUES) {
    const more = problems.length - MAX_VERIFICATION_ISSUES;
    issues.push({
      key: "verification:more",
      tone: problems.slice(MAX_VERIFICATION_ISSUES).some((p) => p.severity === "error")
        ? "error"
        : "warn",
      text: `Daily verification found ${plural(more, "more problem")}: see Daily verification under Advanced.`,
    });
  }

  if (destinations && destinations.length === 0) {
    issues.push({
      key: "no-destination",
      tone: "warn",
      text: "Backups are only on this server. If its disk fails, they go with it: add an off-box destination.",
    });
  } else if (destinations && destinations.every((dest) => !dest.enabled)) {
    issues.push({
      key: "all-paused",
      tone: "warn",
      text: "Every off-box destination is paused, so new backups stay only on this server.",
    });
  }

  if (schedule && !schedule.enabled) {
    issues.push({
      key: "schedule-off",
      tone: "warn",
      text: "Automatic backups are off. Nothing is backed up unless someone presses Back up now.",
    });
  } else if (schedule && lastGood && !running) {
    const age = now.getTime() - new Date(lastGood.createdAt).getTime();
    if (age > PERIOD_MS[schedule.frequency] + STALE_GRACE_MS) {
      issues.push({
        key: "stale",
        tone: "warn",
        text: `The last good backup was taken ${formatAge(lastGood.createdAt, now)}.`,
      });
    }
  }

  const errors = issues.filter((issue) => issue.tone === "error").length;
  const warnings = issues.length - errors;
  let tone: BackupSummary["tone"];
  let headline: string;
  if (running) {
    tone = "working";
    headline = "Backing up now…";
  } else if (!lastGood) {
    tone = "error";
    headline = "Not backed up yet";
  } else if (errors > 0) {
    tone = "error";
    headline = "Backups need attention";
  } else if (copying) {
    tone = "working";
    headline = "Backed up, and copying it off-box now";
  } else if (warnings > 0) {
    tone = "warn";
    headline =
      warnings === 1 ? "Backed up, with a warning" : `Backed up, with ${warnings} warnings`;
  } else {
    tone = "ok";
    headline = "Your data is backed up";
  }

  let activity: string | null = null;
  if (running) {
    activity = `Started ${formatAge(running.createdAt, now)}. It carries on if you leave this page.`;
  } else if (copying) {
    const names = copying.copies
      .filter(inFlight)
      .map((copy) => destinations?.find((dest) => dest.id === copy.destinationId)?.name)
      .filter((name): name is string => Boolean(name));
    activity = names.length
      ? `Copying the backup from ${formatWhenInline(copying.createdAt, now, opts)} to ${joinNames(names)}.`
      : null;
  }

  const verifiedProblems = (verification?.areas ?? []).flatMap((area) => area.problems).length;
  return {
    tone,
    headline,
    activity,
    lastGood,
    lastGoodText: lastGood
      ? `${formatWhen(lastGood.createdAt, now, opts)} (${formatAge(lastGood.createdAt, now)}) · ${formatBytes(lastGood.sizeBytes)}`
      : "None yet",
    whereText: !lastGood
      ? "Nowhere yet"
      : destinations
        ? locationSentence(lastGood, copyViews(lastGood, destinations, now, opts))
        : // Which destinations hold it can't be named until they load.
          lastGood.onServer
          ? "On this server."
          : "No longer on this server.",
    scheduleText: !schedule
      ? "…"
      : schedule.enabled
        ? `${describeSchedule(schedule, opts)} (${schedule.timeZone})`
        : "Off",
    nextText: schedule ? formatNextRun(schedule, now, opts) : null,
    verifiedText:
      verification === undefined
        ? "…"
        : verification === null
          ? "Not run yet"
          : `${formatWhen(verification.verifiedAt, now, opts)}: ${
              verifiedProblems === 0
                ? "every backup in place"
                : `${plural(verifiedProblems, "problem")} found`
            }`,
    issues,
  };
}

// ── Advanced ─────────────────────────────────────────────────────────────

/**
 * What the closed Advanced disclosure says is inside: both retention policies
 * and how daily verification last went. "Keep 30 days here, everything
 * off-box · verified 2 hours ago".
 */
export function advancedSummary(
  schedule: BackupSchedule | null,
  verification: BackupVerification | null | undefined,
  now: Date,
): string {
  const parts: string[] = [];
  if (schedule) {
    const here = schedule.retentionEnabled
      ? `Keep ${plural(schedule.retentionDays, "day")} here`
      : "Keep everything here";
    const offBox = schedule.offBoxRetentionEnabled
      ? `${plural(schedule.offBoxRetentionDays, "day")} off-box`
      : "everything off-box";
    parts.push(`${here}, ${offBox}`);
  }
  if (verification === null) {
    parts.push("not verified yet");
  } else if (verification) {
    const problems = verification.areas.flatMap((area) => area.problems).length;
    parts.push(
      problems > 0
        ? `verification found ${plural(problems, "problem")}`
        : `verified ${formatAge(verification.verifiedAt, now)}`,
    );
  }
  return capitalize(parts.join(" · "));
}

/** One retention policy, in a sentence. */
export function retentionSentence(enabled: boolean, days: number): string {
  return enabled
    ? `Backups older than ${plural(days, "day")} are deleted`
    : "Backups are kept until you delete them";
}
