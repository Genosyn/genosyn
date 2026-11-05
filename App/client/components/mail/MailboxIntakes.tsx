import React from "react";
import { Link, useParams } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { errorMessage } from "@/lib/errors";
import { mailApi, type ProjectIntakeRow } from "@/lib/mail";

/**
 * Which Projects take this mailbox's email as Todos. Intake is set on each Project,
 * because that's who owns the work, so this only says where it's on and goes there.
 */
export function MailboxIntakes({
  companyId,
  accountId,
}: {
  companyId: string;
  accountId: string;
}) {
  const { companySlug } = useParams<{ companySlug: string }>();
  const [rows, setRows] = React.useState<ProjectIntakeRow[] | null>(null);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const page = await mailApi.projectIntakes(companyId, accountId);
        if (cancelled) return;
        setRows(page.projects);
        setCursor(page.nextCursor);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err, "Could not load the Projects taking this email."));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId, accountId]);

  const showMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await mailApi.projectIntakes(companyId, accountId, cursor);
      setRows((current) => [...(current ?? []), ...page.projects]);
      setCursor(page.nextCursor);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, "Could not load more."));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="mt-4 border-t border-slate-100 pt-4 dark:border-slate-800">
      <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100">Filed as tasks</h3>
      <FormError message={error} className="mt-2" />
      {rows && rows.length === 0 && (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          No Project takes this mailbox&apos;s email yet. Turn it on under Email intake in a
          Project&apos;s settings.
        </p>
      )}
      {rows && rows.length > 0 && (
        <ul className="mt-2 space-y-1">
          {rows.map((row) => (
            <li key={row.projectId} className="text-xs text-slate-600 dark:text-slate-300">
              <Link
                to={`/c/${companySlug}/tasks/p/${row.projectSlug}`}
                className="font-medium text-indigo-600 hover:underline dark:text-indigo-300"
              >
                {row.projectName}
              </Link>
              {row.replyMode === "send" && " · replies without review"}
              {row.trustedSenderCount > 0 &&
                ` · ${row.trustedSenderCount} trusted sender${row.trustedSenderCount === 1 ? "" : "s"}`}
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="mt-2"
          loading={loadingMore}
          onClick={() => void showMore()}
        >
          Show more
        </Button>
      )}
    </div>
  );
}
