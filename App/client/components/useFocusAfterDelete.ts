import React from "react";

/**
 * Keeps keyboard focus in a list when one of its rows is deleted. The row's
 * delete button holds focus while the request runs — busy rather than
 * disabled, since a disabled button drops focus the moment it starts — but the
 * reload after it unmounts that button, and focus that goes down with a node
 * lands on <body>: the next Tab would start over at the top of the page, or in
 * the page behind a drawer. So once the row is gone, focus moves to the row
 * that took its place, else the one above it, else `emptyTarget`, the control
 * that adds one.
 */
export function useFocusAfterDelete(
  rows: { id: string }[] | null,
  emptyTarget: React.RefObject<HTMLElement>,
) {
  const deleteButtons = React.useRef(new Map<string, HTMLButtonElement>());
  const successors = React.useRef<string[] | null>(null);

  // `rows` changing is the commit that took the deleted row off the page.
  React.useLayoutEffect(() => {
    const candidates = successors.current;
    if (!candidates) return;
    successors.current = null;
    // Wherever the person went while the delete ran, they stay.
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const target =
      candidates.map((id) => deleteButtons.current.get(id)).find(Boolean) ?? emptyTarget.current;
    target?.focus();
  }, [rows, emptyTarget]);

  return {
    deleteButtonRef: (id: string) => (button: HTMLButtonElement | null) => {
      if (button) deleteButtons.current.set(id, button);
      else deleteButtons.current.delete(id);
    },
    /** Row `id` is deleted. Call before the reload that drops it from `rows`. */
    rowDeleted(id: string) {
      // Only focus that is on the row moves on with it: not after a click in a
      // browser that leaves buttons unfocused, nor once the person has moved.
      if (document.activeElement !== deleteButtons.current.get(id)) return;
      const ids = rows?.map((row) => row.id) ?? [];
      const index = ids.indexOf(id);
      successors.current = [ids[index + 1], ids[index - 1]].filter(
        (candidate): candidate is string => candidate !== undefined,
      );
    },
  };
}
