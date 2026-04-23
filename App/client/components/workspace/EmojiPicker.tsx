import React from "react";

/**
 * Tiny emoji picker — a curated grid, no fuzzy search, no dependency. We
 * keep the list short (~80 emoji) so users can scan a recognizable palette
 * without fighting an autocomplete. Users who want a specific emoji that
 * isn't in the grid can paste a unicode character straight into the input.
 */

const CATEGORIES: { label: string; emoji: string[] }[] = [
  {
    label: "Smileys",
    emoji: [
      "😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣", "😊", "😇",
      "🙂", "🙃", "😉", "😌", "😍", "🥰", "😘", "😗", "😙", "😚",
      "😋", "😛", "😝", "😜", "🤪", "🤨", "🧐", "🤓", "😎", "🥳",
    ],
  },
  {
    label: "Reactions",
    emoji: ["👍", "👎", "👏", "🙌", "🙏", "👀", "💪", "✅", "❌", "⚠️", "🔥", "💯", "✨", "🎉", "💡", "⭐"],
  },
  {
    label: "Hearts",
    emoji: ["❤️", "🧡", "💛", "💚", "💙", "💜", "🤍", "🖤", "💖", "💘", "💝"],
  },
  {
    label: "Work",
    emoji: ["📌", "📎", "📝", "📅", "📆", "📊", "📈", "📉", "💼", "🖥️", "⌨️", "🖱️", "🧠", "🚀", "🛠️", "🧪", "🧰", "📣", "🔒", "🔑"],
  },
  {
    label: "Food",
    emoji: ["☕", "🍵", "🍺", "🍷", "🍕", "🍔", "🌮", "🍜", "🍣", "🍎", "🍪", "🍫"],
  },
];

const ALL = CATEGORIES.flatMap((c) => c.emoji.map((e) => ({ e, label: c.label })));

export function EmojiPicker({
  onPick,
  onClose,
}: {
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = React.useState("");
  const filtered = React.useMemo(() => {
    if (!q.trim()) return ALL;
    const t = q.toLowerCase();
    return ALL.filter((x) => x.label.toLowerCase().includes(t));
  }, [q]);

  return (
    <div
      className="absolute bottom-full right-0 z-30 mb-2 w-72 rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="border-b border-slate-100 p-2 dark:border-slate-800">
        <input
          type="text"
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter by category"
          className="w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-sm text-slate-800 outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        />
      </div>
      <div className="max-h-64 overflow-y-auto p-1">
        {CATEGORIES.map((cat) => {
          const visible = cat.emoji.filter((e) =>
            filtered.some((f) => f.e === e && f.label === cat.label),
          );
          if (visible.length === 0) return null;
          return (
            <div key={cat.label} className="px-2 py-1">
              <div className="py-1 text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
                {cat.label}
              </div>
              <div className="grid grid-cols-8 gap-1">
                {visible.map((e) => (
                  <button
                    key={e}
                    onClick={() => {
                      onPick(e);
                      onClose();
                    }}
                    className="h-7 w-7 rounded text-lg hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div className="py-6 text-center text-xs text-slate-500 dark:text-slate-400">
            No matches.
          </div>
        )}
      </div>
    </div>
  );
}
