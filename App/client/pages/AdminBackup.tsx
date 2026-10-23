import React from "react";
import { useOutletContext } from "react-router-dom";
import {
  api,
  type BackupCopiesStarted,
  type BackupCopy,
  type BackupDestination,
  type BackupHistoryItem,
  type BackupSchedule,
  type BackupStarted,
  type BackupVerification,
} from "@/lib/api";
import { activeRun, isBusy, summarizeBackups } from "@/lib/backupStatus";
import { errorMessage } from "@/lib/errors";
import { TopBar } from "@/components/AppShell";
import type { AdminOutletCtx } from "./AdminLayout";
import { AdvancedSection } from "./backups/AdvancedSection";
import { DestinationsCard } from "./backups/DestinationsCard";
import { HistoryCard } from "./backups/HistoryCard";
import { ScheduleCard } from "./backups/ScheduleCard";
import { StatusCard } from "./backups/StatusCard";

/**
 * Admin → Backups. Built for an owner who wants one answer — are we backed
 * up? — before any detail:
 *
 *   1. what the backups look like right now, and Back up now;
 *   2. when they happen on their own;
 *   3. where copies go besides this server, each with Test beside it;
 *   4. History: every backup, and where each one lives;
 *   5. Advanced, closed: retention, daily verification, uploading a backup
 *      made elsewhere, failure emails, and where the files are.
 *
 * A backup — and copying it off-box — can take hours, so nothing here waits
 * on one: Back up now and Copy off-box answer at once, and the page follows
 * the work from History until it is done. This file holds the page's data and
 * its order; each section is its own file in `pages/backups/`, and what each
 * one says is worked out in `lib/backupStatus.ts`, where every sentence is
 * tested.
 */

/** How often the page looks again while a backup or a copy is under way. */
const POLL_MS = 3_000;

