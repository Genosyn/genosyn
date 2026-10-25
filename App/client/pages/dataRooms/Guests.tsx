import React from "react";
import { useSearchParams } from "react-router-dom";
import {
  Ban,
  Check,
  Copy,
  KeyRound,
  Link2,
  MailCheck,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Send,
  UserPlus,
  Users,
} from "lucide-react";

import { useLiveRefetch } from "@/components/CompanySocket";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { useDialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormError } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { Modal } from "@/components/ui/Modal";
import { SkeletonList } from "@/components/ui/Skeleton";
import { TD, TH, THead, TR, Table, TableCard } from "@/components/ui/Table";
import { Textarea } from "@/components/ui/Textarea";
import { copyToClipboard } from "@/lib/clipboard";
import {
  agoText,
  dataRoomsApi,
  endOfDayIso,
  formatDate,
  type DataRoomFolder,
  type DataRoomGuest,
  type InvitationDelivery,
} from "@/lib/dataRooms";
import { errorMessage } from "@/lib/errors";
import { formatDuration } from "../../../shared/dataRooms";
import type { RoomTabProps } from "../DataRoomDetail";
import { plural } from "./shared";

function accessLabel(guest: DataRoomGuest, folders: DataRoomFolder[]): string {
  if (guest.folderIds.length === 0) return "Every folder";
  const names = folders
    .filter((folder) => guest.folderIds.includes(folder.id))
    .map((folder) => folder.name);
  return names.length === 1 ? names[0] : plural(names.length, "folder");
}

function GuestStatus({ guest }: { guest: DataRoomGuest }) {
  if (guest.status === "revoked") return <Badge>Revoked</Badge>;
  if (guest.expired) return <Badge tone="warning">Access ended</Badge>;
  if (guest.inviteStatus === "failed") {
    return (
      <Badge tone="danger" title={guest.inviteError}>
        Invitation failed
      </Badge>
    );
  }
  if (guest.firstViewedAt)
    return (
      <Badge tone="success" dot>
        Visited
      </Badge>
    );
  if (guest.inviteStatus === "sent") return <Badge tone="info">Invited</Badge>;
  return <Badge>Not emailed</Badge>;
}

