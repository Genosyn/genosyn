import "reflect-metadata";
import fs from "node:fs";
import path from "node:path";

import { AppDataSource } from "../db/datasource.js";
import { User } from "../db/entities/User.js";
import { avatarsRoot } from "../services/avatars.js";
import {
  deleteUserCascade,
  findOwnedCompanies,
  UserOwnsCompaniesError,
} from "../services/userDelete.js";

/**
 * Operator entrypoint behind `genosyn user delete <email>`. Not wired into the
 * HTTP server — it's run directly (`node dist/server/admin/deleteUser.js`) by
 * the CLI inside the container, so the destructive cascade reuses the app's
 * real DataSource + entities instead of being re-implemented in shell.
 *
 * Exit codes (the CLI branches on these):
 *   0  deletable (--preflight) / deleted
 *   2  usage error
 *   3  refused — user owns a company
 *   4  no such user
 *   1  anything else
 */
async function run(): Promise<number> {
  const argv = process.argv.slice(2);
  const preflight = argv.includes("--preflight");
  const email = (argv.find((a) => !a.startsWith("--")) ?? "").trim().toLowerCase();

  if (!email) {
    console.error("Usage: deleteUser <email> [--preflight]");
    return 2;
  }

  await AppDataSource.initialize();
  try {
    const user = await AppDataSource.getRepository(User).findOneBy({ email });
    if (!user) {
      console.error("No user found with email: " + email);
      return 4;
    }

    const who = user.name ? `${user.email} (${user.name})` : user.email;

    const owned = await findOwnedCompanies(user.id);
    if (owned.length) {
      const names = owned.map((c) => c.name).join(", ");
      console.error(`Refusing: ${user.email} is the owner of ${owned.length} company(ies): ${names}.`);
      console.error("Transfer ownership or delete those companies first, then retry.");
      return 3;
    }

    if (preflight) {
      console.log(`Deletable: ${who}`);
      return 0;
    }

    const res = await deleteUserCascade({ userId: user.id });

    // Avatar is a flat-pool file keyed off the row — best-effort cleanup.
    if (user.avatarKey) {
      try {
        fs.rmSync(path.join(avatarsRoot(), user.avatarKey), { force: true });
      } catch {
        /* ignore — orphaned avatars are harmless and cheap to sweep later */
      }
    }

    console.log(`Deleted user ${who}.`);
    console.log(
      `Removed ${res.memberships} membership(s), ${res.apiKeys} API key(s), ` +
        `${res.notifications} notification(s); authored content was preserved and unlinked.`,
    );
    return 0;
  } finally {
    await AppDataSource.destroy().catch(() => {});
  }
}

run()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (err instanceof UserOwnsCompaniesError) {
      console.error(err.message);
      process.exit(3);
    }
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
