/**
 * What a Routine has configured beyond the basics, as one line.
 *
 * The routine page keeps Name, Schedule and the rest of the basics up front and
 * tucks everything else behind an "Advanced" disclosure (and, on the Overview,
 * behind "More details"). A closed disclosure must not hide a setting, so its
 * header carries this line: "Approval required · 2 Checks · 1 Trigger · Webhook
 * on". Only what differs from the defaults is named; when nothing does, the
 * line says so.
 *
 * Every input is optional, and an omitted one is simply not part of the
 * summary. The Settings tab leaves out the outcome check (acceptance criteria
 * are one of its basics), the Overview leaves out Checks and Triggers (it never
 * loads them). `null` for a count means "being loaded": the line is not allowed
 * to claim "all defaults" while it might still be about to learn of two Checks.
 */

/** The defaults the server gives a new Routine. */
export const DEFAULT_TIMEOUT_SEC = 3600;
export const DEFAULT_RETRY_BACKOFF_SEC = 60;

export type RoutineAdvancedValues = {
  /** Where the Routine is filed (the folder's path); null or empty when unfiled. */
  folderPath?: string | null;
  timeoutSec?: number;
  requiresApproval?: boolean;
  /** Whether acceptance criteria are set, i.e. whether the outcome check runs. */
  outcomeCheck?: boolean;
  /** How many Checks it has. `null` while they load. */
  checks?: number | null;
  /** Pinned to one of the employee's models rather than inheriting the active one. */
  modelPinned?: boolean;
  /** `null` inherits the employee's setting; a boolean forces it for this Routine. */
  browserEnabledOverride?: boolean | null;
  /** Runs in a Member browser instead of Genosyn's own. */
  memberBrowser?: boolean;
  catchUpPolicy?: "once" | "skip";
  maxAttempts?: number;
  retryBackoffSec?: number;
  retryOnTimeout?: boolean;
  /** How many Triggers it has. `null` while they load. */
  triggers?: number | null;
  webhookEnabled?: boolean;
};

export type RoutineAdvancedSummary = {
  /** One phrase per non-default setting, in the order the page shows them. */
  items: string[];
  /** A count the summary wants is still loading, so more items may follow. */
  pending: boolean;
};

/** How a duration reads in a summary and on the Overview: `2h`, `90m`, `45s`. */
export function formatTimeout(sec: number): string {
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function summarizeRoutineAdvanced(values: RoutineAdvancedValues): RoutineAdvancedSummary {
  const items: string[] = [];
  let pending = false;

  const folderPath = values.folderPath?.trim();
  if (folderPath) items.push(`Filed in ${folderPath}`);

  if (values.timeoutSec !== undefined && values.timeoutSec !== DEFAULT_TIMEOUT_SEC) {
    items.push(`Timeout ${formatTimeout(values.timeoutSec)}`);
  }
  if (values.requiresApproval) items.push("Approval required");
  if (values.outcomeCheck) items.push("Outcome check on");

  if (values.checks === null) pending = true;
  else if (values.checks !== undefined && values.checks > 0) {
    items.push(count(values.checks, "Check"));
  }

  if (values.modelPinned) items.push("Pinned model");
  if (values.browserEnabledOverride === true) items.push("Browser forced on");
  if (values.browserEnabledOverride === false) items.push("Browser forced off");
  if (values.memberBrowser) items.push("Connected browser");

  if (values.catchUpPolicy === "skip") items.push("Skips late catch-up");
  // Backoff and retrying timeouts do nothing at one attempt, and the page
  // disables both inputs there, so they only count once there are retries.
  if (values.maxAttempts !== undefined && values.maxAttempts > 1) {
    const backoff = values.retryBackoffSec ?? DEFAULT_RETRY_BACKOFF_SEC;
    items.push(
      backoff === DEFAULT_RETRY_BACKOFF_SEC
        ? `${values.maxAttempts} attempts`
        : `${values.maxAttempts} attempts, ${formatTimeout(backoff)} backoff`,
    );
    if (values.retryOnTimeout) items.push("Retries timeouts");
  }

  if (values.triggers === null) pending = true;
  else if (values.triggers !== undefined && values.triggers > 0) {
    items.push(count(values.triggers, "Trigger"));
  }

  if (values.webhookEnabled) items.push("Webhook on");

  return { items, pending };
}

/** The summary as the single line a collapsed disclosure shows. */
export function describeRoutineAdvanced(values: RoutineAdvancedValues): string {
  const { items, pending } = summarizeRoutineAdvanced(values);
  if (items.length > 0) return items.join(" · ");
  return pending ? "Loading…" : "All defaults";
}
