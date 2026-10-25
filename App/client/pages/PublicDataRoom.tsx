import React from "react";
import { useParams } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  CornerDownRight,
  Download,
  FileSpreadsheet,
  FileText,
  Folder,
  Image as ImageIcon,
  Lock,
  MessageCircleQuestion,
  Presentation,
  Quote,
  Search,
  Send,
  ShieldCheck,
} from "lucide-react";

import { LogoMark } from "@/components/Logo";
import { PdfCanvasRenderer } from "@/components/signatures/PdfCanvasRenderer";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClassName } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { Textarea } from "@/components/ui/Textarea";
import { clsx } from "@/components/ui/clsx";
import { ApiError } from "@/lib/api";
import {
  agoText,
  guestRoomApi,
  type GuestBlocked,
  type GuestDocument,
  type GuestQuestion,
  type GuestRoomView,
} from "@/lib/dataRooms";
import { errorMessage } from "@/lib/errors";
import { DATA_ROOM_LIMITS, formatFileSize } from "../../shared/dataRooms";

/** How often reading time is reported while a document is open and visible. */
const HEARTBEAT_SECONDS = 30;
/** How often the page checks for answers while a question is waiting. */
const ANSWER_POLL_MS = 20_000;

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; view: GuestRoomView }
  | { kind: "blocked"; blocked: GuestBlocked }
  | { kind: "invalid"; message: string };

/**
 * A data room as its guest sees it, through their private link and nothing
 * else: no account, no sign-in. The page records the visit, times each
 * document while it is open on screen, and asks and shows the guest's own
 * questions. Downloads appear only when the room allows them, and every PDF
 * arrives already stamped with the guest's email when the room watermarks.
 */
export default function PublicDataRoom() {
  const { token = "" } = useParams<{ token: string }>();
  const roomApi = React.useMemo(() => guestRoomApi(token), [token]);
  const [state, setState] = React.useState<LoadState>({ kind: "loading" });
  const visited = React.useRef(false);

  const load = React.useCallback(async () => {
    try {
      const view = await roomApi.get();
      setState({ kind: "ready", view });
      if (!visited.current) {
        visited.current = true;
        void roomApi.visit().catch(() => undefined);
      }
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.status === 403 &&
        err.data &&
        typeof err.data === "object" &&
        "blocked" in err.data
      ) {
        setState({ kind: "blocked", blocked: err.data as GuestBlocked });
        return;
      }
      setState({ kind: "invalid", message: errorMessage(err, "This data room link is invalid.") });
    }
  }, [roomApi]);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    if (state.kind === "ready")
      document.title = `${state.view.room.name} · ${state.view.company.name}`;
  }, [state]);

  if (state.kind === "loading") {
    return (
      <Shell>
        <div className="flex min-h-[60vh] items-center justify-center gap-3 text-sm text-slate-500 dark:text-slate-400">
          <Spinner size={20} /> Opening the data room…
        </div>
      </Shell>
    );
  }
  if (state.kind === "invalid") {
    return (
      <Shell>
        <Notice
          title="This link doesn't open a data room"
          description="It may have been mistyped, or replaced with a new one. Ask the company that shared it for a fresh link."
        />
      </Shell>
    );
  }
  if (state.kind === "blocked") {
    const { blocked } = state;
    return (
      <Shell companyName={blocked.companyName} roomName={blocked.roomName}>
        <Notice
          title={
            blocked.blocked === "closed"
              ? "This data room is closed"
              : blocked.blocked === "expired"
                ? "Your access has ended"
                : "Your access was withdrawn"
          }
          description={`${blocked.error} Contact ${blocked.companyName} if you think this is a mistake.`}
        />
      </Shell>
    );
  }

  const { view } = state;
  if (!view.termsAccepted) {
    return (
      <Shell companyName={view.company.name} roomName={view.room.name} guest={view.guest}>
        <TermsGate
          view={view}
          onAccept={async (name) =>
            setState({ kind: "ready", view: await roomApi.acceptTerms(name) })
          }
        />
      </Shell>
    );
  }
  return (
    <Shell companyName={view.company.name} roomName={view.room.name} guest={view.guest} wide>
      <Room view={view} token={token} onChanged={load} />
    </Shell>
  );
}

