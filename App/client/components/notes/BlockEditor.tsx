import React from "react";
import {
  Bold,
  CheckSquare,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListOrdered,
  Minus,
  Plus,
  Quote,
  Text as TextIcon,
  Type,
} from "lucide-react";
import { clsx } from "../ui/clsx";
import { useDialog } from "../ui/Dialog";

/**
 * Notion-style block editor. Stores its state as `Block[]` while the parent
 * holds the markdown source — we round-trip on every change so existing
 * notes (and AI-written prose) keep working untouched.
 *
 * Each block is its own contenteditable div with `key={block.id}`. When a
 * structural change happens (split, merge, slash-pick, type swap), we mint
 * a new id for the affected block so React re-mounts it; the mount effect
 * sets the initial textContent. After mount we never push state into the
 * DOM, which keeps the cursor stable while typing.
 */

export type BlockType =
  | "paragraph"
  | "h1"
  | "h2"
  | "h3"
  | "bullet"
  | "numbered"
  | "todo"
  | "quote"
  | "divider";

export type Block = {
  id: string;
  type: BlockType;
  text: string;
  checked?: boolean;
};

export type BlockEditorProps = {
  value: string;
  onChange: (next: string) => void;
  onSave?: () => void;
  placeholder?: string;
};

// ───────────────────────── Markdown round-trip ──────────────────────────────

export function parseMarkdown(md: string): Block[] {
  const lines = md.split("\n");
  const out: Block[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (inCode) {
      if (line.trim() === "```") {
        out.push({ id: nid(), type: "paragraph", text: codeBuf.join("\n") });
        codeBuf = [];
        inCode = false;
      } else {
        codeBuf.push(line);
      }
      continue;
    }
    if (line.trim() === "```") {
      inCode = true;
      continue;
    }
    if (/^---+$|^\*\*\*+$|^___+$/.test(line.trim())) {
      out.push({ id: nid(), type: "divider", text: "" });
      continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = /^### (.*)$/.exec(line))) {
      out.push({ id: nid(), type: "h3", text: m[1] });
    } else if ((m = /^## (.*)$/.exec(line))) {
      out.push({ id: nid(), type: "h2", text: m[1] });
    } else if ((m = /^# (.*)$/.exec(line))) {
      out.push({ id: nid(), type: "h1", text: m[1] });
    } else if ((m = /^- \[( |x|X)\] (.*)$/.exec(line))) {
      out.push({
        id: nid(),
        type: "todo",
        text: m[2],
        checked: m[1].toLowerCase() === "x",
      });
    } else if ((m = /^[-*] (.*)$/.exec(line))) {
      out.push({ id: nid(), type: "bullet", text: m[1] });
    } else if ((m = /^\d+\. (.*)$/.exec(line))) {
      out.push({ id: nid(), type: "numbered", text: m[1] });
    } else if ((m = /^> ?(.*)$/.exec(line))) {
      out.push({ id: nid(), type: "quote", text: m[1] });
    } else if (line.trim() === "") {
      // Drop empty separators — we re-introduce blank lines around block-type
      // transitions when serializing.
    } else {
      out.push({ id: nid(), type: "paragraph", text: line });
    }
  }
  if (out.length === 0) out.push({ id: nid(), type: "paragraph", text: "" });
  return out;
}

export function serializeBlocks(blocks: Block[]): string {
  const lines: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    let line: string;
    switch (b.type) {
      case "h1":
        line = `# ${b.text}`;
        break;
      case "h2":
        line = `## ${b.text}`;
        break;
      case "h3":
        line = `### ${b.text}`;
        break;
      case "bullet":
        line = `- ${b.text}`;
        break;
      case "numbered":
        line = `1. ${b.text}`;
        break;
      case "todo":
        line = `- [${b.checked ? "x" : " "}] ${b.text}`;
        break;
      case "quote":
        line = `> ${b.text}`;
        break;
      case "divider":
        line = "---";
        break;
      default:
        line = b.text;
    }
    lines.push(line);
    const next = blocks[i + 1];
    if (next && needsSeparator(b, next)) lines.push("");
  }
  return lines.join("\n");
}

function needsSeparator(a: Block, b: Block): boolean {
  const listTypes: BlockType[] = ["bullet", "numbered", "todo"];
  const aList = listTypes.includes(a.type);
  const bList = listTypes.includes(b.type);
  if (aList && bList) return false; // keep list rows packed
  if (a.type === "paragraph" && b.type === "paragraph") return true;
  if (a.type === b.type) return true;
  return true;
}

function nid(): string {
  // Random IDs are fine — only used for React keys + focus targeting,
  // never persisted.
  return Math.random().toString(36).slice(2, 11);
}

// ───────────────────────── Slash menu items ─────────────────────────────────

type SlashCommand = {
  id: string;
  label: string;
  hint: string;
  keywords: string[];
  icon: React.ReactNode;
  apply: (b: Block) => Block;
};

const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: "paragraph",
    label: "Text",
    hint: "Just start writing with plain text.",
    keywords: ["text", "paragraph", "plain"],
    icon: <TextIcon size={16} />,
    apply: (b) => ({ ...b, type: "paragraph" }),
  },
  {
    id: "h1",
    label: "Heading 1",
    hint: "Big section heading.",
    keywords: ["h1", "heading", "title", "1"],
    icon: <Heading1 size={16} />,
    apply: (b) => ({ ...b, type: "h1" }),
  },
  {
    id: "h2",
    label: "Heading 2",
    hint: "Medium section heading.",
    keywords: ["h2", "heading", "subtitle", "2"],
    icon: <Heading2 size={16} />,
    apply: (b) => ({ ...b, type: "h2" }),
  },
  {
    id: "h3",
    label: "Heading 3",
    hint: "Small section heading.",
    keywords: ["h3", "heading", "3"],
    icon: <Heading3 size={16} />,
    apply: (b) => ({ ...b, type: "h3" }),
  },
  {
    id: "bullet",
    label: "Bulleted list",
    hint: "Create a simple bulleted list.",
    keywords: ["bullet", "list", "unordered", "ul"],
    icon: <List size={16} />,
    apply: (b) => ({ ...b, type: "bullet" }),
  },
  {
    id: "numbered",
    label: "Numbered list",
    hint: "Create a list with numbering.",
    keywords: ["numbered", "ordered", "list", "ol", "1"],
    icon: <ListOrdered size={16} />,
    apply: (b) => ({ ...b, type: "numbered" }),
  },
  {
    id: "todo",
    label: "To-do list",
    hint: "Track tasks with a checkbox.",
    keywords: ["todo", "task", "check", "checkbox"],
    icon: <CheckSquare size={16} />,
    apply: (b) => ({ ...b, type: "todo", checked: false }),
  },
  {
    id: "quote",
    label: "Quote",
    hint: "Capture a quote.",
    keywords: ["quote", "blockquote"],
    icon: <Quote size={16} />,
    apply: (b) => ({ ...b, type: "quote" }),
  },
  {
    id: "divider",
    label: "Divider",
    hint: "Visually divide blocks.",
    keywords: ["divider", "rule", "line", "hr"],
    icon: <Minus size={16} />,
    apply: (b) => ({ ...b, type: "divider", text: "" }),
  },
];

