import React from "react";
import { Button } from "@/components/ui/Button";
import { FormError, FormSuccess } from "@/components/ui/FormError";
import { Link } from "react-router-dom";
import { AlertTriangle, ShieldCheck, Upload } from "lucide-react";
import { api, type BackupSchedule, type BackupVerification } from "@/lib/api";
import { advancedSummary, formatWhenInline, retentionSentence } from "@/lib/backupStatus";
import { errorMessage } from "@/lib/errors";
import { Disclosure } from "@/components/ui/Disclosure";
import { Spinner } from "@/components/ui/Spinner";
import { clsx } from "@/components/ui/clsx";
import { TONE_TEXT, SectionError } from "./ui";

/**
 * Admin → Backups, behind one closed disclosure: retention, daily verification,
 * uploading a backup made elsewhere, failure emails, and where the files are.
 */

export function AdvancedSection({
  companySlug,
  schedule,
  scheduleError,
  onRetrySchedule,
  onScheduleSaved,
  verification,
  verificationError,
  onRetryVerification,
  onVerified,
  onUploaded,
  now,
}: {
  companySlug: string;
  schedule: BackupSchedule | null;
  scheduleError: string | null;
  onRetrySchedule: () => void;
  onScheduleSaved: (schedule: BackupSchedule) => Promise<void>;
  verification: BackupVerification | null | undefined;
  verificationError: string | null;
  onRetryVerification: () => void;
  onVerified: (verification: BackupVerification) => Promise<void>;
  onUploaded: () => Promise<void>;
  now: Date;
}) {
  return (
    <Disclosure
      title="Advanced"
      summary={advancedSummary(schedule, verification, now) || "Loading…"}
      variant="card"
      heading="h2"
    >
      <div className="flex flex-col divide-y divide-slate-100 dark:divide-slate-800">
        <AdvancedPart title="How long backups are kept" first>
          {schedule ? (
            <RetentionForm schedule={schedule} onSaved={onScheduleSaved} />
          ) : scheduleError ? (
            <SectionError message={scheduleError} onRetry={onRetrySchedule} />
          ) : (
            <Spinner />
          )}
        </AdvancedPart>
        <AdvancedPart title="Daily verification">
          <VerificationPanel
            verification={verification}
            error={verificationError}
            onRetry={onRetryVerification}
            onVerified={onVerified}
            now={now}
          />
        </AdvancedPart>
        <AdvancedPart title="Restore a backup made elsewhere">
          <UploadPanel onUploaded={onUploaded} />
        </AdvancedPart>
        <AdvancedPart title="Failure emails">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            When a backup can&apos;t be copied off-box, or daily verification finds one missing,
            every master admin is emailed: when it starts, at most once a day while it lasts, and
            once more when it is fixed. Emails go out through{" "}
            <Link
              to={`/c/${companySlug}/admin/email`}
              className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
            >
              Admin → Email transport
            </Link>
            ; without one set up, they only reach the server log.
          </p>
        </AdvancedPart>
        <AdvancedPart title="Where backups are kept on this server">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            In the{" "}
            <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
              Backup/
            </code>{" "}
            folder of the data directory, as{" "}
            <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
              .zip
            </code>{" "}
            files. Each one holds the whole install, including the key that decrypts its saved
            passwords, so keep copies somewhere only you can reach. The{" "}
            <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
              genosyn
            </code>{" "}
            command on the server has its own:{" "}
            <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
              genosyn backup
            </code>{" "}
            writes the whole data volume to a file on the server, and{" "}
            <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
              genosyn restore
            </code>{" "}
            puts one back. Those files don&apos;t appear in History.
          </p>
        </AdvancedPart>
      </div>
    </Disclosure>
  );
}

function AdvancedPart({
  title,
  first,
  children,
}: {
  title: string;
  first?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={clsx("flex flex-col gap-3", first ? "pb-5" : "py-5 last:pb-0")}>
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
      {children}
    </section>
  );
}

