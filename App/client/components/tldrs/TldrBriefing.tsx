import React from "react";
import { ChevronDown, MessageSquare } from "lucide-react";

import { ChatMarkdown } from "@/components/ChatMarkdown";
import { TldrQuestions } from "@/components/tldrs/TldrQuestions";
import type { Company, TldrItem } from "@/lib/api";

/** The same summary-first reading experience on Home and in briefing history. */
export function TldrBriefing({
  company,
  item,
  openBriefing = false,
  openDiscussion = false,
}: {
  company: Pick<Company, "id" | "slug">;
  item: TldrItem;
  openBriefing?: boolean;
  openDiscussion?: boolean;
}) {
  const [expanded, setExpanded] = React.useState(openBriefing && !openDiscussion);
  const [questionsOpen, setQuestionsOpen] = React.useState(openDiscussion);
  const [questionsLoaded, setQuestionsLoaded] = React.useState(openDiscussion);
  const [composing, setComposing] = React.useState(openDiscussion);
  const detailsId = React.useId();
  const questionsId = React.useId();
  const questionsButtonId = React.useId();
  const summary = item.summary.trim();
  const body = item.body.trim();
  const stats = item.sourceStats;
  const sources = [
    stats.routineRuns > 0 &&
      `${stats.routineRuns} Routine ${stats.routineRuns === 1 ? "Run" : "Runs"}`,
    stats.channelMessages > 0 &&
      `${stats.channelMessages} ${stats.channelMessages === 1 ? "message" : "messages"} in ${stats.channels} ${stats.channels === 1 ? "channel" : "channels"}`,
    stats.journalEntries > 0 &&
      `${stats.journalEntries} journal ${stats.journalEntries === 1 ? "entry" : "entries"}`,
  ].filter(Boolean);

  React.useEffect(() => {
    if (openDiscussion) {
      setExpanded(false);
      setQuestionsOpen(true);
      setQuestionsLoaded(true);
      setComposing(true);
    } else if (openBriefing) {
      setExpanded(true);
      setQuestionsOpen(false);
    }
  }, [openBriefing, openDiscussion]);

  function toggleDetails() {
    setExpanded(!expanded);
    if (!expanded) setQuestionsOpen(false);
  }

  function toggleQuestions() {
    setQuestionsOpen(!questionsOpen);
    setQuestionsLoaded(true);
    if (!questionsOpen) {
      setExpanded(false);
      if (item.questionCount === 0) setComposing(true);
    }
  }

  return (
    <div>
      {summary && (
        <p
          className={`break-words text-sm leading-6 text-slate-700 dark:text-slate-300 ${expanded ? "" : "line-clamp-3"}`}
        >
          {summary}
        </p>
      )}
      {!summary && body && !expanded && (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Open this briefing to read the recap.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={toggleDetails}
          className="inline-flex items-center gap-1 rounded text-xs font-medium text-indigo-600 hover:text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
        >
          {expanded ? "Hide details" : "Read briefing"}
          <ChevronDown size={13} className={expanded ? "rotate-180" : ""} />
        </button>
        {(item.questionCount > 0 || item.employee.id || questionsLoaded) && (
          <button
            id={questionsButtonId}
            type="button"
            aria-expanded={questionsOpen}
            aria-controls={questionsId}
            onClick={toggleQuestions}
            className="inline-flex items-center gap-1.5 rounded text-xs font-medium text-slate-500 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-slate-400 dark:hover:text-slate-200"
          >
            <MessageSquare size={13} />
            {item.questionCount > 0
              ? `Questions (${item.questionCount})`
              : item.employee.id
                ? "Ask a question"
                : "Questions"}
            <ChevronDown size={13} className={questionsOpen ? "rotate-180" : ""} />
          </button>
        )}
      </div>

      <div id={detailsId} hidden={!expanded}>
        {body && body !== summary && (
          <div className="mt-4 text-sm leading-6 text-slate-700 dark:text-slate-300">
            <ChatMarkdown content={body} />
          </div>
        )}
        <div className="mt-4 space-y-1 border-t border-slate-100 pt-3 text-xs leading-5 text-slate-500 dark:border-slate-800 dark:text-slate-400">
          {sources.length > 0 && <p>Based on {sources.join(" · ")}</p>}
          <p>
            {item.triggerKind === "manual" ? "Generated manually" : "Generated"}{" "}
            {new Date(item.createdAt).toLocaleString()}
          </p>
        </div>
      </div>

      {/* Keep an opened panel mounted so collapsing it never interrupts a reply or loses a draft. */}
      <div
        id={questionsId}
        role="region"
        aria-labelledby={questionsButtonId}
        hidden={!questionsOpen}
      >
        {questionsLoaded && (
          <TldrQuestions
            company={company}
            item={item}
            open={composing}
            onOpenChange={setComposing}
          />
        )}
      </div>
    </div>
  );
}
