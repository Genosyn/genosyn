import React from "react";
import { clsx } from "./clsx";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

// The focus ring is translucent and sits flush against the button rather than
// on an offset. `ring-offset-*` paints the gap in `--tw-ring-offset-color`,
// which is white — a bright hairline around every focused button on a dark
// panel — and one offset colour cannot serve white modals, tinted footers and
// slate-900 surfaces at once. Each variant tints its own ring instead, so a
// destructive button no longer answers with the accent colour.
const variantClasses: Record<Variant, string> = {
  primary:
    "bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-400 focus-visible:ring-indigo-500/40 dark:bg-indigo-500 dark:hover:bg-indigo-600 dark:disabled:bg-indigo-900",
  secondary:
    "bg-white text-slate-900 border border-slate-200 hover:bg-slate-50 disabled:opacity-60 focus-visible:ring-indigo-500/40 dark:bg-slate-900 dark:text-slate-100 dark:border-slate-700 dark:hover:bg-slate-800",
  ghost:
    "bg-transparent text-slate-700 hover:bg-slate-100 disabled:opacity-60 focus-visible:ring-indigo-500/40 dark:text-slate-200 dark:hover:bg-slate-800",
  danger:
    "bg-red-600 text-white hover:bg-red-700 disabled:bg-red-400 focus-visible:ring-red-500/50 dark:bg-red-600 dark:hover:bg-red-700",
};

const sizeClasses: Record<Size, string> = {
  sm: "h-8 px-3 text-sm",
  md: "h-10 px-4 text-sm",
};

export function buttonClassName({
  variant = "primary",
  size = "md",
  className,
}: {
  variant?: Variant;
  size?: Size;
  className?: string;
} = {}) {
  return clsx(
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition",
    "focus-visible:outline-none focus-visible:ring-2",
    "disabled:cursor-not-allowed",
    variantClasses[variant],
    sizeClasses[size],
    className,
  );
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", className, ...rest },
  ref,
) {
  return <button ref={ref} {...rest} className={buttonClassName({ variant, size, className })} />;
});
