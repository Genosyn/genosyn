export type MarkState = "run" | "decision" | "approval" | "standdown";

/**
 * The four state marks.
 *
 * One square, drawn four ways, at a 1.25px stroke with square caps and no
 * rounding. They replace ninety-odd decorative glyphs and every pastel icon
 * tile the site used to carry, and unlike those they mean something:
 *
 *   RUN        a closed square. Bounded work that finished.
 *   DECISION   the right edge is missing. It is open, waiting on a person.
 *   APPROVAL   a bar across the middle. The system interposed a gate.
 *   STANDDOWN  a diagonal. Out of service — the same convention as the 45°
 *              hatch in index.css, at glyph size.
 *
 * The Decision / Approval pair is the point. AGENTS.md §3 spends a long
 * paragraph insisting those are not synonyms — a Decision is the employee
 * choosing to stop and ask, an Approval is the system stopping an action the
 * employee already attempted — and every other product collapses them. Here
 * the distinction is in the geometry rather than in a caption underneath it:
 * one shape is open because it is waiting, the other is barred because
 * something got in the way.
 *
 * They are `aria-hidden` by default because they almost always sit beside the
 * word they encode. Pass a `label` on the rare occasion the mark is alone.
 */
export function Mark({
  state,
  label,
  className = "",
}: {
  state: MarkState;
  label?: string;
  className?: string;
}) {
  const box = "M1.5 1.5 H10.5 V10.5 H1.5 Z";
  const paths: Record<MarkState, string[]> = {
    run: [box],
    // Open on the right: top edge leftwards, down the left, back along the
    // bottom — and stop, leaving the right edge undrawn.
    decision: ["M10.5 1.5 H1.5 V10.5 H10.5"],
    approval: [box, "M1.5 6 H10.5"],
    standdown: [box, "M1.5 1.5 L10.5 10.5"],
  };

  return (
    <svg
      viewBox="0 0 12 12"
      xmlns="http://www.w3.org/2000/svg"
      className={`shrink-0 ${className}`}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {paths[state].map((d) => (
        <path
          key={d}
          d={d}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinecap="square"
        />
      ))}
    </svg>
  );
}

/**
 * A right arrow, drawn rather than typed.
 *
 * U+2192 is not in the latin subset Google serves for Archivo or Martian Mono
 * (it covers U+2191, U+2193 and U+2212 and stops there), so a literal → falls
 * back to a system face and changes width mid-line. Every rightward arrow on
 * the site comes from here. A downward one can be typed, and is.
 */
export function ArrowEast({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 12 12"
      xmlns="http://www.w3.org/2000/svg"
      className={`shrink-0 ${className}`}
      aria-hidden="true"
    >
      <path
        d="M1 6 H10.5 M7 2.5 L10.5 6 L7 9.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="square"
      />
    </svg>
  );
}
