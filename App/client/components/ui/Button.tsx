import React from "react";
import { clsx } from "./clsx";
import { ButtonSpinner } from "./Spinner";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /**
   * The work this button started is still running. The button is disabled
   * until it settles and a spinner stands in for its icon — or leads the
   * label, when it has none — so the click visibly took. Give it only to the
   * button that started the work; the rest of the row stays `disabled`.
   */
  loading?: boolean;
}

// Focus is a 2px outline 2px outside the button. An outline's offset is a gap,
// not paint, so it shows whatever the button sits on — a white modal, a tinted
// footer, a slate-900 panel — where a ring's offset had to be painted one fixed
// colour and drew a bright hairline on dark surfaces. The outline is the
// theme's focus colour (3:1 or better on every surface); a destructive button
// answers in red rather than the accent.
//
// Hover and the unavailable look are kept apart from the resting colours
// because a loading button sheds both: it is busy, not unavailable, so it
// keeps its colour rather than fading the moment it is pressed, and a pointer
// left resting on it is not offered a hover for a click it will not take.
const variantClasses: Record<Variant, { rest: string; hover: string; disabled: string }> = {
  primary: {
    // White text on indigo-600 is 6.3:1; the dark hover's indigo-500 is tuned
    // to 4.6:1 (lib/designTokens.ts).
    rest: "bg-indigo-600 text-white shadow-sm focus-visible:outline-focus",
    hover: "hover:bg-indigo-700 dark:hover:bg-indigo-500",
    disabled: "disabled:opacity-50",
  },
  secondary: {
    rest: "border border-slate-300 bg-white text-slate-800 shadow-sm focus-visible:outline-focus dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100",
    hover: "hover:border-slate-400/80 hover:bg-slate-50 dark:hover:border-slate-600 dark:hover:bg-slate-800",
    disabled: "disabled:opacity-50",
  },
  ghost: {
    rest: "bg-transparent text-slate-700 focus-visible:outline-focus dark:text-slate-300",
    hover: "hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-slate-100",
    disabled: "disabled:opacity-50",
  },
  danger: {
    rest: "bg-red-600 text-white shadow-sm focus-visible:outline-red-600 dark:focus-visible:outline-red-400",
    hover: "hover:bg-red-700",
    disabled: "disabled:opacity-50",
  },
};

const sizeClasses: Record<Size, string> = {
  sm: "h-8 px-3 text-sm",
  md: "h-10 px-4 text-sm",
};

export function buttonClassName({
  variant = "primary",
  size = "md",
  loading = false,
  className,
}: {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  className?: string;
} = {}) {
  const colors = variantClasses[variant];
  return clsx(
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition-colors",
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
    colors.rest,
    loading
      ? "cursor-progress"
      : clsx("disabled:cursor-not-allowed", colors.hover, colors.disabled),
    sizeClasses[size],
    className,
  );
}

/**
 * Children as one flat list. Fragments are opened, so a label written as
 * `<>…</>` inside a ternary is read as the label it is rather than taken for
 * an icon, and keys are prefixed so siblings lifted out of separate fragments
 * cannot collide.
 */
function flattenChildren(children: React.ReactNode, keyPrefix = ""): React.ReactNode[] {
  return React.Children.toArray(children).flatMap((child) => {
    if (!React.isValidElement<{ children?: React.ReactNode }>(child)) return [child];
    const key = `${keyPrefix}${child.key}`;
    if (child.type === React.Fragment) return flattenChildren(child.props.children, `${key}/`);
    return [keyPrefix ? React.cloneElement(child, { key }) : child];
  });
}

/** Margin utilities, variants included: `mr-1.5`, `-ml-0.5`, `sm:mr-1`. */
const MARGIN_CLASS = /^(?:[\w-]+:)*-?m[trblxyse]?-/;

/**
 * Puts the spinner where the button's icon was. Every component that opens a
 * button's children in this app is an icon, so a leading one is swapped out —
 * at its own size and with its own margins, so the label does not shift — and
 * a label that opens with text gets the spinner in front of it.
 */
function withSpinner(children: React.ReactNode): React.ReactNode[] {
  const items = flattenChildren(children);
  const [first, ...rest] = items;
  if (
    React.isValidElement<{ size?: unknown; className?: unknown }>(first) &&
    (typeof first.type !== "string" || first.type === "svg")
  ) {
    const size = typeof first.props.size === "number" ? first.props.size : undefined;
    const margins =
      typeof first.props.className === "string"
        ? first.props.className
            .split(/\s+/)
            .filter((name) => MARGIN_CLASS.test(name))
            .join(" ")
        : "";
    return [<ButtonSpinner key="loading" size={size} className={margins || undefined} />, ...rest];
  }
  return [<ButtonSpinner key="loading" />, ...items];
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "md",
    loading = false,
    disabled,
    className,
    children,
    "aria-busy": ariaBusy,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || ariaBusy}
      className={buttonClassName({ variant, size, loading, className })}
    >
      {loading ? withSpinner(children) : children}
    </button>
  );
});