function RetentionForm({
  schedule,
  onSaved,
}: {
  schedule: BackupSchedule;
  onSaved: (schedule: BackupSchedule) => Promise<void>;
}) {
  const [draft, setDraft] = React.useState(schedule);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  React.useEffect(() => setDraft(schedule), [schedule]);

  const dirty =
    draft.retentionEnabled !== schedule.retentionEnabled ||
    draft.retentionDays !== schedule.retentionDays ||
    draft.offBoxRetentionEnabled !== schedule.offBoxRetentionEnabled ||
    draft.offBoxRetentionDays !== schedule.offBoxRetentionDays;

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!dirty) return;
    setSaving(true);
    setError(null);
    setNote(null);
    try {
      const saved = await api.put<BackupSchedule>("/api/backups/schedule", {
        retentionEnabled: draft.retentionEnabled,
        retentionDays: draft.retentionDays,
        offBoxRetentionEnabled: draft.offBoxRetentionEnabled,
        offBoxRetentionDays: draft.offBoxRetentionDays,
      });
      await onSaved(saved);
      if (saved.prunedNow) {
        setNote(
          `Saved. ${saved.prunedNow} old backup${saved.prunedNow === 1 ? " was" : "s were"} deleted from this server.`,
        );
      }
    } catch (err) {
      setError(errorMessage(err, "Couldn't save how long backups are kept."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={save}>
      <RetentionPolicy
        title="On this server"
        enabled={draft.retentionEnabled}
        days={draft.retentionDays}
        onChange={(enabled, days) =>
          setDraft({ ...draft, retentionEnabled: enabled, retentionDays: days })
        }
        note="Checked every hour and after every backup. The newest backup is always kept, however old, and backups you uploaded are never deleted."
      />
      <RetentionPolicy
        title="On off-box destinations"
        enabled={draft.offBoxRetentionEnabled}
        days={draft.offBoxRetentionDays}
        onChange={(enabled, days) =>
          setDraft({ ...draft, offBoxRetentionEnabled: enabled, offBoxRetentionDays: days })
        }
        note="Applied each time a backup is copied to a destination; the copy just made is always kept. Only Genosyn's own backup-….zip files are deleted there."
      />
      <FormError message={error} />
      <FormSuccess message={note} />
      <div className="flex items-center justify-end gap-3">
        {dirty && (
          <span className="text-xs text-slate-500 dark:text-slate-400">Unsaved changes</span>
        )}
        <Button type="submit" size="sm" loading={saving} disabled={!dirty}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

function RetentionPolicy({
  title,
  enabled,
  days,
  onChange,
  note,
}: {
  title: string;
  enabled: boolean;
  days: number;
  onChange: (enabled: boolean, days: number) => void;
  note: string;
}) {
  const daysId = React.useId();
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {title}
      </legend>
      <div className="flex flex-wrap items-center gap-2 text-sm text-slate-800 dark:text-slate-100">
        <label className="inline-flex items-center gap-2">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-600"
            checked={enabled}
            onChange={(e) => onChange(e.target.checked, days)}
          />
          Delete backups older than
        </label>
        <input
          id={daysId}
          type="number"
          min={1}
          max={3650}
          aria-label={`Days to keep backups ${title.toLowerCase()}`}
          className="h-9 w-20 rounded-lg border border-slate-200 bg-white px-2 text-sm tabular-nums shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900"
          value={days}
          onChange={(e) => onChange(enabled, parseInt(e.target.value, 10) || 30)}
          disabled={!enabled}
        />
        <label htmlFor={daysId}>days</label>
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {retentionSentence(enabled, days)}. {note}
      </p>
    </fieldset>
  );
}

function VerificationPanel({
  verification,
  error,
  onRetry,
  onVerified,
  now,
}: {
  verification: BackupVerification | null | undefined;
  error: string | null;
  onRetry: () => void;
  onVerified: (verification: BackupVerification) => Promise<void>;
  now: Date;
}) {
  const [verifying, setVerifying] = React.useState(false);
  const [verifyError, setVerifyError] = React.useState<string | null>(null);
  const verify = async () => {
    setVerifying(true);
    setVerifyError(null);
    try {
      const result = await api.post<{ verification: BackupVerification }>(
        "/api/backups/verification",
      );
      await onVerified(result.verification);
    } catch (err) {
      setVerifyError(errorMessage(err, "Couldn't verify the backups."));
    } finally {
      setVerifying(false);
    }
  };
  const problems = verification ? verification.areas.flatMap((area) => area.problems).length : 0;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-slate-600 dark:text-slate-300">
        Every day, a few hours after the scheduled backup, Genosyn verifies that each backup the
        schedule and retention promise is really there: on this server, where each one must also
        open, and on every off-box destination. It also records what it finds on each destination in
        History.
      </p>
      {verification === undefined ? (
        error ? (
          <SectionError message={error} onRetry={onRetry} />
        ) : (
          <Spinner />
        )
      ) : verification === null ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Not run yet. The first one runs within the hour, or press Verify now.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <p
            className={clsx(
              "flex flex-wrap items-center gap-1.5 text-sm font-medium",
              problems === 0 ? TONE_TEXT.ok : TONE_TEXT.error,
            )}
          >
            {problems === 0 ? (
              <ShieldCheck size={14} aria-hidden />
            ) : (
              <AlertTriangle size={14} aria-hidden />
            )}
            <span>
              {problems === 0
                ? "Every backup is in place"
                : `${problems} problem${problems === 1 ? "" : "s"} found`}
            </span>
            <span className="font-normal text-slate-500 dark:text-slate-400">
              · verified {formatWhenInline(verification.verifiedAt, now)}
            </span>
          </p>
          <ul className="flex flex-col gap-2">
            {verification.areas.map((area) => (
              <li key={area.id} className="text-xs">
                <span className="font-medium text-slate-800 dark:text-slate-100">{area.title}</span>
                <span className="text-slate-500 dark:text-slate-400"> · {area.summary}</span>
                {area.problems.length > 0 && (
                  <ul className="mt-1 space-y-0.5 border-l-2 border-rose-200 pl-2.5 dark:border-rose-500/30">
                    {area.problems.map((problem) => (
                      <li
                        key={problem.key}
                        className={clsx(
                          "break-words",
                          problem.severity === "error" ? TONE_TEXT.error : TONE_TEXT.warn,
                        )}
                      >
                        {problem.message}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <FormError message={verifyError} />
      <div>
        <Button size="sm" variant="secondary" onClick={verify} loading={verifying}>
          <ShieldCheck size={12} />
          {verifying ? "Verifying…" : "Verify now"}
        </Button>
      </div>
    </div>
  );
}

function UploadPanel({ onUploaded }: { onUploaded: () => Promise<void> }) {
  const input = React.useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);

  const upload = async (file: File) => {
    setUploading(true);
    setError(null);
    setNote(null);
    try {
      const response = await fetch("/api/backups/upload", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/zip" },
        body: file,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        let message = response.statusText || `Upload failed (${response.status})`;
        try {
          message = (JSON.parse(text) as { error?: string }).error ?? message;
        } catch {
          // An HTML error page from a proxy: the status says more.
        }
        throw new Error(message);
      }
      await onUploaded();
      setNote("Uploaded. It is at the top of History, ready to restore.");
    } catch (err) {
      setError(errorMessage(err, "Couldn't upload the backup."));
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-slate-600 dark:text-slate-300">
        Upload a backup{" "}
        <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
          .zip
        </code>{" "}
        downloaded from this or another Genosyn install, up to 2 GB. It appears in History, where
        you can restore it. Uploaded backups are never deleted by retention.
      </p>
      <input
        ref={input}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        aria-label="Backup file to upload"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      <FormError message={error} />
      <FormSuccess message={note} />
      <div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => input.current?.click()}
          loading={uploading}
        >
          <Upload size={12} />
          {uploading ? "Uploading…" : "Upload a backup"}
        </Button>
      </div>
    </div>
  );
}
