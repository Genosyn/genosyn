import React from "react";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  FilePen,
  FilePlus2,
  FileText,
  FileX2,
  FolderSearch,
  FolderTree,
  Gauge,
  GitCommit,
  GitCompare,
  ListChecks,
  OctagonX,
  RotateCw,
  Search,
  Shrink,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { ChatMarkdown } from "../ChatMarkdown";
import { Spinner } from "../ui/Spinner";
import { clsx } from "../ui/clsx";
import type { RepositoryWorkSessionEvent, RepositoryWorkSessionStep } from "../../lib/api";
import {
  SessionActivityItem,
  SessionToolFamily,
  buildSessionActivity,
  commandResultText,
  describeSessionActivity,
  sessionToolFamily,
  toolInput,
  toolOutput,
} from "./sessionState";

/**
 * The live feed of one turn: what the AI Employee did, as it does it.
 *
 * Every agentic coding tool people already use shows this in its terminal —
 * each file read, each edit, each command and what it printed — and it is most
 * of what makes their output trustworthy. Here it sits between the brief and
 * the reply, so a reviewer can see how the diff came to be.
 *
 * A running turn is open, with a live line at the bottom. A finished one
 * collapses to a single line — "14 tool calls · 3 files edited · 2 commands
 * run" — because the reply beneath it is what most readers want, and the feed
 * is there for the ones who want to check.
 *
 * Wide content never widens the page: every `<pre>` scrolls inside its own
 * box, and long summaries truncate with the full text on `title`.
 */
