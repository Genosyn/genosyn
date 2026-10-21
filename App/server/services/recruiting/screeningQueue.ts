import { LessThan, LessThanOrEqual, MoreThanOrEqual } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { RecruitingApplication } from "../../db/entities/RecruitingApplication.js";
import { RecruitingOpening } from "../../db/entities/RecruitingOpening.js";
import { SCORE_LABEL_TEXT } from "../../../shared/recruiting.js";
import { createNotification } from "../notifications.js";
import { emitResourceChange } from "../resourceEvents.js";
import { recordApplicationEvent } from "./events.js";
import { screenApplication, type ScreenOutcome } from "./screening.js";

/**
 * The queue between an Application arriving and its AI screen.
 *
 * It lives on the Application row itself (`screenStatus`, `screenQueuedAt`,
 * `screenStartedAt`, `screenAttempts`), so a restart loses nothing and every
 * replica can serve it: a screen is claimed with a conditional update from
 * `queued` to `running`, which exactly one process wins. A running screen
 * whose process died is put back after {@link STALE_RUNNING_MS}.
 *
 * Retries: a timeout, a provider error or a busy subscription model tries
 * again after a growing pause, up to {@link MAX_SCREEN_ATTEMPTS}, then the
 * Application shows the failure and a "Score again" button. A Standdown
 * defers the screen without spending an attempt — work a person stopped is
 * waiting, not failing — and a missing screener or model fails at once,
 * because no retry can fix what only a person can.
 */

export const MAX_SCREEN_ATTEMPTS = 3;
export const STALE_RUNNING_MS = 10 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;
const STANDDOWN_RECHECK_MS = 5 * 60_000;
const CONCURRENCY = 2;

let active = 0;
let draining = false;
let autoKick = true;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Tests drive the queue by hand with {@link runScreeningQueueOnce}. */
export function setScreeningAutoKickForTests(enabled: boolean): void {
  autoKick = enabled;
}

/** Queue an Application for its AI screen, now. A fresh request resets the attempt count. */
export async function enqueueScreen(applicationId: string, options: { fresh?: boolean } = {}): Promise<void> {
  const repo = AppDataSource.getRepository(RecruitingApplication);
  await repo.update(
    { id: applicationId },
    {
      screenStatus: "queued",
      screenQueuedAt: new Date(),
      screenStartedAt: null,
      screenError: "",
      ...(options.fresh ? { screenAttempts: 0 } : {}),
    },
  );
  // An update by id carries no company, so open pages are told directly.
  const queued = await repo.findOne({ where: { id: applicationId }, select: { companyId: true, openingId: true } });
  if (queued) {
    emitResourceChange(queued.companyId, "recruiting_application", queued.openingId, { trigger: false });
  }
  kick();
}

function kick(): void {
  if (!autoKick) return;
  setImmediate(() => {
    void drain().catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error("[recruiting] screening queue failed:", err);
    });
  });
}

/** Claim the oldest due screen, or null when none is due. */
async function claimNext(): Promise<RecruitingApplication | null> {
  const repo = AppDataSource.getRepository(RecruitingApplication);
  for (let tries = 0; tries < 5; tries++) {
    const next = await repo.findOne({
      where: { screenStatus: "queued", screenQueuedAt: LessThanOrEqual(new Date()) },
      order: { screenQueuedAt: "ASC" },
      select: { id: true, screenAttempts: true },
    });
    if (!next) return null;
    const claim = await repo
      .createQueryBuilder()
      .update(RecruitingApplication)
      .set({
        screenStatus: "running",
        screenStartedAt: new Date(),
        screenAttempts: next.screenAttempts + 1,
      })
      .where("id = :id", { id: next.id })
      .andWhere('"screenStatus" = :queued', { queued: "queued" })
      .execute();
    if (claim.affected === 1) {
      next.screenAttempts += 1;
      return next;
    }
  }
  return null;
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (active < CONCURRENCY) {
      const claimed = await claimNext();
      if (!claimed) break;
      active += 1;
      void settle(claimed)
        .catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.error(`[recruiting] screen ${claimed.id} failed to settle:`, err);
        })
        .finally(() => {
          active -= 1;
          kick();
        });
    }
  } finally {
    draining = false;
  }
}

