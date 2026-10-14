import { Link } from "react-router-dom";
import { ArrowRight, MessageSquareText } from "lucide-react";
import { MAX_INITIATIVE_REQUEST_LENGTH } from "@/lib/initiativePrompt";
import { useInitiativeRequest } from "@/lib/useInitiativeRequest";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormError } from "@/components/ui/FormError";
import { Modal } from "@/components/ui/Modal";
import { submitFormOnModEnter } from "@/lib/keyboard";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { ExistingDraftNote } from "@/components/proactive/ExistingDraftNote";
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
  const {
    employeeId,
    setEmployeeId,
    employee,
    request,
    setRequest,
    unsentDraft,
    canContinue,
    opening,
    error,
    continueToChat,
  } = useInitiativeRequest({ companyId, companySlug, employees });

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
          <Button type="submit" loading={opening} disabled={!canContinue} aria-busy={opening}>
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

          {employee?.chatReady && unsentDraft && (
            <ExistingDraftNote
              employeeName={employee.name}
              chatPath={`/c/${companySlug}/employees/${employee.slug}/chat`}
            />
          )}

          <Textarea
            label="What should become standing work?"
            value={request}
            onChange={(event) => setRequest(event.target.value)}
            onKeyDown={submitFormOnModEnter}
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
