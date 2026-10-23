import React from "react";
import { createPortal } from "react-dom";
import {
  Bold,
  CheckSquare,
  ChevronDown,
  Code2,
  Copy,
  CopyPlus,
  FileText,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Italic,
  Lightbulb,
  Link2,
  List,
  ListOrdered,
  ListTree,
  Minus,
  MoveDown,
  MoveUp,
  Quote,
  Strikethrough,
  Table,
  Text as TextIcon,
  Trash2,
  Unlink,
  type LucideIcon,
} from "lucide-react";
import { clsx } from "../ui/clsx";
import { useCloseOnEscape, useCloseOnPressOutside } from "../ui/Menu";
import type { BlockKind } from "../../lib/noteBlocks";
import type { SlashCommand, SlashCommandId } from "../../lib/noteSlash";

const ICONS: Record<SlashCommandId, LucideIcon> = {
  paragraph: TextIcon,
  h1: Heading1,
  h2: Heading2,
  h3: Heading3,
  bulleted: List,
  numbered: ListOrdered,
  todo: CheckSquare,
  toggle: ListTree,
  quote: Quote,
  callout: Lightbulb,
  code: Code2,
  divider: Minus,
  table: Table,
  image: ImageIcon,
  page: FileText,
};

/** Where a floating menu goes: below its anchor, or above when there's no room below. */
function placement(anchor: DOMRect, width: number, height: number, gap = 6) {
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  const below = viewportH - anchor.bottom - gap;
  const top = below >= height || below >= anchor.top ? anchor.bottom + gap : Math.max(8, anchor.top - gap - height);
  const left = Math.max(8, Math.min(anchor.left, viewportW - width - 8));
  return { top, left };
}

export function SlashMenu({
  anchor,
  commands,
  index,
  query,
  onPick,
  onHover,
  onClose,
}: {
  anchor: DOMRect;
  commands: SlashCommand[];
  index: number;
  query: string;
  onPick: (command: SlashCommand) => void;
  onHover: (index: number) => void;
  onClose: () => void;
}) {
  const listRef = React.useRef<HTMLDivElement>(null);
  const width = 300;
  const height = Math.min(360, 48 + commands.length * 48);
  const pos = placement(anchor, width, height);

  React.useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>(`[data-slash-index="${index}"]`);
    active?.scrollIntoView({ block: "nearest" });
  }, [index]);

  React.useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!(event.target as HTMLElement | null)?.closest("[data-slash-menu]")) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  let lastGroup = "";
  return createPortal(
    <div
      data-slash-menu
      role="listbox"
      aria-label="Insert a block"
      style={{ top: pos.top, left: pos.left, width }}
      className="fixed z-50 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl shadow-slate-900/10 dark:border-slate-700 dark:bg-slate-900"
    >
      {commands.length === 0 ? (
        <div className="px-3 py-3 text-sm text-slate-500 dark:text-slate-400">
          No blocks match &ldquo;{query}&rdquo;
        </div>
      ) : (
        <div ref={listRef} className="max-h-[360px] overflow-y-auto p-1">
          {commands.map((command, i) => {
            const Icon = ICONS[command.id];
            const header = !query && command.group !== lastGroup ? command.group : null;
            lastGroup = command.group;
            return (
              <React.Fragment key={command.id}>
                {header && (
                  <div className="px-2 pb-1 pt-2 text-[11px] font-medium text-slate-400 dark:text-slate-500">{header}</div>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === index}
                  data-slash-index={i}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onPick(command)}
                  onMouseMove={() => i !== index && onHover(i)}
                  className={clsx(
                    "flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left",
                    i === index ? "bg-slate-100 dark:bg-slate-800" : "hover:bg-slate-50 dark:hover:bg-slate-800/60",
                  )}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300">
                    <Icon size={18} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-slate-800 dark:text-slate-100">{command.label}</span>
                    <span className="block truncate text-xs text-slate-500 dark:text-slate-400">{command.description}</span>
                  </span>
                  {command.shortcut && (
                    <kbd className="hidden shrink-0 font-mono text-[11px] text-slate-400 sm:block dark:text-slate-500">
                      {command.shortcut}
                    </kbd>
                  )}
                </button>
              </React.Fragment>
            );
          })}
        </div>
      )}
    </div>,
    document.body,
  );
}

