import React from "react";
import { marked } from "marked";
import { copyToClipboard } from "../../lib/clipboard";
import {
  deleteRange,
  formatAt,
  insertText,
  linkAt,
  linkifyRuns,
  looksLikeUrl,
  normalizeHref,
  plainText,
  rangeHasMark,
  replaceRange,
  type RunFormat,
  runsEqual,
  runsLength,
  setLink,
  textRuns,
  toggleMark,
} from "../../lib/noteInline";
import {
  type Block,
  blocksToMarkdown,
  type CalloutKind,
  isPlainText,
  isRichText,
  listOrdinals,
  type NoteDoc,
  parseDoc,
  serializeDoc,
} from "../../lib/noteMarkdown";
import {
  backspaceAtStart,
  type BlockKind,
  blockRange,
  createBlock,
  deleteAtEnd,
  deleteBlocks,
  dropDepth,
  duplicateBlocks,
  type EditResult,
  ensureBlocks,
  type Focus,
  indentBlocks,
  indexOfBlock,
  insertBlockAbove,
  insertBlockBelow,
  insertParagraphAfter,
  kindOf,
  moveBlocks,
  moveBlocksBy,
  nextVisible,
  outdentBlocks,
  pasteBlocks,
  previousVisible,
  reconcileBlocks,
  selectionSpan,
  setToggleOpen,
  splitBlock,
  turnInto,
  updateBlock,
  visibility,
} from "../../lib/noteBlocks";
import { applyInlineShortcut, matchBlockShortcut } from "../../lib/noteShortcuts";
import { filterSlashCommands, type SlashCommand, slashQueryAt } from "../../lib/noteSlash";
import { blocksFromClipboard, htmlHasStructure, htmlNodeFromDom, parseHtmlFragment } from "../../lib/notePaste";
import { type ChangeKind, EditHistory } from "../../lib/noteHistory";
import { BlockRow, INDENT_PX } from "./BlockRow";
import { BlockMenu, FormatToolbar, LinkEditor, SlashMenu, type ToolbarMarks } from "./EditorMenus";
import type { EditableEntry, EditorController } from "./editorController";
import {
  caretOnFirstLine,
  caretOnLastLine,
  caretRect,
  getSelectionOffsets,
  offsetAtX,
  readPlain,
  readRuns,
  setSelectionOffsets,
} from "./noteDom";

/**
 * The Notes editor: a Notion-style page of blocks over Markdown.
 *
 * Click anywhere and type. `/` opens the block menu; Markdown shortcuts
 * (`# `, `- `, `[] `, `> `, ``` ``` ```, `---`, `**bold**`…) format as you
 * type; Enter, Backspace, Tab and the arrows move through blocks the way
 * Notion's do; the handle beside a block drags it or opens its menu;
 * selecting text shows a formatting bar; Esc or a drag across blocks selects
 * whole blocks. The parent holds the Markdown: `value` in, `onChange` out.
 * Blocks the person didn't touch are written back exactly as they were read.
 */

export type BlockEditorHandle = {
  focusStart(): void;
  focusEnd(): void;
};

export type BlockEditorProps = {
  value: string;
  onChange: (markdown: string) => void;
  readOnly?: boolean;
  /** `/page`: make a sub-page of this page. */
  onCreateSubpage?: () => void;
  /** The arrow went up out of the first block — the page title takes over. */
  onExitTop?: () => void;
  /** Shown under an empty page: how to get started. */
  emptyHint?: React.ReactNode;
};

/** The editor's own clipboard flavour: exact Markdown, so copy and paste between notes loses nothing. */
const INTERNAL_MIME = "application/x-genosyn-note";

type TextSelection = { kind: "text"; id: string; start: number; end: number };
type BlockSelection = { kind: "blocks"; ids: string[] };
type Selection = TextSelection | BlockSelection | null;

type SlashState = { id: string; start: number; query: string; index: number; rect: DOMRect };
type ToolbarState = { id: string; start: number; end: number; rect: DOMRect };
type LinkState = { id: string; start: number; end: number; href: string; rect: DOMRect; error: string | null };

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

function modKey(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac ? event.metaKey : event.ctrlKey;
}

function blockLength(block: Block): number {
  return isRichText(block.type) ? runsLength(block.runs) : block.text.length;
}

function initialDoc(value: string): NoteDoc {
  const doc = parseDoc(value);
  return { ...doc, blocks: ensureBlocks(doc.blocks) };
}