export function SessionActivity({
  events,
  running,
}: {
  events: RepositoryWorkSessionEvent[];
  running: boolean;
}) {
  const activity = React.useMemo(() => buildSessionActivity(events), [events]);
  // Null until the reader chooses; the default follows the turn's state, so a
  // feed that was open while running folds up when the turn ends.
  const [choice, setChoice] = React.useState<boolean | null>(null);
  const expanded = choice ?? running;

  if (!running && events.length === 0) return null;

  const line = describeSessionActivity(activity.summary);

  return (
    <section className="min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <button
        type="button"
        onClick={() => setChoice(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-slate-50 dark:hover:bg-slate-800/60"
      >
        {expanded ? (
          <ChevronDown size={13} className="shrink-0 text-slate-400" />
        ) : (
          <ChevronRight size={13} className="shrink-0 text-slate-400" />
        )}
        <span className="min-w-0 flex-1 truncate text-slate-600 dark:text-slate-300" title={line}>
          {running ? `${line} so far` : line}
        </span>
        {running && <Spinner size={12} />}
      </button>

      {expanded && (
        <div className="border-t border-slate-100 dark:border-slate-800">
          {activity.steps && <StepList steps={activity.steps} running={running} />}
          <ol className="py-1">
            {activity.items.map((item) => (
              <ActivityRow key={item.key} item={item} />
            ))}
            {running && (
              <li className="flex items-center gap-2 px-3 py-1.5 text-xs text-slate-500 dark:text-slate-400">
                <Spinner size={12} />
                Working…
              </li>
            )}
          </ol>
        </div>
      )}
    </section>
  );
}

/**
 * The employee's own plan for the turn, pinned above the calls.
 *
 * Only the latest list is shown: each `steps` event carries the whole list,
 * so the last one is the current state and the earlier ones are history the
 * feed does not need to repeat.
 */
function StepList({ steps, running }: { steps: RepositoryWorkSessionStep[]; running: boolean }) {
  const done = steps.filter((step) => step.status === "completed").length;
  return (
    <div className="border-b border-slate-100 bg-slate-50/60 px-3 py-2 dark:border-slate-800 dark:bg-slate-950/30">
      <div className="flex items-center justify-between gap-2 text-[11px] font-semibold text-slate-600 dark:text-slate-300">
        <span className="inline-flex items-center gap-1.5">
          <ListChecks size={12} className="text-slate-400" /> Steps
        </span>
        <span className="font-mono tabular-nums text-slate-400 dark:text-slate-500">
          {done} of {steps.length} done
        </span>
      </div>
      <ol className="mt-1.5 space-y-1">
        {steps.map((step, index) => (
          <li key={index} className="flex items-start gap-2 text-xs">
            <span className="mt-0.5 shrink-0">
              {step.status === "completed" ? (
                <CircleCheck size={13} className="text-emerald-500" />
              ) : step.status === "in_progress" ? (
                running ? (
                  <Spinner size={13} />
                ) : (
                  <CircleDot size={13} className="text-indigo-500" />
                )
              ) : (
                <Circle size={13} className="text-slate-300 dark:text-slate-600" />
              )}
            </span>
            <span
              className={clsx(
                "min-w-0 break-words leading-5",
                step.status === "completed"
                  ? "text-slate-400 line-through dark:text-slate-500"
                  : step.status === "in_progress"
                    ? "font-medium text-slate-800 dark:text-slate-100"
                    : "text-slate-600 dark:text-slate-300",
              )}
            >
              {step.text}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ActivityRow({ item }: { item: SessionActivityItem }) {
  if (item.kind === "text") {
    return (
      <li className="px-3 py-1.5 text-xs leading-5 text-slate-500 dark:text-slate-400">
        <ChatMarkdown content={item.text} />
      </li>
    );
  }
  if (item.kind === "system") return <SystemRow event={item.event} />;
  return <ToolRow call={item.call} result={item.result} />;
}

const SYSTEM_ICON: Record<string, LucideIcon> = {
  progress: Gauge,
  compact: Shrink,
  retry: RotateCw,
  stopped: OctagonX,
};

/** Compaction, a retry, explicit progress, a stop: one quiet line each. */
function SystemRow({ event }: { event: RepositoryWorkSessionEvent }) {
  const Icon = SYSTEM_ICON[event.kind] ?? Wrench;
  const stopped = event.kind === "stopped";
  return (
    <li
      className={clsx(
        "flex items-center gap-2 px-3 py-1 text-[11px]",
        stopped ? "text-amber-700 dark:text-amber-300" : "text-slate-400 dark:text-slate-500",
      )}
    >
      <Icon size={12} className="shrink-0" />
      <span className="min-w-0 truncate" title={event.summary}>
        {event.summary}
      </span>
    </li>
  );
}

const TOOL_ICON: Record<SessionToolFamily, LucideIcon> = {
  read: FileText,
  edit: FilePen,
  write: FilePlus2,
  delete: FileX2,
  search: Search,
  glob: FolderSearch,
  list: FolderTree,
  status: GitCompare,
  diff: GitCompare,
  command: Terminal,
  commit: GitCommit,
  steps: ListChecks,
  other: Wrench,
};

/**
 * One tool call: what was asked, and — once it lands — what came back.
 *
 * A spinner while the result is outstanding, an error tint when it failed,
 * and the detail behind a chevron so a hundred reads stay a hundred lines.
 */
function ToolRow({
  call,
  result,
}: {
  call: RepositoryWorkSessionEvent | null;
  result: RepositoryWorkSessionEvent | null;
}) {
  const [open, setOpen] = React.useState(false);
  const name = call?.name ?? result?.name ?? "";
  const family = sessionToolFamily(name);
  const Icon = TOOL_ICON[family];
  const pending = result === null;
  const failed = result?.isError === true;
  const summary = call?.summary ?? result?.summary ?? name;
  const outcome = result?.summary ?? "";

  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className={clsx(
          "flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-slate-50 dark:hover:bg-slate-800/60",
          failed ? "text-rose-700 dark:text-rose-300" : "text-slate-700 dark:text-slate-200",
        )}
      >
        <Icon
          size={13}
          className={clsx(
            "shrink-0",
            failed ? "text-rose-500" : "text-slate-400 dark:text-slate-500",
          )}
        />
        <span className="min-w-0 flex-1 truncate" title={summary}>
          {summary}
        </span>
        {outcome && (
          <span
            className={clsx(
              "hidden max-w-[40%] shrink-0 truncate sm:inline",
              failed ? "text-rose-500 dark:text-rose-400" : "text-slate-400 dark:text-slate-500",
            )}
            title={outcome}
          >
            {outcome}
          </span>
        )}
        {pending ? (
          <span className="shrink-0" aria-label="Waiting for the result">
            <Spinner size={11} />
          </span>
        ) : failed ? (
          <AlertCircle size={12} className="shrink-0 text-rose-500" aria-label="Failed" />
        ) : null}
        {open ? (
          <ChevronDown size={12} className="shrink-0 text-slate-400" />
        ) : (
          <ChevronRight size={12} className="shrink-0 text-slate-400" />
        )}
      </button>
      {open && <ToolDetail call={call} result={result} family={family} />}
    </li>
  );
}

function ToolDetail({
  call,
  result,
  family,
}: {
  call: RepositoryWorkSessionEvent | null;
  result: RepositoryWorkSessionEvent | null;
  family: SessionToolFamily;
}) {
  const input = call ? toolInput(call) : {};
  const rawOutput = result ? toolOutput(result) : "";
  const output =
    family === "command" && result && !result.isError ? commandResultText(rawOutput) : rawOutput;

  return (
    <div className="space-y-2 border-y border-slate-100 bg-slate-50/60 px-3 py-2 dark:border-slate-800 dark:bg-slate-950/30">
      {call &&
        (family === "edit" ? (
          <EditInput input={input} />
        ) : family === "command" ? (
          <CommandInput input={input} />
        ) : family === "write" ? (
          <WriteInput input={input} />
        ) : (
          <GenericInput input={input} />
        ))}
      {result ? (
        <div>
          <DetailLabel>{result.isError ? "Error" : "Result"}</DetailLabel>
          <Pre tone={result.isError ? "error" : "plain"}>
            {output.trim() ? output : result.summary || "(no output)"}
          </Pre>
        </div>
      ) : (
        <p className="flex items-center gap-1.5 text-[11px] text-slate-400 dark:text-slate-500">
          <Spinner size={10} /> Waiting for the result…
        </p>
      )}
    </div>
  );
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** `old_string` → `new_string`, as the removed and added halves of a change. */
function EditInput({ input }: { input: Record<string, unknown> }) {
  return (
    <div className="space-y-1.5">
      <DetailLabel>
        <PathLabel path={str(input.path)} />
        {input.replace_all === true && (
          <span className="ml-2 font-normal text-slate-400">every occurrence</span>
        )}
      </DetailLabel>
      <Pre tone="removed">{str(input.old_string)}</Pre>
      <Pre tone="added">{str(input.new_string)}</Pre>
    </div>
  );
}

function CommandInput({ input }: { input: Record<string, unknown> }) {
  return (
    <div>
      <DetailLabel>Command</DetailLabel>
      <Pre>{`$ ${str(input.command)}`}</Pre>
    </div>
  );
}

function WriteInput({ input }: { input: Record<string, unknown> }) {
  return (
    <div>
      <DetailLabel>
        <PathLabel path={str(input.path)} />
      </DetailLabel>
      <Pre tone="added">{str(input.content)}</Pre>
    </div>
  );
}

/** Every other tool: its arguments, one per line, objects as JSON. */
function GenericInput({ input }: { input: Record<string, unknown> }) {
  const entries = Object.entries(input);
  if (entries.length === 0) return null;
  return (
    <div>
      <DetailLabel>Arguments</DetailLabel>
      <dl className="space-y-1">
        {entries.map(([key, value]) => {
          const text =
            typeof value === "string"
              ? value
              : typeof value === "number" || typeof value === "boolean"
                ? String(value)
                : (JSON.stringify(value, null, 2) ?? "");
          const block = text.includes("\n") || text.length > 80;
          return (
            <div key={key} className={block ? "" : "flex min-w-0 items-baseline gap-2"}>
              <dt className="shrink-0 font-mono text-[11px] text-slate-400 dark:text-slate-500">
                {key}
              </dt>
              <dd className="min-w-0">
                {block ? (
                  <Pre>{text}</Pre>
                ) : (
                  <span
                    className="block truncate font-mono text-[11px] text-slate-700 dark:text-slate-200"
                    title={text}
                  >
                    {text}
                  </span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

function DetailLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 flex min-w-0 items-center text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
      {children}
    </div>
  );
}

function PathLabel({ path }: { path: string }) {
  return (
    <span
      className="min-w-0 truncate font-mono normal-case tracking-normal text-slate-600 dark:text-slate-300"
      title={path}
    >
      {path || "(no path)"}
    </span>
  );
}

const PRE_TONE = {
  plain: "bg-white text-slate-700 dark:bg-slate-900 dark:text-slate-200",
  removed: "bg-rose-50/80 text-rose-800 dark:bg-rose-500/10 dark:text-rose-200",
  added: "bg-emerald-50/80 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200",
  error: "bg-rose-50/60 text-rose-700 dark:bg-rose-500/5 dark:text-rose-300",
} as const;

/**
 * A bounded block of verbatim text. `overflow-auto` with a max height keeps a
 * 6,000-character result inside its box rather than the page, and
 * `whitespace-pre` keeps a diff's indentation honest.
 */
function Pre({ children, tone = "plain" }: { children: string; tone?: keyof typeof PRE_TONE }) {
  return (
    <pre
      className={clsx(
        "max-h-64 overflow-auto whitespace-pre rounded-lg border border-slate-200/70 px-2.5 py-2 font-mono text-[11px] leading-4 dark:border-slate-800",
        PRE_TONE[tone],
      )}
    >
      {children}
    </pre>
  );
}
