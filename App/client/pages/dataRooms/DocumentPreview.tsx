import React from "react";
import { AlertTriangle, Download, Sparkles } from "lucide-react";

import { PdfCanvasRenderer } from "@/components/signatures/PdfCanvasRenderer";
import { Badge } from "@/components/ui/Badge";
import { buttonClassName } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import {
  agoText,
  dataRoomsApi,
  jobIsActive,
  type DataRoomDocument,
  type DataRoomJob,
} from "@/lib/dataRooms";
import { errorMessage } from "@/lib/errors";
import { formatFileSize } from "../../../shared/dataRooms";

/**
 * One document as the company sees it: the file itself — rendered pages for a
 * PDF, the image, or the text read out of anything else — beside the AI
 * Employee's brief. `highlight` is a quote an answer cited, shown above the
 * text so a Member can check it against the page.
 */
export function DocumentPreview({
  companyId,
  roomId,
  document,
  index,
  highlight,
  briefJob,
  onClose,
}: {
  companyId: string;
  roomId: string;
  document: DataRoomDocument | null;
  index?: string;
  highlight?: string | null;
  /** The document's latest brief job, so a brief on its way or one that failed says so. */
  briefJob?: DataRoomJob | null;
  onClose: () => void;
}) {
  const api = dataRoomsApi(companyId);
  return (
    <Modal
      open={Boolean(document)}
      onClose={onClose}
      title={document ? `${index ? `${index}  ` : ""}${document.title}` : "Document"}
      description={
        document
          ? `${document.filename} · ${formatFileSize(document.sizeBytes)}${document.pageCount ? ` · ${document.pageCount} pages` : ""}`
          : undefined
      }
      size="xl"
      padded={false}
    >
      {document && (
        <div className="grid min-h-[60vh] lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0 border-b border-slate-100 bg-slate-50 p-3 sm:p-4 lg:border-b-0 lg:border-r dark:border-slate-800 dark:bg-slate-950">
            {highlight && (
              <div className="mb-3 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-900 dark:border-indigo-500/25 dark:bg-indigo-500/10 dark:text-indigo-100">
                <span className="font-medium">Quoted:</span> &ldquo;{highlight}&rdquo;
              </div>
            )}
            <Viewer companyId={companyId} roomId={roomId} document={document} />
          </div>
          <aside className="space-y-4 p-4 sm:p-5">
            <a
              href={api.documentFileUrl(roomId, document.id, true)}
              className={buttonClassName({ variant: "secondary", size: "sm", className: "w-full" })}
            >
              <Download size={14} /> Download original
            </a>
            <BriefPanel document={document} job={briefJob ?? null} />
          </aside>
        </div>
      )}
    </Modal>
  );
}

function Viewer({
  companyId,
  roomId,
  document,
}: {
  companyId: string;
  roomId: string;
  document: DataRoomDocument;
}) {
  const api = dataRoomsApi(companyId);
  const url = api.documentFileUrl(roomId, document.id);
  if (document.viewerKind === "pdf") {
    return <PdfCanvasRenderer sourceUrl={url} readOnly className="max-h-[70vh] overflow-y-auto" />;
  }
  if (document.viewerKind === "image") {
    return (
      <img
        src={url}
        alt={document.title}
        className="mx-auto max-h-[70vh] max-w-full rounded-lg border border-slate-200 bg-white object-contain dark:border-slate-800"
      />
    );
  }
  return <TextViewer companyId={companyId} roomId={roomId} document={document} />;
}

function TextViewer({
  companyId,
  roomId,
  document,
}: {
  companyId: string;
  roomId: string;
  document: DataRoomDocument;
}) {
  const [state, setState] = React.useState<
    { text: string; truncated: boolean } | { error: string } | null
  >(null);
  React.useEffect(() => {
    let live = true;
    setState(null);
    dataRoomsApi(companyId)
      .documentText(roomId, document.id)
      .then((result) => {
        if (live) setState({ text: result.text, truncated: result.truncated });
      })
      .catch((err: unknown) => {
        if (live) setState({ error: errorMessage(err, "Could not read the document") });
      });
    return () => {
      live = false;
    };
  }, [companyId, roomId, document.id]);
  if (state === null) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner size={20} />
      </div>
    );
  }
  if ("error" in state)
    return <p className="text-sm text-rose-700 dark:text-rose-300">{state.error}</p>;
  if (!state.text) {
    return (
      <p className="p-6 text-center text-sm text-slate-500 dark:text-slate-400">
        No text could be read from this file. Download it to open it.
      </p>
    );
  }
  return (
    <div className="max-h-[70vh] overflow-y-auto rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      {document.viewerKind === "file" && (
        <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
          The text read from the file. Download it for the original layout.
        </p>
      )}
      <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6 text-slate-800 dark:text-slate-200">
        {state.text}
      </pre>
      {state.truncated && (
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          The rest is cut for length.
        </p>
      )}
    </div>
  );
}

export function BriefPanel({
  document,
  job,
}: {
  document: DataRoomDocument;
  job: DataRoomJob | null;
}) {
  const brief = document.brief;
  if (!brief) {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 p-4 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
        {document.textStatus === "none" ? (
          "No text could be read from this file, so it has no brief. Scanned PDFs and images need a text version for the AI Employee to read."
        ) : jobIsActive(job) ? (
          <span className="flex items-center gap-2">
            <Spinner size={14} /> The AI Employee is reading it for a brief.
          </span>
        ) : job?.status === "failed" ? (
          <span className="text-rose-700 dark:text-rose-300">The brief failed: {job.error}</span>
        ) : (
          "No brief yet."
        )}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
          Brief{" "}
          <Badge tone="ai" icon={<Sparkles />}>
            AI
          </Badge>
        </div>
        <p className="mt-1.5 text-sm leading-6 text-slate-700 dark:text-slate-300">
          {brief.summary}
        </p>
        {document.briefAt && (
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Written {agoText(document.briefAt)}
          </p>
        )}
      </div>
      {brief.keyFacts.length > 0 && (
        <div>
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">Key facts</div>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm text-slate-700 dark:text-slate-300">
            {brief.keyFacts.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
        </div>
      )}
      {brief.cautions.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-500/25 dark:bg-amber-500/10">
          <div className="flex items-center gap-1.5 text-xs font-medium text-amber-900 dark:text-amber-200">
            <AlertTriangle size={13} /> Check before sharing
          </div>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm text-amber-900 dark:text-amber-100">
            {brief.cautions.map((caution) => (
              <li key={caution}>{caution}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
