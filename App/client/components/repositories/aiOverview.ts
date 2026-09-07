import type {
  RepositoryAiActivity,
  RepositoryAiCounts,
  RepositoryAiEmployeeWork,
  RepositoryAiLanded,
  RepositoryAiSessionRow,
  RepositoryAiStepProgress,
  RepositoryWorkSession,
  RepositoryWorkSessionStatus,
} from "../../lib/api";

/**
 * What the Repository Overview *says* about AI work.
 *
 * The page it belongs to used to open with four facts nobody had asked for —
 * the default branch, the sign-in mode, the command mode, the number of
 * grants — and then explained, at length, a workflow the reader had already
 * used forty times. None of it moved. This module is the replacement subject:
 * who is working here now, what is waiting on a human, what AI work has
 * actually landed, and which employee did it.
 *
 * Everything here is a pure function on the digest the server already
 * computed, and it lives beside the page rather than in it for the reason
 * `lib/workTimeline.ts` gives: client tests in this repo have no DOM, so the
 * wording — the part a reader actually depends on — has to be reachable
 * without React. The component owns colour, icons, and layout. This file owns
 * sentences, grouping, and what a person is being told to do next.
 */

/** The three bands the overview lists sessions in, in display order. */
export const AI_OVERVIEW_GROUP_ORDER = ["running", "attention", "recent"] as const;

export type AiOverviewGroup = (typeof AI_OVERVIEW_GROUP_ORDER)[number];

/**
 * What each band is called, written as what it is *for* rather than as a
 * status name. "Needs you" is a queue; "Ready / empty / failed / proposed" is
 * a schema.
 */
export const AI_OVERVIEW_GROUP_LABEL: Record<AiOverviewGroup, string> = {
  running: "Working now",
  attention: "Needs you",
  recent: "Recently decided",
};

/**
 * Which band a status belongs to — deliberately the same split the AI work
 * inbox and the server digest use, so a session cannot appear in one place as
 * live work and in another as history.
 */
export function aiOverviewGroupOf(status: RepositoryWorkSessionStatus): AiOverviewGroup {
  if (status === "running") return "running";
  if (status === "published" || status === "discarded") return "recent";
  return "attention";
}

/**
 * Split the server's display list into its bands, order preserved.
 *
 * The input is never mutated and every band exists even when empty, so a
 * caller can ask for one without checking whether it is there.
 */
export function groupAiOverviewSessions(
  sessions: readonly RepositoryAiSessionRow[],
): Record<AiOverviewGroup, RepositoryAiSessionRow[]> {
  const groups: Record<AiOverviewGroup, RepositoryAiSessionRow[]> = {
    running: [],
    attention: [],
    recent: [],
  };
  for (const session of sessions) groups[aiOverviewGroupOf(session.status)].push(session);
  return groups;
}

/**
 * The state of AI work in one repository, as one word.
 *
 *   - `working` → a turn is in flight.
 *   - `waiting` → nothing is running and something is waiting on a human.
 *   - `quiet`   → work has happened here, and none of it wants anything.
 *   - `idle`    → an employee could work here and none ever has.
 *   - `closed`  → no employee has been granted the repository at all.
 *
 * Working outranks waiting for the reason Home's roster does: an old session
 * nobody has reviewed must not make live work look stalled.
 */
export type RepositoryAiState = "working" | "waiting" | "quiet" | "idle" | "closed";

/** Everything the headline needs, and nothing a component would have to render. */
export type RepositoryAiGlance = {
  counts: RepositoryAiCounts;
  landed: RepositoryAiLanded;
  /** AI Employees holding a grant on this repository. */
  granted: number;
  /** The employees running a turn right now, in display order. */
  workingNames: string[];
};

/**
 * The employees running a turn in this repository right now, named once each.
 *
 * By employee rather than by session: one employee working two sessions is
 * still one colleague, and listing it twice gives the headline two people and
 * the wrong verb. A session whose employee was fired mid-turn contributes no
 * name — the sentence for that case is written from the count instead.
 */
