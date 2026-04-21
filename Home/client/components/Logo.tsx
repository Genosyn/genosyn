import { useId } from "react";

type LogoMarkProps = {
  className?: string;
  variant?: "tile" | "plain";
};

type LogoProps = {
  className?: string;
};

/**
 * Genosyn mark — geometric G on a rounded indigo tile.
 *
 * Two rounded strokes of equal weight (a near-full arc and a short crossbar)
 * form the letterform. A small filled node caps the crossbar as a quiet nod
 * to the "-syn" (synthesis) in the name. The tile carries a subtle diagonal
 * gradient from indigo-500 to indigo-700 for depth.
 *
 * Use `<LogoMark>` where the mark must stand alone (favicons, tight slots).
 * Prefer `<Logo>` for headers, footers, and auth shells — the full lockup
 * with the wordmark.
 */
export function LogoMark({ className = "", variant = "tile" }: LogoMarkProps) {
  const rawId = useId();
  const gradId = `g-${rawId.replace(/:/g, "")}`;
  const fg = variant === "tile" ? "#ffffff" : "currentColor";

  const Mark = (
    <>
      <path
        d="M 23.79 11.5 A 9 9 0 1 0 23.79 20.5"
        fill="none"
        stroke={fg}
        strokeWidth="3.8"
        strokeLinecap="round"
      />
      <path
        d="M 16 16 L 21.5 16"
        fill="none"
        stroke={fg}
        strokeWidth="3.8"
        strokeLinecap="round"
      />
      <circle cx="22.5" cy="16" r="1.9" fill={fg} />
    </>
  );

  if (variant === "tile") {
    return (
      <svg
        viewBox="0 0 32 32"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        aria-hidden="true"
      >
        <defs>
          <linearGradient
            id={gradId}
            x1="0"
            y1="0"
            x2="32"
            y2="32"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0%" stopColor="#6366f1" />
            <stop offset="100%" stopColor="#4338ca" />
          </linearGradient>
        </defs>
        <rect width="32" height="32" rx="8" fill={`url(#${gradId})`} />
        {Mark}
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {Mark}
    </svg>
  );
}

/**
 * Genosyn full logo — mark + wordmark lockup, as one SVG.
 *
 * Inter ExtraBold (800) with tightened tracking so the letterforms read as a
 * single block beside the mark. Cap height is tuned to the mark's crossbar
 * so both elements share an optical center line (y=16). The tile stays
 * indigo/white; the wordmark uses `currentColor` so it inherits the
 * surrounding text color (slate-900 on light, white on dark).
 */
export function Logo({ className = "" }: LogoProps) {
  const rawId = useId();
  const gradId = `g-${rawId.replace(/:/g, "")}`;
  return (
    <svg
      viewBox="0 0 148 32"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="Genosyn"
    >
      <defs>
        <linearGradient
          id={gradId}
          x1="0"
          y1="0"
          x2="32"
          y2="32"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#4338ca" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${gradId})`} />
      <path
        d="M 23.79 11.5 A 9 9 0 1 0 23.79 20.5"
        fill="none"
        stroke="#ffffff"
        strokeWidth="3.8"
        strokeLinecap="round"
      />
      <path
        d="M 16 16 L 21.5 16"
        fill="none"
        stroke="#ffffff"
        strokeWidth="3.8"
        strokeLinecap="round"
      />
      <circle cx="22.5" cy="16" r="1.9" fill="#ffffff" />
      <text
        x="43"
        y="23.5"
        fontFamily="Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
        fontSize="22"
        fontWeight="800"
        letterSpacing="-0.6"
        fill="currentColor"
      >
        Genosyn
      </text>
    </svg>
  );
}
