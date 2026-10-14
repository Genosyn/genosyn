import React from "react";
import { useNavigate } from "react-router-dom";
import { useChatSessions } from "./chatSessions";
import { errorMessage } from "./errors";
import { buildInitiativeRequestPrompt } from "./initiativePrompt";

/**
 * Asking an AI Employee for standing work, in the one way the product does it:
 * the request goes into a new Chat as an unsent draft, scoped to filing one
 * Initiative, and the Member reads it there before sending anything. Ask AI
 * Employee on Proactive and New routine both use it, so the rules below cannot
 * drift apart.
 */

/** What the hand-off needs of an AI Employee; the roster and the Proactive overview both carry it. */
export type InitiativeAsk = {
  id: string;
  name: string;
  slug: string;
  /** At least one connected AI Model can answer an interactive Chat. */
  chatReady?: boolean;
};

/**
 * Who a request starts out addressed to: the preferred employee when they can
 * be asked, otherwise the only one there is, otherwise nobody yet. A company
 * with one AI Employee has nobody else to ask.
 */
export function startingEmployeeId(
  employees: Pick<InitiativeAsk, "id">[],
  preferredId?: string | null,
): string {
  if (preferredId && employees.some((entry) => entry.id === preferredId)) return preferredId;
  return employees.length === 1 ? employees[0].id : "";
}

/**
 * Whether the request may go to Chat now: someone is chosen whose AI Model can
 * answer, there is something to say, and their Chat does not already hold an
 * unsent draft that opening a new one would bury.
 */
export function canHandToChat(input: {
  employee: Pick<InitiativeAsk, "chatReady"> | undefined;
  unsentDraft: boolean;
  request: string;
}): boolean {
  return Boolean(input.employee?.chatReady && !input.unsentDraft && input.request.trim());
}

export function useInitiativeRequest<E extends InitiativeAsk>({
  companyId,
  companySlug,
  employees,
  preferredEmployeeId,
}: {
  companyId: string;
  companySlug: string;
  /** The employees on offer. Whoever is listed here can be chosen. */
  employees: E[];
  /** Chosen to begin with when they are on offer, as when a list was narrowed to them. */
  preferredEmployeeId?: string | null;
}) {
  const navigate = useNavigate();
  const { sessions, actions } = useChatSessions();
  // Null until the Member chooses, so the starting choice follows the list
  // rather than whatever it held when this first rendered.
  const [picked, setPicked] = React.useState<string | null>(null);
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

  const employeeId = picked ?? startingEmployeeId(employees, preferredEmployeeId);
  const employee = employees.find((entry) => entry.id === employeeId);
  const unsentDraft = Boolean(employee && sessions[employee.id]?.input.trim());
  const canContinue = canHandToChat({ employee, unsentDraft, request });

  /** Stage the request as a draft in a new Chat and open it. Nothing is sent. */
  async function continueToChat(event?: React.FormEvent) {
    event?.preventDefault();
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

  return {
    employeeId,
    setEmployeeId: setPicked,
    employee,
    request,
    setRequest,
    /** The chosen employee's Chat already holds a draft nobody has sent. */
    unsentDraft,
    canContinue,
    opening,
    error,
    continueToChat,
  };
}
