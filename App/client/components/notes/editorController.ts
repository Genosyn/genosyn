import type React from "react";
import type { Run } from "../../lib/noteInline";
import type { CalloutKind } from "../../lib/noteMarkdown";

/** A mounted block editable the editor can draw into and read from. */
export type EditableEntry = {
  el: HTMLElement;
  markShown: (value: readonly Run[] | string) => void;
};

/**
 * What block rows call back into. One stable object for the editor's
 * lifetime, so memoized rows never re-render just because a handler changed.
 */
export type EditorController = {
  readOnly: boolean;
  register(id: string, entry: EditableEntry | null): void;
  onInput(id: string, event: React.FormEvent<HTMLDivElement>): void;
  onKeyDown(id: string, event: React.KeyboardEvent<HTMLDivElement>): void;
  onPaste(id: string, event: React.ClipboardEvent<HTMLDivElement>): void;
  onFocus(id: string): void;
  onBlur(id: string): void;
  onClickText(id: string, event: React.MouseEvent<HTMLDivElement>): void;
  toggleTodo(id: string): void;
  toggleOpen(id: string): void;
  setCalloutKind(id: string, kind: CalloutKind): void;
  setCodeLang(id: string, lang: string): void;
  setImage(id: string, patch: { src?: string; alt?: string }): void;
  addChild(id: string): void;
  gutterAdd(id: string, event: React.MouseEvent): void;
  gutterPointerDown(id: string, event: React.PointerEvent): void;
  selectBlock(id: string, extend: boolean): void;
  editSource(id: string, editing: boolean): void;
  copyText(text: string): void;
};
