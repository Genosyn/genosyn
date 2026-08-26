import React from "react";
import { createPortal } from "react-dom";
import { AlertTriangle } from "lucide-react";
import { Button } from "./Button";
import { Input } from "./Input";
import {
  ModalCloseButton,
  ModalFooter,
  ModalPanel,
  ModalScrim,
  useModalChrome,
} from "./ModalChrome";
import { errorMessage } from "../../lib/errors";

/**
 * Promise-returning confirm/prompt/alert dialogs that replace the browser
 * natives. One provider at the app root renders at most one dialog at a time;
 * each request resolves when the user clicks an action (or Esc / backdrop).
 *
 * Usage:
 *   const dialog = useDialog();
 *   if (!(await dialog.confirm({ title: "Delete?", variant: "danger" }))) return;
 *   const name = await dialog.prompt({ title: "Rename", defaultValue: cur });
 *   await dialog.alert({ title: "Heads up", message: "..." });
 *   dialog.error(err, { title: "Couldn’t archive the thread" });
 *
 * `error` is the fallback error surface for an action with no form to put
 * the message in — a row button, a menu item, an optimistic update that
 * had to roll back. When the failure belongs to a form the user is looking
 * at, render a `<FormError>` inside that form instead: a modal over a form
 * hides the fields the person has to fix.
 */

type ConfirmOpts = {
  title: string;
  message?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "danger";
};

type PromptOpts = {
  title: string;
  message?: React.ReactNode;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /**
   * Block "OK" until the value passes. Return a string to show as an
   * inline error, or null to accept.
   */
  validate?: (value: string) => string | null;
};

type AlertOpts = {
  title: string;
  message?: React.ReactNode;
  confirmLabel?: string;
  variant?: "default" | "danger";
};

type ErrorOpts = {
  /** Headline for the modal. Say what failed, not that something failed. */
  title?: string;
  /** Overrides the message read off the thrown value. */
  message?: string;
  confirmLabel?: string;
};

type DialogApi = {
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
  prompt: (opts: PromptOpts) => Promise<string | null>;
  alert: (opts: AlertOpts) => Promise<void>;
  /**
   * Show a failure in a modal. Resolves when it is dismissed; most callers
   * fire it from a `catch` and ignore the promise.
   */
  error: (error: unknown, opts?: ErrorOpts) => Promise<void>;
};

