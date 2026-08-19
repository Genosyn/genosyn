import React from "react";
import { TokenKind, highlight } from "./highlight";

/**
 * The colour layer that sits underneath the editor's textarea.
 *
 * It is decoration and nothing else: it never receives events, never reports a
 * size, and never learns what the caret is doing. The only thing it owes the
 * textarea is exact alignment, which is why the typography lives in
 * {@link CODE_TYPOGRAPHY} and is applied to both elements from the same
 * constant, and why nothing here sets a weight, a style, or a letter-spacing —
 * an italic comment in a font whose italic face is a hair wider would drag the
 * rest of the line out of register.
 */

/** Applied verbatim to both the textarea and this overlay. */
export const CODE_TYPOGRAPHY = "px-3 py-3 font-mono text-xs leading-5";

/** `leading-5` in pixels, for anything that scrolls to a line number. */
export const CODE_LINE_HEIGHT_PX = 20;

/**
 * Tokenizing is linear but not free, and past a certain size the editor should
 * stay responsive rather than pretty. Callers check this before switching the
 * textarea's own text to transparent.
 */
export const MAX_HIGHLIGHT_CHARS = 120_000;

const KIND_CLASS: Record<TokenKind, string> = {
  plain: "",
  keyword: "text-violet-600 dark:text-violet-300",
  string: "text-emerald-700 dark:text-emerald-400",
  comment: "text-slate-400 dark:text-slate-500",
  number: "text-amber-600 dark:text-amber-400",
  tag: "text-rose-600 dark:text-rose-400",
  attr: "text-sky-700 dark:text-sky-300",
  punctuation: "text-slate-400 dark:text-slate-500",
};

export const HighlightedCode = React.forwardRef<
  HTMLPreElement,
  { source: string; language: string }
>(function HighlightedCode({ source, language }, ref) {
  const tokens = React.useMemo(() => highlight(source, language), [source, language]);

  return (
    <pre
      ref={ref}
      aria-hidden
      // Absolute with only `left`/`top` set so the box shrink-wraps its longest
      // line: a width would wrap the text and break alignment immediately. The
      // parent clips, and the scroll offset arrives as a transform rather than a
      // scrollTop, because a scroll container's maximum offset depends on its
      // scrollbars and the textarea's do not match this element's.
      className={
        "pointer-events-none absolute left-0 top-0 m-0 select-none whitespace-pre text-slate-800 dark:text-slate-100 " +
        CODE_TYPOGRAPHY
      }
    >
      {tokens.map((token, index) => (
        <span key={index} className={KIND_CLASS[token.kind]}>
          {token.text}
        </span>
      ))}
      {/* A textarea shows a final empty row for a trailing newline and a <pre>
        does not, so the overlay would run one line short at the bottom of the
        file. One extra newline makes the two agree in every case. */}
      {"\n"}
    </pre>
  );
});