function Shell({
  companyName,
  roomName,
  guest,
  wide = false,
  children,
}: {
  companyName?: string;
  roomName?: string;
  guest?: GuestRoomView["guest"];
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div
          className={clsx(
            "mx-auto flex h-14 items-center justify-between gap-4 px-4",
            wide ? "max-w-7xl" : "max-w-3xl",
          )}
        >
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
              <Lock size={15} />
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{companyName ?? "Data room"}</div>
              {roomName && (
                <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                  {roomName}
                </div>
              )}
            </div>
          </div>
          {guest && (
            <div className="hidden min-w-0 text-right text-xs text-slate-500 sm:block dark:text-slate-400">
              Viewing as{" "}
              <span className="font-medium text-slate-800 dark:text-slate-200">{guest.name}</span>
              <div className="truncate">{guest.email}</div>
            </div>
          )}
        </div>
      </header>
      <main className={clsx("mx-auto px-4 py-6", wide ? "max-w-7xl" : "max-w-3xl")}>
        {children}
      </main>
      <footer className="flex items-center justify-center gap-2 pb-8 text-xs text-slate-500 dark:text-slate-400">
        <LogoMark className="h-4 w-4" /> Shared privately through Genosyn
      </footer>
    </div>
  );
}

function Notice({ title, description }: { title: string; description: string }) {
  return (
    <div className="mx-auto mt-10 max-w-lg rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <AlertTriangle size={24} className="mx-auto text-amber-500" />
      <h1 className="mt-3 text-lg font-semibold">{title}</h1>
      <p className="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">{description}</p>
    </div>
  );
}

