import React from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

/**
 * Markdown preview for a file that lives in a repository — the editor's preview
 * tab and the README on the overview page render through the same component so
 * a document cannot look like two different things depending on where you open
 * it.
 *
 * `breaks` is deliberately off, unlike the chat renderer: source files are
 * hard-wrapped, and treating every newline as a line break would shred a
 * paragraph that reads fine on GitHub. Sanitizing is not optional — the text is
 * whatever happens to be committed in the repository.
 */
export function MarkdownPreview({
  source,
  emptyMessage = "This file is empty.",
  className = "px-5 py-4",
}: {
  source: string;
  emptyMessage?: string;
  className?: string;
}) {
  const html = React.useMemo(() => {
    const raw = marked.parse(source ?? "", { async: false, gfm: true }) as string;
    return DOMPurify.sanitize(raw);
  }, [source]);

  if (!source.trim()) {
    return (
      <div className="px-6 py-14 text-center text-xs text-slate-500 dark:text-slate-400">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div
      className={"chat-md break-words text-sm " + className}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
