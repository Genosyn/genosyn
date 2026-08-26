import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Handoff } from "../db/entities/Handoff.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { chatWithEmployee } from "./chat.js";
import { getActiveModel } from "./models.js";

/**
 * Kickoff — the work session that starts the moment a Handoff is created.
 *
 * A Handoff used to be a passive row: the receiver discovered it whenever its
 * journal injection next mentioned it — its next Routine tick, or the next
 * time somebody happened to chat with it. Delegation with up to a day of lag
 * isn't delegation; it's a note left on a desk.
 *
 * So creating a Handoff now briefs the receiver immediately, the same "go"
 * signal shape as `todoKickoff.ts` and `decisionKickoff.ts`. The differences
 * are deliberate:
 *
 *  - **Employee authority, not delegated Member authority.** The work is the
 *    receiver's own, not a Member's interactive request — a handoff is usually
 *    authored by another AI Employee, and even when a human creates one from
 *    the Handoffs page the session runs later, unattended, on the receiver's
 *    behalf. So it takes the same trusted non-human orchestration path Mail
 *    handovers use (`toolAuthority: "employee"`), giving the receiver exactly
 *    the authority its own Routine Runs have — no more — and everything
 *    privileged it then tries still meets its own gate.
 *  - **No model → stays pending, quietly.** The journal entry written at
 *    creation already reaches the receiver on its next spawn; that was the
 *    only delivery before this service existed and remains the fallback.
 *  - **The row is not claimed.** Kickoff is fired exactly once, by the
 *    process that created the row; the in-process guard only protects
 *    against re-entrant calls. Completing or declining stays the receiver's
 *    move via `complete_handoff` / `decline_handoff`.
 */

const inFlight = new Set<string>();

/** Keep failure notes inside a size the journal renders comfortably. */
const NOTE_CAP = 8_000;

export async function kickoffHandoff(args: {
  companyId: string;
  handoffId: string;
}): Promise<void> {
  const { companyId, handoffId } = args;
  if (inFlight.has(handoffId)) return;

  const handoff = await AppDataSource.getRepository(Handoff).findOneBy({
    id: handoffId,
    companyId,
  });
  if (!handoff || handoff.status !== "pending") return;

  const [receiver, sender] = await Promise.all([
    AppDataSource.getRepository(AIEmployee).findOneBy({
      id: handoff.toEmployeeId,
      companyId,
    }),
    AppDataSource.getRepository(AIEmployee).findOneBy({
      id: handoff.fromEmployeeId,
      companyId,
    }),
  ]);
  if (!receiver) return;

  // No model, no session — the creation-time journal entry remains the
  // delivery, exactly as before this service existed.
  if (!(await getActiveModel(receiver.id))) return;

  inFlight.add(handoffId);
  try {
    const result = await chatWithEmployee(
      companyId,
      receiver.id,
      composeHandoffBrief(handoff, sender),
      [],
      { toolAuthority: "employee" },
    );
    if (result.status !== "ok") {
      await journal(
        receiver.id,
        `Could not start on the handoff "${handoff.title}"`,
        `The kickoff session failed: ${result.reply}. The handoff is still pending — pick it up on your next run.`,
      );
    }
  } catch (err) {
    await journal(
      receiver.id,
      `Could not start on the handoff "${handoff.title}"`,
      `The kickoff session failed: ${err instanceof Error ? err.message : String(err)}. ` +
        "The handoff is still pending — pick it up on your next run.",
    ).catch(() => undefined);
  } finally {
    inFlight.delete(handoffId);
  }
}

function composeHandoffBrief(handoff: Handoff, sender: AIEmployee | null): string {
  const from = sender ? `${sender.name} (${sender.role})` : "a teammate";
  const lines = [
    `You have just received a handoff from ${from}: **${handoff.title}**`,
  ];
  if (handoff.body.trim()) lines.push("", "Their brief:", "---", handoff.body, "---");
  if (handoff.dueAt) lines.push("", `It is due ${handoff.dueAt.toISOString()}.`);
  lines.push(
    "",
    "---",
    "Start on this now — this session exists so the work begins when it is handed over, not on your next scheduled run.",
    "- Actually do the work with your tools. Don't just plan or acknowledge.",
    `- When you finish, call \`complete_handoff\` with handoffId "${handoff.id}" and a resolution note reporting what you did and where it landed.`,
    `- If you cannot or should not do this, call \`decline_handoff\` with handoffId "${handoff.id}" and say exactly why, so the sender can route around you.`,
    "- If the work is bigger than one session, do the first concrete piece now, then schedule the rest (a Routine or a todo) before you stop — and say so in your reply.",
  );
  return lines.join("\n");
}

async function journal(employeeId: string, title: string, body: string): Promise<void> {
  const repo = AppDataSource.getRepository(JournalEntry);
  await repo.save(
    repo.create({
      employeeId,
      kind: "system",
      title,
      body: body.slice(0, NOTE_CAP),
      runId: null,
      routineId: null,
      authorUserId: null,
    }),
  );
}