export type ToolbarMarks = { bold: boolean; italic: boolean; strike: boolean; code: boolean; link: string | null };

export const TURN_INTO: ReadonlyArray<{ kind: BlockKind; label: string }> = [
  { kind: "paragraph", label: "Text" },
  { kind: "h1", label: "Heading 1" },
  { kind: "h2", label: "Heading 2" },
  { kind: "h3", label: "Heading 3" },
  { kind: "bulleted", label: "Bulleted list" },
  { kind: "numbered", label: "Numbered list" },
  { kind: "todo", label: "To-do list" },
  { kind: "toggle", label: "Toggle list" },
  { kind: "quote", label: "Quote" },
  { kind: "callout", label: "Callout" },
  { kind: "code", label: "Code" },
];

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const mod = isMac ? "⌘" : "Ctrl+";

/** The bar over a text selection: turn into, bold, italic, strikethrough, code, link. */
export function FormatToolbar({
  anchor,
  marks,
  kind,
  onToggle,
  onLink,
  onTurnInto,
}: {
  anchor: DOMRect;
  marks: ToolbarMarks;
  kind: BlockKind | null;
  onToggle: (mark: "bold" | "italic" | "strike" | "code") => void;
  onLink: () => void;
  onTurnInto: (kind: BlockKind) => void;
}) {
  const [turnOpen, setTurnOpen] = React.useState(false);
  const width = 320;
  const top = anchor.top - 48 < 8 ? anchor.bottom + 8 : anchor.top - 48;
  const left = Math.max(8, Math.min(anchor.left + anchor.width / 2 - width / 2, window.innerWidth - width - 8));
  const current = TURN_INTO.find((t) => t.kind === kind)?.label ?? "Text";
  const button = (
    active: boolean,
    label: string,
    onClick: () => void,
    icon: React.ReactNode,
  ) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={clsx(
        "flex h-8 w-8 items-center justify-center rounded-md",
        active
          ? "bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300"
          : "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800",
      )}
    >
      {icon}
    </button>
  );
  return createPortal(
    <div
      data-format-toolbar
      role="toolbar"
      aria-label="Format text"
      style={{ top, left }}
      onMouseDown={(event) => event.preventDefault()}
      className="fixed z-50 flex items-center gap-0.5 rounded-lg border border-slate-200 bg-white p-1 shadow-lg shadow-slate-900/10 dark:border-slate-700 dark:bg-slate-900"
    >
      {kind && (
        <div className="relative">
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setTurnOpen((v) => !v)}
            className="flex h-8 items-center gap-1 rounded-md px-2 text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
            aria-haspopup="menu"
            aria-expanded={turnOpen}
          >
            {current}
            <ChevronDown size={13} />
          </button>
          {turnOpen && (
            <div className="absolute left-0 top-full z-10 mt-1 w-44 rounded-lg border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-700 dark:bg-slate-900">
              {TURN_INTO.map((option) => (
                <button
                  key={option.kind}
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setTurnOpen(false);
                    onTurnInto(option.kind);
                  }}
                  className={clsx(
                    "flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800",
                    option.kind === kind ? "text-indigo-600 dark:text-indigo-300" : "text-slate-700 dark:text-slate-200",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {kind && <span className="mx-0.5 h-5 w-px bg-slate-200 dark:bg-slate-700" />}
      {button(marks.bold, `Bold (${mod}B)`, () => onToggle("bold"), <Bold size={15} />)}
      {button(marks.italic, `Italic (${mod}I)`, () => onToggle("italic"), <Italic size={15} />)}
      {button(marks.strike, `Strikethrough (${mod}Shift+S)`, () => onToggle("strike"), <Strikethrough size={15} />)}
      {button(marks.code, `Inline code (${mod}E)`, () => onToggle("code"), <Code2 size={15} />)}
      {button(Boolean(marks.link), `Link (${mod}K)`, onLink, <Link2 size={15} />)}
    </div>,
    document.body,
  );
}

/** The small form that edits a link's address. */
export function LinkEditor({
  anchor,
  initial,
  onSubmit,
  onRemove,
  onClose,
  error,
}: {
  anchor: DOMRect;
  initial: string;
  onSubmit: (href: string) => void;
  onRemove: (() => void) | null;
  onClose: () => void;
  error: string | null;
}) {
  const [value, setValue] = React.useState(initial);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const width = 340;
  const pos = placement(anchor, width, 90);
  React.useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  React.useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!(event.target as HTMLElement | null)?.closest("[data-link-editor]")) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);
  return createPortal(
    <div
      data-link-editor
      style={{ top: pos.top, left: pos.left, width }}
      className="fixed z-50 rounded-lg border border-slate-200 bg-white p-2 shadow-lg shadow-slate-900/10 dark:border-slate-700 dark:bg-slate-900"
    >
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(value);
        }}
      >
        <input
          ref={inputRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
          placeholder="Paste a link, or type a web address"
          aria-label="Link address"
          className="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-950"
        />
        <button
          type="submit"
          className="rounded-md bg-indigo-600 px-2.5 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 dark:bg-indigo-500 dark:hover:bg-indigo-600"
        >
          Link
        </button>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            title="Remove link"
            aria-label="Remove link"
            className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            <Unlink size={15} />
          </button>
        )}
      </form>
      {error && <p className="mt-1.5 px-0.5 text-xs text-rose-600 dark:text-rose-400">{error}</p>}
    </div>,
    document.body,
  );
}

