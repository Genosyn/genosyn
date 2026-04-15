import React from "react";
import { clsx } from "./clsx";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const variantClasses: Record<Variant, string> = {
  primary:
    "bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-400 dark:bg-indigo-500 dark:hover:bg-indigo-600 dark:disabled:bg-indigo-900",
  secondary:
    "bg-white text-slate-900 border border-slate-200 hover:bg-slate-50 disabled:opacity-60 dark:bg-slate-900 dark:text-slate-100 dark:border-slate-700 dark:hover:bg-slate-800",
  ghost:
    "bg-transparent text-slate-700 hover:bg-slate-100 disabled:opacity-60 dark:text-slate-200 dark:hover:bg-slate-800",
  danger:
    "bg-red-600 text-white hover:bg-red-700 disabled:bg-red-400 dark:bg-red-600 dark:hover:bg-red-700",
};

const sizeClasses: Record<Size, string> = {
  sm: "h-8 px-3 text-sm",
  md: "h-10 px-4 text-sm",
};

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      className={clsx(
        "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition",
        "focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1",
        "disabled:cursor-not-allowed",
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
    />
  );
}
