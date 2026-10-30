/**
 * The step model of a chat turn — what an AI Employee did while it answered a
 * Member, as the server records it and the chat renders it.
 *
 * Shared by both sides so a step reads the same live, after a reload, and in
 * a conversation reopened next week: the server writes the redacted events
 * (`services/chatTurnActivity.ts`), and the chat derives its labels from the
 * same function the server used for each event's one-line summary. Labels are
 * computed from the stored tool name and its redacted arguments rather than
 * frozen into the row, so a better label applies to history too.
 */

/**
 * What one recorded event is.
 *
 *   - `turn_started`  a worker picked the turn up (`attempt` > 1 after a
 *                     server restart or a Retry).
 *   - `tool_use`      the employee called a tool; its redacted arguments.
 *   - `tool_result`   that call returned, paired by `callId`.
 *   - `reasoning`     a chunk of the AI Model's thinking summary, when the
 *                     runtime exposes one.
 *   - `progress`      the employee's own `report_progress` milestone.
 *   - `waiting`       the turn started (or stopped) waiting on something
 *                     outside the employee — see {@link KNOWN_WAIT_CAUSES}.
 *   - `notice`        something worth a quiet line: a compaction, a backup
 *                     key, a retry requested by the Member.
 *   - `stopped`       a Member stopped the turn.
 *   - `turn_finished` the turn ended, with its summary.
 */
export const CHAT_ACTIVITY_KINDS = [
  "turn_started",
  "tool_use",
  "tool_result",
  "reasoning",
  "progress",
  "waiting",
  "notice",
  "stopped",
  "turn_finished",
] as const;
export type ChatActivityKind = (typeof CHAT_ACTIVITY_KINDS)[number];

/** One recorded thing that happened in a chat turn, as it travels on the wire. */
export type ChatActivityEvent = {
  /** Position in the turn, across attempts. Readers resume "after N". */
  ordinal: number;
  attempt: number;
  kind: ChatActivityKind;
  /** The tool for tool events, the cause for `waiting`, the code for `notice`. */
  name: string;
  /** Pairs a `tool_result` with its `tool_use`. Empty for other kinds. */
  callId: string;
  /** One line a person can read: server-written and already redacted. */
  summary: string;
  /** Bounded, redacted structure; see the `*Detail` types below. */
  detail: Record<string, unknown> | null;
  isError: boolean;
  /** When it happened, ISO 8601 with milliseconds. */
  at: string;
};

export type TurnStartedDetail = { attempt: number; reason: "start" | "resume" | "retry" };
export type ToolUseDetail = { input: Record<string, unknown> | null; worker?: string | null };
export type ToolResultDetail = {
  output: string | null;
  durationMs: number | null;
  /** What the result was about, from its own fields: "“Q3 renewal” · from ana@acme.com". */
  hint?: string | null;
  images?: number;
  /** The call was held for a human: an Approval is waiting. */
  approval?: { id: string | null };
  worker?: string | null;
};
export type ReasoningDetail = { text: string; block: string };
export type ProgressDetail = { percent: number; label: string };
export type WaitingDetail = {
  cause: string;
  state: "waiting" | "done";
  /** Server-written words for a cause the chat does not know yet. */
  label: string;
  /** For a retry backoff: when the next attempt starts. */
  until?: string | null;
  attempt?: number | null;
  maxAttempts?: number | null;
  reason?: string | null;
};
export type NoticeDetail = { code: string; label: string };
export type TurnFinishedDetail = TurnActivitySummary;