/** The menu a block's handle opens: turn into, duplicate, move, copy, delete. */
export function BlockMenu({
  anchor,
  kind,
  canMoveUp,
  canMoveDown,
  onTurnInto,
  onDuplicate,
  onMoveUp,
  onMoveDown,
  onCopy,
  onDelete,
  onClose,
}: {
  anchor: DOMRect;
  kind: BlockKind | null;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onTurnInto: (kind: BlockKind) => void;
  onDuplicate: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const triggerRef = React.useRef<HTMLElement>(null);
  const markInside = useCloseOnPressOutside(true, onClose, triggerRef);
  useCloseOnEscape(true, onClose);
  const [showTurn, setShowTurn] = React.useState(false);
  const width = 240;
  const pos = placement(anchor, width, showTurn ? 440 : 250);
  const item = (label: string, icon: React.ReactNode, onClick: () => void, hint?: string, danger?: boolean, disabled?: boolean) => (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={clsx(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm disabled:opacity-40",
        danger
          ? "text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10"
          : "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800",
      )}
    >
      <span className="flex h-4 w-4 items-center justify-center">{icon}</span>
      <span className="flex-1">{label}</span>
      {hint && <span className="text-xs text-slate-400 dark:text-slate-500">{hint}</span>}
    </button>
  );
  return createPortal(
    <div
      role="menu"
      aria-label="Block options"
      onMouseDownCapture={markInside}
      style={{ top: pos.top, left: pos.left, width }}
      className="fixed z-50 max-h-[80vh] overflow-y-auto rounded-xl border border-slate-200 bg-white p-1 shadow-xl shadow-slate-900/10 dark:border-slate-700 dark:bg-slate-900"
    >
      {kind && item("Turn into", <TextIcon size={14} />, () => setShowTurn((v) => !v), showTurn ? "▾" : "▸")}
      {kind && showTurn && (
        <div className="mb-1 ml-6 border-l border-slate-100 pl-1 dark:border-slate-800">
          {TURN_INTO.map((option) => (
            <button
              key={option.kind}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onTurnInto(option.kind)}
              className={clsx(
                "flex w-full items-center rounded-md px-2 py-1 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800",
                option.kind === kind ? "text-indigo-600 dark:text-indigo-300" : "text-slate-700 dark:text-slate-200",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
      {item("Duplicate", <CopyPlus size={14} />, onDuplicate, `${mod}D`)}
      {item("Move up", <MoveUp size={14} />, onMoveUp, `${mod}Shift+↑`, false, !canMoveUp)}
      {item("Move down", <MoveDown size={14} />, onMoveDown, `${mod}Shift+↓`, false, !canMoveDown)}
      {item("Copy as Markdown", <Copy size={14} />, onCopy)}
      <div className="my-1 h-px bg-slate-100 dark:bg-slate-800" />
      {item("Delete", <Trash2 size={14} />, onDelete, "Del", true)}
    </div>,
    document.body,
  );
}
