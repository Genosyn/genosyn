type LogoMarkProps = {
  className?: string;
  variant?: "tile" | "plain";
};

type LogoProps = {
  className?: string;
};

/**
 * Genosyn mark — a plain circle.
 *
 * `variant="plain"` (default) is a monochrome stroked circle in
 * `currentColor` — blends into headers, footers, and dark contexts alike.
 * `variant="tile"` wraps the circle in a slate rounded square (favicons,
 * constrained slots needing their own visual frame).
 */
export function LogoMark({ className = "", variant = "plain" }: LogoMarkProps) {
  const fg = variant === "tile" ? "#ffffff" : "currentColor";

  const Mark = (
    <circle cx="16" cy="16" r="9" fill="none" stroke={fg} strokeWidth="2.4" />
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
 * Genosyn full logo — circle mark + GENOSYN wordmark, single SVG lockup.
 *
 * Wordmark is uppercase Inter 700 with positive tracking. Both elements
 * use `currentColor` so the lockup adapts to its surrounding text color
 * (slate-900 on light, white on dark, accent in branded headers).
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
      <circle
        cx="16"
        cy="16"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
      />
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