/**
 * Why a turn can be waiting rather than working. The chat has words for each;
 * any other cause still renders, with the label the server wrote, so a new
 * waiting state (an AI Model outage, say) needs no client change to show up.
 *
 *   - `thread_busy`   another reply in this conversation is still running.
 *   - `model_lock`    a ChatGPT-subscription AI Model answers one turn at a
 *                     time, across every AI Employee that uses it.
 *   - `model_retry`   the AI Model's service failed and the request is being
 *                     retried after a backoff.
 *   - `model_outage`  a self-hosted AI Model stopped answering, and the
 *                     turn's request is being held until it answers again.
 *   - `model_unavailable` the turn's AI Model is unavailable — its service is
 *                     down, failing, overloaded or rate-limited — so the
 *                     message waits, unclaimed, and is answered automatically
 *                     when the model is back (`server/services/modelAvailability.ts`).
 *   - `model_resuming` the AI Model is back, and the Workspace replies that
 *                     waited for it start one at a time rather than all at
 *                     once (the recovery pacing Routine Runs follow too).
 *
 * A turn resumed after a server restart is not a wait: its `turn_started`
 * event says so (`reason: "resume"`), as it says when a turn an AI Model
 * outage cut short starts again (`reason: "model_back"`).
 */
export const KNOWN_WAIT_CAUSES = [
  "thread_busy",
  "model_lock",
  "model_retry",
  "model_outage",
  "model_unavailable",
  "model_resuming",
] as const;

/** The waiting cause of a message whose AI Model is unavailable. */
export const MODEL_UNAVAILABLE_WAIT_CAUSE = "model_unavailable";

/**
 * What the chat says while a message waits for its unavailable AI Model. The
 * server records it with the wait; the chat shows the server's words.
 */
export const MODEL_UNAVAILABLE_WAIT_LABEL =
  "The AI Model is unavailable — this will be answered when it is back";

/** The waiting cause of a reply taking its turn after its AI Model came back. */
export const MODEL_RESUMING_WAIT_CAUSE = "model_resuming";

/** What the chat says while a reply that waited takes its turn to start again. */
export const MODEL_RESUMING_WAIT_LABEL =
  "The AI Model is back — the replies that waited start one at a time";

/**
 * What a finished turn says when collapsed: "Worked for 2m 14s · 9 steps".
 * Persisted on the reply (`ConversationMessage.activityJson`) so a transcript
 * renders it without reading a single event.
 */
export type TurnActivitySummary = {
  /** When the turn was accepted, ISO. */
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /** Tool calls. */
  steps: number;
  failed: number;
  /** Calls held for a human's Approval. */
  held: number;
  /** Time spent waiting on something outside the employee. */
  waitedMs: number;
  /** Whether any thinking summary was recorded. */
  reasoning: boolean;
  /** Ordinal of the last event, so a reader knows how far to read. */
  lastOrdinal: number;
  /** How the turn ended — the reply's status. */
  status: string;
};

/** Parse a stored summary, tolerating rows written before a field existed. */
export function parseTurnActivitySummary(
  raw: string | null | undefined,
): TurnActivitySummary | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<TurnActivitySummary> | null;
    if (!value || typeof value !== "object") return null;
    if (typeof value.startedAt !== "string" || typeof value.endedAt !== "string") return null;
    const num = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0);
    return {
      startedAt: value.startedAt,
      endedAt: value.endedAt,
      durationMs: num(value.durationMs),
      steps: num(value.steps),
      failed: num(value.failed),
      held: num(value.held),
      waitedMs: num(value.waitedMs),
      reasoning: value.reasoning === true,
      lastOrdinal: num(value.lastOrdinal),
      status: typeof value.status === "string" ? value.status : "ok",
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────── durations ───────────────────────────────

/**
 * A step's duration: "0.4s", "4.2s", "42s", "2m 14s", "1h 3m". Tenths only
 * below ten seconds, where they are the difference between instant and slow.
 */
export function formatStepDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 10_000) return `${(Math.max(ms, 100) / 1000).toFixed(1)}s`;
  return formatElapsed(ms);
}

/** A running clock: "0s", "42s", "2m 14s", "1h 3m". Whole seconds, never tenths. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** "Worked for 2m 14s · 9 steps · 1 failed" — the collapsed line of a finished turn. */
export function describeTurnSummary(summary: TurnActivitySummary): string {
  const parts = [`Worked for ${formatElapsed(summary.durationMs)}`];
  if (summary.steps > 0) parts.push(`${summary.steps} ${summary.steps === 1 ? "step" : "steps"}`);
  if (summary.failed > 0) parts.push(`${summary.failed} failed`);
  if (summary.held > 0) parts.push(`${summary.held} waiting for approval`);
  return parts.join(" · ");
}