function TermsGate({
  view,
  onAccept,
}: {
  view: GuestRoomView;
  onAccept: (name: string) => Promise<void>;
}) {
  const [name, setName] = React.useState(view.guest.name);
  const [agreed, setAgreed] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!agreed) {
      setError("Tick the box to agree to the terms.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onAccept(name.trim());
    } catch (err) {
      setError(errorMessage(err, "Could not record your acceptance"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="flex items-center gap-2 text-sm font-semibold">
        <ShieldCheck size={16} className="text-indigo-600 dark:text-indigo-300" /> Before you enter
      </div>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        {view.company.name} asks every guest to accept these terms before opening {view.room.name}.
      </p>
      <div className="mt-4 max-h-80 overflow-y-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-700 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300">
        {view.room.termsText}
      </div>
      <label className="mt-4 block">
        <span className="text-sm font-medium">Your full name</span>
        <Input
          className="mt-1 w-full"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={160}
        />
      </label>
      <label className="mt-3 flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
        <input
          type="checkbox"
          className="mt-1"
          checked={agreed}
          onChange={(event) => setAgreed(event.target.checked)}
        />
        I have read and agree to these terms. My acceptance, with my name and the time, is recorded.
      </label>
      <FormError message={error} className="mt-3" />
      <Button type="submit" className="mt-4" loading={saving} disabled={name.trim().length < 2}>
        <ShieldCheck size={15} /> Agree and enter
      </Button>
    </form>
  );
}

function DocumentGlyph({ document }: { document: GuestDocument }) {
  const extension = document.filename.toLowerCase().split(".").pop() ?? "";
  const Icon =
    document.viewerKind === "image"
      ? ImageIcon
      : extension === "xlsx" || extension === "csv"
        ? FileSpreadsheet
        : extension === "pptx"
          ? Presentation
          : FileText;
  return <Icon size={15} className="shrink-0 text-slate-400" />;
}

function Room({
  view,
  token,
  onChanged,
}: {
  view: GuestRoomView;
  token: string;
  onChanged: () => Promise<void>;
}) {
  const roomApi = React.useMemo(() => guestRoomApi(token), [token]);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [highlight, setHighlight] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const byId = new Map(view.documents.map((document) => [document.id, document]));
  const open = openId ? (byId.get(openId) ?? null) : null;
  const numbering = React.useMemo(() => {
    const numbers = new Map<string, string>();
    for (const folder of view.folders) {
      view.documents
        .filter((document) => document.folderId === folder.id)
        .forEach((document, index) => numbers.set(document.id, `${folder.number}.${index + 1}`));
    }
    return numbers;
  }, [view]);

  // Answers arrive without a socket: check now and then while one is waiting.
  const waiting = view.questions.some((question) => question.status === "open");
  React.useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => void onChanged(), ANSWER_POLL_MS);
    return () => window.clearInterval(timer);
  }, [waiting, onChanged]);

  const needle = query.trim().toLowerCase();
  const matches = (document: GuestDocument) =>
    !needle || document.title.toLowerCase().includes(needle);
  const groups = [
    ...view.folders.map((folder) => ({
      key: folder.id,
      label: `${folder.number}  ${folder.name}`,
      documents: view.documents.filter(
        (document) => document.folderId === folder.id && matches(document),
      ),
    })),
    {
      key: "top",
      label: "Other documents",
      documents: view.documents.filter((document) => !document.folderId && matches(document)),
    },
  ].filter((group) => group.documents.length > 0 || (!needle && group.key !== "top"));

  const openDocument = (documentId: string, quote: string | null = null) => {
    setOpenId(documentId);
    setHighlight(quote);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // Phones read the room first, then its index, then questions; wide screens
  // keep the index beside both.
  return (
    <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)] lg:grid-rows-[auto_1fr] lg:items-start">
      <aside
        className={clsx("order-2 space-y-3 lg:order-none lg:row-span-2", open && "hidden lg:block")}
      >
        <label className="relative block">
          <span className="sr-only">Search documents</span>
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search documents"
            className="w-full pl-8"
          />
        </label>
        <nav
          aria-label="Documents"
          className="rounded-xl border border-slate-200 bg-white p-2 shadow-sm dark:border-slate-800 dark:bg-slate-900"
        >
          {view.documents.length === 0 ? (
            <p className="p-3 text-sm text-slate-500 dark:text-slate-400">
              No documents have been shared with you yet.
            </p>
          ) : groups.length === 0 ? (
            <p className="p-3 text-sm text-slate-500 dark:text-slate-400">No document matches.</p>
          ) : (
            groups.map((group) => (
              <div key={group.key} className="py-1">
                <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                  <Folder size={12} className="shrink-0" />
                  <span className="truncate">{group.label}</span>
                  {group.documents.length === 0 && (
                    <span className="shrink-0 font-normal text-slate-400 dark:text-slate-500">
                      · empty
                    </span>
                  )}
                </div>
                {group.documents.map((document) => (
                  <button
                    key={document.id}
                    type="button"
                    onClick={() => openDocument(document.id)}
                    aria-current={openId === document.id ? "page" : undefined}
                    className={clsx(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
                      openId === document.id
                        ? "bg-indigo-50 text-indigo-800 dark:bg-indigo-500/15 dark:text-indigo-100"
                        : "text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800/60",
                    )}
                  >
                    <DocumentGlyph document={document} />
                    {numbering.get(document.id) && (
                      <span className="shrink-0 text-xs tabular-nums text-slate-400">
                        {numbering.get(document.id)}
                      </span>
                    )}
                    <span className="min-w-0 truncate">{document.title}</span>
                  </button>
                ))}
              </div>
            ))
          )}
        </nav>
        <p className="flex items-start gap-1.5 px-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
          <ShieldCheck size={13} className="mt-0.5 shrink-0" />
          {view.room.allowDownloads ? "You may download documents." : "Documents are view only."}
          {view.room.watermark ? " PDFs carry your email as a watermark." : ""}
        </p>
      </aside>

      <section className="order-1 min-w-0 lg:order-none lg:col-start-2">
        {open ? (
          <Viewer
            key={open.id}
            document={open}
            number={numbering.get(open.id) ?? null}
            token={token}
            allowDownloads={view.room.allowDownloads}
            highlight={highlight}
            onBack={() => setOpenId(null)}
          />
        ) : (
          <Welcome view={view} onOpen={openDocument} />
        )}
      </section>
      <section className="order-3 min-w-0 lg:order-none lg:col-start-2">
        <Questions
          view={view}
          current={open}
          onAsk={async (question, documentId) => {
            await roomApi.ask(question, documentId);
            await onChanged();
          }}
          onOpenDocument={openDocument}
          titleOf={(id) => byId.get(id)?.title ?? null}
        />
      </section>
    </div>
  );
}

