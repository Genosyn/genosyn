import React from "react";
import { Link, useLocation, useNavigate, useOutletContext, useParams } from "react-router-dom";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  CopyPlus,
  CornerUpRight,
  FilePlus,
  History,
  Link2,
  MoreHorizontal,
  RotateCcw,
  Share2,
  SmilePlus,
  Trash2,
} from "lucide-react";
import { api, Company, Note, NoteOutline } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { copyToClipboard } from "../lib/clipboard";
import { Spinner } from "../components/ui/Spinner";
import { FormError } from "../components/ui/FormError";
import { useDialog } from "../components/ui/Dialog";
import { Menu, MenuItem, MenuSeparator } from "../components/ui/Menu";
import { clsx } from "../components/ui/clsx";
import { BlockEditor, type BlockEditorHandle } from "../components/notes/BlockEditor";
import { IconPicker, NoteIcon, formatRelative } from "../components/notes/NoteIcon";
import { NoteShareModal } from "../components/notes/NoteShareModal";
import { AsyncResourceTagPicker } from "../components/TagPicker";
import { useLiveRefetch } from "../components/CompanySocket";
import { RecordHistory } from "../components/RecordHistory";
import { Autosaver, type AutosaveStatus, type SaveOutcome } from "../lib/noteAutosave";
import {
  browserStorage,
  clearDraft,
  draftKey,
  planDraftRecovery,
  readDraft,
  writeDraft,
} from "../lib/noteDrafts";
import type { NoteSnapshot } from "../lib/noteMerge";
import type { NotesContext } from "./NotesLayout";

/**
 * One note, laid out like a Notion page: an icon and a title you click and
 * type into, a quiet line of tags and who edited it last, then the blocks.
 * There is no edit mode and no Save button — everything saves as you go,
 * a copy of unsaved edits is kept in the browser until the server has them,
 * and an AI Employee's change while you're on the page arrives live, merged
 * with whatever you were typing.
 *
 * The URL is `/c/<co>/notes/<notebook>/<note>`.
 */
