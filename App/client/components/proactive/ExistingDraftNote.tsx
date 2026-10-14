import { Link } from "react-router-dom";

/**
 * Why a request cannot become a new Chat draft yet: the employee's Chat
 * already holds one nobody sent, and a second would replace it.
 */
export function ExistingDraftNote({
  employeeName,
  chatPath,
}: {
  employeeName: string;
  chatPath: string;
}) {
  return (
    <div
      role="status"
      className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
    >
      {employeeName} already has an unsent Chat draft. Open Chat to send or clear it before starting
      another request.{" "}
      <Link className="font-medium underline" to={chatPath}>
        Open existing draft
      </Link>
    </div>
  );
}
