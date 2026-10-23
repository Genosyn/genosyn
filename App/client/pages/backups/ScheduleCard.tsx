import React from "react";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { FormError } from "@/components/ui/FormError";
import { api, type BackupFrequency, type BackupSchedule } from "@/lib/api";
import { describeSchedule, formatHour, formatNextRun } from "@/lib/backupStatus";
import { errorMessage } from "@/lib/errors";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { SectionError, Switch } from "./ui";

/** Admin → Backups: when Genosyn backs up on its own. */

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function ScheduleCard({
  schedule,
  error,
  onRetry,
  onSaved,
  now,
}: {
  schedule: BackupSchedule | null;
  error: string | null;
  onRetry: () => void;
  onSaved: (schedule: BackupSchedule) => void;
  now: Date;
}) {
  const [draft, setDraft] = React.useState<BackupSchedule | null>(schedule);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  React.useEffect(() => setDraft(schedule), [schedule]);

  const dirty =
    !!draft &&
    !!schedule &&
    (draft.enabled !== schedule.enabled ||
      draft.frequency !== schedule.frequency ||
      draft.hour !== schedule.hour ||
      draft.dayOfWeek !== schedule.dayOfWeek ||
      draft.dayOfMonth !== schedule.dayOfMonth);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft || !dirty) return;
    setSaving(true);
    setSaveError(null);
    try {
      onSaved(
        await api.put<BackupSchedule>("/api/backups/schedule", {
          enabled: draft.enabled,
          frequency: draft.frequency,
          hour: draft.hour,
          dayOfWeek: draft.dayOfWeek,
          dayOfMonth: draft.dayOfMonth,
        }),
      );
    } catch (err) {
      setSaveError(errorMessage(err, "Couldn't save the schedule."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          Automatic backups
        </h2>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          Genosyn backs up on its own, on this schedule, and copies each backup to the off-box
          destinations below.
        </p>
      </CardHeader>
      <CardBody>
        {!draft || !schedule ? (
          error ? (
            <SectionError message={error} onRetry={onRetry} />
          ) : (
            <Spinner />
          )
        ) : (
          <form className="flex flex-col gap-4" onSubmit={save}>
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                Back up automatically
              </span>
              <Switch
                label="Back up automatically"
                checked={draft.enabled}
                onChange={(enabled) => setDraft({ ...draft, enabled })}
              />
            </div>
            {draft.enabled && (
              <div className="grid gap-3 sm:grid-cols-3">
                <Select
                  label="How often"
                  value={draft.frequency}
                  onChange={(e) =>
                    setDraft({ ...draft, frequency: e.target.value as BackupFrequency })
                  }
                >
                  <option value="daily">Every day</option>
                  <option value="weekly">Every week</option>
                  <option value="monthly">Every month</option>
                </Select>
                {draft.frequency === "weekly" && (
                  <Select
                    label="On"
                    value={draft.dayOfWeek}
                    onChange={(e) => setDraft({ ...draft, dayOfWeek: Number(e.target.value) })}
                  >
                    {WEEKDAYS.map((day, index) => (
                      <option key={day} value={index}>
                        {day}
                      </option>
                    ))}
                  </Select>
                )}
                {draft.frequency === "monthly" && (
                  <Select
                    label="On day"
                    value={draft.dayOfMonth}
                    onChange={(e) => setDraft({ ...draft, dayOfMonth: Number(e.target.value) })}
                  >
                    {Array.from({ length: 28 }, (_, index) => (
                      <option key={index + 1} value={index + 1}>
                        {index + 1}
                      </option>
                    ))}
                  </Select>
                )}
                <Select
                  label={`At (${schedule.timeZone})`}
                  value={draft.hour}
                  onChange={(e) => setDraft({ ...draft, hour: Number(e.target.value) })}
                >
                  {Array.from({ length: 24 }, (_, hour) => (
                    <option key={hour} value={hour}>
                      {formatHour(hour)}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {dirty
                ? draft.enabled
                  ? `Once saved: ${describeSchedule(draft)} (${schedule.timeZone}).`
                  : "Once saved, nothing is backed up unless someone presses Back up now."
                : schedule.enabled
                  ? `${describeSchedule(schedule)} (${schedule.timeZone}).${
                      formatNextRun(schedule, now) ? ` Next: ${formatNextRun(schedule, now)}.` : ""
                    }`
                  : "Off. Nothing is backed up unless someone presses Back up now."}
            </p>
            <FormError message={saveError} />
            <div className="flex items-center justify-end gap-3">
              {dirty && (
                <span className="text-xs text-slate-500 dark:text-slate-400">Unsaved changes</span>
              )}
              <Button type="submit" size="sm" loading={saving} disabled={!dirty}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </form>
        )}
      </CardBody>
    </Card>
  );
}
