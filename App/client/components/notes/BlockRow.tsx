import React from "react";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Copy,
  GripVertical,
  ImageOff,
  Info,
  Lightbulb,
  MessageSquareWarning,
  OctagonAlert,
  Pencil,
  Plus,
  type LucideIcon,
} from "lucide-react";
import { clsx } from "../ui/clsx";
import { useCloseOnEscape, useCloseOnPressOutside } from "../ui/Menu";
import { Select } from "../ui/Select";
import type { Run } from "../../lib/noteInline";
import { CALLOUT_KINDS, type Block, type CalloutKind, parseTableSource } from "../../lib/noteMarkdown";
import { ordinalLabel } from "../../lib/noteBlocks";
import { parseInline } from "../../lib/noteInline";
import { EditableText } from "./EditableText";
import type { EditorController } from "./editorController";
import {
  CALLOUT_STYLES,
  CODE_LANGUAGES,
  bulletClass,
  gutterTop,
  placeholderFor,
  rowSpacing,
  textClass,
} from "./blockStyles";
import { normalizeHref } from "../../lib/noteInline";

/** Children sit 24px in per level, as in Notion. */
export const INDENT_PX = 24;

const CALLOUT_ICONS: Record<CalloutKind, LucideIcon> = {
  note: Info,
  tip: Lightbulb,
  important: MessageSquareWarning,
  warning: AlertTriangle,
  caution: OctagonAlert,
};

export type BlockRowProps = {
  block: Block;
  previous: Block | undefined;
  ordinal: number | undefined;
  selected: boolean;
  focused: boolean;
  onlyBlock: boolean;
  /** A toggle with nothing inside shows a way to add the first block. */
  emptyToggle: boolean;
  editingSource: boolean;
  ctrl: EditorController;
};

export const BlockRow = React.memo(function BlockRow({
  block,
  previous,
  ordinal,
  selected,
  focused,
  onlyBlock,
  emptyToggle,
  editingSource,
  ctrl,
}: BlockRowProps) {
  const indent = block.depth * INDENT_PX;
  return (
    <div
      data-block-row={block.id}
      data-block-type={block.type}
      className={clsx("group/block relative", rowSpacing(block, previous))}
    >
      {/* Indentation is per level, so it is the one truly dynamic style here. */}
      <div className="relative" style={{ paddingLeft: indent }}>
        {!ctrl.readOnly && <Gutter block={block} focused={focused} indent={indent} ctrl={ctrl} />}
        <div
          className={clsx(
            "relative flex min-w-0 items-start rounded-[4px] transition-colors",
            selected && "bg-indigo-500/[0.14] dark:bg-indigo-400/20",
          )}
        >
          <BlockBody
            block={block}
            ordinal={ordinal}
            focused={focused}
            onlyBlock={onlyBlock}
            editingSource={editingSource}
            ctrl={ctrl}
          />
        </div>
      </div>
      {emptyToggle && !ctrl.readOnly && (
        <div style={{ paddingLeft: indent + 26 }}>
          <button
            type="button"
            onClick={() => ctrl.addChild(block.id)}
            className="rounded px-1 py-0.5 text-left text-sm text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-300"
          >
            Empty toggle. Click to add a block inside.
          </button>
        </div>
      )}
    </div>
  );
});

function Gutter({
  block,
  focused,
  indent,
  ctrl,
}: {
  block: Block;
  focused: boolean;
  indent: number;
  ctrl: EditorController;
}) {
  return (
    <div
      contentEditable={false}
      // The gutter hangs in the page margin, left of wherever this block's
      // indentation puts its text; on a phone only the handle shows, closer in.
      style={{ "--indent": `${indent}px` } as React.CSSProperties}
      className={clsx(
        "absolute left-[calc(var(--indent)-22px)] z-10 flex select-none items-center opacity-0 transition-opacity group-hover/block:opacity-100 sm:left-[calc(var(--indent)-46px)]",
        gutterTop(block),
        focused && "[@media(hover:none)]:opacity-100",
      )}
    >
      <button
        type="button"
        tabIndex={-1}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => ctrl.gutterAdd(block.id, event)}
        title="Click to add a block below · Alt-click to add above"
        aria-label="Add a block"
        className="hidden h-6 w-[22px] items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600 sm:flex dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-300"
      >
        <Plus size={16} strokeWidth={2} />
      </button>
      <button
        type="button"
        tabIndex={-1}
        onPointerDown={(event) => ctrl.gutterPointerDown(block.id, event)}
        title="Drag to move · Click to open the block menu"
        aria-label="Drag to move, or click for block options"
        data-block-grip={block.id}
        className="flex h-6 w-[18px] cursor-grab touch-none items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600 active:cursor-grabbing dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-300"
      >
        <GripVertical size={16} />
      </button>
    </div>
  );
}