// ──────────────────────────────── labels ────────────────────────────────

/**
 * What a tool step is about, for its icon. Kept small on purpose: the label
 * carries the meaning, the icon only helps the eye find kinds of work.
 */
export type ChatToolFamily =
  | "command"
  | "file"
  | "search"
  | "web"
  | "browser"
  | "mail"
  | "finance"
  | "data"
  | "message"
  | "plan"
  | "people"
  | "code"
  | "tool";

export type ChatToolDescription = {
  family: ChatToolFamily;
  /** While it runs: "Searching Banking transactions". */
  active: string;
  /** Once it returned: "Searched Banking transactions". */
  done: string;
  /** The salient argument, short: "“spot instances”", "npm test", "example.com". */
  target: string;
  /** Render {@link target} as code (a command or a path). */
  code: boolean;
  /** The parallel worker that made the call, when one did. */
  worker: string | null;
};

type Verb = { active: string; done: string };

/** The tool's first word, as the step's verb. */
const VERBS: Record<string, Verb> = {
  add: { active: "Adding", done: "Added" },
  answer: { active: "Answering", done: "Answered" },
  archive: { active: "Archiving", done: "Archived" },
  ask: { active: "Asking", done: "Asked" },
  attach: { active: "Attaching", done: "Attached" },
  backfill: { active: "Backfilling", done: "Backfilled" },
  cancel: { active: "Canceling", done: "Canceled" },
  categorize: { active: "Categorizing", done: "Categorized" },
  check: { active: "Checking", done: "Checked" },
  close: { active: "Closing", done: "Closed" },
  complete: { active: "Completing", done: "Completed" },
  convert: { active: "Converting", done: "Converted" },
  create: { active: "Creating", done: "Created" },
  decide: { active: "Deciding", done: "Decided" },
  decline: { active: "Declining", done: "Declined" },
  delete: { active: "Deleting", done: "Deleted" },
  dismiss: { active: "Dismissing", done: "Dismissed" },
  download: { active: "Downloading", done: "Downloaded" },
  draft: { active: "Drafting", done: "Drafted" },
  edit: { active: "Editing", done: "Edited" },
  enroll: { active: "Enrolling", done: "Enrolled" },
  export: { active: "Exporting", done: "Exported" },
  fetch: { active: "Fetching", done: "Fetched" },
  fill: { active: "Filling", done: "Filled" },
  find: { active: "Finding", done: "Found" },
  get: { active: "Reading", done: "Read" },
  import: { active: "Importing", done: "Imported" },
  install: { active: "Installing", done: "Installed" },
  invite: { active: "Inviting", done: "Invited" },
  issue: { active: "Issuing", done: "Issued" },
  link: { active: "Linking", done: "Linked" },
  list: { active: "Listing", done: "Listed" },
  log: { active: "Logging", done: "Logged" },
  lookup: { active: "Looking up", done: "Looked up" },
  mark: { active: "Marking", done: "Marked" },
  match: { active: "Matching", done: "Matched" },
  merge: { active: "Merging", done: "Merged" },
  migrate: { active: "Migrating", done: "Migrated" },
  move: { active: "Moving", done: "Moved" },
  open: { active: "Opening", done: "Opened" },
  pay: { active: "Paying", done: "Paid" },
  place: { active: "Placing", done: "Placed" },
  preview: { active: "Previewing", done: "Previewed" },
  propose: { active: "Proposing", done: "Proposed" },
  publish: { active: "Publishing", done: "Published" },
  push: { active: "Pushing", done: "Pushed" },
  read: { active: "Reading", done: "Read" },
  record: { active: "Recording", done: "Recorded" },
  remind: { active: "Reminding", done: "Reminded" },
  remove: { active: "Removing", done: "Removed" },
  rename: { active: "Renaming", done: "Renamed" },
  reorder: { active: "Reordering", done: "Reordered" },
  replace: { active: "Replacing", done: "Replaced" },
  report: { active: "Reporting", done: "Reported" },
  request: { active: "Requesting", done: "Requested" },
  resolve: { active: "Resolving", done: "Resolved" },
  restore: { active: "Restoring", done: "Restored" },
  retry: { active: "Retrying", done: "Retried" },
  reverse: { active: "Reversing", done: "Reversed" },
  review: { active: "Reviewing", done: "Reviewed" },
  revise: { active: "Revising", done: "Revised" },
  rollback: { active: "Rolling back", done: "Rolled back" },
  rotate: { active: "Rotating", done: "Rotated" },
  run: { active: "Running", done: "Ran" },
  save: { active: "Saving", done: "Saved" },
  scan: { active: "Scanning", done: "Scanned" },
  schedule: { active: "Scheduling", done: "Scheduled" },
  score: { active: "Scoring", done: "Scored" },
  search: { active: "Searching", done: "Searched" },
  send: { active: "Sending", done: "Sent" },
  set: { active: "Setting", done: "Set" },
  start: { active: "Starting", done: "Started" },
  stop: { active: "Stopping", done: "Stopped" },
  suggest: { active: "Suggesting", done: "Suggested" },
  suppress: { active: "Suppressing", done: "Suppressed" },
  sync: { active: "Syncing", done: "Synced" },
  test: { active: "Testing", done: "Tested" },
  undo: { active: "Undoing", done: "Undid" },
  update: { active: "Updating", done: "Updated" },
  verify: { active: "Verifying", done: "Verified" },
  void: { active: "Voiding", done: "Voided" },
  wait: { active: "Waiting for", done: "Waited for" },
  write: { active: "Writing", done: "Wrote" },
};

