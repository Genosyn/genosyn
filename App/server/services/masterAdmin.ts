import { AppDataSource } from "../db/datasource.js";
import { User } from "../db/entities/User.js";

/**
 * Guarantee the install always has at least one master admin.
 *
 * The very first signup self-promotes in the auth route, but that only covers
 * a fresh box. When this feature lands on a deployment that already has users,
 * the migration defaults everyone to `isMasterAdmin = false` — which would lock
 * the whole team out of the Admin dashboard. So on boot we promote the
 * earliest-created account if (and only if) nobody is a master admin yet.
 *
 * Idempotent: once any master admin exists this is a no-op, and on a truly
 * empty DB it does nothing (the first signup handles it). The "earliest
 * created" user is the de-facto operator who set the instance up.
 */
export async function ensureBootstrapMasterAdmin(): Promise<void> {
  const repo = AppDataSource.getRepository(User);
  const existing = await repo.count({ where: { isMasterAdmin: true } });
  if (existing > 0) return;
  // findOne() requires a where-clause in TypeORM; use find({ take: 1 }) to pull
  // the single earliest row without one.
  const [first] = await repo.find({ order: { createdAt: "ASC" }, take: 1 });
  if (!first) return;
  first.isMasterAdmin = true;
  await repo.save(first);
  // eslint-disable-next-line no-console
  console.log(
    `[masterAdmin] no master admin found — promoted earliest user ${first.email}`,
  );
}
