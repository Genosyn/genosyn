import React from "react";
import { MessageSquare } from "lucide-react";
import { useNavigate } from "react-router-dom";
import type { Company, HomeApproval } from "@/lib/api";
import { useChatSessions } from "@/lib/chatSessions";
import { errorMessage } from "@/lib/errors";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Spinner } from "@/components/ui/Spinner";

/** Open a draft conversation tied to the exact review; no message is sent automatically. */
export function ApprovalDiscussButton({
  company,
  approval,
  label = "Ask employee",
  disabled = false,
}: {
  company: Company;
  approval: HomeApproval;
  label?: string;
  disabled?: boolean;
}) {
  const navigate = useNavigate();
  const { actions } = useChatSessions();
  const [opening, setOpening] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const openingRef = React.useRef(false);

  async function discuss() {
    if (!approval.employee || disabled || openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    setError(null);
    try {
      // The saved review can contain customer-controlled prose. Never promote
      // any of it into a Member-authored chat message: the restricted server
      // source reloads the bound card as explicitly untrusted tool data.
      const starterPrompt = [
        `Update [Review](/c/${company.slug}/decisions#review-${approval.id}).`,
        "",
        "Requested changes: ",
      ].join("\n");
      const staged = await actions.stageNewConversation(
        company.id,
        approval.employee.id,
        starterPrompt,
      );
      if (staged) navigate(`/c/${company.slug}/employees/${approval.employee.slug}/chat`);
    } catch (err) {
      setError(errorMessage(err, "Could not open the conversation"));
    } finally {
      openingRef.current = false;
      setOpening(false);
    }
  }

  return (
    <div>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={disabled || opening || !approval.employee}
        onClick={() => void discuss()}
        aria-busy={opening}
      >
        {opening ? <Spinner size={14} /> : <MessageSquare size={14} />}
        {label}
      </Button>
      <FormError message={error} className="mt-2" />
    </div>
  );
}
