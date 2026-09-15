type LogoMarkProps = {
  className?: string;
  variant?: "tile" | "plain";
};

type LogoProps = {
  className?: string;
};

/** The same monochrome circle mark used by the App. */
export function LogoMark({ className = "", variant = "plain" }: LogoMarkProps) {
  const fg = variant === "tile" ? "#ffffff" : "currentColor";

  const Mark = <circle cx="16" cy="16" r="9" fill="none" stroke={fg} strokeWidth="2.4" />;

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
 * The App's circle-and-wordmark SVG. Its height remains em-based so existing
 * Home callers that size the lockup with a text utility keep the same API.
 */
export function Logo({ className = "" }: LogoProps) {
  return (
    <svg
      viewBox="0 0 140 32"
      xmlns="http://www.w3.org/2000/svg"
      className={`h-[1.85em] w-auto ${className}`}
      role="img"
      aria-label="Genosyn"
    >
      <circle cx="16" cy="16" r="9" fill="none" stroke="currentColor" strokeWidth="2.4" />
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
