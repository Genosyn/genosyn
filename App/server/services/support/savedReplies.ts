import { AppDataSource } from "../../db/datasource.js";
import { SupportSavedReply } from "../../db/entities/SupportSavedReply.js";
import { SUPPORT_LIMITS } from "../../../shared/support.js";
import { emitResourceChange } from "../resourceEvents.js";
import { SupportNotFoundError, SupportValidationError } from "./errors.js";

/** Replies a Member writes once. They only ever fill the composer; a person presses Send. */

function announce(companyId: string): void {
  emitResourceChange(companyId, "support_saved_reply", undefined, { trigger: false });
}

function clean(args: { name?: string; body?: string }): { name?: string; body?: string } {
  const fields: { name?: string; body?: string } = {};
  if (args.name !== undefined) {
    const name = args.name.trim();
    if (!name) throw new SupportValidationError("A saved reply needs a name.");
    if (name.length > SUPPORT_LIMITS.savedReplyNameChars) {
      throw new SupportValidationError("That name is too long.");
    }
    fields.name = name;
  }
  if (args.body !== undefined) {
    if (!args.body.trim()) throw new SupportValidationError("A saved reply needs some text.");
    if (args.body.length > SUPPORT_LIMITS.savedReplyBodyChars) {
      throw new SupportValidationError("That saved reply is too long.");
    }
    fields.body = args.body;
  }
  return fields;
}

export async function listSavedReplies(companyId: string): Promise<SupportSavedReply[]> {
  return AppDataSource.getRepository(SupportSavedReply).find({
    where: { companyId },
    order: { name: "ASC" },
    take: 500,
  });
}

export async function createSavedReply(args: {
  companyId: string;
  name: string;
  body: string;
  userId: string | null;
}): Promise<SupportSavedReply> {
  const repo = AppDataSource.getRepository(SupportSavedReply);
  const saved = await repo.save(
    repo.create({
      companyId: args.companyId,
      ...clean({ name: args.name, body: args.body }),
      createdByUserId: args.userId,
    }),
  );
  announce(args.companyId);
  return saved;
}

async function requireSavedReply(companyId: string, id: string): Promise<SupportSavedReply> {
  const reply = await AppDataSource.getRepository(SupportSavedReply).findOneBy({ id, companyId });
  if (!reply) throw new SupportNotFoundError("Saved reply not found");
  return reply;
}

export async function updateSavedReply(args: {
  companyId: string;
  id: string;
  name?: string;
  body?: string;
}): Promise<SupportSavedReply> {
  const reply = await requireSavedReply(args.companyId, args.id);
  const fields = clean({ name: args.name, body: args.body });
  if (Object.keys(fields).length > 0) {
    await AppDataSource.getRepository(SupportSavedReply).update({ id: reply.id }, fields);
    announce(args.companyId);
  }
  return requireSavedReply(args.companyId, reply.id);
}

export async function deleteSavedReply(companyId: string, id: string): Promise<void> {
  const reply = await requireSavedReply(companyId, id);
  await AppDataSource.getRepository(SupportSavedReply).delete({ id: reply.id });
  announce(companyId);
}

/** Counted when inserted, so the list can lead with the ones people actually use. */
export async function markSavedReplyUsed(companyId: string, id: string): Promise<void> {
  const reply = await requireSavedReply(companyId, id);
  await AppDataSource.getRepository(SupportSavedReply).update(
    { id: reply.id },
    { usageCount: reply.usageCount + 1 },
  );
}
