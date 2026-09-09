import React from "react";
import { MessageSquare } from "lucide-react";
import { useNavigate } from "react-router-dom";
import type { Company, Decision } from "@/lib/api";
import { useChatSessions } from "@/lib/chatSessions";
import { errorMessage } from "@/lib/errors";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Spinner } from "@/components/ui/Spinner";

/** Stage a private conversation with the asker; choosing an option stays on the card. */
export function DecisionDiscussButton({
  company,
  decision,
  disabled = false,
}: {
  company: Company;
  decision: Decision;
  disabled?: boolean;
}) {
  const navigate = useNavigate();
  const { actions } = useChatSessions();
  const [opening, setOpening] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const openingRef = React.useRef(false);
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function discuss() {
    if (!decision.employee || disabled || openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    setError(null);
    try {
      // The link selects server-owned context. Employee-authored decision text
      // must not become a Member instruction or enter an unrelated conversation.
      const staged = await actions.stageNewConversation(
        company.id,
        decision.employee.id,
        `Discuss [Decision](/c/${company.slug}/decisions#decision-${decision.id})\n\n` +
          (decision.status === "pending"
            ? "Help me understand this decision and the trade-offs before I choose an option."
            : "Help me understand this decision and its outcome."),
      );
      if (staged && mounted.current) {
        navigate(`/c/${company.slug}/employees/${decision.employee.slug}/chat`);
      }
    } catch (err) {
      if (mounted.current) setError(errorMessage(err, "Could not open the discussion"));
    } finally {
      openingRef.current = false;
      if (mounted.current) setOpening(false);
    }
  }

  return (
    <div>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={disabled || opening || !decision.employee}
        onClick={() => void discuss()}
        title={
          decision.employee
            ? `Ask ${decision.employee.name} about this decision`
            : "The employee who asked this decision has been deleted"
        }
        aria-busy={opening}
      >
        {opening ? <Spinner size={14} /> : <MessageSquare size={14} />}
        Discuss
      </Button>
      <FormError message={error} className="mt-2" />
    </div>
  );
}
