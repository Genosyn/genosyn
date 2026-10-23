import React from "react";
import { Book, FileText } from "lucide-react";
import { clsx } from "../ui/clsx";
import { useCloseOnEscape, useCloseOnPressOutside } from "../ui/Menu";

/** A page's or notebook's icon: the emoji someone chose, or a quiet default. */
export function NoteIcon({
  icon,
  kind = "page",
  size = 14,
  className,
}: {
  icon: string;
  kind?: "page" | "notebook";
  size?: number;
  className?: string;
}) {
  if (icon) {
    return (
      <span aria-hidden className={clsx("leading-none", className)} style={{ fontSize: size }}>
        {icon}
      </span>
    );
  }
  const Icon = kind === "notebook" ? Book : FileText;
  return <Icon aria-hidden size={size} className={clsx("text-slate-400 dark:text-slate-500", className)} />;
}

const PAGE_ICONS = [
  "📄", "📝", "📌", "📚", "🗒️", "📁", "🗂️", "📋", "✨", "💡", "🚀", "🧠",
  "🎯", "🔥", "📊", "📈", "🛠️", "🧪", "💬", "🌱", "⭐", "✅", "❤️", "🧩",
  "📣", "🗓️", "🔒", "🧭", "🏁", "⚙️", "🤝", "💼", "🏷️", "🔍", "🧾", "📦",
];

const NOTEBOOK_ICONS = [
  "📚", "📓", "📔", "📕", "📗", "📘", "📙", "📒", "🗂️", "📁", "📂", "🛠️",
  "🚀", "💡", "🎯", "✨", "🧭", "🏢", "💼", "🤝",
];

/**
 * Pick an emoji for a page or notebook. Anchored under its trigger; closes
 * on a choice, Escape, or a press outside.
 */
export function IconPicker({
  current,
  kind = "page",
  onPick,
  onRemove,
  onClose,
  triggerRef,
}: {
  current: string;
  kind?: "page" | "notebook";
  onPick: (icon: string) => void;
  onRemove: () => void;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLElement>;
}) {
  const [custom, setCustom] = React.useState("");
  const markInside = useCloseOnPressOutside(true, onClose, triggerRef);
  useCloseOnEscape(true, onClose);
  const icons = kind === "notebook" ? NOTEBOOK_ICONS : PAGE_ICONS;
  return (
    <div
      role="dialog"
      aria-label="Choose an icon"
      onMouseDownCapture={markInside}
      className="absolute left-0 top-full z-40 mt-2 w-[19rem] rounded-xl border border-slate-200 bg-white p-3 shadow-xl dark:border-slate-700 dark:bg-slate-900"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Icon</span>
        {current && (
          <button
            type="button"
            onClick={onRemove}
            className="rounded px-1.5 py-0.5 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          >
            Remove
          </button>
        )}
      </div>
      <div className="grid grid-cols-8 gap-0.5">
        {icons.map((emoji) => (
          <button
            key={emoji}
            type="button"
            onClick={() => onPick(emoji)}
            aria-label={`Use ${emoji}`}
            className={clsx(
              "flex h-8 w-8 items-center justify-center rounded-md text-xl transition",
              emoji === current ? "bg-indigo-100 dark:bg-indigo-500/20" : "hover:bg-slate-100 dark:hover:bg-slate-800",
            )}
          >
            {emoji}
          </button>
        ))}
      </div>
      <form
        className="mt-3 flex items-center gap-2 border-t border-slate-100 pt-3 dark:border-slate-800"
        onSubmit={(event) => {
          event.preventDefault();
          const value = custom.trim();
          if (value) onPick(Array.from(value).slice(0, 4).join(""));
        }}
      >
        <input
          value={custom}
          onChange={(event) => setCustom(event.target.value)}
          placeholder="Or paste any emoji"
          aria-label="Custom icon"
          maxLength={8}
          className="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-sm focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:bg-slate-950"
        />
        <button
          type="submit"
          disabled={!custom.trim()}
          className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-40 dark:bg-indigo-500"
        >
          Use
        </button>
      </form>
    </div>
  );
}

/** "2m ago", "3h ago", "4d ago", then a date. */
export function formatRelative(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "just now";
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(ts).toLocaleDateString();
}