/** Tool-name words that read better as product nouns. */
const NOUNS: Record<string, string> = {
  mail: "email",
  banking: "Banking",
  finance: "Finance",
  revenue: "Revenue",
  marketing: "Marketing",
  workspace: "Workspace",
  vault: "Vault",
  repository: "Repository",
  repositories: "Repositories",
  explore: "Explore",
  pdf: "PDF",
  xlsx: "spreadsheet",
  docx: "Word document",
  url: "URL",
  ai: "AI",
  todo: "task",
  todos: "tasks",
};

type Special = {
  family: ChatToolFamily;
  verb: Verb;
  /** The rest of the label after the verb. */
  object: string;
  /** Argument keys, most salient first, for the target. */
  keys?: string[];
  kind?: "query" | "url" | "path" | "command" | "plain";
};

const v = (active: string, done: string): Verb => ({ active, done });

/** Tools a person meets often, worded by hand. Everything else is derived. */
const SPECIAL: Record<string, Special> = {
  // OpenCode's native coding tools
  bash: {
    family: "command",
    verb: v("Running", "Ran"),
    object: "",
    keys: ["command"],
    kind: "command",
  },
  read: {
    family: "file",
    verb: v("Reading", "Read"),
    object: "",
    keys: ["filePath", "path"],
    kind: "path",
  },
  write: {
    family: "file",
    verb: v("Writing", "Wrote"),
    object: "",
    keys: ["filePath", "path"],
    kind: "path",
  },
  edit: {
    family: "file",
    verb: v("Editing", "Edited"),
    object: "",
    keys: ["filePath", "path"],
    kind: "path",
  },
  multiedit: {
    family: "file",
    verb: v("Editing", "Edited"),
    object: "",
    keys: ["filePath", "path"],
    kind: "path",
  },
  patch: {
    family: "file",
    verb: v("Applying", "Applied"),
    object: "a patch",
    keys: ["filePath"],
    kind: "path",
  },
  glob: {
    family: "search",
    verb: v("Finding", "Found"),
    object: "files matching",
    keys: ["pattern"],
    kind: "command",
  },
  grep: {
    family: "search",
    verb: v("Searching", "Searched"),
    object: "files for",
    keys: ["pattern"],
    kind: "query",
  },
  list: {
    family: "file",
    verb: v("Listing", "Listed"),
    object: "files in",
    keys: ["path"],
    kind: "path",
  },
  webfetch: { family: "web", verb: v("Opening", "Opened"), object: "", keys: ["url"], kind: "url" },
  websearch: {
    family: "web",
    verb: v("Searching", "Searched"),
    object: "the web for",
    keys: ["query"],
    kind: "query",
  },
  todowrite: { family: "plan", verb: v("Updating", "Updated"), object: "the plan" },
  todoread: { family: "plan", verb: v("Reading", "Read"), object: "the plan" },
  task: {
    family: "people",
    verb: v("Delegating", "Delegated"),
    object: "",
    keys: ["description"],
    kind: "plain",
  },
  // Genosyn's coding wrappers (subscription models)
  read_file: {
    family: "file",
    verb: v("Reading", "Read"),
    object: "",
    keys: ["path"],
    kind: "path",
  },
  write_file: {
    family: "file",
    verb: v("Writing", "Wrote"),
    object: "",
    keys: ["path"],
    kind: "path",
  },
  edit_file: {
    family: "file",
    verb: v("Editing", "Edited"),
    object: "",
    keys: ["path"],
    kind: "path",
  },
  list_dir: {
    family: "file",
    verb: v("Listing", "Listed"),
    object: "files in",
    keys: ["path"],
    kind: "path",
  },
  // Discovery and orchestration
  find_tools: {
    family: "tool",
    verb: v("Looking for", "Looked for"),
    object: "the right tool",
    keys: ["query"],
    kind: "query",
  },
  call_tool: {
    family: "tool",
    verb: v("Using", "Used"),
    object: "a tool",
    keys: ["name"],
    kind: "plain",
  },
  get_runtime_diagnostics: {
    family: "tool",
    verb: v("Checking", "Checked"),
    object: "its runtime",
  },
  delegate_parallel_work: {
    family: "people",
    verb: v("Handing", "Handed"),
    object: "work to parallel workers",
  },
  get_parallel_work_result: {
    family: "people",
    verb: v("Collecting", "Collected"),
    object: "parallel work results",
  },
  ask_colleague: {
    family: "people",
    verb: v("Asking", "Asked"),
    object: "a colleague",
    keys: ["colleague"],
    kind: "plain",
  },
  get_self: { family: "people", verb: v("Checking", "Checked"), object: "its own profile" },
  report_progress: {
    family: "plan",
    verb: v("Reporting", "Reported"),
    object: "progress",
    keys: ["label"],
    kind: "plain",
  },
  send_chat_attachment: {
    family: "file",
    verb: v("Attaching", "Attached"),
    object: "a file to the reply",
    keys: ["filename"],
    kind: "path",
  },
  request_decision: {
    family: "people",
    verb: v("Raising", "Raised"),
    object: "a Decision",
    keys: ["title"],
    kind: "plain",
  },
  // The web
  search_web: {
    family: "web",
    verb: v("Searching", "Searched"),
    object: "the web for",
    keys: ["query", "q"],
    kind: "query",
  },
  fetch_web_page: {
    family: "web",
    verb: v("Opening", "Opened"),
    object: "",
    keys: ["url"],
    kind: "url",
  },
  download_web_file: {
    family: "web",
    verb: v("Downloading", "Downloaded"),
    object: "",
    keys: ["url"],
    kind: "url",
  },
  // Email
  search_mail: {
    family: "mail",
    verb: v("Searching", "Searched"),
    object: "email for",
    keys: ["query", "q"],
    kind: "query",
  },
  get_mail_thread: {
    family: "mail",
    verb: v("Reading", "Read"),
    object: "an email thread",
    keys: [],
    kind: "plain",
  },
  get_mail_message: {
    family: "mail",
    verb: v("Reading", "Read"),
    object: "an email",
    keys: [],
    kind: "plain",
  },
  read_mail_attachment: {
    family: "mail",
    verb: v("Reading", "Read"),
    object: "an email attachment",
    keys: ["filename"],
    kind: "plain",
  },
  send_mail: {
    family: "mail",
    verb: v("Sending", "Sent"),
    object: "an email to",
    keys: ["to"],
    kind: "plain",
  },
  create_mail_draft: {
    family: "mail",
    verb: v("Drafting", "Drafted"),
    object: "an email to",
    keys: ["to"],
    kind: "plain",
  },
  request_mail_review: {
    family: "mail",
    verb: v("Queuing", "Queued"),
    object: "an email for review to",
    keys: ["to"],
    kind: "plain",
  },
  // Money
  list_banking_transactions: {
    family: "finance",
    verb: v("Searching", "Searched"),
    object: "Banking transactions",
    keys: ["search", "query", "status", "kind"],
    kind: "plain",
  },
  list_finance_transactions: {
    family: "finance",
    verb: v("Searching", "Searched"),
    object: "Finance transactions",
    keys: ["search", "query", "reviewStatus", "source"],
    kind: "plain",
  },
  get_finance_report: {
    family: "finance",
    verb: v("Reading", "Read"),
    object: "a Finance report",
    keys: ["report"],
    kind: "plain",
  },
  // Data
  run_explore_query: {
    family: "data",
    verb: v("Running", "Ran"),
    object: "a query",
    keys: ["sql"],
    kind: "command",
  },
  run_chart: {
    family: "data",
    verb: v("Running", "Ran"),
    object: "a chart",
    keys: ["chartSlug"],
    kind: "plain",
  },
  // Workspace and phone
  send_workspace_message: {
    family: "message",
    verb: v("Posting", "Posted"),
    object: "in Workspace",
    keys: ["channel", "dmEmployee", "dmUser"],
    kind: "plain",
  },
  send_text_message: {
    family: "message",
    verb: v("Texting", "Texted"),
    object: "",
    keys: ["to"],
    kind: "plain",
  },
  place_phone_call: {
    family: "message",
    verb: v("Calling", "Called"),
    object: "",
    keys: ["to"],
    kind: "plain",
  },
  // Repository work sessions
  start_repository_work_session: {
    family: "code",
    verb: v("Starting", "Started"),
    object: "a Repository work session",
    keys: ["repository"],
    kind: "plain",
  },
  repository_run_command: {
    family: "command",
    verb: v("Running", "Ran"),
    object: "",
    keys: ["command"],
    kind: "command",
  },
  repository_read_file: {
    family: "code",
    verb: v("Reading", "Read"),
    object: "",
    keys: ["path"],
    kind: "path",
  },
  repository_edit_file: {
    family: "code",
    verb: v("Editing", "Edited"),
    object: "",
    keys: ["path"],
    kind: "path",
  },
  repository_write_file: {
    family: "code",
    verb: v("Writing", "Wrote"),
    object: "",
    keys: ["path"],
    kind: "path",
  },
  repository_search: {
    family: "search",
    verb: v("Searching", "Searched"),
    object: "the Repository for",
    keys: ["pattern"],
    kind: "query",
  },
  // The browser
  browser_open: {
    family: "browser",
    verb: v("Opening", "Opened"),
    object: "",
    keys: ["url"],
    kind: "url",
  },
  browser_snapshot: { family: "browser", verb: v("Reading", "Read"), object: "the page" },
  browser_click: { family: "browser", verb: v("Clicking", "Clicked"), object: "on the page" },
  browser_fill: { family: "browser", verb: v("Typing", "Typed"), object: "into a field" },
  browser_fill_vault: { family: "browser", verb: v("Filling", "Filled"), object: "a saved login" },
  browser_select: { family: "browser", verb: v("Choosing", "Chose"), object: "an option" },
  browser_press: {
    family: "browser",
    verb: v("Pressing", "Pressed"),
    object: "",
    keys: ["key"],
    kind: "command",
  },
  browser_hover: { family: "browser", verb: v("Pointing", "Pointed"), object: "at an element" },
  browser_scroll: { family: "browser", verb: v("Scrolling", "Scrolled"), object: "the page" },
  browser_back: { family: "browser", verb: v("Going", "Went"), object: "back a page" },
  browser_wait: { family: "browser", verb: v("Waiting", "Waited"), object: "for the page" },
  browser_screenshot: { family: "browser", verb: v("Taking", "Took"), object: "a screenshot" },
  browser_close: { family: "browser", verb: v("Closing", "Closed"), object: "the browser" },
  browser_submit: { family: "browser", verb: v("Submitting", "Submitted"), object: "a form" },
  browser_submit_with_vault_totp: {
    family: "browser",
    verb: v("Signing", "Signed"),
    object: "in with a saved code",
  },
  browser_resume: {
    family: "browser",
    verb: v("Resuming", "Resumed"),
    object: "an approved browser action",
  },
  browser_save_vault_login: {
    family: "browser",
    verb: v("Saving", "Saved"),
    object: "a login to the Vault",
  },
};

