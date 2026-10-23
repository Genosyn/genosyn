/**
 * How much of the process one Member may hold through the Genosyn MCP server
 * at once.
 *
 * A REST client streams each answer to its own socket; the MCP server holds an
 * answer in memory until it can hand it back as JSON-RPC, and a client can ask
 * for many at once — in parallel POSTs, or a batch whose entries the SDK runs
 * together. Without bounds, one caller could hold far more of the process's
 * memory than the same requests over REST would. Three bounds keep it close:
 *
 * - **Calls.** A Member runs a few operations at a time; a further call waits,
 *   in order, for one to finish, and gives up after a while rather than
 *   queueing forever.
 * - **Requests.** A Member has a few MCP requests open at once; one more is
 *   refused straight away with 429, since every open request keeps its
 *   answers until the last of them is ready.
 * - **Files.** One request embeds at most a couple of megabytes of files in
 *   its answers; past that a file is described with its link instead.
 *
 * The bounds are per Member rather than per API key, because a Member can mint
 * as many keys as they like, and per process, which is what they protect.
 */

/** Operations one Member may have running at once. */
export const MAX_CALLS_IN_FLIGHT = 4;

/** MCP requests one Member may have open at once. */
export const MAX_REQUESTS_IN_FLIGHT = 8;

/** File bytes one MCP request may embed in its answers, all told. */
export const EMBED_BUDGET_BYTES = 2 * 1024 * 1024;

/** How long a call waits for a slot before it gives up. */
export const SLOT_WAIT_MS = 30_000;

type Lane = { running: number; waiting: Array<() => void> };

const callLanes = new Map<string, Lane>();
const requestCounts = new Map<string, number>();

export class SlotTimeoutError extends Error {
  constructor() {
    super(
      `This Member already has ${MAX_CALLS_IN_FLIGHT} calls running through the MCP server, and none finished within ${SLOT_WAIT_MS / 1000} seconds. Wait for them, then try again.`,
    );
    this.name = "SlotTimeoutError";
  }
}

/**
 * Wait for one of the Member's call slots, and get back the function that
 * frees it. The returned function is safe to call more than once.
 */
export async function acquireSlot(
  memberId: string,
  options: { waitMs?: number; signal?: AbortSignal } = {},
): Promise<() => void> {
  let lane = callLanes.get(memberId);
  if (!lane) {
    lane = { running: 0, waiting: [] };
    callLanes.set(memberId, lane);
  }
  const current = lane;
  if (current.running >= MAX_CALLS_IN_FLIGHT) {
    await new Promise<void>((resolve, reject) => {
      const admit = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const leave = (error: Error) => {
        const index = current.waiting.indexOf(admit);
        if (index >= 0) current.waiting.splice(index, 1);
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        reject(error);
      };
      const onAbort = () => leave(new Error("The call was cancelled while waiting to run."));
      const timer = setTimeout(() => leave(new SlotTimeoutError()), options.waitMs ?? SLOT_WAIT_MS);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      current.waiting.push(admit);
    });
  } else {
    current.running += 1;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = current.waiting.shift();
    if (next) {
      // The slot passes straight to the next caller in line.
      next();
      return;
    }
    current.running -= 1;
    if (current.running === 0 && callLanes.get(memberId) === current) callLanes.delete(memberId);
  };
}

/**
 * Open one of the Member's request slots, or null when they are all taken.
 * The returned function closes it and is safe to call more than once.
 */
export function enterRequest(memberId: string): (() => void) | null {
  const open = requestCounts.get(memberId) ?? 0;
  if (open >= MAX_REQUESTS_IN_FLIGHT) return null;
  requestCounts.set(memberId, open + 1);
  let left = false;
  return () => {
    if (left) return;
    left = true;
    const remaining = (requestCounts.get(memberId) ?? 1) - 1;
    if (remaining > 0) requestCounts.set(memberId, remaining);
    else requestCounts.delete(memberId);
  };
}

/** What one request may still embed. Each request starts with its own. */
export type EmbedBudget = { remaining: number };

export function newEmbedBudget(): EmbedBudget {
  return { remaining: EMBED_BUDGET_BYTES };
}

/** How many calls a Member has running now, for tests. */
export function callsInFlight(memberId: string): number {
  return callLanes.get(memberId)?.running ?? 0;
}

/** How many requests a Member has open now, for tests. */
export function requestsInFlight(memberId: string): number {
  return requestCounts.get(memberId) ?? 0;
}
