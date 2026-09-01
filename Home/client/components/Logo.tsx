type LogoMarkProps = {
  className?: string;
  variant?: "tile" | "plain";
};

/**
 * Genosyn mark — the circle.
 *
 * This is the original mark, restored. A previous revision replaced it with a
 * square cut at 39.583% (09:30 of 24 hours) to tie the mark to the site's
 * organising idea. That was a reasonable thing to draw and the wrong thing to
 * change: a logo is an identity people already recognise, not a slot for the
 * current design's argument, and a redesign does not get to rename the
 * company's face on its way past.
 *
 * `variant="plain"` (default) is a stroked circle in `currentColor`, so the
 * lockup adapts to whatever it sits in. `variant="tile"` fills a rounded
 * square behind it for constrained slots such as the favicon.
 *
 * The tile fill is the site's own black rather than the `#0f172a` it used to
 * be. That value was Tailwind's slate-900, a cool blue-black that appeared in
 * no token file and now sits against a warm palette, where it reads as a
 * different brand. The geometry, stroke weight and proportions are untouched.
 */
export function LogoMark({ className = "", variant = "plain" }: LogoMarkProps) {
  const fg = variant === "tile" ? "#fbfaf7" : "currentColor";

  const Mark = <circle cx="16" cy="16" r="9" fill="none" stroke={fg} strokeWidth="2.4" />;

  if (variant === "tile") {
    return (
      <svg
        viewBox="0 0 32 32"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        aria-hidden="true"
      >
        <rect width="32" height="32" rx="8" fill="#111110" />
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
      <LogoMark className="h-[1.3em] w-[1.3em] shrink-0" />
      <span className="t-field text-[1em] uppercase leading-none tracking-[0.2em]">Genosyn</span>
    </span>
  );
}
