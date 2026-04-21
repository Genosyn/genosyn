import React from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  Bold,
  Code2,
  Columns2,
  Eye,
  Heading1,
  Heading2,
  Italic,
  Link2,
  List,
  ListOrdered,
  Pencil,
  Quote,
} from "lucide-react";
import { Textarea } from "./ui/Textarea";
import { clsx } from "./ui/clsx";
import { useDialog } from "./ui/Dialog";

/**
 * Markdown editor with three view modes (edit / split / preview), a minimal
 * formatting toolbar, and ⌘S save. Kept dependency-light — marked + DOMPurify
 * for preview, plain <textarea> for input. Monaco is overkill for the sort
 * of prose bodies we edit here (Soul, skill, routine).
 */
export type MarkdownEditorProps = {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  /** Fires on ⌘/Ctrl+S. Parent can trigger save. */
  onSave?: () => void;
};

type Mode = "edit" | "split" | "preview";

export function MarkdownEditor({ value, onChange, rows = 16, onSave }: MarkdownEditorProps) {
  const [mode, setMode] = React.useState<Mode>("split");
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const dialog = useDialog();

  const html = React.useMemo(() => {
    const raw = marked.parse(value || "", { async: false }) as string;
    return DOMPurify.sanitize(raw);
  }, [value]);

  const wrap = React.useCallback(
    (before: string, after: string = before) => {
      const ta = textareaRef.current;
      if (!ta) return;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const selected = value.slice(start, end);
      const next = value.slice(0, start) + before + selected + after + value.slice(end);
      onChange(next);
      // Restore caret / selection after React re-renders.
      requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(start + before.length, end + before.length);
      });
    },
    [value, onChange],
  );

  const prefixLine = React.useCallback(
    (prefix: string) => {
      const ta = textareaRef.current;
      if (!ta) return;
      const start = ta.selectionStart;
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      const next = value.slice(0, lineStart) + prefix + value.slice(lineStart);
      onChange(next);
      requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(start + prefix.length, start + prefix.length);
      });
    },
    [value, onChange],
  );

  const insertLink = React.useCallback(async () => {
    const url = await dialog.prompt({
      title: "Insert link",
      placeholder: "https://example.com",
      confirmLabel: "Insert",
      validate: (v) => {
        if (!v) return "Required";
        if (!/^(https?:\/\/|mailto:|\/|#)/.test(v)) return "Must start with http(s)://, /, #, or mailto:";
        return null;
      },
    });
    if (!url) return;
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = value.slice(start, end) || "text";
    const md = `[${selected}](${url})`;
    const next = value.slice(0, start) + md + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      ta.focus();
      const caret = start + md.length;
      ta.setSelectionRange(caret, caret);
    });
  }, [value, onChange, dialog]);

  const onKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        onSave?.();
        return;
      }
      if (meta && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        wrap("**");
        return;
      }
      if (meta && (e.key === "i" || e.key === "I")) {
        e.preventDefault();
        wrap("_");
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        const ta = e.currentTarget;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const next = value.slice(0, start) + "  " + value.slice(end);
        onChange(next);
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = start + 2;
        });
      }
    },
    [onSave, onChange, value, wrap],
  );

  const lines = value ? value.split("\n").length : 0;
  const chars = value.length;

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 p-2 dark:border-slate-800">
        <div className="flex items-center gap-1">
          <ToolbarButton title="Heading 1" onClick={() => prefixLine("# ")}>
            <Heading1 size={14} />
          </ToolbarButton>
          <ToolbarButton title="Heading 2" onClick={() => prefixLine("## ")}>
            <Heading2 size={14} />
          </ToolbarButton>
          <ToolbarDivider />
          <ToolbarButton title="Bold (⌘B)" onClick={() => wrap("**")}>
            <Bold size={14} />
          </ToolbarButton>
          <ToolbarButton title="Italic (⌘I)" onClick={() => wrap("_")}>
            <Italic size={14} />
          </ToolbarButton>
          <ToolbarButton title="Inline code" onClick={() => wrap("`")}>
            <Code2 size={14} />
          </ToolbarButton>
          <ToolbarDivider />
          <ToolbarButton title="Bulleted list" onClick={() => prefixLine("- ")}>
            <List size={14} />
          </ToolbarButton>
          <ToolbarButton title="Numbered list" onClick={() => prefixLine("1. ")}>
            <ListOrdered size={14} />
          </ToolbarButton>
          <ToolbarButton title="Quote" onClick={() => prefixLine("> ")}>
            <Quote size={14} />
          </ToolbarButton>
          <ToolbarButton title="Link" onClick={insertLink}>
            <Link2 size={14} />
          </ToolbarButton>
        </div>
        <div className="flex items-center gap-1">
          <ModeButton current={mode} mode="edit" onClick={setMode}>
            <Pencil size={12} /> Edit
          </ModeButton>
          <ModeButton current={mode} mode="split" onClick={setMode}>
            <Columns2 size={12} /> Split
          </ModeButton>
          <ModeButton current={mode} mode="preview" onClick={setMode}>
            <Eye size={12} /> Preview
          </ModeButton>
        </div>
      </div>
      <div className={mode === "split" ? "grid grid-cols-2 divide-x divide-slate-100 dark:divide-slate-800" : ""}>
        {mode !== "preview" && (
          <Textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            rows={rows}
            spellCheck={false}
            className="rounded-none border-0 font-mono text-[13px] leading-relaxed shadow-none focus:ring-0"
          />
        )}
        {mode !== "edit" && (
          <div
            className="prose prose-slate max-w-none overflow-y-auto p-4 text-sm dark:prose-invert"
            style={{ maxHeight: `${rows * 1.6}rem` }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </div>
      <div className="flex items-center justify-between border-t border-slate-100 px-3 py-1.5 text-[11px] text-slate-400 dark:border-slate-800 dark:text-slate-500">
        <span>Markdown · ⌘B bold · ⌘I italic · Tab indent</span>
        <span>
          {lines} {lines === 1 ? "line" : "lines"} · {chars} {chars === 1 ? "char" : "chars"}
        </span>
      </div>
    </div>
  );
}

function ToolbarButton({
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
      className="rounded p-1.5 text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100"
    >
      {children}
    </button>
  );
}

function ToolbarDivider() {
  return <span className="mx-1 h-4 w-px bg-slate-200 dark:bg-slate-700" />;
}

function ModeButton({
  current,
  mode,
  onClick,
  children,
}: {
  current: Mode;
  mode: Mode;
  onClick: (m: Mode) => void;
  children: React.ReactNode;
}) {
  const active = current === mode;
  return (
    <button
      type="button"
      onClick={() => onClick(mode)}
      className={clsx(
        "flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium",
        active
          ? "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100"
          : "text-slate-500 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800",
      )}
    >
      {children}
    </button>
  );
}