/** Screen one claimed Application and record what came of it. */
async function settle(claimed: Pick<RecruitingApplication, "id" | "screenAttempts">): Promise<ScreenOutcome> {
  const outcome = await screenApplication(claimed.id);
  const repo = AppDataSource.getRepository(RecruitingApplication);
  if (outcome.outcome === "scored") {
    await notifyStrongMatch(claimed.id);
    return outcome;
  }
  if (outcome.outcome === "retry") {
    if (outcome.cause === "standdown") {
      await repo.update(
        { id: claimed.id },
        {
          screenStatus: "queued",
          screenQueuedAt: new Date(Date.now() + STANDDOWN_RECHECK_MS),
          screenStartedAt: null,
          screenAttempts: Math.max(0, claimed.screenAttempts - 1),
          screenError: outcome.detail,
        },
      );
      return outcome;
    }
    if (claimed.screenAttempts < MAX_SCREEN_ATTEMPTS) {
      const pauseMs = 60_000 * 2 ** (claimed.screenAttempts - 1);
      await repo.update(
        { id: claimed.id },
        {
          screenStatus: "queued",
          screenQueuedAt: new Date(Date.now() + pauseMs),
          screenStartedAt: null,
          screenError: outcome.detail,
        },
      );
      return outcome;
    }
  }
  await repo.update(
    { id: claimed.id },
    { screenStatus: "failed", screenStartedAt: null, screenError: outcome.detail },
  );
  const application = await repo.findOne({
    where: { id: claimed.id },
    select: { id: true, companyId: true, openingId: true },
  });
  if (application) {
    await recordApplicationEvent({
      application,
      kind: "screen_failed",
      actor: { kind: "system" },
      body: outcome.detail,
      meta: { cause: outcome.cause, attempts: claimed.screenAttempts },
    });
  }
  return outcome;
}

/**
 * Tell the Opening's owner about a strong match — the one screening result
 * worth interrupting someone for. Never fails the screen it follows.
 */
async function notifyStrongMatch(applicationId: string): Promise<void> {
  try {
    const application = await AppDataSource.getRepository(RecruitingApplication).findOneBy({
      id: applicationId,
    });
    if (!application || application.scoreLabel !== "strong") return;
    const opening = await AppDataSource.getRepository(RecruitingOpening).findOneBy({
      id: application.openingId,
    });
    if (!opening?.ownerUserId) return;
    await createNotification({
      companyId: application.companyId,
      userId: opening.ownerUserId,
      kind: "recruiting_strong_match",
      title: `${SCORE_LABEL_TEXT.strong}: ${application.candidateName} for ${opening.title}`,
      body: `Scored ${application.score ?? "—"} against the Opening's criteria.`,
      link: `/recruiting/applicants/${application.id}`,
      actorKind: "system",
      entityKind: "recruiting_application",
      entityId: application.id,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[recruiting] strong-match notice failed:", err);
  }
}

/**
 * Put back screens whose process died mid-turn. One that has already used
 * every attempt fails instead, so an application that crashes the process
 * each time it is read is not picked up forever.
 */
export async function reclaimStaleScreens(now = new Date()): Promise<number> {
  const repo = AppDataSource.getRepository(RecruitingApplication);
  const stale = { screenStatus: "running" as const, screenStartedAt: LessThan(new Date(now.getTime() - STALE_RUNNING_MS)) };
  const spent = await repo.find({
    where: { ...stale, screenAttempts: MoreThanOrEqual(MAX_SCREEN_ATTEMPTS) },
    select: { id: true, companyId: true, openingId: true, screenAttempts: true },
  });
  const detail = "The screen stopped before it finished, every time it was tried.";
  for (const application of spent) {
    const failed = await repo.update(
      { id: application.id, screenStatus: "running" },
      { screenStatus: "failed", screenStartedAt: null, screenError: detail },
    );
    if (failed.affected !== 1) continue;
    await recordApplicationEvent({
      application,
      kind: "screen_failed",
      actor: { kind: "system" },
      body: detail,
      meta: { cause: "stale", attempts: application.screenAttempts },
    });
  }
  const result = await repo.update(
    { ...stale, screenAttempts: LessThan(MAX_SCREEN_ATTEMPTS) },
    { screenStatus: "queued", screenQueuedAt: now, screenStartedAt: null },
  );
  return (result.affected ?? 0) + spent.length;
}

/**
 * Screen everything due, one at a time, and return the outcomes — the
 * deterministic form of the queue, for tests and for anything that must know
 * the screens are done before it answers.
 */
export async function runScreeningQueueOnce(): Promise<ScreenOutcome[]> {
  const outcomes: ScreenOutcome[] = [];
  for (;;) {
    const claimed = await claimNext();
    if (!claimed) return outcomes;
    outcomes.push(await settle(claimed));
  }
}

/** Start the sweep that recovers stale screens and picks up due retries. */
export function bootScreeningQueue(): void {
  if (sweepTimer) return;
  const sweep = () => {
    void reclaimStaleScreens()
      .then(() => kick())
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error("[recruiting] screening sweep failed:", err);
      });
  };
  sweep();
  sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}
