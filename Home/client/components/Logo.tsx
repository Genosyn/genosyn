type LogoMarkProps = {
  className?: string;
  variant?: "tile" | "plain";
};

type LogoProps = {
  className?: string;
};

/**
 * Genosyn mark — "Block G".
 *
 * The icon-only form: a heavy geometric G on a rounded indigo tile. Uniform
 * 6-unit weight, flat butt-cut terminals, crossbar whose right edge traces
 * the bowl's inner wall so the two shapes merge into one glyph.
 *
 * Use `<LogoMark>` only where the mark must stand alone (favicons, tight
 * slots). For headers, footers, and auth shells, prefer `<Logo>` — the full
 * lockup with the wordmark.
 */
export function LogoMark({ className = "", variant = "tile" }: LogoMarkProps) {
  const fg = variant === "tile" ? "#ffffff" : "currentColor";

  const Mark = (
    <>
      <path
        d="M 23.79 11.5 A 9 9 0 1 0 23.79 20.5"
        fill="none"
        stroke={fg}
        strokeWidth="6"
        strokeLinecap="butt"
      />
      <path
        d="M 12 13 L 21.2 13 A 6 6 0 0 1 21.2 19 L 12 19 Z"
        fill={fg}
      />
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
        <rect width="32" height="32" rx="7" fill="#4f46e5" />
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
 * The wordmark is set in Inter ExtraBold (800) with tightened tracking so the
 * letterforms read as a single solid block beside the mark, not as body
 * copy. Cap height is tuned to the mark's crossbar so both elements share a
 * common optical center line (y=16).
 *
 * The tile stays indigo/white; the wordmark uses `currentColor` so it
 * inherits the surrounding text color (slate-900 on light, white on dark).
 */
export function Logo({ className = "" }: LogoProps) {
  return (
    <svg
      viewBox="0 0 148 32"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="Genosyn"
    >
      {/* Mark — same block G as <LogoMark>, locked to the left */}
      <rect width="32" height="32" rx="7" fill="#4f46e5" />
      <path
        d="M 23.79 11.5 A 9 9 0 1 0 23.79 20.5"
        fill="none"
        stroke="#ffffff"
        strokeWidth="6"
        strokeLinecap="butt"
      />
      <path
        d="M 12 13 L 21.2 13 A 6 6 0 0 1 21.2 19 L 12 19 Z"
        fill="#ffffff"
      />
      {/* Wordmark — Inter 800, tight tracking, cap-height centered on mark */}
      <text
        x="43"
        y="23.5"
        fontFamily="Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
        fontSize="22"
        fontWeight="800"
        letterSpacing="-0.7"
        fill="currentColor"
      >
        Genosyn
      </text>
    </svg>
  );
}