function BlockBody({
  block,
  ordinal,
  focused,
  onlyBlock,
  editingSource,
  ctrl,
}: {
  block: Block;
  ordinal: number | undefined;
  focused: boolean;
  onlyBlock: boolean;
  editingSource: boolean;
  ctrl: EditorController;
}) {
  const placeholder = ctrl.readOnly ? null : placeholderFor(block, focused, onlyBlock);
  const rich = (extra?: string) => (
    <EditableText
      blockId={block.id}
      runs={block.runs}
      className={clsx(textClass(block), extra)}
      placeholder={placeholder}
      ctrl={ctrl}
    />
  );

  switch (block.type) {
    case "paragraph":
    case "heading":
      return <div className="flex min-w-0 flex-1 px-0.5 py-[3px]">{rich()}</div>;

    case "bulleted":
      return (
        <div className="flex min-w-0 flex-1 py-[3px]">
          <span aria-hidden className="flex h-[1.6em] w-6 shrink-0 items-center justify-center text-slate-800 dark:text-slate-200">
            <span className={clsx("h-[6px] w-[6px]", bulletClass(block.depth))} />
          </span>
          {rich()}
        </div>
      );

    case "numbered":
      return (
        <div className="flex min-w-0 flex-1 py-[3px]">
          <span
            aria-hidden
            className="min-w-6 shrink-0 select-none pr-1.5 text-right text-base leading-[1.6] tabular-nums text-slate-800 dark:text-slate-200"
          >
            {ordinalLabel(ordinal ?? 1, block.depth)}
          </span>
          {rich()}
        </div>
      );

    case "todo":
      return (
        <div className="flex min-w-0 flex-1 py-[3px]">
          <span className="flex h-[1.6em] w-6 shrink-0 items-center justify-center">
            <button
              type="button"
              role="checkbox"
              aria-checked={Boolean(block.checked)}
              aria-label={block.checked ? "Mark as not done" : "Mark as done"}
              disabled={ctrl.readOnly}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => ctrl.toggleTodo(block.id)}
              className={clsx(
                "flex h-4 w-4 items-center justify-center rounded-[3px] border transition-colors",
                block.checked
                  ? "border-indigo-600 bg-indigo-600 text-white dark:border-indigo-500 dark:bg-indigo-500"
                  : "border-slate-400 bg-white hover:bg-slate-100 dark:border-slate-500 dark:bg-transparent dark:hover:bg-slate-800",
              )}
            >
              {block.checked && <Check size={12} strokeWidth={3} />}
            </button>
          </span>
          {rich()}
        </div>
      );

    case "toggle":
      return (
        <div className="flex min-w-0 flex-1 py-[3px]">
          <span className="flex h-[1.6em] w-6 shrink-0 items-center justify-center">
            <button
              type="button"
              aria-label={block.open ? "Collapse" : "Expand"}
              aria-expanded={Boolean(block.open)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => ctrl.toggleOpen(block.id)}
              className="flex h-5 w-5 items-center justify-center rounded text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              <ChevronRight size={16} className={clsx("transition-transform", block.open && "rotate-90")} />
            </button>
          </span>
          {rich()}
        </div>
      );

    case "quote":
      return (
        <div className="my-1 flex min-w-0 flex-1 border-l-[3px] border-slate-800 py-[3px] pl-3.5 dark:border-slate-300">
          {rich()}
        </div>
      );

    case "callout":
      return <Callout block={block} placeholder={placeholder} ctrl={ctrl} />;

    case "code":
      return <CodeBlock block={block} ctrl={ctrl} />;

    case "divider":
      return (
        <div
          role="separator"
          className="w-full cursor-pointer py-2.5"
          onClick={(event) => ctrl.selectBlock(block.id, event.shiftKey)}
        >
          <div className="h-px w-full bg-slate-200 dark:bg-slate-700" />
        </div>
      );

    case "image":
      return <ImageBlock block={block} ctrl={ctrl} />;

    case "table":
      return editingSource ? (
        <SourceEditor block={block} ctrl={ctrl} label="Table source" done={() => ctrl.editSource(block.id, false)} />
      ) : (
        <TablePreview block={block} ctrl={ctrl} />
      );

    case "raw":
      return <SourceEditor block={block} ctrl={ctrl} label="Markdown" />;
  }
}