function Welcome({ view, onOpen }: { view: GuestRoomView; onOpen: (documentId: string) => void }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{view.room.name}</h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        Shared with you by {view.company.name}
        {view.guest.expiresAt
          ? ` · open to you until ${new Date(view.guest.expiresAt).toLocaleDateString()}`
          : ""}
      </p>
      {view.room.welcomeMessage && (
        <p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-slate-700 dark:text-slate-300">
          {view.room.welcomeMessage}
        </p>
      )}
      {view.documents.length > 0 && (
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button onClick={() => onOpen(view.documents[0].id)}>
            <FileText size={15} /> Start reading
          </Button>
          <span className="text-sm text-slate-500 dark:text-slate-400">
            {view.documents.length} {view.documents.length === 1 ? "document" : "documents"}
            {view.folders.length
              ? ` in ${view.folders.length} ${view.folders.length === 1 ? "folder" : "folders"}`
              : ""}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * One open document, timed while it is on screen: a view is opened when it
 * mounts, a heartbeat reports the time every half minute while the tab is
 * visible, and the rest is reported when it closes.
 */
function Viewer({
  document,
  number,
  token,
  allowDownloads,
  highlight,
  onBack,
}: {
  document: GuestDocument;
  number: string | null;
  token: string;
  allowDownloads: boolean;
  highlight: string | null;
  onBack: () => void;
}) {
  const roomApi = React.useMemo(() => guestRoomApi(token), [token]);
  useReadingTimer(roomApi, document.id);
  const url = roomApi.fileUrl(document.id);
  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onBack} aria-label="Back to the room">
            <ArrowLeft size={15} />
          </Button>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">
              {number && <span className="mr-1.5 tabular-nums text-slate-400">{number}</span>}
              {document.title}
            </div>
            <div className="truncate text-xs text-slate-500 dark:text-slate-400">
              {document.filename} · {formatFileSize(document.sizeBytes)}
              {document.pageCount
                ? ` · ${document.pageCount} ${document.filename.toLowerCase().endsWith(".pptx") ? "slides" : "pages"}`
                : ""}
            </div>
          </div>
        </div>
        {allowDownloads && (
          <a
            href={roomApi.fileUrl(document.id, true)}
            className={buttonClassName({ variant: "secondary", size: "sm" })}
          >
            <Download size={14} /> Download
          </a>
        )}
      </div>
      <div className="bg-slate-50 p-3 sm:p-4 dark:bg-slate-950">
        {highlight && (
          <div className="mb-3 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-900 dark:border-indigo-500/25 dark:bg-indigo-500/10 dark:text-indigo-100">
            <span className="font-medium">Quoted in an answer:</span> &ldquo;{highlight}&rdquo;
          </div>
        )}
        {document.viewerKind === "pdf" ? (
          <PdfCanvasRenderer sourceUrl={url} readOnly className="max-h-[75vh] overflow-y-auto" />
        ) : document.viewerKind === "image" ? (
          <img
            src={url}
            alt={document.title}
            className="mx-auto max-h-[75vh] max-w-full rounded-lg bg-white object-contain"
          />
        ) : (
          <GuestText roomApi={roomApi} document={document} allowDownloads={allowDownloads} />
        )}
      </div>
    </div>
  );
}

function useReadingTimer(roomApi: ReturnType<typeof guestRoomApi>, documentId: string) {
  React.useEffect(() => {
    let viewId: string | null = null;
    let since = Date.now();
    let stopped = false;
    const report = (final: boolean) => {
      if (!viewId) return;
      const seconds = Math.round((Date.now() - since) / 1000);
      since = Date.now();
      if (seconds < (final ? 3 : 1) || window.document.visibilityState === "hidden") return;
      void roomApi.heartbeat(viewId, Math.min(120, seconds)).catch(() => undefined);
    };
    void roomApi
      .openView(documentId)
      .then((result) => {
        if (!stopped) viewId = result.viewId;
      })
      .catch(() => undefined);
    const timer = window.setInterval(() => report(false), HEARTBEAT_SECONDS * 1000);
    // Time away from the tab is not reading time.
    const visibility = () => {
      if (window.document.visibilityState === "visible") since = Date.now();
      else report(true);
    };
    window.document.addEventListener("visibilitychange", visibility);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.document.removeEventListener("visibilitychange", visibility);
      report(true);
    };
  }, [roomApi, documentId]);
}

function GuestText({
  roomApi,
  document,
  allowDownloads,
}: {
  roomApi: ReturnType<typeof guestRoomApi>;
  document: GuestDocument;
  allowDownloads: boolean;
}) {
  const [state, setState] = React.useState<
    { text: string; truncated: boolean } | { error: string } | null
  >(null);
  React.useEffect(() => {
    let live = true;
    roomApi
      .text(document.id)
      .then((result) => {
        if (live) setState(result);
      })
      .catch((err: unknown) => {
        if (live) setState({ error: errorMessage(err, "This document could not be opened") });
      });
    return () => {
      live = false;
    };
  }, [roomApi, document.id]);
  if (state === null) {
    return (
      <div className="flex h-48 items-center justify-center">
        <Spinner size={20} />
      </div>
    );
  }
  if ("error" in state)
    return <p className="text-sm text-rose-700 dark:text-rose-300">{state.error}</p>;
  if (!state.text) {
    return (
      <p className="p-6 text-center text-sm text-slate-500 dark:text-slate-400">
        This file can&apos;t be shown here.
        {allowDownloads ? " Download it to open it." : " Ask the company for another format."}
      </p>
    );
  }
  return (
    <div className="max-h-[75vh] overflow-y-auto rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      {document.viewerKind === "file" && (
        <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
          The text of the file{allowDownloads ? " — download it for the original layout" : ""}.
        </p>
      )}
      <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6 text-slate-800 dark:text-slate-200">
        {state.text}
      </pre>
    </div>
  );
}

