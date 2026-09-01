import React from "react";
import { Link } from "react-router-dom";
import { ExternalLink } from "lucide-react";

import { HealthCheckDetail } from "@/components/health/HealthCheckDetail";
import { Button, buttonClassName } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { api } from "@/lib/api";
import type { Company, SystemHealthReport } from "@/lib/api";
import { errorMessage } from "@/lib/errors";

/**
 * One failing System Health check, opened from Home.
 *
 * The Home payload carries only `{id, title, severity, count}` — the summary
 * roll-up deliberately skips materialising the rows — so the number on the
 * card is all a member can see without leaving. This fetches the full report
 * and shows the rows behind the number, each still deep-linking to the thing
 * that needs fixing.
 *
 * Fetched on every open rather than cached: a health panel reporting yesterday's
 * state is the one thing worse than no health panel.
 */

export function HealthCheckPeekModal({
  company,
  checkId,
  title,
  onClose,
  onDismiss,
}: {
  company: Company;
  checkId: string;
  /** From the Home row, so the modal has a title before the fetch lands. */
  title: string;
  onClose: () => void;
  /** Hide this check on this device, the same "I've seen it" the row offers. */
  onDismiss: () => void;
}) {
  const [report, setReport] = React.useState<SystemHealthReport | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<SystemHealthReport>(
          `/api/companies/${company.id}/system-health`,
        );
        if (!cancelled) setReport(data);
      } catch (err) {
        if (!cancelled) setLoadError(errorMessage(err, "Could not load system health"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [company.id]);

  const check = report?.checks.find((c) => c.id === checkId) ?? null;

  return (
    <Modal
      open
      onClose={onClose}
      title={check?.title ?? title}
      description={check?.description}
      size="lg"
      footer={
        <>
          <Link
            to={`/c/${company.slug}/settings/system-health`}
            className={buttonClassName({ variant: "secondary", size: "sm" })}
            onClick={onClose}
          >
            <ExternalLink size={14} /> All checks
          </Link>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              onDismiss();
              onClose();
            }}
          >
            Dismiss on this device
          </Button>
        </>
      }
    >
      {loadError ? (
        <FormError message={loadError} />
      ) : report === null ? (
        <div className="flex min-h-[10rem] items-center justify-center">
          <Spinner size={20} />
        </div>
      ) : check === null ? (
        <p className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
          This check has recovered since Home loaded. Nothing is failing here now.
        </p>
      ) : (
        <HealthCheckDetail check={check} showHeading={false} onItemLink={onClose} />
      )}
    </Modal>
  );
}