// ───────────────────────── Editor component ─────────────────────────────────

type SlashState = {
  blockId: string;
  query: string;
  rect: DOMRect;
  selected: number;
} | null;

type SelectionPopover = {
  rect: DOMRect;
} | null;

type FocusTarget = { id: string; offset: number | "end" } | null;

export function BlockEditor({
  value,
  onChange,
  onSave,
  placeholder,
}: BlockEditorProps) {
  const dialog = useDialog();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const blockElsRef = React.useRef(new Map<string, HTMLDivElement>());
  const lastSerializedRef = React.useRef<string>(value);
  const focusTargetRef = React.useRef<FocusTarget>(null);

  const [blocks, setBlocks] = React.useState<Block[]>(() => parseMarkdown(value));
  const [slash, setSlash] = React.useState<SlashState>(null);
  const [selectionPopover, setSelectionPopover] =
    React.useState<SelectionPopover>(null);

  // Re-parse if the parent's markdown drifts away from what we last emitted.
  // Happens on initial load (different note) and whenever something else
  // mutates `value` (e.g., a server-side update). Skipped during ordinary
  // typing because `lastSerializedRef` shadows the round-trip.
  React.useEffect(() => {
    if (value === lastSerializedRef.current) return;
    lastSerializedRef.current = value;
    setBlocks(parseMarkdown(value));
  }, [value]);

  // Push markdown back to the parent every time blocks change (except the
  // initial render — we already match value).
  React.useEffect(() => {
    const md = serializeBlocks(blocks);
    if (md === lastSerializedRef.current) return;
    lastSerializedRef.current = md;
    onChange(md);
  }, [blocks, onChange]);

  // After a structural change we may want to focus a specific block at a
  // specific caret offset (e.g., after Enter splits a block, focus the new
  // block at offset 0). useLayoutEffect runs after DOM mutation but before
  // paint so the cursor jump isn't visible.
  React.useLayoutEffect(() => {
    const target = focusTargetRef.current;
    if (!target) return;
    focusTargetRef.current = null;
    const el = blockElsRef.current.get(target.id);
    if (!el) return;
    el.focus();
    placeCaret(el, target.offset);
  });

  // Cmd/Ctrl+S — save no matter what's focused inside the editor.
  React.useEffect(() => {
    if (!onSave) return;
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && (e.key === "s" || e.key === "S")) {
        const target = e.target as Node | null;
        if (containerRef.current?.contains(target ?? null)) {
          e.preventDefault();
          onSave?.();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSave]);

  // Track text selection inside the editor; show a floating toolbar when
  // there is a non-collapsed selection.
  React.useEffect(() => {
    function onSelectionChange() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setSelectionPopover(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const anchor = range.commonAncestorContainer;
      const node = anchor.nodeType === 1 ? (anchor as Element) : anchor.parentElement;
      if (!node || !containerRef.current?.contains(node)) {
        setSelectionPopover(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setSelectionPopover(null);
        return;
      }
      setSelectionPopover({ rect });
    }
    document.addEventListener("selectionchange", onSelectionChange);
    return () =>
      document.removeEventListener("selectionchange", onSelectionChange);
  }, []);

  // ───── Block mutation helpers ─────

  const updateBlock = React.useCallback(
    (id: string, patch: Partial<Block>) => {
      setBlocks((prev) =>
        prev.map((b) => (b.id === id ? { ...b, ...patch } : b)),
      );
    },
    [],
  );

  const replaceBlock = React.useCallback((id: string, next: Block) => {
    setBlocks((prev) => prev.map((b) => (b.id === id ? next : b)));
  }, []);

  const splitBlock = React.useCallback(
    (id: string, offset: number) => {
      setBlocks((prev) => {
        const idx = prev.findIndex((b) => b.id === id);
        if (idx < 0) return prev;
        const block = prev[idx];
        if (block.type === "divider") return prev;
        const text = block.text;
        const left = text.slice(0, offset);
        const right = text.slice(offset);
        // Re-mint id on the left side too — we just rewrote its text and
        // need React to re-set the DOM textContent on remount.
        const updatedLeft: Block = { ...block, id: nid(), text: left };
        let newType: BlockType = "paragraph";
        let newChecked: boolean | undefined;
        if (
          block.type === "bullet" ||
          block.type === "numbered" ||
          block.type === "todo"
        ) {
          newType = block.type;
          if (block.type === "todo") newChecked = false;
        }
        const newBlock: Block = {
          id: nid(),
          type: newType,
          text: right,
          checked: newChecked,
        };
        focusTargetRef.current = { id: newBlock.id, offset: 0 };
        return [
          ...prev.slice(0, idx),
          updatedLeft,
          newBlock,
          ...prev.slice(idx + 1),
        ];
      });
    },
    [],
  );

  const insertBlockBelow = React.useCallback(
    (id: string, type: BlockType = "paragraph") => {
      setBlocks((prev) => {
        const idx = prev.findIndex((b) => b.id === id);
        if (idx < 0) return prev;
        const newBlock: Block = { id: nid(), type, text: "" };
        if (type === "todo") newBlock.checked = false;
        focusTargetRef.current = { id: newBlock.id, offset: 0 };
        return [...prev.slice(0, idx + 1), newBlock, ...prev.slice(idx + 1)];
      });
    },
    [],
  );

  const mergeWithPrevious = React.useCallback((id: string) => {
    setBlocks((prev) => {
      const idx = prev.findIndex((b) => b.id === id);
      if (idx <= 0) return prev;
      const cur = prev[idx];
      const prevBlock = prev[idx - 1];
      if (prevBlock.type === "divider") {
        // Pressing backspace at the start of a block right after a divider
        // removes the divider rather than merging.
        focusTargetRef.current = { id: cur.id, offset: 0 };
        return [
          ...prev.slice(0, idx - 1),
          cur,
          ...prev.slice(idx + 1),
        ];
      }
      const mergedText = prevBlock.text + cur.text;
      const merged: Block = {
        ...prevBlock,
        id: nid(),
        text: mergedText,
      };
      focusTargetRef.current = {
        id: merged.id,
        offset: prevBlock.text.length,
      };
      return [
        ...prev.slice(0, idx - 1),
        merged,
        ...prev.slice(idx + 1),
      ];
    });
  }, []);

  const focusPrevious = React.useCallback(
    (id: string, offset: number | "end" = "end") => {
      const idx = blocks.findIndex((b) => b.id === id);
      if (idx <= 0) return;
      const target = blocks[idx - 1];
      const el = blockElsRef.current.get(target.id);
      if (!el) return;
      el.focus();
      placeCaret(el, offset);
    },
    [blocks],
  );

  const focusNext = React.useCallback(
    (id: string, offset: number | "end" = 0) => {
      const idx = blocks.findIndex((b) => b.id === id);
      if (idx < 0 || idx >= blocks.length - 1) return;
      const target = blocks[idx + 1];
      const el = blockElsRef.current.get(target.id);
      if (!el) return;
      el.focus();
      placeCaret(el, offset);
    },
    [blocks],
  );

  // ───── Slash menu ─────

  function openSlashMenu(blockId: string) {
    const el = blockElsRef.current.get(blockId);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setSlash({ blockId, query: "", rect, selected: 0 });
  }

  function closeSlashMenu() {
    setSlash(null);
  }

  const filteredCommands = React.useMemo(() => {
    if (!slash) return SLASH_COMMANDS;
    const q = slash.query.trim().toLowerCase();
    if (!q) return SLASH_COMMANDS;
    return SLASH_COMMANDS.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.keywords.some((k) => k.includes(q)),
    );
  }, [slash]);

  function applySlashCommand(cmd: SlashCommand) {
    if (!slash) return;
    const target = blocks.find((b) => b.id === slash.blockId);
    if (!target) return;
    const next = cmd.apply(target);
    // Drop the typed "/<query>" from the text — we used it to filter but it
    // shouldn't end up in the saved markdown.
    const trimmed: Block = { ...next, id: nid(), text: stripSlashFragment(next.text) };
    replaceBlock(target.id, trimmed);
    focusTargetRef.current = {
      id: trimmed.id,
      offset: trimmed.type === "divider" ? 0 : "end",
    };
    setSlash(null);
    // Divider has no editable surface — append a fresh paragraph so the user
    // can keep writing.
    if (trimmed.type === "divider") {
      setTimeout(() => insertBlockBelow(trimmed.id), 0);
    }
  }

  // ───── Per-block keydown handling ─────

  function handleBlockKeyDown(
    e: React.KeyboardEvent<HTMLDivElement>,
    block: Block,
  ) {
    // While slash menu is open, route arrows/Enter/Escape into it.
    if (slash && slash.blockId === block.id) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlash((s) =>
          s
            ? {
                ...s,
                selected: Math.min(s.selected + 1, filteredCommands.length - 1),
              }
            : s,
        );
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlash((s) =>
          s ? { ...s, selected: Math.max(s.selected - 1, 0) } : s,
        );
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeSlashMenu();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const cmd = filteredCommands[slash.selected];
        if (cmd) applySlashCommand(cmd);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const offset = currentCaretOffset(e.currentTarget);
      // Empty list item → demote to paragraph instead of creating another
      // empty bullet.
      if (
        block.text.trim() === "" &&
        (block.type === "bullet" ||
          block.type === "numbered" ||
          block.type === "todo" ||
          block.type === "quote")
      ) {
        replaceBlock(block.id, {
          ...block,
          id: nid(),
          type: "paragraph",
          checked: undefined,
        });
        return;
      }
      splitBlock(block.id, offset);
      return;
    }

    if (e.key === "Backspace") {
      const offset = currentCaretOffset(e.currentTarget);
      const sel = window.getSelection();
      const collapsed = sel ? sel.isCollapsed : true;
      if (collapsed && offset === 0) {
        e.preventDefault();
        if (block.type !== "paragraph") {
          replaceBlock(block.id, {
            ...block,
            id: nid(),
            type: "paragraph",
            checked: undefined,
          });
          focusTargetRef.current = { id: nid(), offset: 0 };
          // Re-set focus target with the new id we just used:
          // replaceBlock above gave the block a fresh id — read it back.
          // (Cheap fix: schedule a microtask to find it.)
          queueMicrotask(() => {
            setBlocks((prev) => {
              const cur = prev.find((b) => b.text === block.text);
              if (cur) {
                focusTargetRef.current = { id: cur.id, offset: 0 };
              }
              return prev;
            });
          });
          return;
        }
        mergeWithPrevious(block.id);
        return;
      }
    }

    if (e.key === "ArrowUp") {
      const offset = currentCaretOffset(e.currentTarget);
      if (offset === 0) {
        e.preventDefault();
        focusPrevious(block.id, "end");
        return;
      }
    }
    if (e.key === "ArrowDown") {
      const offset = currentCaretOffset(e.currentTarget);
      if (offset === (e.currentTarget.textContent ?? "").length) {
        e.preventDefault();
        focusNext(block.id, 0);
        return;
      }
    }

    const meta = e.metaKey || e.ctrlKey;
    if (meta && (e.key === "b" || e.key === "B")) {
      e.preventDefault();
      wrapSelection("**", "**");
      return;
    }
    if (meta && (e.key === "i" || e.key === "I")) {
      e.preventDefault();
      wrapSelection("_", "_");
      return;
    }
    if (meta && (e.key === "e" || e.key === "E")) {
      e.preventDefault();
      wrapSelection("`", "`");
      return;
    }
    if (meta && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      onLink();
      return;
    }
  }

  // ───── Per-block input handling ─────

  function handleBlockInput(
    e: React.FormEvent<HTMLDivElement>,
    block: Block,
  ) {
    const el = e.currentTarget;
    const text = el.textContent ?? "";
    // Slash menu lifecycle.
    const offset = currentCaretOffset(el);
    const before = text.slice(0, offset);
    const slashIdx = before.lastIndexOf("/");
    if (
      slashIdx >= 0 &&
      // either at start of the line, or right after a space — same heuristic
      // Notion uses
      (slashIdx === 0 || /\s/.test(before[slashIdx - 1])) &&
      !/\s/.test(before.slice(slashIdx + 1))
    ) {
      const query = before.slice(slashIdx + 1);
      const rect = el.getBoundingClientRect();
      setSlash({ blockId: block.id, query, rect, selected: 0 });
    } else if (slash && slash.blockId === block.id) {
      setSlash(null);
    }

    // Markdown shortcuts at start-of-line — only fire while the block is
    // still a plain paragraph so we never re-style something the user has
    // already committed to.
    if (block.type === "paragraph") {
      const m = matchShortcut(text);
      if (m) {
        const remaining = text.slice(m.consumed);
        const next: Block = {
          id: nid(),
          type: m.type,
          text: remaining,
          checked: m.type === "todo" ? false : undefined,
        };
        replaceBlock(block.id, next);
        focusTargetRef.current = { id: next.id, offset: 0 };
        return;
      }
      if (text === "---" || text === "***" || text === "___") {
        const next: Block = { id: nid(), type: "divider", text: "" };
        replaceBlock(block.id, next);
        // Stick a fresh paragraph after so the user keeps a writing surface.
        setTimeout(() => insertBlockBelow(next.id), 0);
        return;
      }
    }

    if (block.text !== text) updateBlock(block.id, { text });
  }

  function handleBlockPaste(
    e: React.ClipboardEvent<HTMLDivElement>,
    block: Block,
  ) {
    const data = e.clipboardData;
    if (!data) return;
    const text = data.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    const lines = text.split(/\r?\n/);
    if (lines.length <= 1) {
      // Single line → splice into the current block at the caret.
      const offset = currentCaretOffset(e.currentTarget);
      const cur = block.text;
      const merged = cur.slice(0, offset) + text + cur.slice(offset);
      updateBlock(block.id, { text: merged });
      // We're not re-mounting, so move the caret manually post-render.
      const newOffset = offset + text.length;
      requestAnimationFrame(() => {
        const el = blockElsRef.current.get(block.id);
        if (el) {
          // The DOM doesn't reflect React state until after the next render —
          // the `text` value the input event already wrote is what's there.
          // Just place the caret.
          placeCaret(el, newOffset);
        }
      });
      return;
    }
    // Multi-line: replace this block with parsed blocks.
    setBlocks((prev) => {
      const idx = prev.findIndex((b) => b.id === block.id);
      if (idx < 0) return prev;
      const offset = currentCaretOffset(blockElsRef.current.get(block.id)!);
      const cur = block.text;
      const before = cur.slice(0, offset);
      const after = cur.slice(offset);
      const head = before + lines[0];
      const tail = lines.slice(1, -1).join("\n");
      const lastLine = lines[lines.length - 1] + after;
      const parsed = parseMarkdown([head, tail, lastLine].filter(Boolean).join("\n"));
      if (parsed.length === 0) return prev;
      // Promote the first parsed block to replace the current one's id slot.
      const focus = parsed[parsed.length - 1];
      focusTargetRef.current = { id: focus.id, offset: "end" };
      return [...prev.slice(0, idx), ...parsed, ...prev.slice(idx + 1)];
    });
  }

  // ───── Inline-formatting helpers ─────

  function wrapSelection(before: string, after: string) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const anchorEl = (range.commonAncestorContainer.nodeType === 1
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentNode) as HTMLElement | null;
    const blockEl = anchorEl?.closest('[data-block-id]') as HTMLDivElement | null;
    if (!blockEl) return;
    const blockId = blockEl.dataset.blockId!;
    const text = blockEl.textContent ?? "";
    const start = caretOffsetWithin(blockEl, range.startContainer, range.startOffset);
    const end = caretOffsetWithin(blockEl, range.endContainer, range.endOffset);
    const selected = text.slice(start, end);
    const insert = `${before}${selected || ""}${after}`;
    const next = text.slice(0, start) + insert + text.slice(end);
    updateBlock(blockId, { text: next });
    // Re-place caret on next frame.
    requestAnimationFrame(() => {
      const el = blockElsRef.current.get(blockId);
      if (!el) return;
      const caret = selected
        ? start + before.length + selected.length
        : start + before.length;
      placeCaret(el, caret);
    });
  }

  async function onLink() {
    const url = await dialog.prompt({
      title: "Insert link",
      placeholder: "https://example.com",
      confirmLabel: "Insert",
      validate: (v) => {
        if (!v) return "Required";
        if (!/^(https?:\/\/|mailto:|\/|#)/.test(v))
          return "Must start with http(s)://, /, #, or mailto:";
        return null;
      },
    });
    if (!url) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const anchorEl = (range.commonAncestorContainer.nodeType === 1
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentNode) as HTMLElement | null;
    const blockEl = anchorEl?.closest('[data-block-id]') as HTMLDivElement | null;
    if (!blockEl) return;
    const blockId = blockEl.dataset.blockId!;
    const text = blockEl.textContent ?? "";
    const start = caretOffsetWithin(blockEl, range.startContainer, range.startOffset);
    const end = caretOffsetWithin(blockEl, range.endContainer, range.endOffset);
    const selected = text.slice(start, end) || "link";
    const insert = `[${selected}](${url})`;
    const next = text.slice(0, start) + insert + text.slice(end);
    updateBlock(blockId, { text: next });
    requestAnimationFrame(() => {
      const el = blockElsRef.current.get(blockId);
      if (!el) return;
      placeCaret(el, start + insert.length);
    });
  }

  // ───── Block rendering ─────

  return (
    <div
      ref={containerRef}
      className="relative w-full"
      data-block-editor
    >
      {blocks.map((block, i) => {
        const isFirst = i === 0;
        const isOnlyEmpty =
          blocks.length === 1 && block.type === "paragraph" && block.text === "";
        return (
          <BlockRow
            key={block.id}
            block={block}
            index={i}
            placeholder={
              isOnlyEmpty
                ? placeholder ?? "Type '/' for commands, or just start writing…"
                : block.type === "h1"
                  ? "Heading 1"
                  : block.type === "h2"
                    ? "Heading 2"
                    : block.type === "h3"
                      ? "Heading 3"
                      : isFirst
                        ? "Type '/' for commands"
                        : ""
            }
            registerEl={(el) => {
              if (el) blockElsRef.current.set(block.id, el);
              else blockElsRef.current.delete(block.id);
            }}
            onAddBelow={() => insertBlockBelow(block.id)}
            onSlashClick={() => openSlashMenu(block.id)}
            onKeyDown={(e) => handleBlockKeyDown(e, block)}
            onInput={(e) => handleBlockInput(e, block)}
            onPaste={(e) => handleBlockPaste(e, block)}
            onToggleCheck={
              block.type === "todo"
                ? () => updateBlock(block.id, { checked: !block.checked })
                : undefined
            }
          />
        );
      })}

      {slash && (
        <SlashMenu
          rect={slash.rect}
          commands={filteredCommands}
          selected={slash.selected}
          onPick={applySlashCommand}
          onHover={(i) => setSlash((s) => (s ? { ...s, selected: i } : s))}
          onClose={closeSlashMenu}
        />
      )}

      {selectionPopover && !slash && (
        <SelectionToolbar
          rect={selectionPopover.rect}
          onBold={() => wrapSelection("**", "**")}
          onItalic={() => wrapSelection("_", "_")}
          onCode={() => wrapSelection("`", "`")}
          onLink={onLink}
          onHeading={(t) => {
            const sel = window.getSelection();
            if (!sel || sel.rangeCount === 0) return;
            const range = sel.getRangeAt(0);
            const anchorEl = (range.commonAncestorContainer.nodeType === 1
              ? range.commonAncestorContainer
              : range.commonAncestorContainer.parentNode) as HTMLElement | null;
            const blockEl = anchorEl?.closest("[data-block-id]") as
              | HTMLDivElement
              | null;
            if (!blockEl) return;
            const blockId = blockEl.dataset.blockId!;
            const cur = blocks.find((b) => b.id === blockId);
            if (!cur) return;
            const next: Block = { ...cur, id: nid(), type: t };
            replaceBlock(blockId, next);
            focusTargetRef.current = { id: next.id, offset: "end" };
          }}
        />
      )}
    </div>
  );
}

// ───────────────────────── Block row ────────────────────────────────────────

type BlockRowProps = {
  block: Block;
  index: number;
  placeholder: string;
  registerEl: (el: HTMLDivElement | null) => void;
  onAddBelow: () => void;
  onSlashClick: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onInput: (e: React.FormEvent<HTMLDivElement>) => void;
  onPaste: (e: React.ClipboardEvent<HTMLDivElement>) => void;
  onToggleCheck?: () => void;
};

function BlockRow({
  block,
  index,
  placeholder,
  registerEl,
  onAddBelow,
  onSlashClick,
  onKeyDown,
  onInput,
  onPaste,
  onToggleCheck,
}: BlockRowProps) {
  const editableRef = React.useRef<HTMLDivElement>(null);

  // Set initial textContent on mount and any time the block id changes
  // (which is how we model "this is a different block now"). React keys
  // already remount the element on id change, so this effect runs fresh
  // for each new id.
  React.useEffect(() => {
    if (!editableRef.current) return;
    if ((editableRef.current.textContent ?? "") !== block.text) {
      editableRef.current.textContent = block.text;
    }
    registerEl(editableRef.current);
    return () => registerEl(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [block.id]);

  const editableClass = blockTypeClass(block.type, block.checked);

  const editable = block.type === "divider" ? (
    <div className="my-3 h-px w-full bg-slate-200 dark:bg-slate-700" />
  ) : (
    <div
      ref={editableRef}
      role="textbox"
      contentEditable
      suppressContentEditableWarning
      spellCheck
      data-block-id={block.id}
      data-placeholder={placeholder}
      onKeyDown={onKeyDown}
      onInput={onInput}
      onPaste={onPaste}
      className={clsx(
        "block-editable min-w-0 flex-1 outline-none",
        "whitespace-pre-wrap break-words",
        editableClass,
      )}
    />
  );

  return (
    <div
      className={clsx(
        "group relative flex items-start",
        block.type === "h1" && "mt-6 mb-1",
        block.type === "h2" && "mt-5 mb-1",
        block.type === "h3" && "mt-4 mb-1",
        (block.type === "bullet" ||
          block.type === "numbered" ||
          block.type === "todo") &&
          "py-0.5",
        block.type === "paragraph" && "py-1",
        block.type === "quote" && "py-1",
        block.type === "divider" && "py-0",
      )}
    >
      <div className="flex h-7 w-14 shrink-0 items-center justify-end pr-1 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          onClick={onAddBelow}
          title="Click to add a block below"
          aria-label="Add block"
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          <Plus size={14} />
        </button>
        <button
          type="button"
          onClick={onSlashClick}
          title="Click to open block menu"
          aria-label="Block menu"
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          <Type size={14} />
        </button>
      </div>

      <div className="flex w-full min-w-0 items-start gap-2">
        {block.type === "bullet" && (
          <span
            aria-hidden
            className="mt-[0.55rem] inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400 dark:bg-slate-500"
          />
        )}
        {block.type === "numbered" && (
          <span
            aria-hidden
            className="mt-1 shrink-0 text-base text-slate-500 dark:text-slate-400"
          >
            {indexAmongType(index)}.
          </span>
        )}
        {block.type === "todo" && (
          <button
            type="button"
            onClick={onToggleCheck}
            aria-label={block.checked ? "Mark as not done" : "Mark as done"}
            className={clsx(
              "mt-[0.4rem] flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition",
              block.checked
                ? "border-indigo-500 bg-indigo-500 text-white"
                : "border-slate-300 bg-white hover:border-indigo-400 dark:border-slate-600 dark:bg-slate-900",
            )}
          >
            {block.checked && (
              <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M2 6.5L5 9l5-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        )}
        {block.type === "quote" && (
          <span
            aria-hidden
            className="mt-1 inline-block w-[3px] self-stretch rounded bg-slate-300 dark:bg-slate-600"
          />
        )}
        {editable}
      </div>
    </div>
  );
}

function indexAmongType(globalIndex: number): number {
  // Numbered lists in Notion restart at 1 per group; we don't currently
  // track groups in state. Showing 1 for every item keeps the markdown
  // round-trippable (`1.` always serializes the same) and matches Notion's
  // visual default well enough for short lists.
  void globalIndex;
  return 1;
}

function blockTypeClass(type: BlockType, checked?: boolean): string {
  switch (type) {
    case "h1":
      return "text-[2rem] font-bold leading-tight text-slate-900 dark:text-slate-50";
    case "h2":
      return "text-2xl font-semibold leading-snug text-slate-900 dark:text-slate-100";
    case "h3":
      return "text-xl font-semibold leading-snug text-slate-900 dark:text-slate-100";
    case "bullet":
    case "numbered":
      return "text-[15px] leading-relaxed text-slate-800 dark:text-slate-100";
    case "todo":
      return clsx(
        "text-[15px] leading-relaxed",
        checked
          ? "text-slate-400 line-through dark:text-slate-500"
          : "text-slate-800 dark:text-slate-100",
      );
    case "quote":
      return "text-[15px] italic leading-relaxed text-slate-600 dark:text-slate-300";
    case "paragraph":
    default:
      return "text-[15px] leading-relaxed text-slate-800 dark:text-slate-100";
  }
}

// ───────────────────────── Slash menu ───────────────────────────────────────

function SlashMenu({
  rect,
  commands,
  selected,
  onPick,
  onHover,
  onClose,
}: {
  rect: DOMRect;
  commands: SlashCommand[];
  selected: number;
  onPick: (cmd: SlashCommand) => void;
  onHover: (i: number) => void;
  onClose: () => void;
}) {
  // Anchor below the active block.
  const top = rect.bottom + window.scrollY + 6;
  const left = rect.left + window.scrollX + 16;
  React.useEffect(() => {
    function onDocClick(e: MouseEvent) {
      const t = e.target as HTMLElement;
      if (!t.closest("[data-slash-menu]")) onClose();
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [onClose]);

  if (commands.length === 0) {
    return (
      <div
        data-slash-menu
        className="fixed z-50 w-72 rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-500 shadow-xl dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400"
        style={{ top, left }}
      >
        No matching blocks
      </div>
    );
  }

  return (
    <div
      data-slash-menu
      className="fixed z-50 w-72 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900"
      style={{ top, left }}
    >
      <div className="border-b border-slate-100 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:border-slate-800 dark:text-slate-500">
        Basic blocks
      </div>
      <div className="max-h-80 overflow-y-auto py-1">
        {commands.map((cmd, i) => (
          <button
            key={cmd.id}
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(cmd);
            }}
            onMouseEnter={() => onHover(i)}
            className={clsx(
              "flex w-full items-center gap-3 px-3 py-2 text-left",
              i === selected
                ? "bg-slate-100 dark:bg-slate-800"
                : "hover:bg-slate-50 dark:hover:bg-slate-800/60",
            )}
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200">
              {cmd.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                {cmd.label}
              </span>
              <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                {cmd.hint}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ───────────────────────── Selection toolbar ────────────────────────────────

function SelectionToolbar({
  rect,
  onBold,
  onItalic,
  onCode,
  onLink,
  onHeading,
}: {
  rect: DOMRect;
  onBold: () => void;
  onItalic: () => void;
  onCode: () => void;
  onLink: () => void;
  onHeading: (t: BlockType) => void;
}) {
  const top = rect.top + window.scrollY - 44;
  const left = rect.left + window.scrollX + rect.width / 2;
  return (
    <div
      className="fixed z-40 -translate-x-1/2 rounded-lg border border-slate-200 bg-white px-1 py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
      style={{ top, left }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="flex items-center gap-0.5">
        <ToolbarBtn title="Heading 1" onClick={() => onHeading("h1")}>
          <Heading1 size={14} />
        </ToolbarBtn>
        <ToolbarBtn title="Heading 2" onClick={() => onHeading("h2")}>
          <Heading2 size={14} />
        </ToolbarBtn>
        <ToolbarBtn title="Heading 3" onClick={() => onHeading("h3")}>
          <Heading3 size={14} />
        </ToolbarBtn>
        <span className="mx-1 h-4 w-px bg-slate-200 dark:bg-slate-700" />
        <ToolbarBtn title="Bold (⌘B)" onClick={onBold}>
          <Bold size={14} />
        </ToolbarBtn>
        <ToolbarBtn title="Italic (⌘I)" onClick={onItalic}>
          <Italic size={14} />
        </ToolbarBtn>
        <ToolbarBtn title="Code (⌘E)" onClick={onCode}>
          <Code2 size={14} />
        </ToolbarBtn>
        <ToolbarBtn title="Link (⌘K)" onClick={onLink}>
          <Link2 size={14} />
        </ToolbarBtn>
      </div>
    </div>
  );
}

function ToolbarBtn({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()}
      className="rounded p-1.5 text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100"
    >
      {children}
    </button>
  );
}

// ───────────────────────── Caret / DOM helpers ──────────────────────────────

function placeCaret(el: HTMLElement, offsetOrEnd: number | "end") {
  const range = document.createRange();
  const sel = window.getSelection();
  if (!sel) return;
  // Find a text node to anchor in. If empty, anchor at the element start.
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let acc = 0;
  let target: Text | null = null;
  let targetOffset = 0;
  const want = offsetOrEnd === "end" ? Number.POSITIVE_INFINITY : offsetOrEnd;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const len = node.data.length;
    if (acc + len >= want) {
      target = node;
      targetOffset = Math.max(0, Math.min(want - acc, len));
      break;
    }
    acc += len;
  }
  if (!target) {
    if (el.lastChild && el.lastChild.nodeType === 3) {
      target = el.lastChild as Text;
      targetOffset = (target.data ?? "").length;
    } else {
      range.selectNodeContents(el);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
  }
  range.setStart(target, targetOffset);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function currentCaretOffset(el: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 0;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return 0;
  return caretOffsetWithin(el, range.startContainer, range.startOffset);
}

function caretOffsetWithin(
  root: HTMLElement,
  node: Node,
  nodeOffset: number,
): number {
  let acc = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const n = walker.currentNode as Text;
    if (n === node) return acc + nodeOffset;
    acc += n.data.length;
  }
  // Fallback: if the selection anchor is the element itself, count text up
  // to its child at the given offset.
  if (node === root) {
    let count = 0;
    for (let i = 0; i < nodeOffset && i < root.childNodes.length; i++) {
      const c = root.childNodes[i];
      count += (c.textContent ?? "").length;
    }
    return count;
  }
  return acc;
}

// ───────────────────────── Inline shortcut detection ────────────────────────

type ShortcutMatch = { type: BlockType; consumed: number };

function matchShortcut(text: string): ShortcutMatch | null {
  if (text.startsWith("# ")) return { type: "h1", consumed: 2 };
  if (text.startsWith("## ")) return { type: "h2", consumed: 3 };
  if (text.startsWith("### ")) return { type: "h3", consumed: 4 };
  if (text.startsWith("- [ ] ")) return { type: "todo", consumed: 6 };
  if (text.startsWith("[] ")) return { type: "todo", consumed: 3 };
  if (text.startsWith("- ") || text.startsWith("* "))
    return { type: "bullet", consumed: 2 };
  if (/^\d+\. /.test(text)) {
    const m = /^\d+\. /.exec(text)!;
    return { type: "numbered", consumed: m[0].length };
  }
  if (text.startsWith("> ")) return { type: "quote", consumed: 2 };
  return null;
}

function stripSlashFragment(text: string): string {
  // The text value when applying a slash command still has the trailing
  // "/<query>" the user typed. Drop the most-recent /word so the new block
  // starts clean.
  const idx = text.lastIndexOf("/");
  if (idx < 0) return text;
  // Make sure it's the slash that opened the menu (no whitespace after it).
  const tail = text.slice(idx + 1);
  if (/\s/.test(tail)) return text;
  return text.slice(0, idx) + text.slice(idx + 1 + tail.length);
}
