import React from "react";
import {
  AlertTriangle,
  CornerDownRight,
  MessageCircleQuestion,
  Pencil,
  Quote,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldAlert,
  Sparkles,
  X,
} from "lucide-react";

import { useLiveRefetch } from "@/components/CompanySocket";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { useDialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormError } from "@/components/ui/FormError";
import { SkeletonList } from "@/components/ui/Skeleton";
import { Textarea } from "@/components/ui/Textarea";
import { clsx } from "@/components/ui/clsx";
import {
  agoText,
  dataRoomsApi,
  documentIndexNumbers,
  jobFor,
  jobIsActive,
  type DataRoomDocument,
  type DataRoomJob,
  type DataRoomQuestion,
} from "@/lib/dataRooms";
import { errorMessage } from "@/lib/errors";
import {
  DATA_ROOM_LIMITS,
  type DataRoomCitation,
  type DataRoomQuestionStatus,
} from "../../../shared/dataRooms";
import type { RoomTabProps } from "../DataRoomDetail";
import { DocumentPreview } from "./DocumentPreview";

const FILTERS: Array<{ value: DataRoomQuestionStatus | "all"; label: string }> = [
  { value: "open", label: "Needs an answer" },
  { value: "answered", label: "Answered" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

export function RoomQuestionsTab({ companyId, detail, reload, setDetail }: RoomTabProps) {
  const roomsApi = React.useMemo(() => dataRoomsApi(companyId), [companyId]);
  const { room, documents, folders, jobs } = detail;
  const [filter, setFilter] = React.useState<DataRoomQuestionStatus | "all">("open");
  const [questions, setQuestions] = React.useState<DataRoomQuestion[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<{
    document: DataRoomDocument;
    quote: string | null;
  } | null>(null);
  const numbers = documentIndexNumbers(folders, documents);
  const byId = new Map(documents.map((document) => [document.id, document]));

  const load = React.useCallback(async () => {
    try {
      setQuestions(
        (await roomsApi.questions(room.id, filter === "all" ? undefined : filter)).questions,
      );
      setError(null);
    } catch (err) {
      setError(errorMessage(err, "Could not load the questions"));
    }
  }, [roomsApi, room.id, filter]);
  React.useEffect(() => {
    setQuestions(null);
    void load();
  }, [load]);
  useLiveRefetch(["data_room_question"], () => void load(), room.id);

  const openDocument = (documentId: string, quote: string | null = null) => {
    const document = byId.get(documentId);
    if (document) setPreview({ document, quote });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div
          className="inline-flex w-fit rounded-lg border border-slate-200 bg-white p-0.5 dark:border-slate-700 dark:bg-slate-900"
          role="group"
          aria-label="Show questions"
        >
          {FILTERS.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={filter === item.value}
              onClick={() => setFilter(item.value)}
              className={clsx(
                "h-8 rounded-md px-3 text-xs font-medium",
                filter === item.value
                  ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {room.aiEmployee
            ? room.aiAnswerMode === "auto"
              ? `${room.aiEmployee.name} answers on its own when the documents do; the rest wait here.`
              : room.aiAnswerMode === "draft"
                ? `${room.aiEmployee.name} drafts an answer to each question for you to publish.`
                : "AI answers are off for this room."
            : "Choose the room's AI Employee in its settings to draft answers."}
        </p>
      </div>

      {error ? (
        <EmptyState
          title="Questions could not be loaded"
          description={error}
          action={<Button onClick={() => void load()}>Try again</Button>}
        />
      ) : questions === null ? (
        <SkeletonList rows={3} />
      ) : questions.length === 0 ? (
        <EmptyState
          icon={<MessageCircleQuestion />}
          title={filter === "open" ? "No question is waiting" : "Nothing here"}
          description="Guests ask from inside the room. Only the guest who asked sees a question and its answer."
        />
      ) : (
        <div className="space-y-3">
          {questions.map((question) => (
            <QuestionCard
              key={question.id}
              question={question}
              job={jobFor(jobs, "answer", question.id)}
              hasAiEmployee={Boolean(room.aiEmployee)}
              documentTitle={(id) => {
                const document = byId.get(id);
                if (!document) return null;
                const number = numbers.get(id);
                return number ? `${number} ${document.title}` : document.title;
              }}
              onOpenDocument={openDocument}
              api={{
                answer: async (answer, citations) => {
                  await roomsApi.answer(room.id, question.id, answer, citations);
                  await load();
                  await reload();
                },
                publishDraft: async () => {
                  await roomsApi.publishDraft(room.id, question.id);
                  await load();
                  await reload();
                },
                draft: async () => setDetail(await roomsApi.requestDraft(room.id, question.id)),
                close: async () => {
                  await roomsApi.closeQuestion(room.id, question.id);
                  await load();
                  await reload();
                },
                reopen: async () => {
                  await roomsApi.reopenQuestion(room.id, question.id);
                  await load();
                  await reload();
                },
              }}
            />
          ))}
        </div>
      )}

      <DocumentPreview
        companyId={companyId}
        roomId={room.id}
        document={preview?.document ?? null}
        index={preview ? numbers.get(preview.document.id) : undefined}
        highlight={preview?.quote}
        briefJob={preview ? jobFor(jobs, "brief", preview.document.id) : null}
        onClose={() => setPreview(null)}
      />
    </div>
  );
}

function Citations({
  citations,
  documentTitle,
  onOpenDocument,
}: {
  citations: DataRoomCitation[];
  documentTitle: (id: string) => string | null;
  onOpenDocument: (documentId: string, quote: string) => void;
}) {
  if (citations.length === 0) return null;
  return (
    <ul className="mt-3 space-y-2">
      {citations.map((citation) => (
        <li key={`${citation.documentId}-${citation.quote}`}>
          <button
            type="button"
            onClick={() => onOpenDocument(citation.documentId, citation.quote)}
            className="group flex w-full items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-left hover:border-slate-300 dark:border-slate-800 dark:bg-slate-950 dark:hover:border-slate-700"
          >
            <Quote size={14} className="mt-0.5 shrink-0 text-slate-400" />
            <span className="min-w-0">
              <span className="block text-sm italic text-slate-700 dark:text-slate-300">
                &ldquo;{citation.quote}&rdquo;
              </span>
              <span className="mt-0.5 block truncate text-xs text-slate-500 group-hover:underline dark:text-slate-400">
                {documentTitle(citation.documentId) ?? citation.title}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

type QuestionApi = {
  answer: (
    answer: string,
    citations: Array<{ documentId: string; quote: string }>,
  ) => Promise<void>;
  publishDraft: () => Promise<void>;
  draft: () => Promise<void>;
  close: () => Promise<void>;
  reopen: () => Promise<void>;
};

function QuestionCard({
  question,
  job,
  hasAiEmployee,
  documentTitle,
  onOpenDocument,
  api,
}: {
  question: DataRoomQuestion;
  job: DataRoomJob | null;
  hasAiEmployee: boolean;
  documentTitle: (id: string) => string | null;
  onOpenDocument: (documentId: string, quote: string | null) => void;
  api: QuestionApi;
}) {
  const dialog = useDialog();
  const [composing, setComposing] = React.useState(false);
  const [text, setText] = React.useState("");
  const [keepCitations, setKeepCitations] = React.useState<DataRoomCitation[]>([]);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const drafting = jobIsActive(job);
  const about = question.documentId ? documentTitle(question.documentId) : null;

  async function run(key: string, work: () => Promise<void>, failure: string) {
    setBusy(key);
    setError(null);
    try {
      await work();
    } catch (err) {
      if (composing) setError(errorMessage(err, failure));
      else void dialog.error(err, { title: failure });
    } finally {
      setBusy(null);
    }
  }

  function compose(from: { text: string; citations: DataRoomCitation[] }) {
    setText(from.text);
    setKeepCitations(from.citations);
    setError(null);
    setComposing(true);
  }

  async function publish(event: React.FormEvent) {
    event.preventDefault();
    if (!text.trim()) {
      setError("Write an answer first.");
      return;
    }
    await run(
      "publish",
      async () => {
        await api.answer(
          text.trim(),
          keepCitations.map((citation) => ({
            documentId: citation.documentId,
            quote: citation.quote,
          })),
        );
        setComposing(false);
      },
      "Couldn’t publish the answer",
    );
  }

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
        <span className="font-medium text-slate-800 dark:text-slate-200">
          {question.guest?.name ?? "A guest"}
        </span>
        {question.guest?.organization && <span>{question.guest.organization}</span>}
        <span aria-hidden="true">·</span>
        <span>{agoText(question.createdAt)}</span>
        {question.status === "answered" && <Badge tone="success">Answered</Badge>}
        {question.status === "closed" && <Badge>Closed</Badge>}
        {question.injectionFlag && (
          <Badge tone="danger" icon={<ShieldAlert />}>
            Tried to instruct the AI
          </Badge>
        )}
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-900 dark:text-slate-100">
        {question.body}
      </p>
      {about && question.documentId && (
        <button
          type="button"
          onClick={() => onOpenDocument(question.documentId!, null)}
          className="mt-1 text-xs text-slate-500 hover:underline dark:text-slate-400"
        >
          Asked while reading {about}
        </button>
      )}

      {question.status === "answered" && (
        <div className="mt-4 border-l-2 border-emerald-300 pl-4 dark:border-emerald-500/50">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <CornerDownRight size={13} />
            Answered {agoText(question.answeredAt)}
            {question.answeredByEmployeeId && (
              <Badge tone="ai" icon={<Sparkles />}>
                By the AI Employee
              </Badge>
            )}
          </div>
          <p className="mt-1.5 whitespace-pre-wrap text-sm leading-6 text-slate-800 dark:text-slate-200">
            {question.answer}
          </p>
          <Citations
            citations={question.citations}
            documentTitle={documentTitle}
            onOpenDocument={onOpenDocument}
          />
          {!composing && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-2"
              onClick={() => compose({ text: question.answer, citations: question.citations })}
            >
              <Pencil size={14} /> Edit the answer
            </Button>
          )}
        </div>
      )}

      {question.status === "open" && (
        <div className="mt-4 space-y-3">
          {drafting && (
            <Badge tone="ai" icon={<Sparkles />}>
              Drafting an answer from the documents…
            </Badge>
          )}
          {job?.status === "failed" && !question.draftAnswer && (
            <p className="text-xs text-rose-700 dark:text-rose-300">
              The AI draft failed: {job.error}
            </p>
          )}
          {question.draftAnswer && !composing && (
            <div className="rounded-lg border border-violet-200 bg-violet-50/60 p-4 dark:border-violet-500/25 dark:bg-violet-500/10">
              <div className="flex items-center gap-2 text-xs font-medium text-violet-800 dark:text-violet-200">
                <Sparkles size={13} /> AI draft · {agoText(question.draftAt)}
              </div>
              <p className="mt-1.5 whitespace-pre-wrap text-sm leading-6 text-slate-800 dark:text-slate-200">
                {question.draftAnswer}
              </p>
              <Citations
                citations={question.draftCitations}
                documentTitle={documentTitle}
                onOpenDocument={onOpenDocument}
              />
              {question.draftNote && (
                <p className="mt-3 flex items-start gap-1.5 text-xs leading-5 text-amber-800 dark:text-amber-200">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                  {question.draftNote}
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  loading={busy === "draft-publish"}
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void run("draft-publish", api.publishDraft, "Couldn’t publish the draft")
                  }
                >
                  <Send size={14} /> Publish draft
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    compose({ text: question.draftAnswer, citations: question.draftCitations })
                  }
                >
                  <Pencil size={14} /> Edit first
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={busy === "redraft"}
                  disabled={Boolean(busy) || drafting}
                  onClick={() => void run("redraft", api.draft, "Couldn’t ask for a new draft")}
                >
                  <RefreshCw size={14} /> Draft again
                </Button>
              </div>
            </div>
          )}
          {!composing && (
            <div className="flex flex-wrap gap-2">
              {!question.draftAnswer && (
                <Button
                  size="sm"
                  onClick={() => compose({ text: "", citations: [] })}
                  disabled={Boolean(busy)}
                >
                  <CornerDownRight size={14} /> Answer
                </Button>
              )}
              {!question.draftAnswer && hasAiEmployee && !drafting && (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === "draft"}
                  disabled={Boolean(busy)}
                  onClick={() => void run("draft", api.draft, "Couldn’t ask for a draft")}
                >
                  <Sparkles size={14} /> Draft with AI
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                loading={busy === "close"}
                disabled={Boolean(busy)}
                onClick={() => void run("close", api.close, "Couldn’t close the question")}
              >
                <X size={14} /> Close without answering
              </Button>
            </div>
          )}
        </div>
      )}

      {question.status === "closed" && (
        <Button
          size="sm"
          variant="ghost"
          className="mt-3"
          loading={busy === "reopen"}
          onClick={() => void run("reopen", api.reopen, "Couldn’t reopen the question")}
        >
          <RotateCcw size={14} /> Reopen
        </Button>
      )}

      {composing && (
        <form onSubmit={publish} className="mt-4 space-y-3">
          <Textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={5}
            maxLength={DATA_ROOM_LIMITS.answerChars}
            className="w-full"
            placeholder="Write the answer the guest will read."
            autoFocus
          />
          {keepCitations.length > 0 && (
            <div className="text-xs text-slate-500 dark:text-slate-400">
              The answer keeps{" "}
              {keepCitations.length === 1 ? "its quote" : `its ${keepCitations.length} quotes`} from
              the documents.{" "}
              <button
                type="button"
                className="font-medium underline"
                onClick={() => setKeepCitations([])}
              >
                Remove them
              </button>
            </div>
          )}
          <FormError message={error} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" loading={busy === "publish"}>
              <Send size={14} /> Publish answer
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setComposing(false)}
              disabled={busy === "publish"}
            >
              Cancel
            </Button>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            The guest sees it in the room and gets an email that it is there.
          </p>
        </form>
      )}
    </Card>
  );
}
