import React from "react";
import { clsx } from "../ui/clsx";
import { runsEqual, type Run } from "../../lib/noteInline";
import { renderPlain, renderRuns } from "./noteDom";
import type { EditorController } from "./editorController";

/**
 * One block's contenteditable. React never renders its children: the editor
 * draws runs into it only when they change from outside (formatting, undo,
 * a merge), and reads them back after the browser has edited it — so typing
 * never fights React and the caret never jumps.
 */
export const EditableText = React.memo(function EditableText({
  blockId,
  runs,
  text,
  plain,
  className,
  placeholder,
  ctrl,
  label,
}: {
  blockId: string;
  /** Rich text to show; omit for a plain-text block. */
  runs?: readonly Run[];
  /** Plain text to show (code, raw Markdown, a table's source). */
  text?: string;
  plain?: boolean;
  className?: string;
  placeholder?: string | null;
  ctrl: EditorController;
  label?: string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const shown = React.useRef<readonly Run[] | string | null>(null);

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (plain) {
      const value = text ?? "";
      if (shown.current !== value) {
        renderPlain(el, value);
        shown.current = value;
      }
      return;
    }
    const value = runs ?? [];
    const current = shown.current;
    if (current === value) return;
    if (current && typeof current !== "string" && runsEqual(current, value)) {
      shown.current = value;
      return;
    }
    renderRuns(el, value);
    shown.current = value;
  });

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    ctrl.register(blockId, {
      el,
      markShown: (value) => {
        shown.current = value;
      },
    });
    return () => ctrl.register(blockId, null);
  }, [blockId, ctrl]);

  const empty = plain ? !(text ?? "") : (runs ?? []).length === 0;

  return (
    <div
      ref={ref}
      role="textbox"
      aria-multiline="true"
      aria-label={label}
      contentEditable={!ctrl.readOnly}
      suppressContentEditableWarning
      spellCheck={!plain}
      data-block-id={blockId}
      data-placeholder={placeholder ?? undefined}
      className={clsx(
        "note-editable min-w-0 flex-1 whitespace-pre-wrap break-words outline-none",
        empty && placeholder ? "is-empty" : undefined,
        className,
      )}
      onInput={(event) => ctrl.onInput(blockId, event)}
      onKeyDown={(event) => ctrl.onKeyDown(blockId, event)}
      onPaste={(event) => ctrl.onPaste(blockId, event)}
      onFocus={() => ctrl.onFocus(blockId)}
      onBlur={() => ctrl.onBlur(blockId)}
      onDrop={(event) => event.preventDefault()}
      onClick={(event) => ctrl.onClickText(blockId, event)}
    />
  );
});
