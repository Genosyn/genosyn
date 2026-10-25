import { AppDataSource } from "../../db/datasource.js";
import { Company } from "../../db/entities/Company.js";
import type { DataRoom } from "../../db/entities/DataRoom.js";
import { DataRoomFolder } from "../../db/entities/DataRoomFolder.js";
import { DataRoomGuest, type DataRoomInviteStatus } from "../../db/entities/DataRoomGuest.js";
import { DATA_ROOM_LIMITS } from "../../../shared/dataRooms.js";
import { normalizeEmail } from "../../lib/emailAddress.js";
import { sendEmail } from "../email.js";
import {
  type DataRoomActor,
  actorColumns,
  auditRoom,
  guestFolderIds,
  requireRoom,
} from "./access.js";
import { buildGuestInvitationEmail } from "./emails.js";
import { DataRoomConflictError, DataRoomNotFoundError, DataRoomValidationError } from "./errors.js";
import { generateGuestToken, guestLink, guestLinkForToken, guestTokenColumns } from "./tokens.js";

/**
 * Inviting people outside the company into a room, and keeping their access
 * right: which folders they see, until when, and whether their link still
 * works. Every change here is a Member's or an AI Employee's with `share`
 * access — guests change nothing about their own access.
 */

export type InvitationDelivery = { status: DataRoomInviteStatus; error: string };

export async function listGuests(roomId: string): Promise<DataRoomGuest[]> {
  return AppDataSource.getRepository(DataRoomGuest).find({
    where: { roomId },
    order: { createdAt: "ASC" },
  });
}

export async function requireGuest(roomId: string, guestId: string): Promise<DataRoomGuest> {
  const guest = await AppDataSource.getRepository(DataRoomGuest).findOneBy({ id: guestId, roomId });
  if (!guest) throw new DataRoomNotFoundError("Guest not found");
  return guest;
}

function cleanPerson(
  name: string,
  organization: string | undefined,
): { name: string; organization: string } {
  const cleanName = name.replace(/\s+/g, " ").trim();
  if (!cleanName) throw new DataRoomValidationError("The guest's name is required.");
  if (cleanName.length > 160)
    throw new DataRoomValidationError("Keep the name under 160 characters.");
  const cleanOrganization = (organization ?? "").replace(/\s+/g, " ").trim();
  if (cleanOrganization.length > 160) {
    throw new DataRoomValidationError("Keep the organization under 160 characters.");
  }
  return { name: cleanName, organization: cleanOrganization };
}

/** The folder ids, each checked to be the room's own. Empty means every folder. */
async function cleanFolderIds(roomId: string, folderIds: string[] | undefined): Promise<string[]> {
  if (!folderIds || folderIds.length === 0) return [];
  const folders = await AppDataSource.getRepository(DataRoomFolder).find({
    where: { roomId },
    select: { id: true },
  });
  const known = new Set(folders.map((folder) => folder.id));
  const unique = [...new Set(folderIds)];
  if (unique.some((id) => !known.has(id))) throw new DataRoomNotFoundError("Folder not found");
  return unique;
}

function cleanExpiry(value: Date | null | undefined): Date | null {
  if (!value) return null;
  if (!Number.isFinite(value.getTime()))
    throw new DataRoomValidationError("The end date is not a date.");
  if (value.getTime() <= Date.now())
    throw new DataRoomValidationError("Access must end in the future.");
  return value;
}

async function deliverInvitation(args: {
  room: DataRoom;
  guest: DataRoomGuest;
  link: string;
  message: string;
  actor: DataRoomActor;
}): Promise<InvitationDelivery> {
  const company = await AppDataSource.getRepository(Company).findOneBy({ id: args.room.companyId });
  if (!company) return { status: "failed", error: "Company not found" };
  let delivery: InvitationDelivery;
  try {
    const result = await sendEmail({
      ...buildGuestInvitationEmail({
        company,
        room: args.room,
        guest: args.guest,
        link: args.link,
        message: args.message,
        expiresAt: args.guest.expiresAt,
      }),
      companyId: args.room.companyId,
      triggeredByUserId: args.actor.kind === "user" ? args.actor.userId : null,
    });
    delivery = { status: result.status, error: result.errorMessage.slice(0, 500) };
  } catch (error) {
    delivery = {
      status: "failed",
      error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    };
  }
  await AppDataSource.getRepository(DataRoomGuest).update(
    { id: args.guest.id },
    {
      inviteStatus: delivery.status,
      inviteError: delivery.error,
      inviteSentAt: delivery.status === "sent" ? new Date() : args.guest.inviteSentAt,
    },
  );
  return delivery;
}