export function workingEmployeeNames(sessions: readonly RepositoryAiSessionRow[]): string[] {
  const byEmployee = new Map<string, string>();
  for (const session of sessions) {
    if (session.status !== "running" || !session.employee) continue;
    if (!byEmployee.has(session.employee.id))
      byEmployee.set(session.employee.id, session.employee.name);
  }
  return [...byEmployee.values()];
}

/**
 * What the page reasons over, from the digest and the grants.
 *
 * A digest that has not arrived is all zeroes, and the page must not print a
 * sentence off it — {@link repositoryAiHeading} is what decides that, from the
 * read state, and this only supplies the numbers. `granted` is passed in
 * because it comes from the other read.
 */
export function repositoryAiGlanceOf(
  overview: {
    counts: RepositoryAiCounts;
    landed: RepositoryAiLanded;
    sessions: readonly RepositoryAiSessionRow[];
  } | null,
  granted: number,
): RepositoryAiGlance {
  if (!overview) {
    return {
      counts: { total: 0, running: 0, attention: 0, completed: 0, archived: 0 },
      landed: { sessions: 0, filesChanged: 0, insertions: 0, deletions: 0 },
      granted,
      workingNames: [],
    };
  }
  return {
    counts: overview.counts,
    landed: overview.landed,
    granted,
    workingNames: workingEmployeeNames(overview.sessions),
  };
}

export function repositoryAiState(glance: RepositoryAiGlance): RepositoryAiState {
  if (glance.counts.running > 0) return "working";
  if (glance.counts.attention > 0) return "waiting";
  if (glance.counts.total > 0) return "quiet";
  return glance.granted > 0 ? "idle" : "closed";
}

function plural(count: number, noun: string, many?: string): string {
  return `${num(count)} ${count === 1 ? noun : (many ?? `${noun}s`)}`;
}