type Request =
  | { kind: "confirm"; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | { kind: "prompt"; opts: PromptOpts; resolve: (v: string | null) => void }
  | { kind: "alert"; opts: AlertOpts; resolve: () => void };

const DialogContext = React.createContext<DialogApi | null>(null);

export function useDialog(): DialogApi {
  const ctx = React.useContext(DialogContext);
  if (!ctx) throw new Error("useDialog must be used inside <DialogProvider>");
  return ctx;
}

type BackgroundOptions<T> = {
  /** Headline for the error modal. Say what failed. */
  title?: string;
  /** Message for the error modal; defaults to the thrown value's own. */
  error?: string | ((error: unknown) => string);
  onSuccess?: (result: T) => void;
  /** Undo the optimistic update here. Runs before the modal opens. */
  onError?: (error: unknown) => void;
};

/**
 * Fire an action the user is not waiting on — the optimistic half of a
 * click that already updated the screen. Nothing is shown while it runs or
 * when it succeeds; a failure runs `onError` (put the rollback there) and
 * then opens the error modal, so the row snapping back has an explanation
 * attached to it.
 *
 *   const background = useBackgroundAction();
 *   background(() => api.del(url), {
 *     title: "Couldn’t delete the tag",
 *     onError: () => setTags(previous),
 *   });
 */
export function useBackgroundAction() {
  const dialog = useDialog();
  return React.useCallback(
    <T,>(action: () => Promise<T>, options: BackgroundOptions<T> = {}) => {
      void Promise.resolve()
        .then(action)
        .then((result) => {
          options.onSuccess?.(result);
        })
        .catch((error: unknown) => {
          options.onError?.(error);
          const message =
            typeof options.error === "function" ? options.error(error) : options.error;
          void dialog.error(error, { title: options.title, message });
        });
    },
    [dialog],
  );
}

export function DialogProvider({ children }: { children: React.ReactNode }) {
  // `seq` remounts the shell when one dialog replaces another without a gap,
  // so a prompt never opens carrying the previous prompt's typed value.
  const [current, setCurrent] = React.useState<{ seq: number; request: Request } | null>(null);
  const seqRef = React.useRef(0);

  const api = React.useMemo<DialogApi>(() => {
    function open(request: Request) {
      seqRef.current += 1;
      setCurrent({ seq: seqRef.current, request });
    }
    return {
      confirm: (opts) =>
        new Promise<boolean>((resolve) => {
          open({ kind: "confirm", opts, resolve });
        }),
      prompt: (opts) =>
        new Promise<string | null>((resolve) => {
          open({ kind: "prompt", opts, resolve });
        }),
      alert: (opts) =>
        new Promise<void>((resolve) => {
          open({ kind: "alert", opts, resolve });
        }),
      error: (error, opts) =>
        new Promise<void>((resolve) => {
          open({
            kind: "alert",
            opts: {
              title: opts?.title ?? "Something went wrong",
              message: opts?.message ?? errorMessage(error),
              confirmLabel: opts?.confirmLabel ?? "Close",
              variant: "danger",
            },
            resolve,
          });
        }),
    };
  }, []);

  function close(result: unknown) {
    if (!current) return;
    const { request } = current;
    // Narrow by request kind so we hand back the right shape.
    if (request.kind === "confirm") {
      request.resolve(Boolean(result));
    } else if (request.kind === "prompt") {
      request.resolve((result as string | null) ?? null);
    } else {
      request.resolve();
    }
    setCurrent(null);
  }

  return (
    <DialogContext.Provider value={api}>
      {children}
      {current && (
        <DialogShell
          key={current.seq}
          request={current.request}
          onCancel={() => close(current.request.kind === "prompt" ? null : false)}
          onConfirm={(value) => close(value)}
        />
      )}
    </DialogContext.Provider>
  );
}

function DialogShell({
  request,
  onCancel,
  onConfirm,
}: {
  request: Request;
  onCancel: () => void;
  onConfirm: (value: unknown) => void;
}) {
  // A dialog is what a Modal asks a question with, so it sits on the layer
  // above one: it owns Escape and Tab while open, and the Modal underneath
  // stays put until it is answered.
  const { titleId, panelRef } = useModalChrome({ open: true, onDismiss: onCancel });
  const messageId = React.useId();

  const isDanger =
    (request.kind === "confirm" && request.opts.variant === "danger") ||
    (request.kind === "alert" && request.opts.variant === "danger");

  const hasMessage = request.opts.message !== undefined;

  return createPortal(
    <ModalScrim layer="dialog" onDismiss={onCancel}>
      <ModalPanel
        ref={panelRef}
        size="sm"
        labelledBy={titleId}
        describedBy={hasMessage ? messageId : undefined}
      >
        {request.kind === "prompt" ? (
          <PromptDialog
            request={request}
            titleId={titleId}
            messageId={messageId}
            onCancel={onCancel}
            onConfirm={onConfirm}
          />
        ) : (
          <>
            <DialogBody
              isDanger={isDanger}
              title={request.opts.title}
              titleId={titleId}
              message={request.opts.message}
              messageId={messageId}
              onCancel={onCancel}
            />
            <ModalFooter>
              {request.kind === "confirm" && (
                <Button size="sm" variant="secondary" onClick={onCancel}>
                  {request.opts.cancelLabel ?? "Cancel"}
                </Button>
              )}
              <Button
                size="sm"
                variant={
                  request.kind === "confirm" && request.opts.variant === "danger"
                    ? "danger"
                    : "primary"
                }
                onClick={() => onConfirm(request.kind === "confirm" ? true : undefined)}
                autoFocus
              >
                {request.opts.confirmLabel ??
                  (request.kind === "alert" ? "OK" : isDanger ? "Delete" : "Confirm")}
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalPanel>
    </ModalScrim>,
    document.body,
  );
}

/**
 * Icon, question and close button — the part above the action tray. It is the
 * scroll region, so a long message keeps the buttons reachable instead of
 * pushing them off the bottom of the screen.
 */
function DialogBody({
  isDanger,
  title,
  titleId,
  message,
  messageId,
  onCancel,
  children,
}: {
  isDanger: boolean;
  title: string;
  titleId: string;
  message?: React.ReactNode;
  messageId: string;
  onCancel: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
      <div className="flex items-start gap-3">
        {isDanger && (
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400">
            <AlertTriangle size={16} />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <h2
            id={titleId}
            className="text-base font-semibold tracking-tight text-slate-900 dark:text-slate-100"
          >
            {title}
          </h2>
          {message !== undefined && (
            <div
              id={messageId}
              className="mt-1.5 whitespace-pre-wrap break-words text-sm text-slate-600 dark:text-slate-300"
            >
              {message}
            </div>
          )}
        </div>
        <ModalCloseButton onClick={onCancel} />
      </div>
      {/* Below the row rather than inside the text column, so a field lines up
          with the panel's gutter instead of stopping short of the ✕. */}
      {children}
    </div>
  );
}

function PromptDialog({
  request,
  titleId,
  messageId,
  onCancel,
  onConfirm,
}: {
  request: Extract<Request, { kind: "prompt" }>;
  titleId: string;
  messageId: string;
  onCancel: () => void;
  onConfirm: (value: string | null) => void;
}) {
  const { opts } = request;
  const [value, setValue] = React.useState(opts.defaultValue ?? "");
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const errorId = React.useId();

  React.useEffect(() => {
    // Select-all on open so the default value is easy to replace.
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  function submit() {
    const trimmed = value.trim();
    if (opts.validate) {
      const err = opts.validate(trimmed);
      if (err) {
        setError(err);
        return;
      }
    }
    if (!trimmed) {
      setError("Required");
      return;
    }
    onConfirm(trimmed);
  }

  return (
    <>
      <DialogBody
        isDanger={false}
        title={opts.title}
        titleId={titleId}
        message={opts.message}
        messageId={messageId}
        onCancel={onCancel}
      >
        <Input
          ref={inputRef}
          className="mt-4 w-full"
          aria-label={opts.title}
          aria-describedby={error ? errorId : undefined}
          invalid={Boolean(error)}
          value={value}
          placeholder={opts.placeholder}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
        {error && (
          <div id={errorId} className="mt-1.5 text-xs text-red-600 dark:text-red-400">
            {error}
          </div>
        )}
      </DialogBody>
      <ModalFooter>
        <Button size="sm" variant="secondary" onClick={onCancel}>
          {opts.cancelLabel ?? "Cancel"}
        </Button>
        <Button size="sm" onClick={submit}>
          {opts.confirmLabel ?? "OK"}
        </Button>
      </ModalFooter>
    </>
  );
}