/** Argument keys worth naming in a step, most salient first. */
const SALIENT_KEYS = [
  "query",
  "q",
  "search",
  "pattern",
  "command",
  "url",
  "filePath",
  "path",
  "subject",
  "title",
  "name",
  "label",
  "email",
  "question",
  "description",
  "slug",
] as const;

const DATE_LIKE = /^\d{4}-\d{2}-\d{2}/;

const QUERY_KEYS = new Set(["query", "q", "search", "pattern", "question"]);

/** Never named in a label, whatever the tool: the value is or may be a secret. */
const NEVER_NAMED =
  /(?:authorization|apikey|accesstoken|refreshtoken|token|secret|password|passwd|cookie|credential|privatekey|clientsecret|value|body|content|text|html)/i;

const WORKER_PREFIX = /^\[worker:([^\]]*)\]\s*/;

/**
 * Describe one tool call for a person: verb, object and the one argument that
 * says what it was about. Pure and total — any name gets a sensible line.
 */
export function describeChatToolCall(
  rawName: string,
  input: Record<string, unknown> | null | undefined,
): ChatToolDescription {
  const workerMatch = WORKER_PREFIX.exec(rawName);
  const worker = workerMatch ? workerMatch[1].trim() || null : null;
  let name = workerMatch ? rawName.slice(workerMatch[0].length) : rawName;
  // OpenCode's wire name for a Genosyn tool, in case one reaches us prefixed.
  if (name.startsWith("genosyn_")) name = name.slice("genosyn_".length);
  const args = input && typeof input === "object" ? input : {};

  const special = SPECIAL[name];
  if (special) {
    const target = pickTarget(args, special.keys ?? [], special.kind);
    return finish(special.family, special.verb, special.object, target, worker);
  }

  const words = name.split(/[_\-.]+/).filter(Boolean);
  const verb = VERBS[words[0]?.toLowerCase() ?? ""];
  const family = familyFor(name);
  const target = pickTarget(args, [], undefined);
  if (verb && words.length > 1) {
    const object = humanize(words.slice(1));
    // A listing narrowed by a search reads as the search it is.
    const searching = words[0] === "list" && SALIENT_QUERY_PRESENT(args);
    return finish(family, searching ? VERBS.search : verb, object, target, worker);
  }
  // An unknown verb, an Integration's tool, a company MCP server's tool.
  return finish(family, v("Using", "Used"), humanize(words) || "a tool", target, worker);
}

