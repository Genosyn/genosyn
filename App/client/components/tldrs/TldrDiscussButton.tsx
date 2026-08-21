import React from "react";
import { LoaderCircle, MessageSquare } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { useDialog } from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/Toast";
import { api, type Company, type Employee, type TldrItem } from "@/lib/api";
import { useChatSessions } from "@/lib/chatSessions";
import { tldrDiscussionStarterPrompt } from "@/lib/tldrDiscussion";

/** Start a fresh, private direct-chat thread with the employee who wrote a TLDR. */
export function TldrDiscussButton({
  company,
  item,
  compact = false,
}: {
  company: Pick<Company, "id" | "slug">;
  item: TldrItem;
  compact?: boolean;
}) {
  const navigate = useNavigate();
  const { sessions, actions } = useChatSessions();
  const dialog = useDialog();
  const { toast } = useToast();
  const [opening, setOpening] = React.useState(false);
  const employeeId = item.employee.id;

  if (!employeeId) return null;

  async function openDiscussion() {
    if (opening) return;
    const existingDraft = sessions[employeeId!]?.input.trim() ?? "";
    if (
      existingDraft &&
      !(await dialog.confirm({
        title: "Replace chat draft?",
        message: `You have an unsent draft with ${item.employee.name || "this AI Employee"}. Starting a TLDR discussion will replace it.`,
        confirmLabel: "Replace draft",
        variant: "danger",
      }))
    ) {
      return;
    }

    setOpening(true);
    try {
      // The direct-chat send path creates this staged conversation lazily, so
      // opening a discussion and leaving does not leave an empty DB row.
      const employee = await api.get<Employee>(
        `/api/companies/${company.id}/employees/${employeeId!}`,
      );
      await actions.stageNewConversation(
        company.id,
        employeeId!,
        tldrDiscussionStarterPrompt(item, company.slug),
      );
      navigate(`/c/${company.slug}/employees/${employee.slug}/chat`);
    } catch (error) {
      toast(
        `Couldn’t open the TLDR discussion: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
        "error",
      );
      setOpening(false);
    }
  }

  const label = compact ? "Discuss" : `Discuss with ${item.employee.name || "AI Employee"}`;

  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      disabled={opening}
      onClick={() => void openDiscussion()}
      className={compact ? undefined : "max-w-full"}
      aria-label={`Discuss this TLDR with ${item.employee.name || "the AI Employee"}`}
      title={`Start a new private conversation with ${item.employee.name || "this AI Employee"}`}
    >
      {opening ? (
        <LoaderCircle size={14} className="motion-safe:animate-spin" aria-hidden="true" />
      ) : (
        <MessageSquare size={14} aria-hidden="true" />
      )}
      <span className={compact ? undefined : "min-w-0 truncate"}>
        {opening ? "Opening…" : label}
      </span>
    </Button>
  );
}
