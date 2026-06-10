import webpush from "web-push";
import { AppDataSource } from "../db/datasource.js";
import { AppSetting } from "../db/entities/AppSetting.js";
import { PushSubscription } from "../db/entities/PushSubscription.js";
import { config } from "../../config.js";

/**
 * Web Push delivery for the PWA. Zero-config by design: the VAPID keypair
 * is generated on first use and persisted in `app_settings`, so a
 * self-hosted operator never has to mint keys by hand. Browsers subscribe
 * via `routes/push.ts`; `createNotifications` fans every bell row out to
 * the recipient's registered devices.
 *
 * Payloads stay small (title/body/link) — the service worker renders them
 * with `registration.showNotification` and deep-links back into the SPA.
 */

const PUBLIC_KEY_SETTING = "push.vapid.publicKey";
const PRIVATE_KEY_SETTING = "push.vapid.privateKey";

export type PushPayload = {
  title: string;
  body: string;
  /** Relative SPA link (`/c/acme/workspace/…`) resolved by the worker. */
  link: string;
  /** Collapse key so re-sends replace instead of stacking. */
  tag?: string;
};

let vapidKeys: { publicKey: string; privateKey: string } | null = null;

/**
 * Load (or mint + persist) the instance VAPID keypair and point web-push
 * at it. Single-process server, so the read-then-write here can't race.
 */
async function ensureVapid(): Promise<{ publicKey: string; privateKey: string }> {
  if (vapidKeys) return vapidKeys;
  const repo = AppDataSource.getRepository(AppSetting);
  let pub = await repo.findOneBy({ key: PUBLIC_KEY_SETTING });
  let priv = await repo.findOneBy({ key: PRIVATE_KEY_SETTING });
  if (!pub?.value || !priv?.value) {
    const generated = webpush.generateVAPIDKeys();
    pub = repo.create({ key: PUBLIC_KEY_SETTING, value: generated.publicKey });
    priv = repo.create({ key: PRIVATE_KEY_SETTING, value: generated.privateKey });
    await repo.save([pub, priv]);
  }
  // Push services require a contact on every request. An https publicUrl
  // doubles as one; otherwise fall back to a mailto so localhost installs
  // still work without config.
  const subject = config.publicUrl.startsWith("https://")
    ? config.publicUrl
    : "mailto:admin@genosyn.local";
  webpush.setVapidDetails(subject, pub.value, priv.value);
  vapidKeys = { publicKey: pub.value, privateKey: priv.value };
  return vapidKeys;
}

export async function getVapidPublicKey(): Promise<string> {
  return (await ensureVapid()).publicKey;
}

export async function saveSubscription(params: {
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string;
}): Promise<PushSubscription> {
  const repo = AppDataSource.getRepository(PushSubscription);
  // Same browser re-subscribing (or a device changing hands between
  // accounts) upserts on the endpoint instead of stacking rows.
  let row = await repo.findOneBy({ endpoint: params.endpoint });
  if (!row) row = repo.create({ endpoint: params.endpoint });
  row.userId = params.userId;
  row.p256dh = params.p256dh;
  row.auth = params.auth;
  row.userAgent = params.userAgent;
  await repo.save(row);
  return row;
}

export async function removeSubscription(params: {
  userId: string;
  endpoint: string;
}): Promise<boolean> {
  const r = await AppDataSource.getRepository(PushSubscription).delete({
    userId: params.userId,
    endpoint: params.endpoint,
  });
  return (r.affected ?? 0) > 0;
}

export async function listSubscriptionsForUser(
  userId: string,
): Promise<PushSubscription[]> {
  return AppDataSource.getRepository(PushSubscription).find({
    where: { userId },
    order: { createdAt: "ASC" },
  });
}

/**
 * Deliver a payload to every device the user registered. Best-effort: a
 * dead endpoint (410 Gone / 404) drops its row, anything else logs and
 * moves on — push must never break the write path that triggered it.
 */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
): Promise<void> {
  const repo = AppDataSource.getRepository(PushSubscription);
  const subs = await repo.find({ where: { userId } });
  if (subs.length === 0) return;
  await ensureVapid();

  const body = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          body,
          { TTL: 60 * 60 * 24 },
        );
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await repo.delete({ id: sub.id });
          return;
        }
        // eslint-disable-next-line no-console
        console.error(
          `[push] send failed (status ${status ?? "?"}) for user ${userId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }),
  );
}
