type LogoMarkProps = {
  className?: string;
  variant?: "tile" | "plain";
};

/**
 * Genosyn mark — the 09:30 square.
 *
 * A 24×24 square cut once at 39.583% of its width, which is 09:30 of 24
 * hours. The left field is solid: the night, already worked. The right field
 * is open: your day, which has not happened yet. It is the same idea the
 * whole site is drawn on, at favicon size, and it shares its geometry and its
 * 2px stroke with the four state marks in components/Marks.tsx.
 *
 * The previous mark was a stroked circle, which is to say it was a shape with
 * nothing to do with the product. This one can be explained in a sentence.
 *
 * `variant="plain"` (default) draws in `currentColor` so the lockup adapts to
 * whatever it sits in. `variant="tile"` fills the square for constrained slots
 * (favicons) and puts the cut in signal amber, which is the only place the
 * mark carries the hue.
 */
export function LogoMark({ className = "", variant = "plain" }: LogoMarkProps) {
  if (variant === "tile") {
    return (
      <svg
        viewBox="0 0 24 24"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        aria-hidden="true"
      >
        <rect width="24" height="24" fill="#111110" />
        <rect x="4" y="4" width="16" height="16" fill="none" stroke="#fbfaf7" strokeWidth="2" />
        <rect x="4" y="4" width="6.33" height="16" fill="#fbfaf7" />
        <rect x="10.33" y="4" width="1.6" height="16" fill="#ffb000" />
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <rect
        x="1"
        y="1"
        width="22"
        height="22"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <rect x="2" y="2" width="8.7" height="20" fill="currentColor" />
    </svg>
  );
}

/**
 * Genosyn lockup — the mark plus the wordmark.
 *
 * The wordmark is live HTML text rather than an SVG `<text>` node, which is
 * how it used to be drawn. An SVG `<text>` carrying an explicit `font-family`
 * silently renders in a fallback face for as long as the webfont has not
 * arrived, and at a *different* width, so the logo used to reflow the header
 * on every cold load. As HTML it participates in the normal font stack and
 * the `display=swap` behaviour every other string on the page gets.
 *
 * Sized by `font-size`, not height: pass a text size (the mark scales with
 * it via `em`). Colour comes from `currentColor` as before.
 */
export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-[0.55em] ${className}`}>
      <LogoMark className="h-[1.15em] w-[1.15em] shrink-0" />
      <span className="t-cond text-[1em] uppercase leading-none tracking-[0.2em]">Genosyn</span>
    </span>
  );
}
