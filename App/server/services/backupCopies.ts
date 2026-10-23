import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Backup } from "../db/entities/Backup.js";
import { BackupCopy, type BackupCopyStatus } from "../db/entities/BackupCopy.js";

/**
 * Where each backup's off-box copies stand: one {@link BackupCopy} per backup
 * and destination.
 *
 * History used to say nothing about where a backup lived. A destination
 * remembered only its own last delivery, so whether *this* backup ever left the
 * server could not be told from anything on record. Every attempt to copy a
 * backup off-box now writes its own row as it goes — waiting its turn,
 * copying, copied or failed with the destination's reason — and two things that
 * learn about copies later keep the rows true: off-box retention, which deletes
 * them on purpose, and daily verification, which lists every destination and
 * records what is really there. Verification is also the only thing that may
 * fill in a backup taken before copies were recorded, and it records only what
 * it finds; until it has looked, such a backup's copies stay "not recorded".
 */

/** A copy whose delivery is still under way; only that delivery settles it. */
export const COPY_IN_FLIGHT: readonly BackupCopyStatus[] = ["pending", "copying"];

/** What a copy left mid-way by a stopped process reads as after a restart. */
export const INTERRUPTED_COPY_ERROR = "Interrupted: Genosyn restarted before this copy finished.";

/** Ids per `IN (…)` list, well inside SQLite's bound-parameter limit. */
const ID_CHUNK = 500;

function chunk<T>(items: T[], size = ID_CHUNK): T[][] {
  const parts: T[][] = [];
  for (let i = 0; i < items.length; i += size) parts.push(items.slice(i, i + size));
  return parts;
}

function copiesRepo() {
  return AppDataSource.getRepository(BackupCopy);
}

function isInFlight(copy: BackupCopy | null | undefined): boolean {
  return Boolean(copy && COPY_IN_FLIGHT.includes(copy.status));
}

type CopyPatch = Partial<
  Pick<BackupCopy, "status" | "error" | "startedAt" | "copiedAt" | "checkedAt">
>;

/** Create or update the one row for `backupId` on `destinationId`. */
async function setCopy(
  backupId: string,
  destinationId: string,
  patch: CopyPatch,
): Promise<BackupCopy> {
  const repo = copiesRepo();
  const row =
    (await repo.findOneBy({ backupId, destinationId })) ??
    repo.create({
      backupId,
      destinationId,
      status: "pending",
      error: "",
      startedAt: null,
      copiedAt: null,
      checkedAt: null,
    });
  Object.assign(row, patch);
  return repo.save(row);
}

/**
 * What each queued copy was before it was queued — nothing, or an earlier
 * copy's result — so one that never gets its turn can go back to it. In
 * memory, like the delivery that queued it: a restart fails anything still
 * queued instead ({@link recoverInterruptedCopies}).
 */
const beforeQueued = new Map<string, { status: BackupCopyStatus; error: string } | null>();

function copyKey(backupId: string, destinationId: string): string {
  return `${backupId}\u0000${destinationId}`;
}

/**
 * Every destination a delivery is about to copy to waits its turn: copies go
 * to one destination at a time, and a big one can take hours.
 */
export async function markCopiesPending(
  backupId: string,
  destinationIds: string[],
): Promise<BackupCopy[]> {
  const rows: BackupCopy[] = [];
  for (const destinationId of destinationIds) {
    const key = copyKey(backupId, destinationId);
    const existing = await copiesRepo().findOneBy({ backupId, destinationId });
    if (!isInFlight(existing) && !beforeQueued.has(key)) {
      beforeQueued.set(key, existing ? { status: existing.status, error: existing.error } : null);
    }
    rows.push(await setCopy(backupId, destinationId, { status: "pending", error: "" }));
  }
  return rows;
}

/**
 * A queued copy whose turn never came — its destination was removed, or
 * paused, while an earlier copy ran. It goes back to what it was before it was
 * queued, or away if it was nothing: it was never attempted.
 */
