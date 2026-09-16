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
import { clsx } from "./clsx";

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
 *
 * A surface with its own scroller, such as a conversation, uses `bodyMode="fill"`
 * and gives the panel an explicit height. That keeps one scroll owner instead
 * of nesting a transcript scrollbar inside the modal body's scrollbar.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  onSubmit,
  onEscape,
  size = "md",
  padded = true,
  bodyMode = "scroll",
  panelClassName,
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
  /**
   * First refusal on Escape, for a modal containing something that owns the
   * key — an autocomplete, a picker. Return true to say it was handled and
   * leave the modal open. Escape only: a click on the X still closes.
   */
  onEscape?: () => boolean;
  size?: ModalSize;
  /**
   * Drop the body's own padding, for content that has to reach the panel edge
   * — a chat transcript whose row hover and scrollbar belong at the edge, a
   * table, a full-bleed preview. Such content owns its own inset, and should
   * match the header's `px-4 sm:px-5` so the rules line up.
   */
  padded?: boolean;
  /** `fill` lets children own scrolling while the body becomes a clipped flex viewport. */
  bodyMode?: "scroll" | "fill";
  /** Deliberate panel geometry for surfaces such as chat; generic forms stay content-sized. */
  panelClassName?: string;
}) {
  const { titleId, panelRef } = useModalChrome({ open, onDismiss: onClose, onEscape });
  const descriptionId = React.useId();

  if (!open) return null;

  const body = (
    <>
      <div
        className={clsx(
          "min-h-0 flex-1",
          bodyMode === "scroll" ? "overflow-y-auto overscroll-contain" : "flex overflow-hidden",
          padded && "p-4 sm:p-5",
        )}
      >
        {children}
      </div>
      {footer && <ModalFooter>{footer}</ModalFooter>}
    </>
  );

  return createPortal(
    <ModalScrim onDismiss={onClose}>
      <ModalPanel
        ref={panelRef}
        size={size}
        className={panelClassName}
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