function SALIENT_QUERY_PRESENT(args: Record<string, unknown>): boolean {
  return [...QUERY_KEYS].some((key) => typeof args[key] === "string" && String(args[key]).trim());
}

/** A label's last word that only leads into its target: "Searching email for". */
const LEADS_INTO_TARGET = /\s+(?:for|to|in|matching)$/;

function finish(
  family: ChatToolFamily,
  verb: Verb,
  object: string,
  target: { text: string; code: boolean },
  worker: string | null,
): ChatToolDescription {
  // Without its target — none was given, or the reader is not shown it — the
  // label ends where its object does: "Searching email", not "…email for".
  const said = target.text ? object : object.replace(LEADS_INTO_TARGET, "");
  const tail = said ? ` ${said}` : "";
  return {
    family,
    active: `${verb.active}${tail}`,
    done: `${verb.done}${tail}`,
    target: target.text,
    code: target.code,
    worker,
  };
}

function familyFor(name: string): ChatToolFamily {
  if (name.startsWith("browser_")) return "browser";
  if (name.startsWith("repository_")) return "code";
  if (/mail|inbox/.test(name)) return "mail";
  if (
    /banking|finance|invoice|bill|estimate|payment|vendor|ledger|tax|subsidiar|customer|recurring/.test(
      name,
    )
  )
    return "finance";
  if (/base|chart|dashboard|explore|query|xlsx|record/.test(name)) return "data";
  if (/workspace|channel|message|text|phone|call/.test(name)) return "message";
  if (/member|employee|colleague|team|handoff/.test(name)) return "people";
  if (/web|url|page/.test(name)) return "web";
  if (/search|find|lookup/.test(name)) return "search";
  if (/todo|project|routine|goal|workstream|plan/.test(name)) return "plan";
  return "tool";
}

