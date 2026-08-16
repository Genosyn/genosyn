import { AppDataSource } from "../db/datasource.js";
import { MemberBrowser } from "../db/entities/MemberBrowser.js";

/**
 * The sentences a model reads when a Member's browser is not usable.
 *
 * These matter more than most error strings. The model is mid-task, holding a
 * plan, and its default instinct on any failure is to retry or to route around
 * — both of which are wrong here. Retrying cannot help (nothing on the App
 * side will change), and "routing around" would mean doing the human's work in
 * a different browser than the one they chose, which is exactly the silent
 * substitution the whole design refuses. So every message: names the browser,
 * says whether anything ran, forbids the retry, and hands over the one fix a
 * human can actually perform.
 */

export type MemberBrowserUnavailableReason =
  | "offline"
  | "busy"
  | "no-context"
  | "revoked"
  | "disconnected"
  | (string & {});

async function browserName(browserId: string): Promise<string> {
  const row = await AppDataSource.getRepository(MemberBrowser)
    .findOneBy({ id: browserId })
    .catch(() => null);
  return row?.name ?? "the paired browser";
}

export async function describeMemberBrowserUnavailable(
  browserId: string,
  reason: MemberBrowserUnavailableReason,
): Promise<string> {
  const name = await browserName(browserId);
  switch (reason) {
    case "busy":
      return (
        `"${name}" is already being driven by another session, and one browser can only ` +
        `take one driver at a time. Nothing ran and nothing was changed. Do not retry ` +
        `browser tools this turn and do not use a different browser — tell the human that ` +
        `browser is busy and ask whether to wait or to use Genosyn's own browser instead.`
      );
    case "revoked":
      return (
        `"${name}" was disconnected by its owner, so nothing ran and nothing was changed. ` +
        `Do not retry browser tools this turn. Tell the human their browser is no longer ` +
        `connected to this AI Employee.`
      );
    case "no-context":
      return (
        `"${name}" answered but had no browser window to work in, so nothing ran. ` +
        `Do not retry. Ask the human to restart the Genosyn browser bridge on that computer.`
      );
    case "disconnected":
      return (
        `"${name}" went away mid-action — the computer stopped responding or Chrome was ` +
        `closed. The last action may or may not have completed; treat it as unverified and ` +
        `do not repeat it. Summarise what you finished and what is left, and ask the human ` +
        `to bring that browser back online.`
      );
    case "offline":
    default:
      return (
        `"${name}" is offline, so nothing ran and nothing was changed. Do not retry browser ` +
        `tools this turn and do not use a different browser. Ask the human to start the ` +
        `Genosyn browser bridge on that computer, or whether they would rather you used ` +
        `Genosyn's own browser.`
      );
  }
}
