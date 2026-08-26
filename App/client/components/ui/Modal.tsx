import React from "react";
import { createPortal } from "react-dom";
import {
  ModalCloseButton,
  ModalFooter,
  ModalPanel,
  ModalScrim,
  useModalChrome,
  type ModalSize,
} from "./ModalChrome";

/**
 * A titled panel a page opens over itself.
 *
 * `footer` puts the action row in a tray below the scrolling body, where it
 * stays put however long the form gets. Because most of those rows submit a
 * form, pass `onSubmit` too and the modal owns the `<form>` — the tray is
 * inside it, so `type="submit"` and Enter both still work.
 *
 *   <Modal
 *     open={open}
 *     onClose={onClose}
 *     title="New contact"
 *     description="They will show up under Revenue → Contacts."
 *     onSubmit={save}
 *     footer={
 *       <>
 *         <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
 *         <Button type="submit">Create contact</Button>
 *       </>
 *     }
 *   >
 *     …fields…
 *   </Modal>
 *
 * Both are optional: a modal that passes neither renders its children exactly
 * as it always did, action row and all.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  onSubmit,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** One quiet line under the title. Say what the modal is for, not that it is a form. */
  description?: React.ReactNode;
  children: React.ReactNode;
  /** Action row, pinned below the body. */
  footer?: React.ReactNode;
  /** Makes the modal own the `<form>` around body + footer. */
  onSubmit?: (event: React.FormEvent<HTMLFormElement>) => void;
  size?: ModalSize;
}) {
  const { titleId, panelRef } = useModalChrome({ open, onDismiss: onClose });
  const descriptionId = React.useId();

  if (!open) return null;

  const body = (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-5">{children}</div>
      {footer && <ModalFooter>{footer}</ModalFooter>}
    </>
  );

  return createPortal(
    <ModalScrim onDismiss={onClose}>
      <ModalPanel
        ref={panelRef}
        size={size}
        labelledBy={titleId}
        describedBy={description ? descriptionId : undefined}
      >
        <div
          className={`flex shrink-0 justify-between gap-3 border-b border-slate-200/70 px-4 py-3 sm:px-5 dark:border-slate-800 ${
            description ? "items-start" : "items-center"
          }`}
        >
          <div className="min-w-0">
            {/* Titles interpolate a record's name — `Run: ${routine.name}` — and a
                long one used to wrap and drag the close button off-axis. Truncated
                here, with the full string on hover. */}
            <h2
              id={titleId}
              title={title}
              className="truncate text-base font-semibold tracking-tight text-slate-900 dark:text-slate-100"
            >
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
                {description}
              </p>
            )}
          </div>
          <ModalCloseButton onClick={onClose} />
        </div>
        {onSubmit ? (
          <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {body}
          </form>
        ) : (
          body
        )}
      </ModalPanel>
    </ModalScrim>,
    document.body,
  );
}