function humanize(words: string[]): string {
  return words
    .map((word) => NOUNS[word.toLowerCase()] ?? word.toLowerCase())
    .join(" ")
    .trim();
}

/** The salient argument, shortened for one line. */
function pickTarget(
  args: Record<string, unknown>,
  preferred: string[],
  kind: Special["kind"],
): { text: string; code: boolean } {
  const keys = [...preferred, ...SALIENT_KEYS.filter((key) => !preferred.includes(key))];
  for (const key of keys) {
    if (NEVER_NAMED.test(key) && !preferred.includes(key)) continue;
    const raw = args[key];
    const listed = Array.isArray(raw)
      ? raw.filter((item): item is string => typeof item === "string" && item.trim() !== "")
      : null;
    if (typeof raw !== "string" && typeof raw !== "number" && !listed?.length) continue;
    const value = (listed ? listed.join(", ") : String(raw)).replace(/\s+/g, " ").trim();
    if (!value || value === "[redacted]") continue;
    const effective = kind ?? inferKind(key);
    if (effective === "url") return { text: shortUrl(value), code: false };
    if (effective === "path") return { text: shortPath(value), code: true };
    if (effective === "command") return { text: clip(value, 80), code: true };
    if (effective === "query") return { text: `“${clip(value, 60)}”`, code: false };
    return { text: clip(value, 60), code: false };
  }
  return { text: dateRange(args), code: false };
}