export async function inviteGuest(args: {
  companyId: string;
  roomId: string;
  name: string;
  email: string;
  organization?: string;
  folderIds?: string[];
  expiresAt?: Date | null;
  /** Email the link (the default). Without it the Member shares the link themselves. */
  sendInvitation?: boolean;
  message?: string;
  actor: DataRoomActor;
}): Promise<{ guest: DataRoomGuest; link: string; delivery: InvitationDelivery | null }> {
  const room = await requireRoom(args.companyId, args.roomId);
  if (room.status !== "open")
    throw new DataRoomConflictError("Reopen the room before inviting anyone.");
  const email = normalizeEmail(args.email)?.toLowerCase();
  if (!email) throw new DataRoomValidationError("Enter a valid email address.");
  const person = cleanPerson(args.name, args.organization);
  const folderIds = await cleanFolderIds(room.id, args.folderIds);
  const expiresAt = cleanExpiry(args.expiresAt);
  const message = (args.message ?? "").trim();
  if (message.length > 2_000)
    throw new DataRoomValidationError("Keep the message under 2,000 characters.");
  const repo = AppDataSource.getRepository(DataRoomGuest);
  const existing = await repo.findOneBy({ roomId: room.id, email });
  if (existing && existing.status === "active") {
    throw new DataRoomConflictError(`${existing.name} <${email}> is already a guest of this room.`);
  }
  if (!existing && (await repo.countBy({ roomId: room.id })) >= DATA_ROOM_LIMITS.guestsPerRoom) {
    throw new DataRoomConflictError(
      `A room can have at most ${DATA_ROOM_LIMITS.guestsPerRoom} guests.`,
    );
  }
  const token = generateGuestToken();
  const who = actorColumns(args.actor);
  const fields = {
    name: person.name,
    organization: person.organization,
    status: "active" as const,
    folderIdsJson: JSON.stringify(folderIds),
    expiresAt,
    ...guestTokenColumns(room.companyId, token),
    invitedByUserId: who.userId,
    invitedByEmployeeId: who.employeeId,
    revokedAt: null,
    inviteStatus: "none" as const,
    inviteError: "",
  };
  let guest: DataRoomGuest;
  if (existing) {
    await repo.update({ id: existing.id }, fields);
    guest = await repo.findOneByOrFail({ id: existing.id });
  } else {
    guest = await repo.save(
      repo.create({ companyId: room.companyId, roomId: room.id, email, ...fields }),
    );
  }
  const link = guestLinkForToken(token);
  const delivery =
    args.sendInvitation === false
      ? null
      : await deliverInvitation({ room, guest, link, message, actor: args.actor });
  await auditRoom(args.actor, room, existing ? "guest_reinvited" : "guest_invited", {
    guestId: guest.id,
    email,
    organization: person.organization,
    folders: folderIds.length || "all",
    emailed: delivery?.status ?? "not sent",
  });
  return { guest: await repo.findOneByOrFail({ id: guest.id }), link, delivery };
}

export async function updateGuest(args: {
  companyId: string;
  roomId: string;
  guestId: string;
  name?: string;
  organization?: string;
  folderIds?: string[];
  expiresAt?: Date | null;
  actor: DataRoomActor;
}): Promise<DataRoomGuest> {
  const room = await requireRoom(args.companyId, args.roomId);
  const guest = await requireGuest(room.id, args.guestId);
  const changes: Partial<DataRoomGuest> = {};
  if (args.name !== undefined || args.organization !== undefined) {
    const person = cleanPerson(args.name ?? guest.name, args.organization ?? guest.organization);
    changes.name = person.name;
    changes.organization = person.organization;
  }
  if (args.folderIds !== undefined) {
    changes.folderIdsJson = JSON.stringify(await cleanFolderIds(room.id, args.folderIds));
  }
  if (args.expiresAt !== undefined) changes.expiresAt = cleanExpiry(args.expiresAt);
  if (Object.keys(changes).length === 0) return guest;
  await AppDataSource.getRepository(DataRoomGuest).update({ id: guest.id }, changes);
  await auditRoom(args.actor, room, "guest_access_changed", {
    guestId: guest.id,
    email: guest.email,
    fields: Object.keys(changes),
    ...(changes.folderIdsJson !== undefined
      ? { folders: guestFolderIds({ folderIdsJson: changes.folderIdsJson }).length || "all" }
      : {}),
  });
  return requireGuest(room.id, guest.id);
}

