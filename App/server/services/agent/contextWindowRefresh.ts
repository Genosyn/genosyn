import cron, { type ScheduledTask } from "node-cron";
import { AppDataSource } from "../../db/datasource.js";
import { AIModel } from "../../db/entities/AIModel.js";
import { isModelConnected } from "../providers.js";
import { withSchedulerLease } from "../schedulerLeases.js";
import { canProbeContextWindow, probeContextWindow } from "./contextWindow.js";

/**
 * Keep every model's context window current instead of frozen at whatever the
 * provider said the day its credential was saved.
 *
 * The number moves under us. An operator restarts vLLM with a different
 * `--max-model-len`, points the same model id at re-quantized weights, or a
 * hosted provider raises a published model's window. Until this sweep existed
 * the only ways back to the truth were re-saving the credential or clicking
 * "Ask the provider" — so between them a stale number silently mis-budgets
 * every run: too high and the provider rejects a turn we thought would fit,
 * too low and `contextBudget.ts` drops history that had room.
 *
 * Every three hours is the balance. A re-pointed endpoint corrects itself
 * inside a working session, while a model costs eight cheap `/v1/models`-style
 * requests a day — nothing an endpoint would notice, unlike a per-run probe.
 *
 * Nothing here can make the stored number worse than it already is: a probe
 * that fails returns null and the sweep keeps what it knew (see
 * {@link refreshContextWindow}), and a window an operator typed in is never
 * touched at all.
 */

/** Top of every third hour. Clock-aligned, so a restart can't reset the cycle. */
const REFRESH_CRON = "0 */3 * * *";

/** Stable node-cron name — without one, node-cron leaks a map entry per register. */
const TASK_NAME = "context-window-refresh";

/**
 * One holder across a Postgres deployment. Long enough that a sweep over many
 * slow endpoints stays under it; `withSchedulerLease` renews while it works.
 */
const LEASE_NAME = "context-window-refresh";
const LEASE_TTL_MS = 10 * 60_000;

let task: ScheduledTask | null = null;
let sweeping = false;

/** Injectable so tests can drive the sweep without reaching a real provider. */
export type ContextWindowProbe = (model: AIModel) => Promise<number | null>;

/**
 * Re-ask the provider for a model's context window and persist what it says.
 *
 * Called after a credential lands (that's the first moment we can ask), from
 * the operator's "Ask the provider" button, and from the sweep below. Returns
 * whether the stored window actually moved.
 *
 * Best-effort by design: an unreachable endpoint must not block saving a model,
 * so a failed probe just leaves the window as it was.
 */
export async function refreshContextWindow(
  m: AIModel,
  probe: ContextWindowProbe = probeContextWindow,
): Promise<boolean> {
  // A human who typed a number has told us something the probe demonstrably
  // couldn't work out. Don't relitigate it on every save — only an explicit
  // clear returns this model to probing.
  if (m.contextWindowSource === "manual") return false;
  const found = await probe(m);
  // Null means "couldn't ask", not "has no window" — keep whatever we already
  // knew rather than letting one unreachable moment erase it. Callers that
  // change the endpoint clear the field themselves, since the old number is
  // stale by definition at that point.
  if (found === null || found === m.contextWindow) return false;
  m.contextWindow = found;
  m.contextWindowSource = "probed";
  await AppDataSource.getRepository(AIModel).update(
    { id: m.id },
    {
      contextWindow: found,
      contextWindowSource: "probed",
    },
  );
  return true;
}

/**
 * Re-probe every model whose window we're allowed to ask about, and report how
 * many changed.
 *
 * Filtered in JS rather than SQL: `contextWindowSource` is null on most rows and
 * `Not("manual")` would exclude those nulls, and {@link canProbeContextWindow}
 * plus {@link isModelConnected} both read the row's shape. An install has a
 * handful of models per employee, so the full scan is cheaper than the subtlety.
 *
 * Serial on purpose. These are outbound requests to whatever an operator
 * pointed us at — often one small GPU box serving several employees — and a
 * housekeeping job has no reason to arrive as a burst.
 */
export async function sweepContextWindows(
  options: {
    probe?: ContextWindowProbe;
    /** Stop early if a Postgres deployment lost the lease mid-sweep. */
    isHeld?: () => boolean;
  } = {},
): Promise<number> {
  const { probe = probeContextWindow, isHeld = () => true } = options;
  const models = await AppDataSource.getRepository(AIModel).find();
  const due = models.filter(
    (m) => m.contextWindowSource !== "manual" && canProbeContextWindow(m) && isModelConnected(m),
  );
  let changed = 0;
  for (const m of due) {
    if (!isHeld()) break;
    try {
      if (await refreshContextWindow(m, probe)) changed++;
    } catch (error) {
      // One unhappy row — a decrypt that fails, a write that races a delete —
      // must not cost every model behind it its refresh.
      // eslint-disable-next-line no-console
      console.error(
        `[context-window] refresh failed for model ${m.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return changed;
}

async function tick(): Promise<void> {
  // A sweep across a dozen unreachable endpoints can outlast its slot. Skipping
  // the overlapping tick is right: the next one is only three hours away, and
  // two concurrent sweeps would double the load on the same endpoints.
  if (sweeping) return;
  sweeping = true;
  try {
    await withSchedulerLease(LEASE_NAME, LEASE_TTL_MS, (lease) =>
      sweepContextWindows({ isHeld: lease.isHeld }),
    );
  } finally {
    sweeping = false;
  }
}

/**
 * Register the three-hourly sweep. No boot pass: startup already has plenty to
 * do, and a crash-looping install would otherwise hammer every configured
 * endpoint on each restart.
 */
export function bootContextWindowRefresh(): void {
  if (task) return;
  task = cron.schedule(
    REFRESH_CRON,
    () => {
      tick().catch((error: unknown) => {
        // eslint-disable-next-line no-console
        console.error(
          `[context-window] scheduled refresh failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    },
    { name: TASK_NAME },
  );
}

/**
 * Take the sweep down — a restore destroys the DataSource underneath it.
 *
 * `destroy()` rather than `stop()`: node-cron keys its module-global task map
 * by a per-instance id, and only a destroyed task is removed from it. A stopped
 * one would linger there for every restore this process serves.
 */
export function stopContextWindowRefresh(): void {
  if (!task) return;
  void task.destroy();
  task = null;
}