function Questions({
  view,
  current,
  onAsk,
  onOpenDocument,
  titleOf,
}: {
  view: GuestRoomView;
  current: GuestDocument | null;
  onAsk: (question: string, documentId: string | null) => Promise<void>;
  onOpenDocument: (documentId: string, quote: string | null) => void;
  titleOf: (id: string) => string | null;
}) {
  const [text, setText] = React.useState("");
  const [aboutCurrent, setAboutCurrent] = React.useState(true);
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (text.trim().length < 3) {
      setError("Write your question.");
      return;
    }
    setSending(true);
    setError(null);
    try {
      await onAsk(text.trim(), current && aboutCurrent ? current.id : null);
      setText("");
    } catch (err) {
      setError(errorMessage(err, "Your question could not be sent"));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <MessageCircleQuestion size={16} /> Questions
      </h2>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        Only you and {view.company.name} see what you ask here. Answers point to the documents they
        come from.
      </p>
      <form onSubmit={submit} className="mt-3 space-y-2">
        <Textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={3}
          maxLength={DATA_ROOM_LIMITS.questionChars}
          placeholder={
            current
              ? `Ask about ${current.title}, or anything in the room`
              : "Ask anything about the room"
          }
          className="w-full"
        />
        {current && (
          <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
            <input
              type="checkbox"
              checked={aboutCurrent}
              onChange={(event) => setAboutCurrent(event.target.checked)}
            />
            About {current.title}
          </label>
        )}
        <FormError message={error} />
        <Button type="submit" size="sm" loading={sending}>
          <Send size={14} /> Ask
        </Button>
      </form>
      {view.questions.length > 0 && (
        <ul className="mt-5 space-y-4 border-t border-slate-100 pt-4 dark:border-slate-800">
          {view.questions.map((question) => (
            <GuestQuestionItem
              key={question.id}
              question={question}
              titleOf={titleOf}
              onOpenDocument={onOpenDocument}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function GuestQuestionItem({
  question,
  titleOf,
  onOpenDocument,
}: {
  question: GuestQuestion;
  titleOf: (id: string) => string | null;
  onOpenDocument: (documentId: string, quote: string | null) => void;
}) {
  const about = question.documentId ? titleOf(question.documentId) : null;
  return (
    <li>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
        <span>Asked {agoText(question.createdAt)}</span>
        {about && (
          <>
            <span aria-hidden="true">·</span>
            <span>about {about}</span>
          </>
        )}
        {question.status === "open" && <Badge tone="info">Waiting for an answer</Badge>}
        {question.status === "closed" && <Badge>Closed</Badge>}
      </div>
      <p className="mt-1 whitespace-pre-wrap text-sm text-slate-900 dark:text-slate-100">
        {question.body}
      </p>
      {question.status === "answered" && question.answer && (
        <div className="mt-2 border-l-2 border-emerald-300 pl-3 dark:border-emerald-500/50">
          <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            <CornerDownRight size={12} /> Answered {agoText(question.answeredAt)}
          </div>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-800 dark:text-slate-200">
            {question.answer}
          </p>
          {question.citations.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {question.citations.map((citation) => (
                <li key={`${citation.documentId}-${citation.quote}`}>
                  <button
                    type="button"
                    onClick={() => onOpenDocument(citation.documentId, citation.quote)}
                    className="flex w-full items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-left hover:bg-slate-100 dark:bg-slate-950 dark:hover:bg-slate-800"
                  >
                    <Quote size={13} className="mt-0.5 shrink-0 text-slate-400" />
                    <span className="min-w-0">
                      <span className="block text-sm italic text-slate-700 dark:text-slate-300">
                        &ldquo;{citation.quote}&rdquo;
                      </span>
                      <span className="block truncate text-xs text-indigo-600 dark:text-indigo-300">
                        {titleOf(citation.documentId) ?? citation.title}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}
