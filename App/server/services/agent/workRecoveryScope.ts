import { createHash } from "node:crypto";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Conversation } from "../../db/entities/Conversation.js";
import { Project } from "../../db/entities/Project.js";
import { Channel } from "../../db/entities/Channel.js";
import { Routine } from "../../db/entities/Routine.js";
import { Run } from "../../db/entities/Run.js";
import { resolveMcpToken } from "../mcpTokens.js";
import { createPrivilegedMemberToolAuthorizer } from "../memberTurnAuthority.js";

export type RecoveryScope = {
  companyId: string;
  employeeId: string;
  scopeKey: string;
  authority: "employee" | "member";
  requesterUserId: string;
  runId: string | null;
  runs: Run[];
};

/** Resolve identity and lineage from live server authority, never caller-selected IDs. */
export async function resolveRecoveryScope(
  token: string,
  allowRestricted = false,
): Promise<RecoveryScope | null> {
  const info = resolveMcpToken(token);
  if (
    !info ||
    info.authority === "untrusted" ||
    (!allowRestricted && (info.selfReviewOnly || info.proactiveReview))
  )
    return null;
  if (info.authority === "member") {
    if (!info.requesterUserId || info.requesterSessionVersion === null) return null;
    const denial = await createPrivilegedMemberToolAuthorizer({
      companyId: info.companyId,
      userId: info.requesterUserId,
      sessionVersion: info.requesterSessionVersion,
    })();
    if (denial) return null;
  }
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: info.employeeId,
    companyId: info.companyId,
  });
  if (!employee) return null;
  const identity = {
    companyId: info.companyId,
    employeeId: info.employeeId,
    authority: info.authority,
    requesterUserId: info.requesterUserId ?? "",
  };
  if (info.runId) {
    const run = await AppDataSource.getRepository(Run).findOneBy({ id: info.runId });
    if (!run || run.routineId !== info.routineId) return null;
    const routine = await AppDataSource.getRepository(Routine).findOneBy({
      id: run.routineId,
      employeeId: info.employeeId,
    });
    if (!routine) return null;
    const runs = [run];
    let current = run;
    while (current.triggerKind === "retry" || current.triggerKind === "continuation") {
      if (
        !current.parentRunId ||
        runs.some((entry) => entry.id === current.parentRunId) ||
        runs.length >= 100
      ) {
        throw new Error("The Run recovery lineage could not be verified.");
      }
      const parent = await AppDataSource.getRepository(Run).findOneBy({
        id: current.parentRunId,
        routineId: run.routineId,
      });
      if (!parent) throw new Error("The Run recovery lineage could not be verified.");
      runs.push(parent);
      current = parent;
    }
    return { ...identity, scopeKey: `run:${current.id}`, runId: run.id, runs };
  }
  if (info.conversationId) {
    const conversation = await AppDataSource.getRepository(Conversation).findOneBy({
      id: info.conversationId,
      employeeId: info.employeeId,
    });
    if (
      !conversation ||
      (conversation.ownerUserId && conversation.ownerUserId !== info.requesterUserId) ||
      (!conversation.ownerUserId && info.authority === "member")
    )
      return null;
    return { ...identity, scopeKey: `conversation:${conversation.id}`, runId: null, runs: [] };
  }
  return null;
}

export type RecoveryGrantSnapshot = string[];

/**
 * Persist only hashes of access rows. Additional Grants do not invalidate old
 * evidence; a removed/replaced/changed original Grant does. This deliberately
 * fails conservatively on level changes because recovered prose cannot tell
 * which part came from which resource.
 */
export async function captureRecoveryGrants(
  companyId: string,
  employeeId: string,
): Promise<RecoveryGrantSnapshot> {
  const entries: string[] = [];
  const metadata = AppDataSource.entityMetadatas.filter(
    (entry) =>
      (/^Employee.*Grant$/.test(entry.name) ||
        ["ProjectMember", "ChannelMember", "McpServer"].includes(entry.name)) &&
      entry.columns.some((column) => column.propertyName === "employeeId"),
  );
  const rowsByEntity = await Promise.all(
    metadata.map((entry) =>
      AppDataSource.getRepository(entry.target).findBy({
        employeeId,
        ...(entry.name === "McpServer" ? { enabled: true } : {}),
      }),
    ),
  );
  for (const [index, entry] of metadata.entries()) {
    const rows = rowsByEntity[index];
    for (const row of rows) {
      const values = entry.columns
        .filter((column) => !["createdAt", "updatedAt"].includes(column.propertyName))
        .map((column) => [column.propertyName, column.getEntityValue(row)]);
      entries.push(`${entry.name}:${hash(JSON.stringify(values))}`);
    }
  }
  // An open Project needs no membership row; closing it must still revoke the
  // ability to recover data learned while it was open.
  const openProjects = await AppDataSource.getRepository(Project).findBy({
    companyId,
    accessMode: "open",
  });
  for (const project of openProjects) entries.push(`OpenProject:${project.id}`);
  const publicChannels = await AppDataSource.getRepository(Channel).findBy({
    companyId,
    kind: "public",
  });
  for (const channel of publicChannels) entries.push(`PublicChannel:${channel.id}`);
  return entries.sort();
}

export function recoveryGrantsCover(saved: string, current: RecoveryGrantSnapshot): boolean {
  try {
    const required: unknown = JSON.parse(saved);
    if (!Array.isArray(required) || required.some((value) => typeof value !== "string"))
      return false;
    const available = new Set(current);
    return required.every((value) => available.has(value));
  } catch {
    return false;
  }
}

export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