export async function unqueueCopy(backupId: string, destinationId: string): Promise<void> {
  const key = copyKey(backupId, destinationId);
  const before = beforeQueued.get(key) ?? null;
  beforeQueued.delete(key);
  const row = await copiesRepo().findOneBy({ backupId, destinationId });
  if (!row || row.status !== "pending") return;
  if (before) {
    row.status = before.status;
    row.error = before.error;
    await copiesRepo().save(row);
  } else {
    await copiesRepo().delete({ id: row.id });
  }
}

export async function markCopyStarted(
  backupId: string,
  destinationId: string,
  at = new Date(),
): Promise<void> {
  beforeQueued.delete(copyKey(backupId, destinationId));
  await setCopy(backupId, destinationId, { status: "copying", error: "", startedAt: at });
}

export async function markCopyCopied(
  backupId: string,
  destinationId: string,
  at = new Date(),
): Promise<void> {
  beforeQueued.delete(copyKey(backupId, destinationId));
  await setCopy(backupId, destinationId, { status: "copied", error: "", copiedAt: at });
}

export async function markCopyFailed(
  backupId: string,
  destinationId: string,
  error: string,
): Promise<void> {
  beforeQueued.delete(copyKey(backupId, destinationId));
  await setCopy(backupId, destinationId, {
    status: "failed",
    error: error.trim() || "The destination gave no reason.",
  });
}

/**
 * Off-box retention just deleted these archives from a destination. Each is a
 * backup's copy deleted on purpose, so its row says "removed" — including a
 * backup taken before copies were recorded, whose archive was evidently there.
 * Partial copies belong to no backup of their own and are left out by the
 * caller.
 */
export async function markCopiesRemoved(destinationId: string, filenames: string[]): Promise<void> {
  const names = [...new Set(filenames.filter(Boolean))];
  for (const part of chunk(names)) {
    const backups = await AppDataSource.getRepository(Backup).find({
      where: { filename: In(part) },
      select: { id: true },
    });
    for (const backup of backups) {
      const existing = await copiesRepo().findOneBy({ backupId: backup.id, destinationId });
      if (isInFlight(existing)) continue;
      await setCopy(backup.id, destinationId, { status: "removed", error: "" });
    }
  }
}

/**
 * A delivery that stopped with an error of its own — not a destination's,
 * which it records itself — leaves no copy waiting for it: each one still in
 * flight fails with that error. Copies it already settled keep their result.
 */
export async function failCopiesInFlight(
  backupId: string,
  destinationIds: string[],
  error: string,
): Promise<void> {
  if (destinationIds.length === 0) return;
  for (const destinationId of destinationIds) beforeQueued.delete(copyKey(backupId, destinationId));
  await copiesRepo().update(
    { backupId, destinationId: In(destinationIds), status: In([...COPY_IN_FLIGHT]) },
    { status: "failed", error: error.trim() || "The copy stopped without a reason." },
  );
}

/**
 * Copies a stopped process left waiting or part-way. Nothing resumes them, so
 * they read as failed with that reason; daily verification flips one to
 * copied if it did arrive after all. Called at boot, before anything new can
 * start a copy.
 */
export async function recoverInterruptedCopies(): Promise<number> {
  beforeQueued.clear();
  const result = await copiesRepo().update(
    { status: In([...COPY_IN_FLIGHT]) },
    { status: "failed", error: INTERRUPTED_COPY_ERROR },
  );
  return result.affected ?? 0;
}

/** The copies of each of `backupIds`, by backup id, oldest destination first. */
export async function copiesByBackup(backupIds: string[]): Promise<Map<string, BackupCopy[]>> {
  const byBackup = new Map<string, BackupCopy[]>();
  for (const part of chunk([...new Set(backupIds)])) {
    const rows = await copiesRepo().find({
      where: { backupId: In(part) },
      order: { createdAt: "ASC" },
    });
    for (const row of rows) {
      const list = byBackup.get(row.backupId) ?? [];
      list.push(row);
      byBackup.set(row.backupId, list);
    }
  }
  return byBackup;
}

