/**
 * The closed Advanced line on Settings → Company: the company's web address
 * and whether two-factor sign-in is required. Both are rarely changed, so they
 * sit behind one disclosure, and both are always named on its line so neither
 * is invisible while it is shut (AGENTS.md §8).
 *
 *   { slug: "acme", requireTwoFactor: false } → "Web address /c/acme · Two-factor sign-in optional"
 */
export function describeCompanyAdvanced(values: {
  /** The address as typed, already normalized; empty while it is being cleared. */
  slug: string;
  requireTwoFactor: boolean;
}): string {
  return [
    `Web address /c/${values.slug || "…"}`,
    values.requireTwoFactor ? "Two-factor sign-in required" : "Two-factor sign-in optional",
  ].join(" · ");
}
