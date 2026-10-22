import { AppDataSource } from "../db/datasource.js";
import type { BackupDestination } from "../db/entities/BackupDestination.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { sendEmail } from "./email.js";
import { getPublicUrl } from "./publicUrl.js";

/**
 * Telling master admins when backups go wrong.
 *
 * A destination that fails says so only on Admin → Backups, so an install can
 * go weeks without its backups leaving the machine — one went from October 11
 * until someone looked. These emails go to every master admin through the
 * install-wide email transport: when a run of failed deliveries begins, at
 * most once a day while it lasts, and once more when a copy gets through
 * again; and when daily backup verification finds something missing. Sending is
 * best-effort: what went wrong is already recorded where the page shows it.
 */

const REMINDER_MS = 24 * 60 * 60 * 1000;

/** Whether a failed delivery emails admins: the first of a run, or a day after the last email. */
export function alertDue(lastAlertedAt: Date | null, now: Date): boolean {
  return !lastAlertedAt || now.getTime() - lastAlertedAt.getTime() >= REMINDER_MS;
}

export async function alertDeliveryFailed(dest: BackupDestination, filename: string): Promise<void> {
  const since = dest.failingSince ?? new Date();
  const lastCopy = dest.lastSyncedAt ? formatWhen(dest.lastSyncedAt) : "never";
  await emailMasterAdmins(`Off-box backups to ${dest.name} are failing`, (link) =>
    [
      `Genosyn could not copy the backup ${filename} to the off-box destination "${dest.name}" (${dest.hint}).`,
      "",
      `Error: ${dest.lastError}`,
      "",
      `Copies there have been failing since ${formatWhen(since)}. The last one that arrived was ${lastCopy}.`,
      "Backups are still being taken on this server, but they are not leaving it.",
      "",
      `Review the destination under Admin → Backups: ${link}`,
      "",
      "You will be reminded at most once a day while this continues, and told when copies arrive again.",
    ].join("\n"),
  );
}

export async function alertDeliveryRecovered(
  dest: BackupDestination,
  failingSince: Date,
): Promise<void> {
  await emailMasterAdmins(`Off-box backups to ${dest.name} are working again`, (link) =>
    [
      `A backup reached the off-box destination "${dest.name}" (${dest.hint}) again.`,
      "",
      `Copies there had been failing since ${formatWhen(failingSince)}.`,
      "",
      `Admin → Backups: ${link}`,
    ].join("\n"),
  );
}

/** A problem daily backup verification found; see services/backupVerification.ts. */
type VerificationProblem = { key: string; message: string };

/** Problems an email lists per section; the page has the rest. */
const MAX_LISTED = 20;

function listProblems(problems: VerificationProblem[]): string[] {
  const lines = problems.slice(0, MAX_LISTED).map((problem) => `- ${problem.message}`);
  if (problems.length > MAX_LISTED) lines.push(`- …and ${problems.length - MAX_LISTED} more`);
  return lines;
}

export async function alertVerificationFailed(
  problems: VerificationProblem[],
  fresh: Set<string>,
): Promise<void> {
  const found = problems.filter((problem) => fresh.has(problem.key));
  const known = problems.filter((problem) => !fresh.has(problem.key));
  const subject =
    found.length === 1
      ? "Backup verification found a problem"
      : `Backup verification found ${found.length} problems`;
  await emailMasterAdmins(subject, (link) => {
    const lines = [
      "Today's backup verification found something wrong with this install's backups:",
      "",
      ...listProblems(found),
    ];
    if (known.length > 0) {
      lines.push("", "Still unresolved from earlier days:", "", ...listProblems(known));
    }
    lines.push(
      "",
      `Review them under Admin → Backups: ${link}`,
      "",
      "You will hear again when verification finds something new, and once more when everything is back in place.",
    );
    return lines.join("\n");
  });
}

export async function alertVerificationPassed(): Promise<void> {
  await emailMasterAdmins("Backups are all in place again", (link) =>
    [
      "Backup verification found every backup it expects again — on this server and on each off-box destination.",
      "",
      `Admin → Backups: ${link}`,
    ].join("\n"),
  );
}

async function emailMasterAdmins(subject: string, body: (link: string) => string): Promise<void> {
  try {
    const admins = await AppDataSource.getRepository(User).find({ where: { isMasterAdmin: true } });
    for (const admin of admins) {
      if (!admin.email) continue;
      await sendEmail({
        to: admin.email,
        subject,
        text: body(await backupsLink(admin.id)),
        companyId: null,
        purpose: "backup_alert",
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[backups] could not email admins about off-box backups:",
      (err as Error).message ?? String(err),
    );
  }
}

/** Admin → Backups as `userId` reaches it: the Admin area lives under a company they belong to. */
async function backupsLink(userId: string): Promise<string> {
  const base = getPublicUrl().replace(/\/+$/, "");
  const membership = await AppDataSource.getRepository(Membership).findOneBy({ userId });
  const company = membership
    ? await AppDataSource.getRepository(Company).findOneBy({ id: membership.companyId })
    : null;
  return company ? `${base}/c/${company.slug}/admin/backup` : base;
}

function formatWhen(at: Date): string {
  return `${at.toISOString().replace("T", " ").slice(0, 16)} UTC`;
}