export async function setGuestStatus(args: {
  companyId: string;
  roomId: string;
  guestId: string;
  status: "active" | "revoked";
  actor: DataRoomActor;
}): Promise<DataRoomGuest> {
  const room = await requireRoom(args.companyId, args.roomId);
  const guest = await requireGuest(room.id, args.guestId);
  if (guest.status === args.status) return guest;
  await AppDataSource.getRepository(DataRoomGuest).update(
    { id: guest.id },
    { status: args.status, revokedAt: args.status === "revoked" ? new Date() : null },
  );
  await auditRoom(
    args.actor,
    room,
    args.status === "revoked" ? "guest_revoked" : "guest_restored",
    {
      guestId: guest.id,
      email: guest.email,
    },
  );
  return requireGuest(room.id, guest.id);
}

/** A new link for the guest; the old one stops working at once. */
export async function reissueGuestLink(args: {
  companyId: string;
  roomId: string;
  guestId: string;
  sendInvitation?: boolean;
  actor: DataRoomActor;
}): Promise<{ guest: DataRoomGuest; link: string; delivery: InvitationDelivery | null }> {
  const room = await requireRoom(args.companyId, args.roomId);
  const guest = await requireGuest(room.id, args.guestId);
  const token = generateGuestToken();
  await AppDataSource.getRepository(DataRoomGuest).update(
    { id: guest.id },
    guestTokenColumns(room.companyId, token),
  );
  const updated = await requireGuest(room.id, guest.id);
  const link = guestLinkForToken(token);
  const delivery =
    args.sendInvitation && updated.status === "active" && room.status === "open"
      ? await deliverInvitation({ room, guest: updated, link, message: "", actor: args.actor })
      : null;
  await auditRoom(args.actor, room, "guest_link_reissued", {
    guestId: guest.id,
    email: guest.email,
  });
  return { guest: await requireGuest(room.id, guest.id), link, delivery };
}

/** Send the invitation again, with the guest's current link. */
export async function resendInvitation(args: {
  companyId: string;
  roomId: string;
  guestId: string;
  message?: string;
  actor: DataRoomActor;
}): Promise<{ guest: DataRoomGuest; delivery: InvitationDelivery }> {
  const room = await requireRoom(args.companyId, args.roomId);
  if (room.status !== "open") throw new DataRoomConflictError("Reopen the room first.");
  const guest = await requireGuest(room.id, args.guestId);
  if (guest.status !== "active")
    throw new DataRoomConflictError("Restore the guest's access first.");
  const link = guestLink(guest);
  if (!link) {
    throw new DataRoomConflictError(
      "This guest's link can no longer be read. Reissue the link instead.",
    );
  }
  const delivery = await deliverInvitation({
    room,
    guest,
    link,
    message: (args.message ?? "").trim().slice(0, 2_000),
    actor: args.actor,
  });
  await auditRoom(args.actor, room, "guest_invitation_resent", {
    guestId: guest.id,
    email: guest.email,
    emailed: delivery.status,
  });
  return { guest: await requireGuest(room.id, guest.id), delivery };
}

/** The guest's current link, for a Member copying it. */
export async function guestLinkFor(args: {
  companyId: string;
  roomId: string;
  guestId: string;
}): Promise<string> {
  const room = await requireRoom(args.companyId, args.roomId);
  const guest = await requireGuest(room.id, args.guestId);
  const link = guestLink(guest);
  if (!link) {
    throw new DataRoomConflictError(
      "This guest's link can no longer be read. Reissue the link instead.",
    );
  }
  return link;
}
