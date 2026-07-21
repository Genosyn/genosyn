import { AppDataSource } from "../db/datasource.js";
import { User } from "../db/entities/User.js";
import { config } from "../../config.js";

/**
 * Guarantee the install always has at least one master admin.
 *
 * The very first signup self-promotes in the auth route, but that only covers
 * a fresh box. When this feature lands on a deployment that already has users,
 * the migration defaults everyone to `isMasterAdmin = false` — which would lock
 * the whole team out of the Admin dashboard. A self-hosted install promotes the
 * earliest account for backwards compatibility; shared SaaS promotes only the
 * explicitly configured bootstrap email (or waits for that address to sign up).
 *
 * Idempotent: once any master admin exists this is a no-op, and on a truly
 * empty DB it does nothing (the signup route handles it).
 */
export async function ensureBootstrapMasterAdmin(): Promise<void> {
  const repo = AppDataSource.getRepository(User);
  const existing = await repo.count({ where: { isMasterAdmin: true } });
  if (existing > 0) return;
  if (config.security.multiTenant) {
    const email = config.security.bootstrapMasterAdminEmail.trim().toLowerCase();
    const bootstrap = await repo.findOneBy({ email });
    if (!bootstrap) {
      // The signup route reserves this exact address as the only account that
      // can claim an empty operator role, even when ordinary signup is closed.
      // Never promote an unrelated historical account on a shared service.
      // eslint-disable-next-line no-console
      console.warn(`[masterAdmin] waiting for bootstrap account ${email}`);
      return;
    }
    bootstrap.isMasterAdmin = true;
    await repo.save(bootstrap);
    // eslint-disable-next-line no-console
    console.log(`[masterAdmin] promoted configured bootstrap account ${email}`);
    return;
  }
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