/** The time, kept current so "2 minutes ago" stays true while the page is open. */
function useNow(intervalMs: number): Date {
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function upsertBackup(rows: BackupHistoryItem[] | null, item: BackupHistoryItem) {
  const list = rows ?? [];
  const index = list.findIndex((row) => row.id === item.id);
  if (index < 0) return [item, ...list];
  const next = list.slice();
  next[index] = item;
  return next;
}

function mergeCopies(rows: BackupHistoryItem[] | null, backupId: string, copies: BackupCopy[]) {
  if (!rows) return rows;
  return rows.map((row) =>
    row.id !== backupId
      ? row
      : {
          ...row,
          copies: [
            ...row.copies.filter(
              (existing) => !copies.some((copy) => copy.destinationId === existing.destinationId),
            ),
            ...copies,
          ],
        },
  );
}

export function AdminBackup() {
  const { company } = useOutletContext<AdminOutletCtx>();
  const now = useNow(30_000);
  const [history, setHistory] = React.useState<BackupHistoryItem[] | null>(null);
  const [historyError, setHistoryError] = React.useState<string | null>(null);
  const [destinations, setDestinations] = React.useState<BackupDestination[] | null>(null);
  const [destinationsError, setDestinationsError] = React.useState<string | null>(null);
  const [schedule, setSchedule] = React.useState<BackupSchedule | null>(null);
  const [scheduleError, setScheduleError] = React.useState<string | null>(null);
  /** undefined while loading; null before the first verification has run. */
  const [verification, setVerification] = React.useState<BackupVerification | null | undefined>(
    undefined,
  );
  const [verificationError, setVerificationError] = React.useState<string | null>(null);

  const loadHistory = React.useCallback(async () => {
    try {
      setHistory(await api.get<BackupHistoryItem[]>("/api/backups"));
      setHistoryError(null);
    } catch (err) {
      setHistoryError(errorMessage(err, "Couldn't load the backups."));
    }
  }, []);
  const loadDestinations = React.useCallback(async () => {
    try {
      setDestinations(await api.get<BackupDestination[]>("/api/backup-destinations"));
      setDestinationsError(null);
    } catch (err) {
      setDestinationsError(errorMessage(err, "Couldn't load the off-box destinations."));
    }
  }, []);
  const loadSchedule = React.useCallback(async () => {
    try {
      setSchedule(await api.get<BackupSchedule>("/api/backups/schedule"));
      setScheduleError(null);
    } catch (err) {
      setScheduleError(errorMessage(err, "Couldn't load the schedule."));
    }
  }, []);
  const loadVerification = React.useCallback(async () => {
    try {
      const { verification: last } = await api.get<{ verification: BackupVerification | null }>(
        "/api/backups/verification",
      );
      setVerification(last);
      setVerificationError(null);
    } catch (err) {
      setVerificationError(errorMessage(err, "Couldn't load the last verification."));
    }
  }, []);

  React.useEffect(() => {
    void loadHistory();
    void loadDestinations();
    void loadSchedule();
    void loadVerification();
  }, [loadHistory, loadDestinations, loadSchedule, loadVerification]);

  // Follow a backup or a copy that is under way; each poll re-reads the
  // destinations too, whose health moves as copies land.
  const busy = history ? isBusy(history) : false;
  React.useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => {
      void loadHistory();
      void loadDestinations();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [busy, loadHistory, loadDestinations]);
  // Once it is over, the schedule's last run may have moved too.
  const wasBusy = React.useRef(false);
  React.useEffect(() => {
    if (wasBusy.current && !busy) void loadSchedule();
    wasBusy.current = busy;
  }, [busy, loadSchedule]);

  const run = history ? activeRun(history) : null;
  const latestOnServer =
    history?.find((backup) => backup.status === "completed" && backup.onServer) ?? null;
  const summary = history
    ? summarizeBackups({ backups: history, destinations, schedule, verification, now })
    : null;

  const [starting, setStarting] = React.useState(false);
  const [startError, setStartError] = React.useState<string | null>(null);
  const [startNote, setStartNote] = React.useState<string | null>(null);
  const backUpNow = async () => {
    setStarting(true);
    setStartError(null);
    setStartNote(null);
    try {
      const { alreadyRunning, ...item } = await api.post<BackupStarted>("/api/backups");
      setHistory((rows) => upsertBackup(rows, item));
      if (alreadyRunning) {
        setStartNote("A backup was already under way, so Genosyn is finishing that one first.");
      }
    } catch (err) {
      setStartError(errorMessage(err, "Couldn't start the backup."));
    } finally {
      setStarting(false);
    }
  };

  /** Copy a backup off-box now; to one destination when one is named. */
  const copyBackup = async (backup: BackupHistoryItem, destinationId?: string) => {
    const result = await api.post<BackupCopiesStarted>(
      `/api/backups/${backup.id}/deliver`,
      destinationId ? { destinationId } : undefined,
    );
    setHistory((rows) => mergeCopies(rows, backup.id, result.copies));
    return result;
  };

  return (
    <>
      <TopBar title="Backups" />
      <div className="flex flex-col gap-4">
        <StatusCard
          summary={summary}
          error={history ? null : historyError}
          onRetry={() => void loadHistory()}
          run={run}
          starting={starting}
          onBackUpNow={backUpNow}
          startError={startError}
          startNote={startNote}
        />
        <ScheduleCard
          schedule={schedule}
          error={scheduleError}
          onRetry={() => void loadSchedule()}
          onSaved={setSchedule}
          now={now}
        />
        <DestinationsCard
          destinations={destinations}
          error={destinationsError}
          onRetry={() => void loadDestinations()}
          onChanged={async () => {
            await Promise.all([loadDestinations(), loadHistory()]);
          }}
          latestOnServer={latestOnServer}
          onCopyLatest={(destinationId) =>
            latestOnServer ? copyBackup(latestOnServer, destinationId) : Promise.resolve(null)
          }
          now={now}
        />
        <HistoryCard
          rows={history}
          error={historyError}
          onRetry={() => void loadHistory()}
          destinations={destinations}
          onChanged={loadHistory}
          onCopy={copyBackup}
          now={now}
        />
        <AdvancedSection
          companySlug={company.slug}
          schedule={schedule}
          scheduleError={scheduleError}
          onRetrySchedule={() => void loadSchedule()}
          onScheduleSaved={async (saved) => {
            setSchedule(saved);
            // Saving on-box retention deletes what it has expired, there and then.
            if (saved.prunedNow) await loadHistory();
          }}
          verification={verification}
          verificationError={verificationError}
          onRetryVerification={() => void loadVerification()}
          onVerified={async (next) => {
            setVerification(next);
            // Verification records the copies it finds, for History to show.
            await loadHistory();
          }}
          onUploaded={loadHistory}
          now={now}
        />
      </div>
    </>
  );
}