export async function deleteCopiesOfBackups(backupIds: string[]): Promise<void> {
  for (const part of chunk([...new Set(backupIds)])) {
    await copiesRepo().delete({ backupId: In(part) });
  }
}

export async function deleteCopiesAtDestination(destinationId: string): Promise<void> {
  await copiesRepo().delete({ destinationId });
}

/**
 * Record what daily verification found on one destination, against every
 * backup it could have found there.
 *
 * Only Genosyn's own `backup-….zip` archives are listed, so uploaded backups
 * are left alone, as is any copy still on its way. Evidence wins over what a
 * delivery said: an archive there whole is copied, even after a failure was
 * recorded; one shorter than the archive on this server never finished
 * arriving; and one that was copied but is no longer there is missing. A backup
 * taken before copies were recorded learns either way, which is the only way
 * one ever stops being "not recorded". A backup recorded all along that was
 * never sent there gains nothing: its History row already says so.
 */
export async function recordCopiesFound(input: {
  destinationId: string;
  backups: Backup[];
  /** Complete archives on the destination: name → size in bytes. */
  whole: Map<string, number>;
  /** Backup filenames of which only a `.partial` copy is there. */
  partial: Set<string>;
  /** The size of each archive still on this server, by filename. */
  localSizes: Map<string, number>;
  now: Date;
}): Promise<void> {
  const { destinationId, whole, partial, localSizes, now } = input;
  const candidates = input.backups.filter(
    (backup) => backup.status === "completed" && backup.kind !== "uploaded",
  );
  if (candidates.length === 0) return;

  const existing = new Map<string, BackupCopy>();
  for (const part of chunk(candidates.map((backup) => backup.id))) {
    const rows = await copiesRepo().find({ where: { destinationId, backupId: In(part) } });
    for (const row of rows) existing.set(row.backupId, row);
  }

  const changed: BackupCopy[] = [];
  for (const backup of candidates) {
    const copy = existing.get(backup.id) ?? null;
    if (isInFlight(copy)) continue;
    const size = whole.get(backup.filename);
    const expected = localSizes.get(backup.filename);
    let next: CopyPatch | null;
    if (size !== undefined && (expected === undefined || size === expected)) {
      next = { status: "copied", error: "" };
    } else if (size !== undefined) {
      next = {
        status: "failed",
        error: `The copy there is ${formatBytes(size)}, but the backup is ${formatBytes(expected ?? 0)}: it never finished arriving.`,
      };
    } else if (partial.has(backup.filename) && (!copy || copy.status === "copied")) {
      next = {
        status: "failed",
        error: "Only part of it is there: the copy never finished arriving.",
      };
    } else if (!copy) {
      next = backup.copiesTracked ? null : { status: "missing", error: "" };
    } else if (copy.status === "copied") {
      next = { status: "missing", error: "" };
    } else {
      // Failed, missing or removed, and still not there: only note the look.
      next = {};
    }
    if (next === null) continue;
    const row =
      copy ??
      copiesRepo().create({
        backupId: backup.id,
        destinationId,
        status: "missing",
        error: "",
        startedAt: null,
        copiedAt: null,
        checkedAt: null,
      });
    Object.assign(row, next, { checkedAt: now });
    changed.push(row);
  }
  for (const part of chunk(changed)) await copiesRepo().save(part);
}

export function serializeCopy(copy: BackupCopy) {
  return {
    destinationId: copy.destinationId,
    status: copy.status,
    error: copy.error,
    startedAt: copy.startedAt,
    copiedAt: copy.copiedAt,
    checkedAt: copy.checkedAt,
    updatedAt: copy.updatedAt,
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
