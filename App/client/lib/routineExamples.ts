/**
 * Starting points for "What should happen, and how often?" on the New routine
 * page. Each is a whole request, the way a person would say it to a colleague:
 * the work and how often. A chip fills the box with it, and the person then
 * changes it to fit the company.
 */
export type RoutineExample = {
  /** The chip. */
  label: string;
  /** What the box holds after the chip is pressed. */
  request: string;
};

export const ROUTINE_EXAMPLES: readonly RoutineExample[] = [
  {
    label: "Morning email digest",
    request:
      "Every weekday morning, summarize the customer emails that arrived overnight and flag anything urgent.",
  },
  {
    label: "Weekly follow-ups",
    request:
      "Every Monday, review open customer commitments and propose the follow-ups that need an owner.",
  },
  {
    label: "Friday report",
    request:
      "Every Friday afternoon, write a short report on what the team finished this week and what is still open.",
  },
  {
    label: "Overdue invoices",
    request:
      "On the first of every month, list the invoices that are overdue and who should be reminded.",
  },
];

/**
 * Whether the chips are still worth showing: the box is empty, or holds one of
 * them untouched. Once the person has written their own words, pressing a chip
 * would replace them, so the chips step aside instead.
 */
export function examplesStayOnOffer(request: string): boolean {
  return request.trim() === "" || ROUTINE_EXAMPLES.some((example) => example.request === request);
}
