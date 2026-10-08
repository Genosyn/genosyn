import { MessageSquare } from "lucide-react";
import type { Decision } from "@/lib/api";
import { Button } from "@/components/ui/Button";

/**
 * Show or hide the Decision's discussion step, on the card itself. Choosing an
 * option stays a separate, explicit step on the same card.
 */
export function DecisionDiscussButton({
  decision,
  open,
  controls,
  onToggle,
  disabled = false,
}: {
  decision: Decision;
  open: boolean;
  /** Id of the discussion step this button shows. */
  controls: string;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      disabled={disabled || !decision.employee}
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      title={
        decision.employee
          ? `Ask ${decision.employee.name} about this decision`
          : "The employee who asked this decision has been deleted"
      }
    >
      <MessageSquare size={14} />
      {open ? "Hide discussion" : "Discuss"}
    </Button>
  );
}