function Callout({
  block,
  placeholder,
  ctrl,
}: {
  block: Block;
  placeholder: string | null;
  ctrl: EditorController;
}) {
  const kind = block.kind ?? "tip";
  const style = CALLOUT_STYLES[kind];
  const Icon = CALLOUT_ICONS[kind];
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const markInside = useCloseOnPressOutside(open, () => setOpen(false), triggerRef);
  useCloseOnEscape(open, () => setOpen(false));
  return (
    <div className={clsx("my-1 flex min-w-0 flex-1 gap-2 rounded-lg px-3 py-3", style.box)}>
      <div className="relative shrink-0" onMouseDownCapture={markInside}>
        <button
          ref={triggerRef}
          type="button"
          disabled={ctrl.readOnly}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setOpen((v) => !v)}
          aria-label={`${style.label} callout — change style`}
          title="Change callout style"
          className={clsx("flex h-[1.6em] w-6 items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/10", style.icon)}
        >
          <Icon size={18} />
        </button>
        {open && (
          <div className="absolute left-0 top-full z-30 mt-1 w-44 rounded-lg border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-700 dark:bg-slate-900">
            {CALLOUT_KINDS.map((option) => {
              const OptionIcon = CALLOUT_ICONS[option];
              return (
                <button
                  key={option}
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setOpen(false);
                    ctrl.setCalloutKind(block.id, option);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  <OptionIcon size={15} className={CALLOUT_STYLES[option].icon} />
                  <span className="flex-1">{CALLOUT_STYLES[option].label}</span>
                  {option === kind && <Check size={13} className="text-indigo-600 dark:text-indigo-300" />}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <EditableText
        blockId={block.id}
        runs={block.runs}
        className={textClass(block)}
        placeholder={placeholder}
        ctrl={ctrl}
      />
    </div>
  );
}

function CodeBlock({ block, ctrl }: { block: Block; ctrl: EditorController }) {
  const lang = block.lang ?? "";
  const known = CODE_LANGUAGES.some((l) => l.id === lang);
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const handle = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(handle);
  }, [copied]);
  return (
    <div className="group/code relative my-1 min-w-0 flex-1 rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/70">
      <div
        contentEditable={false}
        className="flex items-center justify-between gap-2 px-3 pt-2 text-xs text-slate-500 dark:text-slate-400"
      >
        <Select
          value={lang}
          disabled={ctrl.readOnly}
          onChange={(event) => ctrl.setCodeLang(block.id, event.target.value)}
          aria-label="Code language"
          searchPlaceholder="Search languages…"
          emptyMessage="No matching language"
          containerClassName="-ml-1 w-36"
          className="!rounded !border-0 !bg-transparent py-0.5 !pl-1 !pr-7 !text-xs !text-slate-500 !shadow-none hover:!bg-slate-200/60 focus:!ring-1 focus:!ring-indigo-400 dark:!bg-transparent dark:!text-slate-400 dark:hover:!bg-slate-800"
        >
          {!known && <option value={lang}>{lang}</option>}
          {CODE_LANGUAGES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </Select>
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            ctrl.copyText(block.text);
            setCopied(true);
          }}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 opacity-0 transition-opacity hover:bg-slate-200/60 group-hover/code:opacity-100 focus-visible:opacity-100 dark:hover:bg-slate-800 [@media(hover:none)]:opacity-100"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <EditableText
        blockId={block.id}
        text={block.text}
        plain
        label={`Code${lang ? ` (${lang})` : ""}`}
        className="px-4 pb-3 pt-1.5 font-mono text-[13px] leading-[1.65] text-slate-800 [tab-size:2] dark:text-slate-100"
        ctrl={ctrl}
      />
    </div>
  );
}

function SourceEditor({
  block,
  ctrl,
  label,
  done,
}: {
  block: Block;
  ctrl: EditorController;
  label: string;
  done?: () => void;
}) {
  return (
    <div className="group/raw relative my-1 min-w-0 flex-1 rounded-lg border border-dashed border-slate-300 bg-slate-50/60 dark:border-slate-700 dark:bg-slate-900/40">
      <div
        contentEditable={false}
        className="text-xs flex items-center justify-between px-3 pt-1.5 font-medium text-slate-500 dark:text-slate-400"
      >
        <span title="Kept exactly as written in the page's Markdown">{label}</span>
        {done && (
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={done}
            className="rounded px-1.5 py-0.5 normal-case tracking-normal hover:bg-slate-200/60 dark:hover:bg-slate-800"
          >
            Done
          </button>
        )}
      </div>
      <EditableText
        blockId={block.id}
        text={block.text}
        plain
        label={label}
        className="px-3 pb-2 pt-1 font-mono text-[13px] leading-[1.6] text-slate-700 dark:text-slate-200"
        ctrl={ctrl}
      />
    </div>
  );
}

/** Runs drawn read-only, for a table preview's cells. */
export function RunsView({ runs }: { runs: readonly Run[] }) {
  return (
    <>
      {runs.map((run, i) => {
        let node: React.ReactNode = run.text;
        if (run.code) node = <code className="rounded bg-slate-100 px-1 font-mono text-[0.85em] dark:bg-slate-800">{node}</code>;
        if (run.italic) node = <em>{node}</em>;
        if (run.bold) node = <strong className="font-semibold">{node}</strong>;
        if (run.strike) node = <s>{node}</s>;
        if (run.href) {
          node = (
            <a href={run.href} target="_blank" rel="noreferrer noopener" className="text-indigo-600 underline underline-offset-2 dark:text-indigo-300">
              {node}
            </a>
          );
        }
        return <React.Fragment key={i}>{node}</React.Fragment>;
      })}
    </>
  );
}

function TablePreview({ block, ctrl }: { block: Block; ctrl: EditorController }) {
  const table = React.useMemo(() => parseTableSource(block.text), [block.text]);
  if (!table) return <SourceEditor block={block} ctrl={ctrl} label="Table source" />;
  const alignClass = (i: number) =>
    table.align[i] === "center" ? "text-center" : table.align[i] === "right" ? "text-right" : "text-left";
  return (
    <div className="group/table relative my-1 min-w-0 flex-1">
      <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-slate-50 dark:bg-slate-900/60">
            <tr>
              {table.header.map((cell, i) => (
                <th
                  key={i}
                  className={clsx(
                    "border-b border-slate-200 px-3 py-2 font-semibold text-slate-700 dark:border-slate-700 dark:text-slate-200",
                    alignClass(i),
                  )}
                >
                  <RunsView runs={parseInline(cell)} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, r) => (
              <tr key={r} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                {row.map((cell, i) => (
                  <td key={i} className={clsx("px-3 py-2 align-top text-slate-700 dark:text-slate-300", alignClass(i))}>
                    <RunsView runs={parseInline(cell)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!ctrl.readOnly && (
        <button
          type="button"
          onClick={() => ctrl.editSource(block.id, true)}
          className="absolute right-2 top-2 flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 opacity-0 shadow-sm transition-opacity hover:bg-slate-50 group-hover/table:opacity-100 focus-visible:opacity-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 [@media(hover:none)]:opacity-100"
        >
          <Pencil size={12} /> Edit table
        </button>
      )}
    </div>
  );
}

function ImageBlock({ block, ctrl }: { block: Block; ctrl: EditorController }) {
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => setFailed(false), [block.src]);
  if (!block.src) return <ImageUrlForm blockId={block.id} ctrl={ctrl} />;
  return (
    <figure className="my-1 min-w-0 flex-1">
      {failed ? (
        <div className="flex items-center gap-2 rounded-lg border border-dashed border-slate-300 px-4 py-6 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
          <ImageOff size={16} />
          <span className="min-w-0 truncate">Couldn&apos;t load {block.src}</span>
        </div>
      ) : (
        <img
          src={block.src}
          alt={block.alt ?? ""}
          loading="lazy"
          onError={() => setFailed(true)}
          onClick={(event) => ctrl.selectBlock(block.id, event.shiftKey)}
          className="max-h-[560px] max-w-full cursor-pointer rounded-lg"
        />
      )}
      <input
        value={block.alt ?? ""}
        readOnly={ctrl.readOnly}
        onChange={(event) => ctrl.setImage(block.id, { alt: event.target.value })}
        placeholder={ctrl.readOnly ? "" : "Add a caption"}
        aria-label="Image caption"
        className="mt-1.5 w-full border-0 bg-transparent p-0 text-sm text-slate-500 placeholder:text-slate-300 focus:outline-none focus:ring-0 dark:text-slate-400 dark:placeholder:text-slate-600"
      />
    </figure>
  );
}

function ImageUrlForm({ blockId, ctrl }: { blockId: string; ctrl: EditorController }) {
  const [value, setValue] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    inputRef.current?.focus();
  }, []);
  function submit() {
    const href = normalizeHref(value);
    if (!href || (!/^https?:\/\//i.test(href) && !href.startsWith("/"))) {
      setError("Paste a link to an image, starting with https://");
      return;
    }
    ctrl.setImage(blockId, { src: href });
  }
  return (
    <div className="my-1 min-w-0 flex-1 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-900/60">
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <input
          ref={inputRef}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          placeholder="Paste an image link…"
          aria-label="Image link"
          className="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-950"
        />
        <button
          type="submit"
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 dark:bg-indigo-500 dark:hover:bg-indigo-600"
        >
          Embed image
        </button>
      </form>
      {error && <p className="mt-1.5 text-xs text-rose-600 dark:text-rose-400">{error}</p>}
    </div>
  );
}
