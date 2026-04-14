type LogoMarkProps = {
  className?: string;
  variant?: "tile" | "plain";
};

/**
 * Genosyn mark: a geometric G drawn as a 270° arc with an inward tongue,
 * plus a small "seed" dot inside the opening — an AI employee emerging
 * from the company. Tile variant is the primary app-icon form; plain uses
 * currentColor so it can sit inline in any colored surface.
 */
export function LogoMark({ className = "", variant = "tile" }: LogoMarkProps) {
  if (variant === "tile") {
    return (
      <svg
        viewBox="0 0 32 32"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        aria-hidden="true"
      >
        <rect width="32" height="32" rx="8" fill="#4f46e5" />
        <path
          d="M16 9 A7 7 0 1 0 23 16 L18.5 16"
          fill="none"
          stroke="#ffffff"
          strokeWidth="2.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="20" cy="11.5" r="1.5" fill="#ffffff" fillOpacity="0.55" />
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
      <path
        d="M16 9 A7 7 0 1 0 23 16 L18.5 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="20" cy="11.5" r="1.5" fill="currentColor" />
    </svg>
  );
}