export default function NoteDetail({ company }: { company: Company }) {
  const { noteSlug, notebookSlug } = useParams<{ noteSlug: string; notebookSlug: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const ctx = useOutletContext<NotesContext>();
  const dialog = useDialog();

  const [note, setNote] = React.useState<Note | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [title, setTitle] = React.useState("");
  const [icon, setIcon] = React.useState("");
  const [body, setBody] = React.useState("");
  const [editorKey, setEditorKey] = React.useState(0);
  const [status, setStatus] = React.useState<AutosaveStatus>("idle");
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [shareOpen, setShareOpen] = React.useState(false);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [iconOpen, setIconOpen] = React.useState(false);
  const [reloadToken, setReloadToken] = React.useState(0);

  const saverRef = React.useRef<Autosaver | null>(null);
  const snapshotRef = React.useRef<NoteSnapshot>({ title: "", body: "", icon: "" });
  const editorRef = React.useRef<BlockEditorHandle>(null);
  const titleRef = React.useRef<HTMLTextAreaElement>(null);
  const iconButtonRef = React.useRef<HTMLButtonElement>(null);
  const historyRef = React.useRef<HTMLDivElement>(null);
  const mounted = React.useRef(true);
  const draftTimer = React.useRef<number | null>(null);
  const isNewNote = Boolean((location.state as { newNote?: unknown } | null)?.newNote);

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const noteId = note?.id ?? null;
  const base = `/api/companies/${company.id}`;

  const persistDraft = React.useCallback(() => {
    const saver = saverRef.current;
    if (!saver || !noteId) return;
    const key = draftKey(company.id, noteId);
    if (!saver.dirty) {
      clearDraft(browserStorage(), key);
      return;
    }
    writeDraft(browserStorage(), key, {
      v: 1,
      noteId,
      snapshot: snapshotRef.current,
      base: saver.serverVersion.snapshot,
      baseVersion: saver.serverVersion.version,
      savedAt: Date.now(),
    });
  }, [company.id, noteId]);

  /** Show a snapshot in the page (a merge or a live update). */
  const applySnapshot = React.useCallback(
    (snapshot: NoteSnapshot) => {
      snapshotRef.current = snapshot;
      setTitle(snapshot.title === "Untitled" ? "" : snapshot.title);
      setIcon(snapshot.icon);
      setBody(snapshot.body);
      if (noteId) ctx.patchNote(noteId, { title: snapshot.title.trim() || "Untitled", icon: snapshot.icon });
    },
    [ctx, noteId],
  );
  const applyRef = React.useRef(applySnapshot);
  applyRef.current = applySnapshot;

  // Load the page, restore any unsaved edits left in this browser, and start saving.
  React.useEffect(() => {
    if (!noteSlug) return;
    let cancelled = false;
    setNote(null);
    setLoadError(null);
    setSaveError(null);
    setNotice(null);
    setStatus("idle");
    api
      .get<Note>(`${base}/notes/${noteSlug}`)
      .then((loaded) => {
        if (cancelled) return;
        const server: NoteSnapshot = { title: loaded.title, body: loaded.body, icon: loaded.icon };
        const version = loaded.version ?? loaded.updatedAt;
        const key = draftKey(company.id, loaded.id);
        const plan = planDraftRecovery(readDraft(browserStorage(), key), { ...server, version }, Date.now());
        if (plan.kind === "discard") clearDraft(browserStorage(), key);
        const shown = plan.kind === "restore" ? plan.snapshot : server;

        const save = async (
          snapshot: NoteSnapshot,
          baseVersion: string,
          options: { keepalive: boolean },
        ): Promise<SaveOutcome> => {
          const payload = JSON.stringify({ ...snapshot, baseVersion });
          try {
            const res = await fetch(`${base}/notes/${loaded.slug}`, {
              method: "PATCH",
              credentials: "same-origin",
              headers: { "content-type": "application/json" },
              body: payload,
              // keepalive lets a save finish after the tab closes; browsers cap it at 64KB.
              keepalive: options.keepalive && payload.length < 60_000,
            });
            const text = await res.text();
            const data = text ? (JSON.parse(text) as { error?: string; note?: Note } & Partial<Note>) : null;
            if (res.status === 409 && data?.note) {
              const current = data.note;
              return {
                kind: "conflict",
                server: {
                  snapshot: { title: current.title, body: current.body, icon: current.icon },
                  version: current.version ?? current.updatedAt,
                },
              };
            }
            if (!res.ok || !data) {
              return { kind: "error", error: new Error(data?.error ?? `The server answered ${res.status}`) };
            }
            const saved = data as Note;
            if (mounted.current) {
              setNote((current) => (current && current.id === saved.id ? saved : current));
              ctx.patchNote(saved.id, {
                title: saved.title,
                icon: saved.icon,
                updatedAt: saved.updatedAt,
                lastEditedBy: saved.lastEditedBy,
              });
            }
            return {
              kind: "saved",
              server: {
                snapshot: { title: saved.title, body: saved.body, icon: saved.icon },
                version: saved.version ?? saved.updatedAt,
              },
            };
          } catch (error) {
            return { kind: "error", error };
          }
        };

        const saver = new Autosaver(
          { snapshot: server, version },
          {
            save,
            onStatus: (next, error) => {
              if (!mounted.current) return;
              setStatus(next);
              setSaveError(next === "error" ? errorMessage(error, "Couldn't save your changes") : null);
            },
            onSaved: () => {
              // The server has everything typed so far: the browser copy can go.
              if (!saver.dirty) clearDraft(browserStorage(), key);
            },
            onMerged: (snapshot, conflicts) => {
              if (!mounted.current) return;
              applyRef.current(snapshot);
              setNotice(
                conflicts > 0
                  ? "Someone else edited the same lines while you typed. Your version of those lines was kept."
                  : null,
              );
            },
          },
        );
        saverRef.current?.dispose();
        saverRef.current = saver;
        snapshotRef.current = shown;
        setNote(loaded);
        setTitle(shown.title === "Untitled" ? "" : shown.title);
        setIcon(shown.icon);
        setBody(shown.body);
        setEditorKey((k) => k + 1);
        if (plan.kind === "restore") {
          saver.update(shown);
          setNotice(
            plan.conflicts > 0
              ? "Restored edits you hadn't saved. Some overlapped newer changes; your version of those lines was kept."
              : "Restored edits you hadn't saved yet.",
          );
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err, "Could not load the page"));
      });
    return () => {
      cancelled = true;
    };
    // ctx.patchNote is stable; the page reloads only when the address changes
    // (or a restore from the trash asks for a fresh copy).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, company.id, noteSlug, reloadToken]);

  // Leaving the page (another page, another section, an unmount) sends what's unsaved.
  React.useEffect(() => {
    return () => {
      saverRef.current?.dispose();
      saverRef.current = null;
    };
  }, [noteSlug]);

  // Closing the tab or hiding it: save now, and keep the browser copy current.
  React.useEffect(() => {
    const flush = () => {
      persistDraft();
      void saverRef.current?.flush({ keepalive: true });
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [persistDraft]);

  const changed = React.useCallback(
    (patch: Partial<NoteSnapshot>) => {
      const next = { ...snapshotRef.current, ...patch };
      snapshotRef.current = next;
      saverRef.current?.update(next);
      if (draftTimer.current === null) {
        draftTimer.current = window.setTimeout(() => {
          draftTimer.current = null;
          persistDraft();
        }, 300);
      }
    },
    [persistDraft],
  );

  React.useEffect(
    () => () => {
      if (draftTimer.current !== null) window.clearTimeout(draftTimer.current);
    },
    [],
  );

  const onBodyChange = React.useCallback(
    (markdown: string) => {
      setBody(markdown);
      changed({ body: markdown });
    },
    [changed],
  );

  const onTitleChange = (value: string) => {
    const clean = value.replace(/\n/g, " ");
    setTitle(clean);
    changed({ title: clean });
    if (noteId) ctx.patchNote(noteId, { title: clean.trim() || "Untitled" });
  };

  const onIconChange = (value: string) => {
    setIcon(value);
    setIconOpen(false);
    changed({ icon: value });
    if (noteId) ctx.patchNote(noteId, { icon: value });
  };

  // An edit by someone else (an AI Employee, another tab) shows up live.
  const onRemoteChange = React.useCallback(async () => {
    const saver = saverRef.current;
    if (!saver || saver.saving || !noteSlug) return;
    try {
      const fresh = await api.get<Note>(`${base}/notes/${noteSlug}`);
      if (saverRef.current !== saver || saver.saving) return;
      const version = fresh.version ?? fresh.updatedAt;
      if (version === saver.serverVersion.version) return;
      const result = saver.serverChanged({
        snapshot: { title: fresh.title, body: fresh.body, icon: fresh.icon },
        version,
      });
      if (!result) return;
      applySnapshot(result.snapshot);
      setNote(fresh);
      if (result.conflicts > 0) {
        setNotice("Someone else edited the same lines while you typed. Your version of those lines was kept.");
      }
    } catch {
      // A missed live update is caught by the next one, or by the next save's version check.
    }
  }, [applySnapshot, base, noteSlug]);
  useLiveRefetch("note", onRemoteChange);

  // A new page opens with the caret in its title. Opening one from another page keeps the
  // old page on screen until the new one loads, so wait for the page in the address.
  const loadedId = note && note.slug === noteSlug ? note.id : null;
  React.useEffect(() => {
    if (!isNewNote || !loadedId) return;
    titleRef.current?.focus();
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [isNewNote, loadedId, navigate, location.pathname, location.search]);

  // Keep the address on the page's own notebook.
  const canonicalNotebook = React.useMemo(
    () => (note ? ctx.notebooks.find((nb) => nb.id === note.notebookId) ?? null : null),
    [ctx.notebooks, note],
  );
  React.useEffect(() => {
    if (!note || !canonicalNotebook) return;
    if (notebookSlug && notebookSlug !== canonicalNotebook.slug) {
      navigate(`/c/${company.slug}/notes/${canonicalNotebook.slug}/${note.slug}`, { replace: true });
    }
  }, [canonicalNotebook, company.slug, navigate, note, notebookSlug]);

  // ⌘S saves now (there is nothing else to save) rather than downloading the page.
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saverRef.current?.flush();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The title grows with its text instead of scrolling.
  React.useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [title, note]);

  const outline = React.useMemo<NoteOutline | null>(
    () => (note ? ctx.notes.find((n) => n.id === note.id) ?? null : null),
    [ctx.notes, note],
  );
  const children = React.useMemo(
    () =>
      note
        ? ctx.notes
            .filter((n) => n.parentId === note.id)
            .sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title))
        : [],
    [ctx.notes, note],
  );
  const trail = React.useMemo(() => {
    if (!note) return [];
    const byId = new Map(ctx.notes.map((n) => [n.id, n]));
    const out: NoteOutline[] = [];
    const seen = new Set<string>([note.id]);
    let cursor = note.parentId ? byId.get(note.parentId) : undefined;
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      out.unshift(cursor);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    return out;
  }, [ctx.notes, note]);

  async function createSubpage() {
    if (!outline) return;
    await saverRef.current?.flush();
    await ctx.createPage({ parent: outline });
  }

  async function restore() {
    if (!note) return;
    try {
      await api.patch<Note>(`${base}/notes/${note.slug}`, { archived: false });
      setReloadToken((t) => t + 1);
      await ctx.refresh();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t restore the page" });
    }
  }

  async function destroy() {
    if (!note) return;
    const ok = await dialog.confirm({
      title: `Delete “${note.title || "Untitled"}” forever?`,
      message: "This can't be undone. Pages inside it stay in the trash, one level up.",
      confirmLabel: "Delete forever",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api.del(`${base}/notes/${note.slug}`);
      await ctx.refresh();
      navigate(canonicalNotebook ? `/c/${company.slug}/notes/${canonicalNotebook.slug}` : `/c/${company.slug}/notes`);
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t delete the page" });
    }
  }

  if (loadError) {
    return (
      <div className="flex h-full items-start justify-center px-6 pt-14">
        <div className="w-full max-w-md">
          <FormError message={loadError} />
          <Link to={`/c/${company.slug}/notes`} className="mt-3 inline-block text-sm text-indigo-600 hover:underline dark:text-indigo-300">
            Back to Notes
          </Link>
        </div>
      </div>
    );
  }

  if (!note) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const archived = Boolean(note.archivedAt);
  const editor = note.lastEditedBy ?? note.createdBy;
  const pageForMenus: NoteOutline = outline ?? { ...note, preview: "" };

  return (
    <div className="flex h-full flex-col">
      <header className="sticky top-0 z-20 flex h-11 items-center justify-between gap-2 border-b border-slate-100 bg-white/90 px-3 backdrop-blur sm:px-4 dark:border-slate-800 dark:bg-slate-950/85">
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-0.5 text-sm text-slate-500 dark:text-slate-400">
          {canonicalNotebook && (
            <Crumb to={`/c/${company.slug}/notes/${canonicalNotebook.slug}`} icon={<NoteIcon icon={canonicalNotebook.icon} kind="notebook" size={13} />}>
              {canonicalNotebook.title}
            </Crumb>
          )}
          {trail.length > 1 && (
            <>
              <Divider />
              <span className="px-1 sm:hidden">…</span>
            </>
          )}
          {trail.map((page, i) => (
            <React.Fragment key={page.id}>
              <Divider className={i < trail.length - 1 ? "hidden sm:block" : undefined} />
              <Crumb
                to={ctx.hrefFor(page)}
                icon={<NoteIcon icon={page.icon} size={13} />}
                className={i < trail.length - 1 ? "hidden sm:flex" : undefined}
              >
                {page.title || "Untitled"}
              </Crumb>
            </React.Fragment>
          ))}
          <Divider />
          <span className="flex min-w-0 items-center gap-1 px-1 font-medium text-slate-700 dark:text-slate-200">
            <NoteIcon icon={icon} size={13} />
            <span className="truncate">{title.trim() || "Untitled"}</span>
          </span>
        </nav>
        <div className="flex shrink-0 items-center gap-1">
          <SaveStatus status={status} archived={archived} onRetry={() => void saverRef.current?.retry()} />
          <button
            type="button"
            onClick={() => setShareOpen(true)}
            className="flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-md px-2 text-sm text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100"
            title="Share with AI Employees"
          >
            <Share2 size={14} />
            <span className="hidden sm:inline">Share</span>
          </button>
          <Menu
            align="right"
            width={220}
            trigger={({ ref, onClick, open }) => (
              <button
                ref={ref}
                type="button"
                onClick={onClick}
                aria-label="Page actions"
                aria-expanded={open}
                className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
              >
                <MoreHorizontal size={16} />
              </button>
            )}
          >
            {(close) =>
              archived ? (
                <>
                  <MenuItem icon={<RotateCcw size={14} />} label="Restore page" onSelect={() => { close(); void restore(); }} />
                  <MenuSeparator />
                  <MenuItem
                    icon={<Trash2 size={14} />}
                    label="Delete forever"
                    className="text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10"
                    onSelect={() => { close(); void destroy(); }}
                  />
                </>
              ) : (
                <>
                  <MenuItem
                    icon={<Link2 size={14} />}
                    label="Copy link"
                    onSelect={() => {
                      close();
                      void copyToClipboard(window.location.href);
                    }}
                  />
                  <MenuItem
                    icon={<CopyPlus size={14} />}
                    label="Duplicate"
                    onSelect={async () => {
                      close();
                      await saverRef.current?.flush();
                      void ctx.duplicatePage(pageForMenus);
                    }}
                  />
                  <MenuItem icon={<CornerUpRight size={14} />} label="Move to…" onSelect={() => { close(); ctx.openMoveDialog(pageForMenus); }} />
                  <MenuItem icon={<FilePlus size={14} />} label="Add a page inside" onSelect={() => { close(); void createSubpage(); }} />
                  <MenuItem
                    icon={<History size={14} />}
                    label="Page history"
                    onSelect={() => {
                      close();
                      setHistoryOpen(true);
                      requestAnimationFrame(() => historyRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
                    }}
                  />
                  <MenuSeparator />
                  <MenuItem
                    icon={<Trash2 size={14} />}
                    label="Move to trash"
                    className="text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10"
                    onSelect={async () => {
                      close();
                      await saverRef.current?.flush();
                      ctx.trashPage(pageForMenus);
                    }}
                  />
                </>
              )
            }
          </Menu>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <article className="mx-auto w-full max-w-[52rem] px-8 pb-24 pt-10 sm:px-16 sm:pt-16 lg:px-24">
          {archived && (
            <div className="mb-6 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200">
              <span>This page is in the trash.</span>
              <span className="flex items-center gap-2">
                <button type="button" onClick={() => void restore()} className="rounded-md border border-rose-300 px-2 py-0.5 font-medium hover:bg-rose-100 dark:border-rose-800 dark:hover:bg-rose-900/40">
                  Restore page
                </button>
                <button type="button" onClick={() => void destroy()} className="rounded-md px-2 py-0.5 hover:bg-rose-100 dark:hover:bg-rose-900/40">
                  Delete forever
                </button>
              </span>
            </div>
          )}
          {saveError && (
            <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
              <AlertCircle size={15} className="mt-0.5 shrink-0" />
              <span className="flex-1">
                {saveError}. Your edits are kept in this browser and will be saved when the connection is back.
              </span>
              <button type="button" onClick={() => void saverRef.current?.retry()} className="font-medium underline-offset-2 hover:underline">
                Retry now
              </button>
            </div>
          )}
          {notice && (
            <div className="mb-4 flex items-start justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:bg-slate-900 dark:text-slate-300">
              <span>{notice}</span>
              <button type="button" onClick={() => setNotice(null)} className="shrink-0 text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-100">
                Dismiss
              </button>
            </div>
          )}

          <div className="group/title relative">
            {icon ? (
              <div className="relative mb-2 inline-block">
                <button
                  ref={iconButtonRef}
                  type="button"
                  disabled={archived}
                  onClick={() => setIconOpen((v) => !v)}
                  aria-label="Change icon"
                  className="-ml-1 flex h-[4.5rem] w-[4.5rem] items-center justify-center rounded-lg text-[3.25rem] leading-none hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <span aria-hidden>{icon}</span>
                </button>
                {iconOpen && (
                  <IconPicker
                    current={icon}
                    onPick={onIconChange}
                    onRemove={() => onIconChange("")}
                    onClose={() => setIconOpen(false)}
                    triggerRef={iconButtonRef}
                  />
                )}
              </div>
            ) : (
              !archived && (
                <div className="relative mb-1 h-7">
                  <button
                    ref={iconButtonRef}
                    type="button"
                    onClick={() => setIconOpen((v) => !v)}
                    className="touch-target relative flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm text-slate-400 opacity-0 transition-opacity hover:bg-slate-100 hover:text-slate-600 focus-visible:opacity-100 group-hover/title:opacity-100 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-300 [@media(hover:none)]:opacity-100"
                  >
                    <SmilePlus size={15} /> Add icon
                  </button>
                  {iconOpen && (
                    <IconPicker
                      current=""
                      onPick={onIconChange}
                      onRemove={() => onIconChange("")}
                      onClose={() => setIconOpen(false)}
                      triggerRef={iconButtonRef}
                    />
                  )}
                </div>
              )
            )}
            <textarea
              ref={titleRef}
              value={title}
              rows={1}
              readOnly={archived}
              onChange={(event) => onTitleChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                const el = event.currentTarget;
                const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
                if (event.key === "Enter" || (event.key === "ArrowDown" && atEnd)) {
                  event.preventDefault();
                  editorRef.current?.focusStart();
                }
              }}
              aria-label="Page title"
              placeholder="Untitled"
              className="block w-full resize-none overflow-hidden border-0 bg-transparent p-0 text-[2.25rem] font-bold leading-[1.2] tracking-tight text-slate-900 placeholder:text-slate-300 focus:outline-none focus:ring-0 sm:text-[2.5rem] dark:text-slate-50 dark:placeholder:text-slate-600"
            />
          </div>

          <div className="mb-8 mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-slate-400 dark:text-slate-500">
            <AsyncResourceTagPicker companyId={company.id} resourceType="note" resourceId={note.id} variant="inline" />
            {editor && (
              <span className="flex items-center gap-1">
                Edited {formatRelative(note.updatedAt)} by{" "}
                <span className="font-medium text-slate-500 dark:text-slate-400">{editor.name}</span>
                {editor.kind === "ai" && (
                  <span className="rounded bg-violet-50 px-1 text-xs font-medium text-violet-600 dark:bg-violet-500/15 dark:text-violet-300">
                    AI Employee
                  </span>
                )}
              </span>
            )}
          </div>

          <BlockEditor
            key={editorKey}
            ref={editorRef}
            value={body}
            onChange={onBodyChange}
            readOnly={archived}
            onCreateSubpage={archived ? undefined : () => void createSubpage()}
            onExitTop={() => {
              const el = titleRef.current;
              if (!el) return;
              el.focus();
              el.setSelectionRange(el.value.length, el.value.length);
            }}
            emptyHint={<EmptyPageHint />}
          />

          {children.length > 0 && (
            <section aria-label="Pages inside" className="mt-4 border-t border-slate-100 pt-4 dark:border-slate-800">
              <h2 className="mb-1.5 text-xs font-medium text-slate-400 dark:text-slate-500">Pages inside</h2>
              <ul>
                {children.map((child) => (
                  <li key={child.id}>
                    <Link
                      to={ctx.hrefFor(child)}
                      className="-mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800/70"
                    >
                      <NoteIcon icon={child.icon} size={15} />
                      <span className="min-w-0 flex-1 truncate border-b border-slate-200 dark:border-slate-700">
                        {child.title || "Untitled"}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div ref={historyRef} className="mt-12 border-t border-slate-100 pt-4 dark:border-slate-800">
            <button
              type="button"
              onClick={() => setHistoryOpen((v) => !v)}
              aria-expanded={historyOpen}
              className="touch-target relative flex items-center gap-1.5 rounded-md px-1 py-1 text-sm text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100"
            >
              {historyOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <History size={14} />
              History
            </button>
            {historyOpen && (
              <RecordHistory
                className="mt-3"
                companyId={company.id}
                companySlug={company.slug}
                targetType="note"
                targetId={note.id}
                noun="this page"
                milestones={[{ label: "Page created", at: note.createdAt, covers: ["create"] }]}
              />
            )}
          </div>
        </article>
      </div>

      <NoteShareModal
        company={company}
        note={note}
        notebookSlug={canonicalNotebook?.slug ?? notebookSlug ?? ""}
        open={shareOpen}
        onClose={() => setShareOpen(false)}
      />
    </div>
  );
}

function Crumb({
  to,
  icon,
  children,
  className,
}: {
  to: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      to={to}
      className={clsx(
        "touch-target relative flex min-w-0 max-w-[10rem] items-center gap-1 rounded px-1 py-0.5 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-100",
        className,
      )}
    >
      <span className="flex shrink-0 items-center">{icon}</span>
      <span className="truncate">{children}</span>
    </Link>
  );
}

function Divider({ className }: { className?: string }) {
  return <span aria-hidden className={clsx("shrink-0 text-slate-300 dark:text-slate-600", className)}>/</span>;
}

/** "Saving…" while a save runs, "Saved" after; an error says so and offers a retry. */
function SaveStatus({
  status,
  archived,
  onRetry,
}: {
  status: AutosaveStatus;
  archived: boolean;
  onRetry: () => void;
}) {
  if (archived) return null;
  if (status === "error") {
    return (
      <button
        type="button"
        onClick={onRetry}
        className="mr-1 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-amber-700 hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-500/10"
      >
        <AlertCircle size={12} /> Not saved — retry
      </button>
    );
  }
  const label = status === "saving" || status === "pending" ? "Saving…" : status === "saved" ? "Saved" : "";
  return (
    <span aria-live="polite" className="mr-1 hidden text-xs text-slate-400 sm:inline dark:text-slate-500">
      {label}
    </span>
  );
}

const SHORTCUTS: Array<[string, string]> = [
  ["/", "insert any block"],
  ["#", "heading"],
  ["-", "bulleted list"],
  ["1.", "numbered list"],
  ["[]", "to-do"],
  [">", "quote"],
  ["```", "code"],
  ["---", "divider"],
];

/** What an empty page offers: the slash menu and the Markdown that works as you type. */
function EmptyPageHint() {
  return (
    <div className="rounded-lg border border-dashed border-slate-200 px-4 py-3 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
      <p className="mb-2 font-medium text-slate-600 dark:text-slate-300">Start writing — it saves as you go.</p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-[13px]">
        {SHORTCUTS.map(([key, label]) => (
          <li key={key} className="flex items-center gap-1.5">
            <kbd className="rounded border border-slate-200 bg-slate-50 px-1.5 py-px font-mono text-[11px] text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
              {key}
            </kbd>
            {label}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[13px]">
        Paste from anywhere and it keeps its headings, lists and links. AI Employees you share the page with read and write it too.
      </p>
    </div>
  );
}
