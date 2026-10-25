import React from "react";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Menu } from "@/components/ui/Menu";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  MinusCircle,
  MoreHorizontal,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { type Tone } from "@/lib/backupStatus";
import { clsx } from "@/components/ui/clsx";

/** Small pieces Admin → Backups' sections share: tones, a row's ⋯ menu, a switch. */

export const TONE_TEXT: Record<Tone, string> = {
  ok: "text-emerald-700 dark:text-emerald-400",
  warn: "text-amber-700 dark:text-amber-400",
  error: "text-rose-700 dark:text-rose-400",
  working: "text-indigo-700 dark:text-indigo-300",
  muted: "text-slate-500 dark:text-slate-400",
};

export const TONE_CHIP: Record<Tone, string> = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200",
  warn: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
  error:
    "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200",
  working:
    "border-indigo-200 bg-indigo-50 text-indigo-800 dark:border-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-200",
  muted:
    "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300",
};

export function ToneIcon({
  tone,
  size = 14,
  className,
}: {
  tone: Tone;
  size?: number;
  className?: string;
}) {
  const props = { size, "aria-hidden": true, className: clsx("shrink-0", className) };
  if (tone === "ok") return <CheckCircle2 {...props} />;
  if (tone === "warn") return <AlertTriangle {...props} />;
  if (tone === "error") return <XCircle {...props} />;
  if (tone === "working")
    return <Loader2 {...props} className={clsx(props.className, "animate-spin")} />;
  return <MinusCircle {...props} />;
}

/** A row's ⋯ menu; `Menu` opens it upward when the row is near the bottom of the window. */
export function RowMenu({
  label,
  loading,
  disabled,
  children,
}: {
  label: string;
  loading?: boolean;
  disabled?: boolean;
  children: (close: () => void) => React.ReactNode;
}) {
  return (
    <Menu
      align="right"
      width={240}
      trigger={({ ref, onClick, open }) => (
        <Button
          ref={ref}
          size="sm"
          variant="ghost"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={label}
          loading={loading}
          disabled={disabled}
          onClick={onClick}
        >
          <MoreHorizontal size={14} />
        </Button>
      )}
    >
      {children}
    </Menu>
  );
}

/** A section that couldn't load: why, and a way to try again. */
export function SectionError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col gap-2">
      <FormError message={message} />
      <div>
        <Button size="sm" variant="secondary" onClick={onRetry}>
          <RefreshCw size={12} />
          Try again
        </Button>
      </div>
    </div>
  );
}

/** An on / off control that reads as one. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-60",
        checked ? "bg-indigo-600 dark:bg-indigo-500" : "bg-slate-300 dark:bg-slate-700",
      )}
    >
      <span
        className={clsx(
          "inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform",
          checked ? "translate-x-5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

/**
 * The raw message behind a reason shown in plain words — "ENOSPC: no space
 * left on device, write" behind "The server ran out of disk space" — closed
 * until asked for. Renders nothing when there is none.
 */
export function TechnicalDetail({
  detail,
  className,
}: {
  detail: string | null | undefined;
  className?: string;
}) {
  if (!detail) return null;
  return (
    <details className={clsx("text-xs text-slate-500 dark:text-slate-400", className)}>
      <summary className="w-fit cursor-pointer select-none hover:text-slate-700 dark:hover:text-slate-200">
        Technical detail
      </summary>
      <code className="mt-1 block whitespace-pre-wrap break-all rounded bg-slate-100 px-2 py-1 font-mono text-[11px] text-slate-700 dark:bg-slate-800 dark:text-slate-200">
        {detail}
      </code>
    </details>
  );
}