export const BlockEditor = React.forwardRef<BlockEditorHandle, BlockEditorProps>(function BlockEditor(
  { value, onChange, readOnly = false, onCreateSubpage, onExitTop, emptyHint },
  ref,
) {
  const [doc, setDoc] = React.useState<NoteDoc>(() => initialDoc(value));
  const docRef = React.useRef(doc);
  const lastEmitted = React.useRef(value);
  const history = React.useRef(new EditHistory<NoteDoc, Selection>());
  const entries = React.useRef(new Map<string, EditableEntry>());
  const focusRequest = React.useRef<Focus | null>(null);
  const forced = React.useRef<{ id: string; offset: number; format: RunFormat } | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const pointerDown = React.useRef(false);
  const dropTarget = React.useRef<{ index: number; depth: number } | null>(null);

  const [focusedId, setFocusedId] = React.useState<string | null>(null);
  const [blockSel, setBlockSel] = React.useState<{ anchor: string; head: string } | null>(null);
  const [slash, setSlash] = React.useState<SlashState | null>(null);
  const [toolbar, setToolbar] = React.useState<ToolbarState | null>(null);
  const [linkEdit, setLinkEdit] = React.useState<LinkState | null>(null);
  const [blockMenu, setBlockMenu] = React.useState<{ id: string; anchor: DOMRect } | null>(null);
  const [dropLine, setDropLine] = React.useState<{ top: number; left: number } | null>(null);
  const [editingSource, setEditingSource] = React.useState<string | null>(null);

  // Handlers read the latest values through refs so the controller object,
  // and with it every memoized row, never changes identity.
  const live = React.useRef({ blockSel, slash, onChange, onCreateSubpage, onExitTop, readOnly });
  live.current = { blockSel, slash, onChange, onCreateSubpage, onExitTop, readOnly };

  const selectedIds = React.useCallback((): string[] => {
    const sel = live.current.blockSel;
    if (!sel) return [];
    return blockRange(docRef.current.blocks, sel.anchor, sel.head);
  }, []);

  const currentSelection = React.useCallback((): Selection => {
    const ids = selectedIds();
    if (ids.length) return { kind: "blocks", ids };
    const active = document.activeElement as HTMLElement | null;
    const id = active?.getAttribute?.("data-block-id");
    if (!id || !containerRef.current?.contains(active)) return null;
    const entry = entries.current.get(id);
    const offsets = entry ? getSelectionOffsets(entry.el) : null;
    return offsets ? { kind: "text", id, ...offsets } : { kind: "text", id, start: 0, end: 0 };
  }, [selectedIds]);

  const emit = React.useCallback((next: NoteDoc) => {
    const markdown = serializeDoc(next);
    if (markdown === lastEmitted.current) return;
    lastEmitted.current = markdown;
    live.current.onChange(markdown);
  }, []);

  const selectBlocks = React.useCallback((ids: string[]) => {
    if (!ids.length) return;
    setBlockSel({ anchor: ids[0], head: ids[ids.length - 1] });
    setSlash(null);
    setToolbar(null);
    window.getSelection()?.removeAllRanges();
    containerRef.current?.focus({ preventScroll: true });
  }, []);

  const commit = React.useCallback(
    (blocks: Block[], options: { kind?: ChangeKind; key?: string; focus?: Focus; select?: string[] } = {}) => {
      const previous = docRef.current;
      history.current.record(previous, currentSelection(), options.kind ?? "structure", options.key, performance.now());
      const next: NoteDoc = { ...previous, blocks: ensureBlocks(blocks) };
      docRef.current = next;
      setDoc(next);
      emit(next);
      if (options.focus) {
        focusRequest.current = options.focus;
        setBlockSel(null);
      }
      if (options.select) selectBlocks(options.select);
    },
    [currentSelection, emit, selectBlocks],
  );

  const commitResult = React.useCallback(
    (result: EditResult | null, extra: { focus?: Focus } = {}) => {
      if (!result || result.blocks === docRef.current.blocks) return false;
      commit(result.blocks, { focus: extra.focus ?? result.focus, select: result.select });
      return true;
    },
    [commit],
  );

  /** Change screen state only (a toggle opened): not an edit, so no history and no save. */
  const setUiBlocks = React.useCallback((blocks: Block[]) => {
    const next = { ...docRef.current, blocks };
    docRef.current = next;
    setDoc(next);
  }, []);

  const getBlock = React.useCallback((id: string) => docRef.current.blocks.find((b) => b.id === id), []);

  const restore = React.useCallback(
    (selection: Selection) => {
      if (!selection) return;
      if (selection.kind === "text") {
        focusRequest.current = { id: selection.id, start: selection.start, end: selection.end };
        setBlockSel(null);
      } else {
        selectBlocks(selection.ids);
      }
    },
    [selectBlocks],
  );

  const undo = React.useCallback(() => {
    const step = history.current.undo(docRef.current, currentSelection());
    if (!step) return;
    docRef.current = step.state;
    setDoc(step.state);
    emit(step.state);
    restore(step.selection);
  }, [currentSelection, emit, restore]);

  const redo = React.useCallback(() => {
    const step = history.current.redo(docRef.current, currentSelection());
    if (!step) return;
    docRef.current = step.state;
    setDoc(step.state);
    emit(step.state);
    restore(step.selection);
  }, [currentSelection, emit, restore]);

  // An outside change (an AI Employee saved, edits were merged): show it,
  // keeping the blocks — and the caret — that are still there.
  React.useEffect(() => {
    if (value === lastEmitted.current) return;
    lastEmitted.current = value;
    const selection = currentSelection();
    const parsed = parseDoc(value);
    const blocks = ensureBlocks(reconcileBlocks(docRef.current.blocks, parsed.blocks));
    history.current.record(docRef.current, selection, "structure", undefined, performance.now());
    const next: NoteDoc = { ...parsed, blocks };
    docRef.current = next;
    setDoc(next);
    if (selection?.kind === "text" && blocks.some((b) => b.id === selection.id)) {
      focusRequest.current = { id: selection.id, start: selection.start, end: selection.end };
    }
  }, [value, currentSelection]);

  // Put the caret where the last change asked for it, before paint.
  React.useLayoutEffect(() => {
    const request = focusRequest.current;
    if (!request) return;
    focusRequest.current = null;
    const block = docRef.current.blocks.find((b) => b.id === request.id);
    if (!block) return;
    const entry = entries.current.get(request.id);
    if (!entry) {
      if (!isRichText(block.type) && !isPlainText(block.type)) selectBlocks([block.id]);
      return;
    }
    const length = blockLength(block);
    const start = Math.max(0, Math.min(request.start, length));
    const end = Math.max(start, Math.min(request.end ?? request.start, length));
    if (document.activeElement !== entry.el) entry.el.focus({ preventScroll: true });
    setSelectionOffsets(entry.el, start, end);
    const rect = entry.el.getBoundingClientRect();
    if (rect.bottom > window.innerHeight - 40 || rect.top < 60) {
      entry.el.scrollIntoView({ block: "nearest", behavior: "auto" });
    }
  });

  const focusNow = React.useCallback((id: string, start: number, end: number = start) => {
    focusRequest.current = { id, start, end };
    const entry = entries.current.get(id);
    const block = docRef.current.blocks.find((b) => b.id === id);
    if (!entry || !block) {
      setDoc((d) => ({ ...d }));
      return;
    }
    focusRequest.current = null;
    entry.el.focus({ preventScroll: true });
    const length = blockLength(block);
    setSelectionOffsets(entry.el, Math.min(start, length), Math.min(end, length));
    entry.el.scrollIntoView({ block: "nearest" });
  }, []);

  const editableNeighbour = React.useCallback((id: string, direction: -1 | 1): Block | null => {
    const blocks = docRef.current.blocks;
    let index = indexOfBlock(blocks, id);
    for (;;) {
      index = direction < 0 ? previousVisible(blocks, index) : nextVisible(blocks, index);
      if (index < 0) return null;
      const candidate = blocks[index];
      if (entries.current.has(candidate.id)) return candidate;
    }
  }, []);

  React.useImperativeHandle(
    ref,
    () => ({
      focusStart() {
        const first = docRef.current.blocks.find((b) => entries.current.has(b.id));
        if (first) focusNow(first.id, 0);
      },
      focusEnd() {
        const blocks = docRef.current.blocks;
        for (let i = blocks.length - 1; i >= 0; i--) {
          if (entries.current.has(blocks[i].id)) {
            focusNow(blocks[i].id, blockLength(blocks[i]));
            return;
          }
        }
      },
    }),
    [focusNow],
  );

  // ───── Text edits ─────

  const replaceText = React.useCallback(
    (id: string, start: number, end: number, insert: string, kind: ChangeKind = "typing") => {
      const block = getBlock(id);
      if (!block) return;
      if (isPlainText(block.type)) {
        const text = block.text.slice(0, start) + insert + block.text.slice(end);
        commit(updateBlock(docRef.current.blocks, id, { text }), {
          kind,
          key: id,
          focus: { id, start: start + insert.length },
        });
        return;
      }
      const runs = replaceRange(block.runs, start, end, insert ? [{ ...formatAt(block.runs, start), text: insert }] : []);
      commit(updateBlock(docRef.current.blocks, id, { runs }), {
        kind,
        key: id,
        focus: { id, start: start + insert.length },
      });
    },
    [commit, getBlock],
  );

  const toggleMarkAt = React.useCallback(
    (id: string, start: number, end: number, mark: "bold" | "italic" | "strike" | "code") => {
      const block = getBlock(id);
      if (!block || !isRichText(block.type)) return;
      if (start === end) {
        // No selection: the next characters typed take (or drop) the mark.
        const base = forced.current?.id === id && forced.current.offset === start ? forced.current.format : formatAt(block.runs, start);
        const format: RunFormat = { ...base };
        if (format[mark]) delete format[mark];
        else format[mark] = true;
        forced.current = { id, offset: start, format };
        return;
      }
      commit(updateBlock(docRef.current.blocks, id, { runs: toggleMark(block.runs, start, end, mark) }), {
        focus: { id, start, end },
      });
    },
    [commit, getBlock],
  );

  const openLinkEditor = React.useCallback(
    (id: string, start: number, end: number) => {
      const block = getBlock(id);
      if (!block || !isRichText(block.type)) return;
      let range = { start, end };
      const existing = linkAt(block.runs, start);
      if (start === end) {
        if (!existing) return;
        range = { start: existing.start, end: existing.end };
      }
      const rect = caretRect() ?? entries.current.get(id)?.el.getBoundingClientRect();
      if (!rect) return;
      setToolbar(null);
      setLinkEdit({ id, ...range, href: existing?.href ?? "", rect, error: null });
    },
    [getBlock],
  );

  // ───── Slash menu ─────

  const slashCommands = React.useMemo(
    () => (slash ? filterSlashCommands(slash.query).filter((c) => c.id !== "page" || Boolean(onCreateSubpage)) : []),
    [slash, onCreateSubpage],
  );
  const slashCommandsRef = React.useRef(slashCommands);
  slashCommandsRef.current = slashCommands;

  const updateSlash = React.useCallback((id: string, text: string, caret: number) => {
    const query = slashQueryAt(text, caret);
    if (!query) {
      setSlash((s) => (s ? null : s));
      return;
    }
    const matches = filterSlashCommands(query.query);
    if (matches.length === 0 && query.query.length >= 4) {
      setSlash(null);
      return;
    }
    const rect = caretRect() ?? entries.current.get(id)?.el.getBoundingClientRect();
    if (!rect) return;
    setSlash((s) => ({
      id,
      start: query.start,
      query: query.query,
      index: s && s.id === id && s.query === query.query ? s.index : 0,
      rect,
    }));
  }, []);

  const applySlash = React.useCallback(
    (command: SlashCommand) => {
      const state = live.current.slash;
      if (!state) return;
      const block = getBlock(state.id);
      setSlash(null);
      if (!block || !isRichText(block.type)) return;
      const entry = entries.current.get(block.id);
      const caret = (entry && getSelectionOffsets(entry.el)?.end) ?? state.start + 1 + state.query.length;
      const runs = deleteRange(block.runs, state.start, Math.max(caret, state.start + 1));
      const blocks = docRef.current.blocks;
      const index = indexOfBlock(blocks, block.id);
      const stripped: Block = { ...block, runs };
      const empty = plainText(runs) === "";
      const replaceWith = (...items: Block[]) => {
        const next = blocks.slice();
        next.splice(index, 1, ...items);
        return next;
      };
      switch (command.id) {
        case "page":
          commit(replaceWith(stripped), { focus: { id: block.id, start: state.start } });
          live.current.onCreateSubpage?.();
          return;
        case "divider": {
          const divider = createBlock("divider", { depth: block.depth });
          const after = createBlock("paragraph", { depth: block.depth });
          commit(empty ? replaceWith(divider, after) : replaceWith(stripped, divider, after), {
            focus: { id: after.id, start: 0 },
          });
          return;
        }
        case "image": {
          const image = createBlock("image", { depth: block.depth, src: "", alt: "" });
          commit(empty ? replaceWith(image) : replaceWith(stripped, image));
          return;
        }
        case "table": {
          const table = createBlock("table", {
            depth: block.depth,
            text: "| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |",
          });
          setEditingSource(table.id);
          commit(empty ? replaceWith(table) : replaceWith(stripped, table), {
            focus: { id: table.id, start: 2, end: 10 },
          });
          return;
        }
        default: {
          const kind = command.id as BlockKind;
          const result = turnInto(replaceWith(stripped), [block.id], kind);
          commit(result.blocks, { focus: { id: block.id, start: state.start } });
        }
      }
    },
    [commit, getBlock],
  );

  // ───── Keyboard ─────

  const handleKeyDown = React.useCallback(
    (id: string, event: React.KeyboardEvent<HTMLDivElement>) => {
      if (live.current.readOnly) return;
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      const block = getBlock(id);
      const entry = entries.current.get(id);
      if (!block || !entry) return;
      const sel = getSelectionOffsets(entry.el) ?? { start: 0, end: 0 };
      const plain = isPlainText(block.type);
      const length = blockLength(block);
      const mod = modKey(event);
      const key = event.key;
      const lower = key.length === 1 ? key.toLowerCase() : key;

      const slashState = live.current.slash;
      if (slashState && slashState.id === id) {
        const list = slashCommandsRef.current;
        if (key === "ArrowDown" || key === "ArrowUp") {
          event.preventDefault();
          if (!list.length) return;
          const delta = key === "ArrowDown" ? 1 : -1;
          setSlash({ ...slashState, index: (slashState.index + delta + list.length) % list.length });
          return;
        }
        if ((key === "Enter" || key === "Tab") && list.length) {
          event.preventDefault();
          applySlash(list[Math.min(slashState.index, list.length - 1)]);
          return;
        }
        if (key === "Escape") {
          event.preventDefault();
          setSlash(null);
          return;
        }
      }

      if (mod && !event.altKey && lower === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && !isMac && lower === "y") {
        event.preventDefault();
        redo();
        return;
      }
      if (mod && !plain && !event.altKey) {
        if (lower === "b" && !event.shiftKey) {
          event.preventDefault();
          toggleMarkAt(id, sel.start, sel.end, "bold");
          return;
        }
        if (lower === "i" && !event.shiftKey) {
          event.preventDefault();
          toggleMarkAt(id, sel.start, sel.end, "italic");
          return;
        }
        if (lower === "e" && !event.shiftKey) {
          event.preventDefault();
          toggleMarkAt(id, sel.start, sel.end, "code");
          return;
        }
        if ((lower === "s" || lower === "x") && event.shiftKey) {
          event.preventDefault();
          toggleMarkAt(id, sel.start, sel.end, "strike");
          return;
        }
        if (lower === "k") {
          event.preventDefault();
          openLinkEditor(id, sel.start, sel.end);
          return;
        }
      }
      if (mod && lower === "d" && !event.shiftKey) {
        event.preventDefault();
        commitResult(duplicateBlocks(docRef.current.blocks, [id]));
        return;
      }
      if (mod && event.shiftKey && (key === "ArrowUp" || key === "ArrowDown")) {
        event.preventDefault();
        const result = moveBlocksBy(docRef.current.blocks, [id], key === "ArrowUp" ? -1 : 1);
        if (result) commit(result.blocks, { focus: { id, start: sel.start, end: sel.end } });
        return;
      }
      if (mod && lower === "a" && !event.shiftKey && length > 0 && sel.start === 0 && sel.end === length) {
        event.preventDefault();
        selectBlocks(docRef.current.blocks.map((b) => b.id));
        return;
      }
      if (key === "Escape") {
        event.preventDefault();
        setSlash(null);
        selectBlocks([id]);
        return;
      }

      if (key === "Enter") {
        if (mod) {
          event.preventDefault();
          commitResult(insertParagraphAfter(docRef.current.blocks, id));
          return;
        }
        if (event.shiftKey || plain) {
          event.preventDefault();
          replaceText(id, sel.start, sel.end, "\n", "structure");
          return;
        }
        event.preventDefault();
        commitResult(splitBlock(docRef.current.blocks, id, sel.start, sel.end));
        return;
      }

      if (key === "Backspace" && !mod && !event.altKey && sel.start === 0 && sel.end === 0) {
        event.preventDefault();
        commitResult(backspaceAtStart(docRef.current.blocks, id));
        return;
      }
      if (key === "Delete" && sel.start === length && sel.end === length) {
        const result = deleteAtEnd(docRef.current.blocks, id);
        if (result.blocks !== docRef.current.blocks) {
          event.preventDefault();
          commitResult(result);
        }
        return;
      }

      if (key === "Tab" && !mod && !event.altKey) {
        event.preventDefault();
        if (block.type === "code") {
          if (!event.shiftKey) replaceText(id, sel.start, sel.end, "  ", "structure");
          else {
            const lineStart = block.text.lastIndexOf("\n", sel.start - 1) + 1;
            const spaces = /^ {1,2}/.exec(block.text.slice(lineStart))?.[0].length ?? 0;
            if (spaces) {
              const text = block.text.slice(0, lineStart) + block.text.slice(lineStart + spaces);
              commit(updateBlock(docRef.current.blocks, id, { text }), {
                focus: { id, start: Math.max(lineStart, sel.start - spaces) },
              });
            }
          }
          return;
        }
        const result = event.shiftKey
          ? outdentBlocks(docRef.current.blocks, [id])
          : indentBlocks(docRef.current.blocks, [id]);
        if (result) commit(result.blocks, { focus: { id, start: sel.start, end: sel.end } });
        return;
      }

      if (!event.shiftKey && !mod && !event.altKey) {
        const collapsed = sel.start === sel.end;
        if (key === "ArrowUp" && caretOnFirstLine(entry.el)) {
          const target = editableNeighbour(id, -1);
          const x = caretRect()?.left ?? 0;
          if (target) {
            event.preventDefault();
            const targetEl = entries.current.get(target.id)!.el;
            focusNow(target.id, offsetAtX(targetEl, x, "last") ?? blockLength(target));
          } else if (live.current.onExitTop) {
            event.preventDefault();
            live.current.onExitTop();
          }
          return;
        }
        if (key === "ArrowDown" && caretOnLastLine(entry.el)) {
          const target = editableNeighbour(id, 1);
          if (target) {
            event.preventDefault();
            const x = caretRect()?.left ?? 0;
            const targetEl = entries.current.get(target.id)!.el;
            focusNow(target.id, offsetAtX(targetEl, x, "first") ?? 0);
          }
          return;
        }
        if (key === "ArrowLeft" && collapsed && sel.start === 0) {
          const target = editableNeighbour(id, -1);
          if (target) {
            event.preventDefault();
            focusNow(target.id, blockLength(target));
          }
          return;
        }
        if (key === "ArrowRight" && collapsed && sel.end === length) {
          const target = editableNeighbour(id, 1);
          if (target) {
            event.preventDefault();
            focusNow(target.id, 0);
          }
          return;
        }
      }
      // Shift+arrow off the edge of a block starts a block selection.
      if (event.shiftKey && !mod && (key === "ArrowUp" || key === "ArrowDown")) {
        const atEdge = key === "ArrowUp" ? sel.start === 0 && caretOnFirstLine(entry.el) : sel.end === length && caretOnLastLine(entry.el);
        if (atEdge) {
          const target = editableNeighbour(id, key === "ArrowUp" ? -1 : 1);
          event.preventDefault();
          if (target) {
            setBlockSel({ anchor: id, head: target.id });
            window.getSelection()?.removeAllRanges();
            containerRef.current?.focus({ preventScroll: true });
          } else selectBlocks([id]);
        }
      }
    },
    [applySlash, commit, commitResult, editableNeighbour, focusNow, getBlock, openLinkEditor, redo, replaceText, selectBlocks, toggleMarkAt, undo],
  );

  // ───── Input ─────

  const handleInput = React.useCallback(
    (id: string, event: React.FormEvent<HTMLDivElement>) => {
      const block = getBlock(id);
      const entry = entries.current.get(id);
      if (!block || !entry) return;
      const native = event.nativeEvent as InputEvent;
      if (isPlainText(block.type)) {
        const text = readPlain(entry.el);
        entry.markShown(text);
        commit(updateBlock(docRef.current.blocks, id, { text }), { kind: "typing", key: id });
        return;
      }
      let runs = readRuns(entry.el);
      entry.markShown(runs);
      if (native.isComposing) {
        commit(updateBlock(docRef.current.blocks, id, { runs }), { kind: "typing", key: id });
        return;
      }
      const sel = getSelectionOffsets(entry.el);
      const caret = sel?.end ?? runsLength(runs);
      const text = plainText(runs);
      const typed = native.inputType?.startsWith("insert") ?? true;
      // Undo goes back a word at a time: a space after a word starts a new step.
      if (native.inputType === "insertText" && native.data && /^\s/.test(native.data) && /\S/.test(text[caret - 2] ?? "")) {
        history.current.seal();
      }

      const shortcut = typed ? matchBlockShortcut(text.slice(0, caret), block.type) : null;
      if (shortcut) {
        const remaining = deleteRange(runs, 0, shortcut.consumed);
        const blocks = docRef.current.blocks;
        const index = indexOfBlock(blocks, id);
        setSlash(null);
        if (shortcut.kind === "divider") {
          const divider = createBlock("divider", { depth: block.depth });
          const rest: Block = { ...block, type: "paragraph", runs: remaining };
          const next = blocks.slice();
          next.splice(index, 1, divider, rest);
          commit(next, { focus: { id, start: 0 } });
          return;
        }
        const turned = turnInto(updateBlock(blocks, id, { runs: remaining }), [id], shortcut.kind).blocks;
        const patch: Partial<Block> = {};
        if ("checked" in shortcut && shortcut.checked !== undefined) patch.checked = shortcut.checked;
        if ("start" in shortcut && shortcut.start !== undefined && shortcut.start !== 1) patch.start = shortcut.start;
        if ("lang" in shortcut && shortcut.lang) patch.lang = shortcut.lang;
        commit(updateBlock(turned, id, patch), { focus: { id, start: 0 } });
        return;
      }

      if (native.inputType === "insertText" && native.data && /[*_~`]$/.test(native.data)) {
        const result = applyInlineShortcut(runs, caret);
        if (result) {
          const format = formatAt(result.runs, result.caret);
          delete format[result.mark];
          forced.current = { id, offset: result.caret, format };
          commit(updateBlock(docRef.current.blocks, id, { runs: result.runs }), {
            focus: { id, start: result.caret },
          });
          setSlash(null);
          return;
        }
      }

      if (native.inputType === "insertText" && native.data && /\s/.test(native.data)) {
        const linked = linkifyRuns(runs);
        if (!runsEqual(linked, runs)) {
          runs = linked;
          commit(updateBlock(docRef.current.blocks, id, { runs }), {
            kind: "typing",
            key: id,
            focus: { id, start: sel?.start ?? caret, end: sel?.end ?? caret },
          });
          updateSlash(id, text, caret);
          return;
        }
      }

      updateSlash(id, text, caret);
      commit(updateBlock(docRef.current.blocks, id, { runs }), { kind: "typing", key: id });
    },
    [commit, getBlock, updateSlash],
  );

  // Native beforeinput: undo from the Edit menu, mobile keyboards' Enter and
  // Backspace (which arrive without a usable keydown), and typing in a mark
  // toggled with nothing selected.
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onBeforeInput = (event: InputEvent) => {
      if (live.current.readOnly) return;
      const target = (event.target as HTMLElement | null)?.closest?.("[data-block-id]") as HTMLElement | null;
      const id = target?.getAttribute("data-block-id");
      if (!target || !id) return;
      const block = getBlock(id);
      if (!block) return;
      if (event.inputType === "historyUndo") {
        event.preventDefault();
        undo();
        return;
      }
      if (event.inputType === "historyRedo") {
        event.preventDefault();
        redo();
        return;
      }
      const sel = getSelectionOffsets(target) ?? { start: 0, end: 0 };
      if (event.inputType === "insertParagraph" && !event.isComposing) {
        event.preventDefault();
        if (isPlainText(block.type)) replaceText(id, sel.start, sel.end, "\n", "structure");
        else commitResult(splitBlock(docRef.current.blocks, id, sel.start, sel.end));
        return;
      }
      if (event.inputType === "insertLineBreak") {
        event.preventDefault();
        replaceText(id, sel.start, sel.end, "\n", "structure");
        return;
      }
      if (event.inputType === "deleteContentBackward" && sel.start === 0 && sel.end === 0) {
        event.preventDefault();
        commitResult(backspaceAtStart(docRef.current.blocks, id));
        return;
      }
      if (event.inputType === "formatBold" || event.inputType === "formatItalic" || event.inputType === "formatStrikeThrough") {
        event.preventDefault();
        const mark = event.inputType === "formatBold" ? "bold" : event.inputType === "formatItalic" ? "italic" : "strike";
        toggleMarkAt(id, sel.start, sel.end, mark);
        return;
      }
      const pending = forced.current;
      if (event.inputType === "insertText" && event.data && pending && pending.id === id && isRichText(block.type)) {
        if (sel.start === sel.end && sel.start === pending.offset) {
          event.preventDefault();
          const runs = insertText(block.runs, sel.start, event.data, pending.format);
          forced.current = { ...pending, offset: pending.offset + event.data.length };
          commit(updateBlock(docRef.current.blocks, id, { runs }), {
            kind: "typing",
            key: id,
            focus: { id, start: sel.start + event.data.length },
          });
          return;
        }
        forced.current = null;
      }
    };
    container.addEventListener("beforeinput", onBeforeInput);
    return () => container.removeEventListener("beforeinput", onBeforeInput);
  }, [commit, commitResult, getBlock, redo, replaceText, toggleMarkAt, undo]);

  // ───── Paste ─────

  const handlePaste = React.useCallback(
    (id: string, event: React.ClipboardEvent<HTMLDivElement>) => {
      if (live.current.readOnly) return;
      const block = getBlock(id);
      const entry = entries.current.get(id);
      if (!block || !entry) return;
      event.preventDefault();
      const data = event.clipboardData;
      const internal = data.getData(INTERNAL_MIME);
      const html = data.getData("text/html");
      const text = data.getData("text/plain");
      const sel = getSelectionOffsets(entry.el) ?? { start: 0, end: 0 };
      if (isPlainText(block.type)) {
        replaceText(id, sel.start, sel.end, (internal || text).replace(/\r\n?/g, "\n"), "structure");
        return;
      }
      if (!internal && sel.start !== sel.end && looksLikeUrl(text)) {
        commit(updateBlock(docRef.current.blocks, id, { runs: setLink(block.runs, sel.start, sel.end, text.trim()) }), {
          focus: { id, start: sel.end },
        });
        return;
      }
      const structured = Boolean(html && htmlHasStructure(html));
      if (!internal && !structured && !/[\r\n]/.test(text.replace(/[\r\n]+$/, ""))) {
        const line = text.replace(/[\r\n]+$/, "");
        if (!line) return;
        const inserted = linkifyRuns([{ ...formatAt(block.runs, sel.start), text: line }]);
        const runs = replaceRange(block.runs, sel.start, sel.end, inserted);
        commit(updateBlock(docRef.current.blocks, id, { runs }), { focus: { id, start: sel.start + line.length } });
        return;
      }
      const parseHtml = (source: string) =>
        typeof DOMParser !== "undefined"
          ? htmlNodeFromDom(new DOMParser().parseFromString(source, "text/html").body)
          : parseHtmlFragment(source);
      const pasted = blocksFromClipboard({ internal, html, text }, parseHtml);
      if (!pasted.length) return;
      commitResult(pasteBlocks(docRef.current.blocks, id, sel.start, sel.end, pasted));
    },
    [commit, commitResult, getBlock, replaceText],
  );

  // ───── Block selection ─────

  const deleteSelected = React.useCallback(() => {
    const ids = selectedIds();
    if (!ids.length) return;
    const result = deleteBlocks(docRef.current.blocks, ids);
    setBlockSel(null);
    commit(result.blocks, { focus: result.focus, select: result.select });
  }, [commit, selectedIds]);

  const handleContainerKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.target !== containerRef.current || live.current.readOnly) return;
      const sel = live.current.blockSel;
      if (!sel) return;
      const ids = selectedIds();
      const blocks = docRef.current.blocks;
      const mod = modKey(event);
      const lower = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (mod && lower === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && !isMac && lower === "y") {
        event.preventDefault();
        redo();
        return;
      }
      if (mod && lower === "a") {
        event.preventDefault();
        selectBlocks(blocks.map((b) => b.id));
        return;
      }
      if (mod && lower === "d") {
        event.preventDefault();
        commitResult(duplicateBlocks(blocks, ids));
        return;
      }
      if (mod && event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault();
        const result = moveBlocksBy(blocks, ids, event.key === "ArrowUp" ? -1 : 1);
        if (result) commit(result.blocks, { select: ids });
        return;
      }
      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        deleteSelected();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setBlockSel(null);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const last = getBlock(ids[ids.length - 1]);
        if (last && entries.current.has(last.id)) {
          setBlockSel(null);
          focusNow(last.id, blockLength(last));
        }
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        const result = event.shiftKey ? outdentBlocks(blocks, ids) : indentBlocks(blocks, ids);
        if (result) commit(result.blocks, { select: ids });
        return;
      }
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        const headIndex = indexOfBlock(blocks, sel.head);
        const nextIndex = event.key === "ArrowUp" ? previousVisible(blocks, headIndex) : nextVisible(blocks, headIndex);
        if (nextIndex < 0) return;
        const nextId = blocks[nextIndex].id;
        setBlockSel(event.shiftKey ? { anchor: sel.anchor, head: nextId } : { anchor: nextId, head: nextId });
      }
    },
    [commit, commitResult, deleteSelected, focusNow, getBlock, redo, selectBlocks, selectedIds, undo],
  );

  // Copy and cut whole blocks as Markdown (plus HTML for other apps).
  React.useEffect(() => {
    const onCopy = (event: ClipboardEvent, cut: boolean) => {
      const ids = selectedIds();
      if (!ids.length || !event.clipboardData) return;
      if (document.activeElement !== containerRef.current) return;
      const span = selectionSpan(docRef.current.blocks, ids);
      if (!span) return;
      const markdown = blocksToMarkdown(docRef.current.blocks.slice(span[0], span[1]));
      event.preventDefault();
      event.clipboardData.setData("text/plain", markdown);
      event.clipboardData.setData(INTERNAL_MIME, markdown);
      try {
        event.clipboardData.setData("text/html", marked.parse(markdown, { async: false }) as string);
      } catch {
        // Plain text and the editor's own flavour are enough.
      }
      if (cut && !live.current.readOnly) deleteSelected();
    };
    const copy = (event: ClipboardEvent) => onCopy(event, false);
    const cut = (event: ClipboardEvent) => onCopy(event, true);
    document.addEventListener("copy", copy);
    document.addEventListener("cut", cut);
    return () => {
      document.removeEventListener("copy", copy);
      document.removeEventListener("cut", cut);
    };
  }, [deleteSelected, selectedIds]);

  // A press outside the page's blocks drops a block selection.
  React.useEffect(() => {
    if (!blockSel) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-block-grip]") || target?.closest('[role="menu"]')) return;
      if (!containerRef.current?.contains(target)) setBlockSel(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [blockSel]);

  // Dragging a text selection from one block into another selects whole blocks, as in Notion.
  const handleMouseDown = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.button !== 0 || live.current.readOnly) return;
      pointerDown.current = true;
      const target = event.target as HTMLElement;
      if (target.closest("[data-block-grip]") || target.closest("button, input, select, a")) return;
      const row = target.closest("[data-block-row]");
      const anchor = row?.getAttribute("data-block-row");
      if (live.current.blockSel && !event.shiftKey) setBlockSel(null);
      if (event.shiftKey && anchor && live.current.blockSel) {
        event.preventDefault();
        setBlockSel({ anchor: live.current.blockSel.anchor, head: anchor });
        return;
      }
      if (!anchor) return;
      let spanning = false;
      const onMove = (move: MouseEvent) => {
        if (!(move.buttons & 1)) return;
        const over = document.elementFromPoint(move.clientX, move.clientY)?.closest("[data-block-row]");
        const head = over?.getAttribute("data-block-row");
        if (!head || !containerRef.current?.contains(over!)) return;
        if (head === anchor && !spanning) return;
        spanning = true;
        setBlockSel({ anchor, head });
        window.getSelection()?.removeAllRanges();
        if (document.activeElement !== containerRef.current) containerRef.current?.focus({ preventScroll: true });
      };
      const onUp = () => {
        pointerDown.current = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [],
  );

  // ───── Formatting toolbar ─────

  React.useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (live.current.readOnly) return;
        const selection = window.getSelection();
        if (forced.current) {
          const anchorEl = (selection?.anchorNode as HTMLElement | null)?.parentElement?.closest?.("[data-block-id]");
          const offsets = anchorEl ? getSelectionOffsets(anchorEl as HTMLElement) : null;
          if (!offsets || anchorEl?.getAttribute("data-block-id") !== forced.current.id || offsets.start !== forced.current.offset) {
            forced.current = null;
          }
        }
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
          setToolbar(null);
          return;
        }
        if (pointerDown.current) return;
        const range = selection.getRangeAt(0);
        const node = range.commonAncestorContainer;
        const el = (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement)?.closest(
          "[data-block-id]",
        ) as HTMLElement | null;
        if (!el || !containerRef.current?.contains(el)) {
          setToolbar(null);
          return;
        }
        const id = el.getAttribute("data-block-id")!;
        const block = docRef.current.blocks.find((b) => b.id === id);
        const offsets = getSelectionOffsets(el);
        if (!block || !isRichText(block.type) || !offsets || offsets.start === offsets.end) {
          setToolbar(null);
          return;
        }
        setToolbar({ id, ...offsets, rect: range.getBoundingClientRect() });
      });
    };
    const onUp = () => {
      pointerDown.current = false;
      update();
    };
    document.addEventListener("selectionchange", update);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("keyup", update);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("keyup", update);
    };
  }, []);

  const toolbarBlock = toolbar ? doc.blocks.find((b) => b.id === toolbar.id) : undefined;
  const toolbarMarks: ToolbarMarks | null =
    toolbar && toolbarBlock
      ? {
          bold: rangeHasMark(toolbarBlock.runs, toolbar.start, toolbar.end, "bold"),
          italic: rangeHasMark(toolbarBlock.runs, toolbar.start, toolbar.end, "italic"),
          strike: rangeHasMark(toolbarBlock.runs, toolbar.start, toolbar.end, "strike"),
          code: rangeHasMark(toolbarBlock.runs, toolbar.start, toolbar.end, "code"),
          link: linkAt(toolbarBlock.runs, toolbar.start)?.href ?? null,
        }
      : null;

  // ───── Dragging blocks by their handle ─────

  const gutterPointerDown = React.useCallback(
    (id: string, event: React.PointerEvent) => {
      if (event.button !== 0 || live.current.readOnly) return;
      event.preventDefault();
      event.stopPropagation();
      const grip = event.currentTarget as HTMLElement;
      const startX = event.clientX;
      const startY = event.clientY;
      const selected = selectedIds();
      const ids = selected.includes(id) ? selected : [id];
      let dragging = false;
      const rows = () =>
        Array.from(containerRef.current?.querySelectorAll<HTMLElement>("[data-block-row]") ?? []);
      const onMove = (move: PointerEvent) => {
        if (!dragging && Math.hypot(move.clientX - startX, move.clientY - startY) < 4) return;
        if (!dragging) {
          dragging = true;
          setBlockSel({ anchor: ids[0], head: ids[ids.length - 1] });
          setBlockMenu(null);
          document.body.classList.add("cursor-grabbing", "select-none");
        }
        const blocks = docRef.current.blocks;
        const span = selectionSpan(blocks, ids);
        const container = containerRef.current;
        if (!span || !container) return;
        const box = container.getBoundingClientRect();
        let index = blocks.length;
        let top = 0;
        const all = rows();
        for (const row of all) {
          const rect = row.getBoundingClientRect();
          if (move.clientY < rect.top + rect.height / 2) {
            index = indexOfBlock(blocks, row.getAttribute("data-block-row")!);
            top = rect.top - box.top;
            break;
          }
          top = rect.bottom - box.top;
        }
        if (index >= span[0] && index <= span[1]) {
          dropTarget.current = null;
          setDropLine(null);
        } else {
          const depth = dropDepth(blocks, index);
          dropTarget.current = { index, depth };
          setDropLine({ top, left: depth * INDENT_PX });
        }
        if (move.clientY < 80) window.scrollBy(0, -12);
        else if (move.clientY > window.innerHeight - 80) window.scrollBy(0, 12);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        document.body.classList.remove("cursor-grabbing", "select-none");
        setDropLine(null);
        if (dragging) {
          const target = dropTarget.current;
          dropTarget.current = null;
          if (target) {
            const result = moveBlocks(docRef.current.blocks, ids, target.index, target.depth);
            if (result) commit(result.blocks, { select: ids });
          }
          return;
        }
        selectBlocks(ids);
        setBlockMenu({ id, anchor: grip.getBoundingClientRect() });
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [commit, selectBlocks, selectedIds],
  );

  // ───── The controller rows call into ─────

  const ctrlRef = React.useRef<EditorController | null>(null);
  const handlers = React.useRef({
    handleInput,
    handleKeyDown,
    handlePaste,
    gutterPointerDown,
    commit,
    commitResult,
    selectBlocks,
    focusNow,
  });
  handlers.current = {
    handleInput,
    handleKeyDown,
    handlePaste,
    gutterPointerDown,
    commit,
    commitResult,
    selectBlocks,
    focusNow,
  };
  if (!ctrlRef.current) {
    const h = () => handlers.current;
    ctrlRef.current = {
      readOnly,
      register(id, entry) {
        if (entry) entries.current.set(id, entry);
        else entries.current.delete(id);
      },
      onInput: (id, event) => h().handleInput(id, event),
      onKeyDown: (id, event) => h().handleKeyDown(id, event),
      onPaste: (id, event) => h().handlePaste(id, event),
      onFocus(id) {
        setFocusedId(id);
        setBlockSel(null);
        history.current.seal();
      },
      onBlur(id) {
        setFocusedId((current) => (current === id ? null : current));
        setSlash((s) => (s && s.id === id ? null : s));
      },
      onClickText(_id, event) {
        const anchor = (event.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
        if (anchor && (live.current.readOnly || event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          window.open(anchor.href, "_blank", "noopener,noreferrer");
        }
      },
      toggleTodo(id) {
        const block = docRef.current.blocks.find((b) => b.id === id);
        if (!block || live.current.readOnly) return;
        h().commit(updateBlock(docRef.current.blocks, id, { checked: !block.checked }));
      },
      toggleOpen(id) {
        const block = docRef.current.blocks.find((b) => b.id === id);
        if (!block) return;
        setUiBlocks(setToggleOpen(docRef.current.blocks, id, !block.open));
      },
      setCalloutKind(id, kind: CalloutKind) {
        h().commit(updateBlock(docRef.current.blocks, id, { kind }));
      },
      setCodeLang(id, lang) {
        h().commit(updateBlock(docRef.current.blocks, id, { lang }));
      },
      setImage(id, patch) {
        h().commit(updateBlock(docRef.current.blocks, id, patch), {
          kind: patch.alt !== undefined ? "typing" : "structure",
          key: `${id}:image`,
        });
      },
      addChild(id) {
        const blocks = docRef.current.blocks;
        const index = indexOfBlock(blocks, id);
        if (index < 0) return;
        const child = createBlock("paragraph", { depth: blocks[index].depth + 1 });
        const next = blocks.slice();
        next.splice(index + 1, 0, child);
        h().commit(next, { focus: { id: child.id, start: 0 } });
      },
      gutterAdd(id, event) {
        const blocks = docRef.current.blocks;
        const result = event.altKey ? insertBlockAbove(blocks, id) : insertBlockBelow(blocks, id);
        const fresh = result.focus?.id;
        if (!fresh) return;
        // Notion's +: a new block with "/" typed in it, menu open.
        const withSlash = updateBlock(result.blocks, fresh, { runs: textRuns("/") });
        h().commit(withSlash, { focus: { id: fresh, start: 1 } });
        requestAnimationFrame(() => {
          const entry = entries.current.get(fresh);
          const rect = entry?.el.getBoundingClientRect();
          if (rect) setSlash({ id: fresh, start: 0, query: "", index: 0, rect });
        });
      },
      gutterPointerDown: (id, event) => h().gutterPointerDown(id, event),
      selectBlock(id, extend) {
        if (extend && live.current.blockSel) setBlockSel({ anchor: live.current.blockSel.anchor, head: id });
        else h().selectBlocks([id]);
      },
      editSource(id, editing) {
        setEditingSource(editing ? id : null);
        if (editing) {
          const block = docRef.current.blocks.find((b) => b.id === id);
          focusRequest.current = { id, start: block?.text.length ?? 0 };
        }
      },
      copyText(text) {
        void copyToClipboard(text);
      },
    };
  }
  const ctrl = ctrlRef.current;
  ctrl.readOnly = readOnly;

  // ───── Render ─────

  const blocks = doc.blocks;
  const shown = visibility(blocks);
  const ordinals = listOrdinals(blocks);
  const selected = new Set(blockSel ? blockRange(blocks, blockSel.anchor, blockSel.head) : []);
  const onlyBlock = blocks.length === 1;

  const menuBlock = blockMenu ? blocks.find((b) => b.id === blockMenu.id) : undefined;
  const menuIds = blockMenu ? (selected.has(blockMenu.id) ? [...selected] : [blockMenu.id]) : [];

  return (
    <div className="relative">
      <div
        ref={containerRef}
        tabIndex={-1}
        data-block-editor
        onKeyDown={handleContainerKeyDown}
        onMouseDown={handleMouseDown}
        className="relative outline-none"
        aria-label="Page content"
      >
        {blocks.map((block, i) =>
          shown[i] ? (
            <BlockRow
              key={block.id}
              block={block}
              previous={blocks[i - 1]}
              ordinal={ordinals[i]}
              selected={selected.has(block.id)}
              focused={focusedId === block.id}
              onlyBlock={onlyBlock}
              emptyToggle={
                block.type === "toggle" && Boolean(block.open) && !(blocks[i + 1] && blocks[i + 1].depth > block.depth)
              }
              editingSource={editingSource === block.id}
              ctrl={ctrl}
            />
          ) : null,
        )}
        {dropLine && (
          <div
            aria-hidden
            className="pointer-events-none absolute right-0 z-20 h-[3px] -translate-y-1/2 rounded-full bg-sky-400/90"
            style={{ top: dropLine.top, left: dropLine.left }}
          />
        )}
      </div>
      {emptyHint &&
        !readOnly &&
        blocks.length === 1 &&
        blocks[0].type === "paragraph" &&
        blocks[0].runs.length === 0 && <div className="mt-6">{emptyHint}</div>}
      {!readOnly && (
        <div
          aria-hidden
          className="min-h-[30vh] cursor-text"
          onMouseDown={(event) => {
            event.preventDefault();
            const all = docRef.current.blocks;
            const last = all[all.length - 1];
            if (last && last.type === "paragraph" && last.depth === 0 && plainText(last.runs) === "") {
              focusNow(last.id, 0);
              return;
            }
            const fresh = createBlock("paragraph");
            commit([...all, fresh], { focus: { id: fresh.id, start: 0 } });
          }}
        />
      )}

      {slash && !readOnly && (
        <SlashMenu
          anchor={slash.rect}
          commands={slashCommands}
          index={Math.min(slash.index, Math.max(0, slashCommands.length - 1))}
          query={slash.query}
          onPick={applySlash}
          onHover={(index) => setSlash((s) => (s ? { ...s, index } : s))}
          onClose={() => setSlash(null)}
        />
      )}

      {toolbar && toolbarMarks && !slash && !linkEdit && !readOnly && (
        <FormatToolbar
          anchor={toolbar.rect}
          marks={toolbarMarks}
          kind={toolbarBlock ? kindOf(toolbarBlock) : null}
          onToggle={(mark) => toggleMarkAt(toolbar.id, toolbar.start, toolbar.end, mark)}
          onLink={() => openLinkEditor(toolbar.id, toolbar.start, toolbar.end)}
          onTurnInto={(kind) => {
            const result = turnInto(docRef.current.blocks, [toolbar.id], kind);
            commit(result.blocks, { focus: { id: toolbar.id, start: toolbar.start, end: toolbar.end } });
          }}
        />
      )}

      {linkEdit && (
        <LinkEditor
          anchor={linkEdit.rect}
          initial={linkEdit.href}
          error={linkEdit.error}
          onClose={() => {
            setLinkEdit(null);
            focusNow(linkEdit.id, linkEdit.start, linkEdit.end);
          }}
          onRemove={
            linkEdit.href
              ? () => {
                  const block = getBlock(linkEdit.id);
                  setLinkEdit(null);
                  if (!block) return;
                  commit(updateBlock(docRef.current.blocks, linkEdit.id, { runs: setLink(block.runs, linkEdit.start, linkEdit.end, null) }), {
                    focus: { id: linkEdit.id, start: linkEdit.end },
                  });
                }
              : null
          }
          onSubmit={(input) => {
            const href = normalizeHref(input);
            if (!href) {
              setLinkEdit({ ...linkEdit, error: "Enter a web address, like https://example.com" });
              return;
            }
            const block = getBlock(linkEdit.id);
            setLinkEdit(null);
            if (!block) return;
            commit(updateBlock(docRef.current.blocks, linkEdit.id, { runs: setLink(block.runs, linkEdit.start, linkEdit.end, href) }), {
              focus: { id: linkEdit.id, start: linkEdit.end },
            });
          }}
        />
      )}

      {blockMenu && menuBlock && !readOnly && (
        <BlockMenu
          anchor={blockMenu.anchor}
          kind={kindOf(menuBlock)}
          canMoveUp={moveBlocksBy(blocks, menuIds, -1) !== null}
          canMoveDown={moveBlocksBy(blocks, menuIds, 1) !== null}
          onClose={() => setBlockMenu(null)}
          onTurnInto={(kind) => {
            setBlockMenu(null);
            const result = turnInto(docRef.current.blocks, menuIds, kind);
            commit(result.blocks, { focus: result.focus, select: result.select });
          }}
          onDuplicate={() => {
            setBlockMenu(null);
            commitResult(duplicateBlocks(docRef.current.blocks, menuIds));
          }}
          onMoveUp={() => {
            const result = moveBlocksBy(docRef.current.blocks, menuIds, -1);
            if (result) commit(result.blocks, { select: menuIds });
            setBlockMenu(null);
          }}
          onMoveDown={() => {
            const result = moveBlocksBy(docRef.current.blocks, menuIds, 1);
            if (result) commit(result.blocks, { select: menuIds });
            setBlockMenu(null);
          }}
          onCopy={() => {
            const span = selectionSpan(docRef.current.blocks, menuIds);
            if (span) void copyToClipboard(blocksToMarkdown(docRef.current.blocks.slice(span[0], span[1])));
            setBlockMenu(null);
          }}
          onDelete={() => {
            setBlockMenu(null);
            const result = deleteBlocks(docRef.current.blocks, menuIds);
            setBlockSel(null);
            commit(result.blocks, { focus: result.focus, select: result.select });
          }}
        />
      )}
    </div>
  );
});
