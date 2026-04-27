type LogoMarkProps = {
  className?: string;
  variant?: "tile" | "plain";
};

type LogoProps = {
  className?: string;
};

/**
 * Genosyn mark — monoline G with a synthesis node.
 *
 * One continuous stroke draws a near-full arc that, at its lower terminator,
 * folds ninety degrees inward and rises as a short vertical spur. A small
 * filled square caps the spur — the deliberate, architectural "stop" that
 * gives the syn(thetic) half of the name its visual signature. Stroke
 * weight is uniform across the arc and spur so the mark reads as one
 * engineered gesture.
 *
 * `variant="plain"` (default) is monochrome `currentColor` — blends into
 * headers, footers, and dark contexts alike. `variant="tile"` wraps the
 * mark in a slate rounded square (favicons, constrained slots needing
 * their own visual frame).
 */
export function LogoMark({ className = "", variant = "plain" }: LogoMarkProps) {
  const fg = variant === "tile" ? "#ffffff" : "currentColor";

  const Mark = (
    <>
      <path
        d="M 23 11 A 9 9 0 1 0 23 21 L 23 17"
        fill="none"
        stroke={fg}
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="21.4" y="13.4" width="3.2" height="3.2" rx="0.6" fill={fg} />
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
        <rect width="32" height="32" rx="8" fill="#0f172a" />
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
 * Genosyn full logo — mark + GENOSYN wordmark, single SVG lockup.
 *
 * Wordmark is uppercase Inter 700 with positive tracking. The wide letter
 * spacing matches the geometric formality of the mark and makes the name
 * read as a brand, not a heading. Both elements use `currentColor` so the
 * lockup adapts to its surrounding text color (slate-900 on light, white
 * on dark, accent in branded headers).
 */
export function Logo({ className = "" }: LogoProps) {
  return (
    <svg
      viewBox="0 0 140 32"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="Genosyn"
    >
      <path
        d="M 23 11 A 9 9 0 1 0 23 21 L 23 17"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="21.4" y="13.4" width="3.2" height="3.2" rx="0.6" fill="currentColor" />
      <text
        x="36"
        y="22"
        fontFamily="Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
        fontSize="17"
        fontWeight="700"
        letterSpacing="2.4"
        fill="currentColor"
      >
        GENOSYN
      </text>
    </svg>
  );
}