export function RoomGuestsTab({ companyId, detail, reload }: RoomTabProps) {
  const dialog = useDialog();
  const roomsApi = React.useMemo(() => dataRoomsApi(companyId), [companyId]);
  const { room, folders } = detail;
  const [guests, setGuests] = React.useState<DataRoomGuest[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [inviting, setInviting] = React.useState(false);
  const [editing, setEditing] = React.useState<DataRoomGuest | null>(null);
  const [params, setParams] = useSearchParams();
  // The room header's "Invite a guest" lands here with ?invite=1.
  React.useEffect(() => {
    if (params.get("invite") !== "1") return;
    const next = new URLSearchParams(params);
    next.delete("invite");
    setParams(next, { replace: true });
    if (room.status === "open") setInviting(true);
  }, [params, setParams, room.status]);
  const [shared, setShared] = React.useState<{
    guest: DataRoomGuest;
    link: string;
    delivery: InvitationDelivery | null;
  } | null>(null);

  const load = React.useCallback(async () => {
    try {
      setGuests((await roomsApi.guests(room.id)).guests);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, "Could not load the guests"));
    }
  }, [roomsApi, room.id]);
  React.useEffect(() => {
    void load();
  }, [load]);
  useLiveRefetch(["data_room_guest"], () => void load(), room.id);

  async function act(title: string, work: () => Promise<unknown>) {
    try {
      await work();
      await load();
      await reload();
    } catch (err) {
      void dialog.error(err, { title });
    }
  }

  async function copyLink(guest: DataRoomGuest) {
    try {
      const { link } = await roomsApi.guestLink(room.id, guest.id);
      const copied = await copyToClipboard(link);
      if (!copied) await dialog.alert({ title: "Copy this link", message: link });
      else
        await dialog.alert({
          title: "Link copied",
          message: `${guest.name}'s private link is on your clipboard. Anyone with it can open the room as them.`,
        });
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t copy the link" });
    }
  }

  async function reissue(guest: DataRoomGuest) {
    const ok = await dialog.confirm({
      title: `Give ${guest.name} a new link?`,
      message: "Their current link stops working at once. The new one is emailed to them.",
      confirmLabel: "New link",
    });
    if (!ok) return;
    try {
      const result = await roomsApi.reissueLink(room.id, guest.id, true);
      setShared(result);
      await load();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t reissue the link" });
    }
  }

  async function revoke(guest: DataRoomGuest) {
    const ok = await dialog.confirm({
      title: `Revoke ${guest.name}'s access?`,
      message: "Their link stops opening the room at once. You can restore it later.",
      confirmLabel: "Revoke access",
      variant: "danger",
    });
    if (ok) await act("Couldn’t revoke access", () => roomsApi.revokeGuest(room.id, guest.id));
  }

  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-slate-500 dark:text-slate-400">
        Each guest opens the room through their own private link and sees only the folders you give
        them. Every visit, page and question is recorded.
      </p>

      {error ? (
        <EmptyState
          title="Guests could not be loaded"
          description={error}
          action={<Button onClick={() => void load()}>Try again</Button>}
        />
      ) : guests === null ? (
        <SkeletonList rows={3} />
      ) : guests.length === 0 ? (
        <EmptyState
          icon={<Users />}
          title="No guests yet"
          description={
            room.status === "open"
              ? "Invite an investor, a buyer or an auditor. They get a private link by email; you see what they read."
              : "The room is closed. Reopen it in its settings to invite anyone."
          }
          action={
            room.status === "open" ? (
              <Button onClick={() => setInviting(true)}>
                <UserPlus size={15} /> Invite a guest
              </Button>
            ) : undefined
          }
        />
      ) : (
        <TableCard>
          <Table>
            <THead>
              <tr>
                <TH>Guest</TH>
                <TH className="hidden lg:table-cell">Can open</TH>
                <TH>Status</TH>
                <TH className="hidden sm:table-cell">Last visit</TH>
                <TH className="hidden xl:table-cell" align="right">
                  Reading
                </TH>
                <TH>
                  <span className="sr-only">Actions</span>
                </TH>
              </tr>
            </THead>
            <tbody>
              {guests.map((guest) => (
                <TR key={guest.id}>
                  <TD>
                    <div className="min-w-0 max-w-[14rem] sm:max-w-xs">
                      <div className="truncate font-medium text-slate-900 dark:text-slate-100">
                        {guest.name}
                      </div>
                      <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                        {guest.organization ? `${guest.organization} · ` : ""}
                        {guest.email}
                      </div>
                    </div>
                  </TD>
                  <TD className="hidden lg:table-cell">
                    <div className="max-w-[12rem] truncate text-sm">
                      {accessLabel(guest, folders)}
                    </div>
                    {guest.expiresAt && (
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        Until {formatDate(guest.expiresAt)}
                      </div>
                    )}
                  </TD>
                  <TD>
                    <GuestStatus guest={guest} />
                  </TD>
                  <TD className="hidden whitespace-nowrap text-sm sm:table-cell">
                    {guest.lastViewedAt ? agoText(guest.lastViewedAt) : "Not yet"}
                  </TD>
                  <TD className="hidden xl:table-cell" align="right" numeric>
                    <div className="text-sm">{formatDuration(guest.totalSeconds)}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {plural(guest.visitCount, "visit")}
                    </div>
                  </TD>
                  <TD align="right">
                    <Menu
                      align="right"
                      width={220}
                      trigger={({ ref, onClick }) => (
                        <Button
                          ref={ref}
                          variant="ghost"
                          size="sm"
                          onClick={onClick}
                          aria-label={`Actions for ${guest.name}`}
                        >
                          <MoreHorizontal size={15} />
                        </Button>
                      )}
                    >
                      {(close) => (
                        <>
                          <MenuItem
                            icon={<Copy size={14} />}
                            label="Copy private link"
                            onSelect={() => {
                              close();
                              void copyLink(guest);
                            }}
                          />
                          {guest.status === "active" && room.status === "open" && (
                            <MenuItem
                              icon={<Send size={14} />}
                              label="Email the invitation again"
                              onSelect={() => {
                                close();
                                void act("Couldn’t send the invitation", () =>
                                  roomsApi.resendInvitation(room.id, guest.id),
                                );
                              }}
                            />
                          )}
                          <MenuItem
                            icon={<Pencil size={14} />}
                            label="Change access"
                            onSelect={() => {
                              close();
                              setEditing(guest);
                            }}
                          />
                          <MenuItem
                            icon={<KeyRound size={14} />}
                            label="Give a new link"
                            onSelect={() => {
                              close();
                              void reissue(guest);
                            }}
                          />
                          <MenuSeparator />
                          {guest.status === "active" ? (
                            <MenuItem
                              icon={<Ban size={14} />}
                              label="Revoke access"
                              onSelect={() => {
                                close();
                                void revoke(guest);
                              }}
                            />
                          ) : (
                            <MenuItem
                              icon={<RotateCcw size={14} />}
                              label="Restore access"
                              onSelect={() => {
                                close();
                                void act("Couldn’t restore access", () =>
                                  roomsApi.restoreGuest(room.id, guest.id),
                                );
                              }}
                            />
                          )}
                        </>
                      )}
                    </Menu>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </TableCard>
      )}

      <InviteModal
        open={inviting}
        onClose={() => setInviting(false)}
        folders={folders}
        onInvite={async (input) => {
          const result = await roomsApi.invite(room.id, input);
          setInviting(false);
          setShared(result);
          await load();
          await reload();
        }}
      />
      <AccessModal
        guest={editing}
        folders={folders}
        onClose={() => setEditing(null)}
        onSave={async (patch) => {
          if (!editing) return;
          await roomsApi.updateGuest(room.id, editing.id, patch);
          setEditing(null);
          await load();
        }}
      />
      <SharedLinkModal shared={shared} onClose={() => setShared(null)} />
    </div>
  );
}

/** "Every folder" or a chosen few, as checkboxes. */
function FolderChoice({
  folders,
  selected,
  onChange,
}: {
  folders: DataRoomFolder[];
  selected: string[] | null;
  onChange: (next: string[] | null) => void;
}) {
  const everything = selected === null;
  return (
    <fieldset>
      <legend className="text-sm font-medium text-slate-800 dark:text-slate-200">Can open</legend>
      <div className="mt-2 space-y-2 text-sm">
        <label className="flex items-center gap-2">
          <input type="radio" checked={everything} onChange={() => onChange(null)} />
          Every folder, and anything added later
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            checked={!everything}
            onChange={() => onChange([])}
            disabled={folders.length === 0}
          />
          Only the folders I choose
        </label>
      </div>
      {!everything && (
        <div className="mt-2 grid gap-1.5 rounded-lg border border-slate-200 p-3 sm:grid-cols-2 dark:border-slate-800">
          {folders.map((folder) => (
            <label
              key={folder.id}
              className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300"
            >
              <Checkbox
                label={folder.name}
                checked={selected.includes(folder.id)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selected, folder.id]
                      : selected.filter((id) => id !== folder.id),
                  )
                }
              />
              <span className="truncate">
                {folder.number} {folder.name}
              </span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

function InviteModal({
  open,
  onClose,
  folders,
  onInvite,
}: {
  open: boolean;
  onClose: () => void;
  folders: DataRoomFolder[];
  onInvite: (input: {
    name: string;
    email: string;
    organization: string;
    folderIds: string[];
    expiresAt: string | null;
    sendInvitation: boolean;
    message: string;
  }) => Promise<void>;
}) {
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [organization, setOrganization] = React.useState("");
  const [selected, setSelected] = React.useState<string[] | null>(null);
  const [until, setUntil] = React.useState("");
  const [send, setSend] = React.useState(true);
  const [message, setMessage] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setName("");
    setEmail("");
    setOrganization("");
    setSelected(null);
    setUntil("");
    setSend(true);
    setMessage("");
    setError(null);
  }, [open]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || !email.trim()) {
      setError("A name and an email address are needed.");
      return;
    }
    if (selected !== null && selected.length === 0) {
      setError("Choose at least one folder, or give them every folder.");
      return;
    }
    const expiresAt = until ? endOfDayIso(until) : null;
    if (until && !expiresAt) {
      setError("The end date is not a date.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onInvite({
        name: name.trim(),
        email: email.trim(),
        organization: organization.trim(),
        folderIds: selected ?? [],
        expiresAt,
        sendInvitation: send,
        message: message.trim(),
      });
    } catch (err) {
      setError(errorMessage(err, "Could not invite them"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Invite a guest"
      description="They get their own private link. You can change what they see, or revoke it, at any time."
      onSubmit={submit}
      size="lg"
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            <UserPlus size={15} /> Invite
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-sm font-medium text-slate-800 dark:text-slate-200">Name</span>
            <Input
              className="mt-1 w-full"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
              maxLength={160}
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-800 dark:text-slate-200">Email</span>
            <Input
              className="mt-1 w-full"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              maxLength={320}
            />
          </label>
        </div>
        <label className="block">
          <span className="text-sm font-medium text-slate-800 dark:text-slate-200">
            Firm or company{" "}
            <span className="font-normal text-slate-500 dark:text-slate-400">(optional)</span>
          </span>
          <Input
            className="mt-1 w-full"
            value={organization}
            onChange={(event) => setOrganization(event.target.value)}
            placeholder="Acme Ventures"
            maxLength={160}
          />
        </label>
        <FolderChoice folders={folders} selected={selected} onChange={setSelected} />
        <label className="block">
          <span className="text-sm font-medium text-slate-800 dark:text-slate-200">
            Access ends{" "}
            <span className="font-normal text-slate-500 dark:text-slate-400">(optional)</span>
          </span>
          <Input
            className="mt-1 w-full sm:w-56"
            type="date"
            value={until}
            onChange={(event) => setUntil(event.target.value)}
          />
        </label>
        <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
          <Checkbox
            label="Email the invitation"
            checked={send}
            onChange={(event) => setSend(event.target.checked)}
          />
          <span>
            Email them the invitation now
            <span className="block text-xs text-slate-500 dark:text-slate-400">
              Otherwise you get the link to share yourself.
            </span>
          </span>
        </label>
        {send && (
          <label className="block">
            <span className="text-sm font-medium text-slate-800 dark:text-slate-200">
              Note in the email{" "}
              <span className="font-normal text-slate-500 dark:text-slate-400">(optional)</span>
            </span>
            <Textarea
              className="mt-1 w-full"
              rows={3}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              maxLength={2000}
            />
          </label>
        )}
        <FormError message={error} />
      </div>
    </Modal>
  );
}

function AccessModal({
  guest,
  folders,
  onClose,
  onSave,
}: {
  guest: DataRoomGuest | null;
  folders: DataRoomFolder[];
  onClose: () => void;
  onSave: (patch: {
    organization: string;
    folderIds: string[];
    expiresAt: string | null;
  }) => Promise<void>;
}) {
  const [organization, setOrganization] = React.useState("");
  const [selected, setSelected] = React.useState<string[] | null>(null);
  const [until, setUntil] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!guest) return;
    setOrganization(guest.organization);
    setSelected(guest.folderIds.length ? guest.folderIds : null);
    setUntil(guest.expiresAt ? guest.expiresAt.slice(0, 10) : "");
    setError(null);
  }, [guest]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (selected !== null && selected.length === 0) {
      setError("Choose at least one folder, or give them every folder.");
      return;
    }
    const expiresAt = until ? endOfDayIso(until) : null;
    setSaving(true);
    setError(null);
    try {
      await onSave({ organization: organization.trim(), folderIds: selected ?? [], expiresAt });
    } catch (err) {
      setError(errorMessage(err, "Could not change their access"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={Boolean(guest)}
      onClose={onClose}
      title={guest ? `${guest.name}'s access` : "Access"}
      description={guest?.email}
      onSubmit={submit}
      size="lg"
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            <Check size={15} /> Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <label className="block">
          <span className="text-sm font-medium text-slate-800 dark:text-slate-200">
            Firm or company
          </span>
          <Input
            className="mt-1 w-full"
            value={organization}
            onChange={(event) => setOrganization(event.target.value)}
            maxLength={160}
          />
        </label>
        <FolderChoice folders={folders} selected={selected} onChange={setSelected} />
        <label className="block">
          <span className="text-sm font-medium text-slate-800 dark:text-slate-200">
            Access ends
          </span>
          <Input
            className="mt-1 w-full sm:w-56"
            type="date"
            value={until}
            onChange={(event) => setUntil(event.target.value)}
          />
        </label>
        <FormError message={error} />
      </div>
    </Modal>
  );
}

function SharedLinkModal({
  shared,
  onClose,
}: {
  shared: { guest: DataRoomGuest; link: string; delivery: InvitationDelivery | null } | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => setCopied(false), [shared]);
  if (!shared) return null;
  const { guest, link, delivery } = shared;
  return (
    <Modal
      open
      onClose={onClose}
      title={delivery?.status === "sent" ? `${guest.name} is invited` : `${guest.name}'s link`}
      description={
        delivery?.status === "sent"
          ? `The invitation went to ${guest.email}.`
          : delivery?.status === "failed"
            ? `The email to ${guest.email} failed: ${delivery.error || "the provider refused it"}. Share the link yourself.`
            : delivery?.status === "skipped"
              ? "No email provider is set up, so nothing was sent. Share the link yourself."
              : "Share it with them yourself, through a channel you trust."
      }
      footer={
        <Button type="button" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Input
            readOnly
            value={link}
            className="w-full font-mono text-xs"
            onFocus={(event) => event.target.select()}
          />
          <Button
            type="button"
            variant="secondary"
            onClick={async () => {
              setCopied(await copyToClipboard(link));
            }}
          >
            {copied ? <MailCheck size={15} /> : <Link2 size={15} />} {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Anyone with this link can open the room as {guest.name}. Give them a new link at any time
          to turn this one off.
        </p>
      </div>
    </Modal>
  );
}