/** "2026-10-01 – 2026-10-31", "since 2026-10-01" — a listing's period, when it has one. */
function dateRange(args: Record<string, unknown>): string {
  const date = (key: string) => {
    const value = args[key];
    return typeof value === "string" && DATE_LIKE.test(value) ? value.slice(0, 10) : null;
  };
  const from = date("from") ?? date("after") ?? date("since");
  const to = date("to") ?? date("before") ?? date("until");
  if (from && to) return `${from} – ${to}`;
  if (from) return `since ${from}`;
  if (to) return `until ${to}`;
  return "";
}

function inferKind(key: string): Special["kind"] {
  if (QUERY_KEYS.has(key)) return "query";
  if (key === "url") return "url";
  if (key === "path" || key === "filePath") return "path";
  if (key === "command") return "command";
  return "plain";
}

/** "https://www.example.com/pricing?x=1" → "example.com/pricing". */
export function shortUrl(value: string): string {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "");
    const path = url.pathname === "/" ? "" : url.pathname;
    return clip(`${host}${path}`, 60);
  } catch {
    return clip(value, 60);
  }
}

/** Keep a path's end, where its file is: "…/client/pages/EmployeeChat.tsx". */
export function shortPath(value: string): string {
  if (value.length <= 60) return value;
  return `…${value.slice(value.length - 59)}`;
}

function clip(value: string, cap: number): string {
  return value.length > cap ? `${value.slice(0, cap - 1)}…` : value;
}

/** A tool step the chat leaves out of the list: the event it produces says it better. */
export function isQuietChatTool(name: string): boolean {
  const bare = name.replace(WORKER_PREFIX, "").replace(/^genosyn_/, "");
  return bare === "report_progress";
}

/** Recognize a tool result that held the call for a human's Approval. */
export function approvalHeldIn(output: string): { id: string | null } | null {
  if (!output) return null;
  const head = output.slice(0, 4_000);
  if (!/pending_approval|Approval pending|Approval queued/i.test(head)) return null;
  const id =
    /"approvalId"\s*:\s*"([0-9a-f-]{8,})"/i.exec(head)?.[1] ??
    /approval(?:\s+id|Id)?[:\s]+([0-9a-f]{8}-[0-9a-f-]{27,})/i.exec(head)?.[1] ??
    null;
  return { id };
}
