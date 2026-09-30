type LogoMarkProps = {
  className?: string;
  variant?: "tile" | "plain";
};

type LogoProps = {
  className?: string;
};

/** The ring mark the App uses. */
export function LogoMark({ className = "", variant = "plain" }: LogoMarkProps) {
  const fg = variant === "tile" ? "#F4F1EB" : "currentColor";

  const Mark = <circle cx="16" cy="16" r="9" fill="none" stroke={fg} strokeWidth="2.4" />;

  if (variant === "tile") {
    return (
      <svg
        viewBox="0 0 32 32"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        aria-hidden="true"
      >
        <rect width="32" height="32" rx="8" fill="#17150F" />
        {Mark}
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      {Mark}
    </svg>
  );
}

/**
 * The ring and the wordmark. Height is em-based so callers size the lockup
 * with a text utility.
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
        x="35"
        y="21.5"
        fontFamily="Geist, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
        fontSize="16.5"
        fontWeight="600"
        letterSpacing="2.6"
        fill="currentColor"
      >
        GENOSYN
      </text>
    </svg>
  );
}
