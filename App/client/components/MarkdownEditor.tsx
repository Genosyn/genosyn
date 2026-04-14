import React from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { Textarea } from "./ui/Textarea";
import { clsx } from "./ui/clsx";

export function MarkdownEditor({
  value,
  onChange,
  rows = 16,
}: {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
}) {
  const [tab, setTab] = React.useState<"edit" | "preview">("edit");
  const html = React.useMemo(() => {
    const raw = marked.parse(value || "", { async: false }) as string;
    return DOMPurify.sanitize(raw);
  }, [value]);

  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <div className="flex items-center gap-1 border-b border-slate-100 p-2">
        {(["edit", "preview"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={clsx(
              "rounded-md px-3 py-1 text-sm capitalize",
              tab === t ? "bg-slate-100 text-slate-900" : "text-slate-500 hover:bg-slate-50",
            )}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "edit" ? (
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={rows}
          className="border-0 shadow-none focus:ring-0"
        />
      ) : (
        <div
          className="prose prose-slate max-w-none p-4 text-sm"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  );
}