/** Thousands separators, pinned so the sentence reads the same everywhere. */
function num(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * The employees there is actually a name for.
 *
 * An employee fired mid-turn leaves a running session with nobody to name, and
 * a name that is only whitespace is the same thing wearing a hat. Both the
 * subject of the sentence and the verb after it have to be counted from this
 * list rather than from the raw one, or a blank beside a real name conjugates
 * for two people and prints "Ada are working here now."
 */
export function namedWorkers(names: readonly string[]): string[] {
  return names.map((name) => name.trim()).filter((name) => name.length > 0);
}

/**
 * The employees working right now, named.
 *
 * Two are named, three or more are counted. A list of five names is not a
 * headline, and the fifth name is not what the reader came for.
 */
export function workingSubject(names: readonly string[]): string {
  const named = namedWorkers(names);
  if (named.length === 0) return "";
  if (named.length === 1) return named[0];
  if (named.length === 2) return `${named[0]} and ${named[1]}`;
  return `${named[0]}, ${named[1]} and ${plural(named.length - 2, "other")}`;
}

/**
 * The one sentence at the top of the page.
 *
 * It answers, in order: is anything happening, is anything waiting for me,
 * has anything ever happened, and can anything happen at all. A repository
 * nobody has granted gets the sentence that says so rather than a zero, because
 * "0 sessions" and "no employee may work here" are different problems with
 * different fixes.
 */
export function repositoryAiHeadline(glance: RepositoryAiGlance): string {
  const { counts } = glance;
  switch (repositoryAiState(glance)) {
    case "working": {
      const named = namedWorkers(glance.workingNames);
      const who = workingSubject(named);
      // A session whose employee has since been fired still runs, and still
      // deserves a sentence — it just has no name to put in front of it.
      const lead = who
        ? `${who} ${named.length === 1 ? "is" : "are"} working here now.`
        : `${plural(counts.running, "session")} ${
            counts.running === 1 ? "is" : "are"
          } running here now.`;
      if (counts.attention === 0) return lead;
      return `${lead} ${plural(counts.attention, "other session")} ${
        counts.attention === 1 ? "is" : "are"
      } waiting for you.`;
    }
    case "waiting":
      return `${plural(counts.attention, "session")} ${
        counts.attention === 1 ? "is" : "are"
      } waiting for you to decide.`;
    case "quiet":
      return glance.landed.sessions > 0
        ? `Nothing is running. AI employees have landed ${plural(
            glance.landed.sessions,
            "session",
          )} here.`
        : "Nothing is running, and no AI work has been accepted here yet.";
    case "idle":
      return `${plural(glance.granted, "AI employee")} can work here. None has yet.`;
    case "closed":
      return "No AI employee can work in this repository yet.";
  }
}

/**
 * The line under the headline: what to do about it.
 *
 * Every state has an action, including the quiet ones, because a page whose
 * only sentence is a status is a page that has stopped being useful the moment
 * the status is good.
 */
export function repositoryAiSubline(glance: RepositoryAiGlance): string {
  switch (repositoryAiState(glance)) {
    case "working":
      return "Follow the work as it happens, or leave it — nothing reaches this repository until you accept it.";
    case "waiting":
      return "Read the diff and accept it, ask for another pass, or throw it away.";
    case "quiet":
      return "Hand over the next piece of work and review what comes back.";
    case "idle":
      return "Describe an outcome and one of them will work on a branch of its own.";
    case "closed":
      return "Grant an AI employee access and it gets a checkout of this repository to work in.";
  }
}

/**
 * Whether the digest has arrived.
 *
 * Three states rather than two, because "we have not been answered yet" and
 * "we were answered with a failure" are the same absence of an answer, and
 * neither of them is a quiet repository.
 */
export type RepositoryAiReadState = "loading" | "failed" | "ready";

/**
 * The two sentences at the top of the band, including when there is nothing to
 * say yet.
 *
 * A read that has not landed and a read that failed both leave the page not
 * knowing what is happening here, and reporting either as "no AI employee has
 * worked here" would be a definite claim about a repository whose work the page
 * has just admitted it cannot see. Home's `teamSentence` states the same rule
 * about the same mistake.
 */
export function repositoryAiHeading(
  read: RepositoryAiReadState,
  glance: RepositoryAiGlance,
): { headline: string; subline: string } {
  if (read === "loading") {
    return {
      headline: "Reading back the AI work…",
      subline: "What employees have done here, and what is waiting for you.",
    };
  }
  if (read === "failed") {
    return {
      headline: "The AI work here could not be read.",
      subline: "Nothing else on this page is affected. Ask for it again below.",
    };
  }
  return { headline: repositoryAiHeadline(glance), subline: repositoryAiSubline(glance) };
}

/** "12 of 30 sessions accepted", for the sentence under the tallies. */
export function landedSentence(counts: RepositoryAiCounts, landed: RepositoryAiLanded): string {
  if (counts.total === 0) return "";
  if (landed.sessions === 0) return `None of ${plural(counts.total, "session")} has been accepted.`;
  return `${num(landed.sessions)} of ${plural(counts.total, "session")} accepted.`;
}

/** One tile in the strip that replaced the repository's settings cards. */
export type RepositoryAiStat = {
  key: "running" | "attention" | "accepted" | "changed";
  label: string;
  value: string;
  /** The smaller second line, or null when the value says it all. */
  hint: string | null;
};

/**
 * The four numbers worth a tile.
 *
 * They are the same four in the same order whatever the repository is doing,
 * including when they are zero: a strip that reflows as work starts and stops
 * is unreadable, and the whole strip is hidden by the page when the repository
 * has never had any AI work at all.
 */
export function repositoryAiStats(glance: RepositoryAiGlance): RepositoryAiStat[] {
  const { counts, landed } = glance;
  return [
    {
      key: "running",
      label: "Working now",
      value: counts.running === 0 ? "None" : plural(counts.running, "session"),
      hint: counts.running > 0 ? workingSubject(glance.workingNames) || null : null,
    },
    {
      key: "attention",
      label: "Waiting for you",
      value: counts.attention === 0 ? "None" : plural(counts.attention, "session"),
      hint: counts.attention > 0 ? "Review, revise, or discard" : null,
    },
    {
      key: "accepted",
      label: "Accepted",
      value: plural(landed.sessions, "session"),
      hint: counts.total > 0 ? `of ${num(counts.total)} in total` : null,
    },
    {
      key: "changed",
      label: "Lines accepted",
      value:
        landed.insertions === 0 && landed.deletions === 0
          ? "None yet"
          : `+${num(landed.insertions)} / −${num(landed.deletions)}`,
      hint: landed.filesChanged > 0 ? `across ${plural(landed.filesChanged, "file")}` : null,
    },
  ];
}

/** "4 files · +120 · −8", or an empty string when a session changed nothing. */
export function diffstatLabel(
  session: Pick<RepositoryWorkSession, "filesChanged" | "insertions" | "deletions">,
): string {
  if (session.filesChanged === 0 && session.insertions === 0 && session.deletions === 0) return "";
  return `${plural(session.filesChanged, "file")} · +${num(session.insertions)} · −${num(
    session.deletions,
  )}`;
}

/**
 * What this session wants from the reader, in words.
 *
 * Never the status name. A status says what the *work* is, and the row already
 * carries one on a chip beside the title; this line has to earn its place by
 * saying something the chip does not. For a session still in the queue that is
 * the next move — and for one that has been decided it is where the work went,
 * because "Accepted" printed under a chip reading "Accepted" is a row that got
 * longer without getting more informative.
 */
export function sessionNextStep(
  session: Pick<RepositoryWorkSession, "status" | "pullRequestNumber" | "publishedBranch">,
): string {
  switch (session.status) {
    case "running":
      return "Working now";
    case "ready":
      return "Read the diff and decide";
    case "empty":
      return "Nothing changed — ask for another pass";
    case "proposed":
      return session.pullRequestNumber
        ? `Pull request #${session.pullRequestNumber} is open`
        : "A pull request is open";
    case "failed":
      return "The last turn failed — ask again";
    case "published":
      return session.publishedBranch
        ? `Merged into ${session.publishedBranch}`
        : "Merged into this repository";
    case "discarded":
      return "Its branch was thrown away";
    default:
      return "";
  }
}

/**
 * The live line for a running session.
 *
 * A turn that has not written an event yet is *starting*, which is a fact, and
 * saying nothing there would leave a row that looks stuck.
 */
export function activityLine(activity: RepositoryAiActivity | null | undefined): string {
  const summary = activity?.summary?.trim() ?? "";
  return summary || "Starting…";
}

/** "Step 3 of 7", or an empty string when the employee wrote no step list. */
export function stepsLabel(steps: RepositoryAiStepProgress | null | undefined): string {
  if (!steps || steps.total === 0) return "";
  return `Step ${Math.min(steps.done + 1, steps.total)} of ${steps.total}`;
}

/** "24 tool calls" — how much work is behind the one line above it. */
export function toolCallsLabel(activity: RepositoryAiActivity | null | undefined): string {
  const calls = activity?.toolCalls ?? 0;
  return calls === 0 ? "" : plural(calls, "tool call");
}

/** What one employee has done here: "8 sessions · 5 accepted · +900 −120". */
export function employeeWorkLabel(work: RepositoryAiEmployeeWork | null | undefined): string {
  if (!work || work.sessions === 0) return "No work here yet";
  const parts = [plural(work.sessions, "session")];
  parts.push(`${num(work.landed)} accepted`);
  if (work.insertions > 0 || work.deletions > 0) {
    parts.push(`+${num(work.insertions)} / −${num(work.deletions)}`);
  }
  return parts.join(" · ");
}

/** Index the per-employee tallies so a grant row can find its own. */
export function employeeWorkById(
  employees: readonly RepositoryAiEmployeeWork[],
): Map<string, RepositoryAiEmployeeWork> {
  return new Map(employees.map((row) => [row.employeeId, row]));
}

/** Index the live lines so a running session row can find its own. */
export function activityBySession(
  activity: readonly RepositoryAiActivity[],
): Map<string, RepositoryAiActivity> {
  return new Map(activity.map((row) => [row.sessionId, row]));
}

/** Where a session row goes: its own page in the AI work inbox. */
export function overviewSessionHref(aiBase: string, sessionId: string): string {
  return `${aiBase}/${sessionId}`;
}

/**
 * What the page says when the tallies stopped counting.
 *
 * A number that quietly means "the first two thousand" is worse than one that
 * says so, which is the same rule the work timeline states about its own caps.
 */
export function cappedNote(capped: boolean, counts: RepositoryAiCounts): string {
  return capped ? `Counted over the most recent ${num(counts.total)} sessions.` : "";
}
