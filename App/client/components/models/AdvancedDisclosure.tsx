import React from "react";
import { Disclosure } from "../ui/Disclosure";

/**
 * The single "Advanced" disclosure a model section keeps for what most people
 * never touch. Closed until opened, so the page is just the answer to "is it
 * connected?" — and the closed line is honest about what is inside: it names
 * anything moved off its default, so a setting that matters is never invisible
 * just because it is folded away.
 *
 * `summary` is that line, empty when nothing is changed; `hint` stands in for it
 * then, saying what a person would find by opening it. The content stays
 * mounted while closed, as the panels inside keep their own state.
 */
export function AdvancedDisclosure({
  summary,
  hint,
  children,
}: {
  summary: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <Disclosure variant="card" title="Advanced" summary={summary || hint} keepMounted>
      <div className="flex flex-col gap-4">{children}</div>
    </Disclosure>
  );
}
