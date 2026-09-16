import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, MessageSquareText } from "lucide-react";
import {
  buildInitiativeRequestPrompt,
  MAX_INITIATIVE_REQUEST_LENGTH,
} from "@/lib/initiativePrompt";
import { useChatSessions } from "@/lib/chatSessions";
import { errorMessage } from "@/lib/errors";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormError } from "@/components/ui/FormError";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import type { ProactiveEmployee } from "../../../shared/proactive";

/**
 * Hand a reviewed draft to ordinary Employee Chat. Opening this modal and
 * continuing never sends a model turn: the Member sees the full request in
 * a new Chat composer first, scoped to filing one inert Initiative.
 */
export function AskEmployeeModal({
  companyId,
  companySlug,
  employees,
  onClose,
}: {
  companyId: string;
  companySlug: string;
  employees: ProactiveEmployee[];
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { sessions, actions } = useChatSessions();
  const [employeeId, setEmployeeId] = React.useState("");
  const [request, setRequest] = React.useState("");
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
  const employee = employees.find((entry) => entry.id === employeeId);
  const existingDraft = employee ? sessions[employee.id]?.input.trim() : "";
  const canContinue = Boolean(employee?.chatReady && !existingDraft && request.trim());

  async function continueToChat(event: React.FormEvent) {
    event.preventDefault();
    if (!employee || !canContinue || openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    setError(null);
    try {
      const staged = await actions.stageNewConversation(
        companyId,
        employee.id,
        buildInitiativeRequestPrompt(request),
      );
      if (staged && mounted.current) {
        navigate(`/c/${companySlug}/employees/${employee.slug}/chat`);
      }
    } catch (err) {
      if (mounted.current) setError(errorMessage(err, "Could not open Chat"));
    } finally {
      openingRef.current = false;
      if (mounted.current) setOpening(false);
    }
  }

  return (
    <Modal
      open
      onClose={() => {
        if (!opening) onClose();
      }}
      title="Ask an AI Employee"
      description="Open a draft request in Chat. Nothing is sent yet."
      size="lg"
      onSubmit={continueToChat}
      footer={
        <>
          <Button type="button" variant="secondary" disabled={opening} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canContinue || opening} aria-busy={opening}>
            {opening ? "Opening Chat…" : "Continue to Chat"}{" "}
            <ArrowRight size={16} aria-hidden="true" />
          </Button>
        </>
      }
    >
      {employees.length === 0 ? (
        <EmptyState
          title="No AI Employees yet"
          description="Create an AI Employee first, then ask them to investigate and propose standing work."
          action={
            <Link
              className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
              to={`/c/${companySlug}/employees/new`}
            >
              Create an AI Employee
            </Link>
          }
        />
      ) : (
        <div className="space-y-5">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900/60">
            <div className="flex gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white text-indigo-600 shadow-sm dark:bg-slate-950 dark:text-indigo-400">
                <MessageSquareText size={18} aria-hidden="true" />
              </span>
              <div>
                <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  You stay in control
                </p>
                <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                  The employee investigates your request and may propose one Initiative. No Routine
                  exists until an owner or admin reviews and accepts it.
                </p>
              </div>
            </div>
          </div>

          <Select
            label="AI Employee"
            value={employeeId}
            onChange={(event) => setEmployeeId(event.target.value)}
            required
          >
            <option value="">Choose an AI Employee</option>
            {employees.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
                {entry.chatReady ? "" : " — AI Model not connected"}
              </option>
            ))}
          </Select>

          {employee && !employee.chatReady && (
            <div
              role="status"
              className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
            >
              Connect an AI Model before asking {employee.name}.{" "}
              <Link
                className="font-medium underline"
                to={`/c/${companySlug}/employees/${employee.slug}/settings/model`}
              >
                Open Model settings
              </Link>
            </div>
          )}

          {employee?.chatReady && existingDraft && (
            <div
              role="status"
              className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
            >
              {employee.name} already has an unsent Chat draft. Open Chat to send or clear it before
              starting another request.{" "}
              <Link
                className="font-medium underline"
                to={`/c/${companySlug}/employees/${employee.slug}/chat`}
              >
                Open existing draft
              </Link>
            </div>
          )}

          <Textarea
            label="What should become standing work?"
            value={request}
            onChange={(event) => setRequest(event.target.value)}
            maxLength={MAX_INITIATIVE_REQUEST_LENGTH}
            placeholder="For example: Every Monday, review open customer commitments and propose the follow-ups that need an owner."
            hint="Describe the outcome and timing. The employee will inspect existing Routines and Initiatives before proposing anything."
            required
            autoFocus
          />

          <FormError message={error} />
        </div>
      )}
    </Modal>
  );
}
