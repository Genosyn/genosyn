import React from "react";
import { X, AlertTriangle } from "lucide-react";
import { Button } from "./Button";
import { clsx } from "./clsx";

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

type DialogApi = {
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
  prompt: (opts: PromptOpts) => Promise<string | null>;
  alert: (opts: AlertOpts) => Promise<void>;
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

export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [current, setCurrent] = React.useState<Request | null>(null);

  const api = React.useMemo<DialogApi>(
    () => ({
      confirm: (opts) =>
        new Promise<boolean>((resolve) => {
          setCurrent({ kind: "confirm", opts, resolve });
        }),
      prompt: (opts) =>
        new Promise<string | null>((resolve) => {
          setCurrent({ kind: "prompt", opts, resolve });
        }),
      alert: (opts) =>
        new Promise<void>((resolve) => {
          setCurrent({ kind: "alert", opts, resolve });
        }),
    }),
    [],
  );

  function close(result: unknown) {
    if (!current) return;
    // Narrow by request kind so we hand back the right shape.
    if (current.kind === "confirm") {
      current.resolve(Boolean(result));
    } else if (current.kind === "prompt") {
      current.resolve((result as string | null) ?? null);
    } else {
      current.resolve();
    }
    setCurrent(null);
  }

  return (
    <DialogContext.Provider value={api}>
      {children}
      {current && (
        <DialogShell
          request={current}
          onCancel={() => close(current.kind === "prompt" ? null : false)}
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
  // Esc closes, Enter submits (outside of textareas).
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const isDanger =
    (request.kind === "confirm" && request.opts.variant === "danger") ||
    (request.kind === "alert" && request.opts.variant === "danger");

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/40 p-4 dark:bg-black/60"
      onMouseDown={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-md overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900"
      >
        <div className="flex items-start gap-3 px-5 py-4">
          {isDanger && (
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-100 text-red-600 dark:bg-red-500/15 dark:text-red-400">
              <AlertTriangle size={18} />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {request.opts.title}
            </h2>
            {request.kind === "confirm" && request.opts.message !== undefined && (
              <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                {request.opts.message}
              </div>
            )}
            {request.kind === "alert" && request.opts.message !== undefined && (
              <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                {request.opts.message}
              </div>
            )}
            {request.kind === "prompt" && (
              <PromptBody request={request} onCancel={onCancel} onConfirm={onConfirm} />
            )}
          </div>
          <button
            onClick={onCancel}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
        {request.kind !== "prompt" && (
          <FooterButtons request={request} onCancel={onCancel} onConfirm={onConfirm} />
        )}
      </div>
    </div>
  );
}

function FooterButtons({
  request,
  onCancel,
  onConfirm,
}: {
  request: Request;
  onCancel: () => void;
  onConfirm: (value: unknown) => void;
}) {
  if (request.kind === "alert") {
    return (
      <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50/70 px-5 py-3 dark:border-slate-800 dark:bg-slate-900/50">
        <Button size="sm" onClick={() => onConfirm(undefined)} autoFocus>
          {request.opts.confirmLabel ?? "OK"}
        </Button>
      </div>
    );
  }
  if (request.kind === "confirm") {
    const danger = request.opts.variant === "danger";
    return (
      <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50/70 px-5 py-3 dark:border-slate-800 dark:bg-slate-900/50">
        <Button size="sm" variant="secondary" onClick={onCancel}>
          {request.opts.cancelLabel ?? "Cancel"}
        </Button>
        <Button
          size="sm"
          variant={danger ? "danger" : "primary"}
          onClick={() => onConfirm(true)}
          autoFocus
        >
          {request.opts.confirmLabel ?? (danger ? "Delete" : "Confirm")}
        </Button>
      </div>
    );
  }
  return null;
}

function PromptBody({
  request,
  onCancel,
  onConfirm,
}: {
  request: Extract<Request, { kind: "prompt" }>;
  onCancel: () => void;
  onConfirm: (value: string | null) => void;
}) {
  const { opts } = request;
  const [value, setValue] = React.useState(opts.defaultValue ?? "");
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

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
      {opts.message !== undefined && (
        <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          {opts.message}
        </div>
      )}
      <input
        ref={inputRef}
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
        className={clsx(
          "mt-3 h-10 w-full rounded-lg border bg-white px-3 text-sm text-slate-900 shadow-sm dark:bg-slate-900 dark:text-slate-100",
          "focus:outline-none focus:ring-2",
          error
            ? "border-red-400 focus:ring-red-200 dark:border-red-800 dark:focus:ring-red-900"
            : "border-slate-200 focus:border-indigo-500 focus:ring-indigo-200 dark:border-slate-700 dark:focus:ring-indigo-900",
        )}
      />
      {error && (
        <div className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</div>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <Button size="sm" variant="secondary" onClick={onCancel}>
          {opts.cancelLabel ?? "Cancel"}
        </Button>
        <Button size="sm" onClick={submit}>
          {opts.confirmLabel ?? "OK"}
        </Button>
      </div>
    </>
  );
}
