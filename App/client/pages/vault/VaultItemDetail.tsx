import React from "react";
import {
  Building2,
  Check,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Fingerprint,
  KeyRound,
  LockKeyhole,
  Pencil,
  ShieldCheck,
  Smartphone,
  StickyNote,
  Trash2,
  UserRound,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useDialog } from "@/components/ui/Dialog";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { copyToClipboard } from "@/lib/clipboard";
import {
  safeVaultWebsiteUrl,
  scheduleVaultClipboardClear,
  vaultApi,
  type VaultItem,
  type VaultPasskey,
  vaultItemTypeLabel,
  vaultSecretLabel,
  vaultUsernameLabel,
} from "@/lib/vault";
import { VaultAccessPanel } from "@/pages/vault/VaultAccessPanel";

const SECRET_LIFETIME_SECONDS = 30;

function vaultExpiryTimestamp(value: string | number): number {
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function VaultItemDetail({
  companyId,
  item,
  onClose,
  onEdit,
  onUpdated,
  onDeleted,
}: {
  companyId: string;
  item: VaultItem | null;
  onClose: () => void;
  onEdit: (item: VaultItem) => void;
  onUpdated: (item: VaultItem) => void | Promise<void>;
  onDeleted: (item: VaultItem) => void | Promise<void>;
}) {
  const { toast } = useToast();
  const dialog = useDialog();
  const [detail, setDetail] = React.useState<VaultItem | null>(item);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [revealedSecret, setRevealedSecret] = React.useState<string | null>(null);
  const [revealExpiresAt, setRevealExpiresAt] = React.useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = React.useState(0);
  const [revealing, setRevealing] = React.useState(false);
  const [copying, setCopying] = React.useState(false);
  const [copiedField, setCopiedField] = React.useState<string | null>(null);
  const [totpCode, setTotpCode] = React.useState<string | null>(null);
  const [totpExpiresAt, setTotpExpiresAt] = React.useState<number | null>(null);
  const [totpSecondsLeft, setTotpSecondsLeft] = React.useState(0);
  const [totpBusy, setTotpBusy] = React.useState<"show" | "copy" | "remove" | null>(null);
  const [passkeyBusy, setPasskeyBusy] = React.useState<string | null>(null);

  const hideSecret = React.useCallback(() => {
    setRevealedSecret(null);
    setRevealExpiresAt(null);
    setSecondsLeft(0);
  }, []);

  const hideTotpCode = React.useCallback(() => {
    setTotpCode(null);
    setTotpExpiresAt(null);
    setTotpSecondsLeft(0);
  }, []);

  React.useEffect(() => {
    setDetail(item);
    setError(null);
    hideSecret();
    hideTotpCode();
    if (!item) return;
    let active = true;
    setLoading(true);
    vaultApi
      .getItem(companyId, item.id)
      .then((next) => {
        if (active) setDetail(next);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        const message =
          cause instanceof Error ? cause.message : "The Vault item could not be loaded.";
        setError(message);
        toast(message, "error");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [companyId, hideSecret, hideTotpCode, item, toast]);

  React.useEffect(() => {
    if (!revealExpiresAt) return;
    const update = () => {
      const remaining = Math.max(0, Math.ceil((revealExpiresAt - Date.now()) / 1_000));
      setSecondsLeft(remaining);
      if (remaining === 0) hideSecret();
    };
    update();
    const timer = window.setInterval(update, 500);
    return () => window.clearInterval(timer);
  }, [hideSecret, revealExpiresAt]);

  React.useEffect(() => {
    if (!totpExpiresAt) return;
    const update = () => {
      const remaining = Math.max(0, Math.ceil((totpExpiresAt - Date.now()) / 1_000));
      setTotpSecondsLeft(remaining);
      if (remaining === 0) hideTotpCode();
    };
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [hideTotpCode, totpExpiresAt]);

  async function reveal() {
    if (!detail || revealing) return;
    setRevealing(true);
    try {
      const secret = await vaultApi.revealItem(companyId, detail.id, "reveal");
      setRevealedSecret(secret);
      setRevealExpiresAt(Date.now() + SECRET_LIFETIME_SECONDS * 1_000);
      setSecondsLeft(SECRET_LIFETIME_SECONDS);
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : "The value could not be revealed.", "error");
    } finally {
      setRevealing(false);
    }
  }

  async function copyStoredSecret() {
    if (!detail || copying) return;
    setCopying(true);
    try {
      const secret = await vaultApi.revealItem(companyId, detail.id, "copy");
      const copied = await copyToClipboard(secret);
      if (!copied) throw new Error("Could not access the clipboard");
      setCopiedField("secret");
      toast("Copied. Clipboard will be cleared after 30 seconds when supported.", "success");
      scheduleVaultClipboardClear(secret, SECRET_LIFETIME_SECONDS * 1_000);
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : "The value could not be copied.", "error");
    } finally {
      setCopying(false);
    }
  }

  async function copyMetadata(value: string, field: string) {
    if (!(await copyToClipboard(value))) {
      toast("Could not access the clipboard", "error");
      return;
    }
    setCopiedField(field);
    toast("Copied to clipboard", "success");
  }

  async function applyAuthenticatorUpdate(next: VaultItem) {
    setDetail(next);
    await onUpdated(next);
  }

  async function showCurrentTotpCode() {
    if (!detail || totpBusy) return;
    setTotpBusy("show");
    try {
      const result = await vaultApi.getTotpCode(companyId, detail.id, "reveal");
      const expiresAt = vaultExpiryTimestamp(result.expiresAt);
      setTotpCode(result.code);
      setTotpExpiresAt(expiresAt);
      setTotpSecondsLeft(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1_000)));
    } catch (cause) {
      toast(
        cause instanceof Error ? cause.message : "The authenticator code could not be shown.",
        "error",
      );
    } finally {
      setTotpBusy(null);
    }
  }

  async function copyCurrentTotpCode() {
    if (!detail || totpBusy) return;
    setTotpBusy("copy");
    try {
      const result = await vaultApi.getTotpCode(companyId, detail.id, "copy");
      if (!(await copyToClipboard(result.code))) throw new Error("Could not access the clipboard");
      setCopiedField("totp");
      const expiresAt = vaultExpiryTimestamp(result.expiresAt);
      scheduleVaultClipboardClear(
        result.code,
        Math.max(0, Math.min(SECRET_LIFETIME_SECONDS * 1_000, expiresAt - Date.now())),
      );
      toast(
        "Authenticator code copied. Clipboard clearing is scheduled when supported.",
        "success",
      );
    } catch (cause) {
      toast(
        cause instanceof Error ? cause.message : "The authenticator code could not be copied.",
        "error",
      );
    } finally {
      setTotpBusy(null);
    }
  }

  async function removeTotp() {
    if (!detail || totpBusy) return;
    const confirmed = await dialog.confirm({
      title: `Remove authenticator from “${detail.title}”?`,
      message:
        "This deletes the setup key and stops Genosyn from generating codes. It does not turn off two-factor authentication on the external site, so confirm another sign-in method works first.",
      confirmLabel: "Remove authenticator",
      variant: "danger",
    });
    if (!confirmed) return;
    setTotpBusy("remove");
    try {
      const next = await vaultApi.deleteTotp(companyId, detail.id);
      hideTotpCode();
      await applyAuthenticatorUpdate(next);
      toast("Authenticator removed from Vault", "success");
    } catch (cause) {
      toast(
        cause instanceof Error ? cause.message : "The authenticator could not be removed.",
        "error",
      );
    } finally {
      setTotpBusy(null);
    }
  }

  async function removePasskey(passkey: VaultPasskey) {
    if (!detail || passkeyBusy) return;
    const account = passkey.userDisplayName || passkey.userName || passkey.rpId;
    const confirmed = await dialog.confirm({
      title: `Delete passkey for “${account}”?`,
      message:
        "This permanently deletes the encrypted private key from Genosyn. It does not remove the registered passkey from the external site, so confirm another sign-in method works and remove it there too.",
      confirmLabel: "Delete passkey",
      variant: "danger",
    });
    if (!confirmed) return;
    setPasskeyBusy(passkey.id);
    try {
      const next = await vaultApi.deletePasskey(companyId, detail.id, passkey.id);
      await applyAuthenticatorUpdate(next);
      toast("Passkey deleted from Vault", "success");
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : "The passkey could not be deleted.", "error");
    } finally {
      setPasskeyBusy(null);
    }
  }

  async function remove() {
    if (!detail) return;
    const confirmed = await dialog.confirm({
      title: `Delete “${detail.title}”?`,
      message: `This permanently removes the encrypted value and every Member access entry and AI Employee Grant. This cannot be undone.${
        detail.type === "login" && (detail.hasTotp || (detail.passkeys ?? []).length > 0)
          ? " External authenticator and passkey registrations stay active, so confirm another sign-in method works and remove them from the external site too."
          : ""
      }`,
      confirmLabel: "Delete Vault item",
      variant: "danger",
    });
    if (!confirmed) return;
    try {
      await vaultApi.deleteItem(companyId, detail.id);
      hideSecret();
      await onDeleted(detail);
      toast("Vault item deleted", "success");
    } catch (cause) {
      toast(
        cause instanceof Error ? cause.message : "The Vault item could not be deleted.",
        "error",
      );
    }
  }

  const open = item !== null;
  const websiteHref = detail ? safeVaultWebsiteUrl(detail.websiteUrl) : null;

  return (
    <Modal
      open={open}
      onClose={() => {
        hideSecret();
        hideTotpCode();
        onClose();
      }}
      title={detail?.title ?? "Vault item"}
      size="xl"
    >
      {loading && !detail ? (
        <div className="flex min-h-64 items-center justify-center">
          <Spinner size={20} />
        </div>
      ) : !detail ? null : (
        <div className="flex flex-col gap-7">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <VaultTypeIcon item={detail} large />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    {vaultItemTypeLabel(detail.type)}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    {detail.visibility === "company" ? (
                      <Building2 size={11} />
                    ) : (
                      <Users size={11} />
                    )}
                    {detail.visibility === "company" ? "Company" : "Restricted"}
                  </span>
                </div>
                <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                  Updated {new Date(detail.updatedAt).toLocaleString()}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {detail.canEdit && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    hideSecret();
                    hideTotpCode();
                    onEdit(detail);
                  }}
                >
                  <Pencil size={13} /> Edit
                </Button>
              )}
              {detail.canDelete && (
                <Button variant="ghost" size="sm" onClick={() => void remove()}>
                  <Trash2 size={13} /> Delete
                </Button>
              )}
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300">
              {error}
            </div>
          )}

          <section>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
              Item details
            </h3>
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
              {detail.type !== "secure_note" && detail.username && (
                <DetailRow
                  icon={<UserRound size={15} />}
                  label={vaultUsernameLabel(detail.type)}
                  value={detail.username}
                  action={
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void copyMetadata(detail.username, "username")}
                    >
                      {copiedField === "username" ? <Check size={13} /> : <Copy size={13} />}
                      <span className="hidden sm:inline">Copy</span>
                    </Button>
                  }
                />
              )}
              {detail.type !== "secure_note" && detail.websiteUrl && (
                <DetailRow
                  icon={<ExternalLink size={15} />}
                  label="Website"
                  value={detail.websiteUrl}
                  action={
                    websiteHref ? (
                      <a
                        href={websiteHref}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                      >
                        <ExternalLink size={13} /> Open
                      </a>
                    ) : null
                  }
                />
              )}
              <div className="border-t border-slate-100 px-4 py-3 first:border-t-0 dark:border-slate-800">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <KeyRound size={15} className="mt-0.5 shrink-0 text-slate-400" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
                        {vaultSecretLabel(detail.type)}
                      </div>
                      {detail.type === "secure_note" && revealedSecret !== null ? (
                        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-3 font-mono text-sm text-slate-800 dark:bg-slate-800 dark:text-slate-100">
                          {revealedSecret}
                        </pre>
                      ) : (
                        <code className="mt-1 block break-all font-mono text-sm text-slate-800 dark:text-slate-100">
                          {revealedSecret ?? "••••••••••••••••"}
                        </code>
                      )}
                      {revealedSecret !== null && (
                        <div className="mt-1 text-xs tabular-nums text-amber-600 dark:text-amber-300">
                          Auto-hides in {secondsLeft}s
                        </div>
                      )}
                    </div>
                  </div>
                  {detail.canReveal && (
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={revealing}
                        onClick={() => (revealedSecret === null ? void reveal() : hideSecret())}
                      >
                        {revealedSecret === null ? <Eye size={13} /> : <EyeOff size={13} />}
                        {revealing ? "Revealing…" : revealedSecret === null ? "Reveal" : "Hide"}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={copying}
                        onClick={() => void copyStoredSecret()}
                      >
                        {copiedField === "secret" ? <Check size={13} /> : <Copy size={13} />}
                        {copying ? "Copying…" : "Copy"}
                      </Button>
                    </div>
                  )}
                </div>
              </div>
              {detail.notes && (
                <DetailRow
                  icon={<StickyNote size={15} />}
                  label="Private context"
                  value={detail.notes}
                  multiline
                />
              )}
            </div>
          </section>

          {detail.type === "login" && (
            <section>
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                Sign-in authenticators
              </h3>
              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
                <div className="px-4 py-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <Smartphone size={15} className="mt-0.5 shrink-0 text-slate-400" />
                      <div className="min-w-0 flex-1">
                        <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
                          Authenticator code
                        </div>
                        {detail.hasTotp ? (
                          <>
                            <code className="mt-1 block font-mono text-lg font-semibold tracking-[0.18em] text-slate-800 dark:text-slate-100">
                              {totpCode ?? "••• •••"}
                            </code>
                            <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                              {totpCode
                                ? `Expires in ${totpSecondsLeft}s`
                                : "Setup key encrypted with this login"}
                            </div>
                          </>
                        ) : (
                          <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                            None attached. Edit this login to add a Base32 setup key or otpauth URI.
                          </p>
                        )}
                      </div>
                    </div>
                    {detail.hasTotp && (
                      <div className="flex shrink-0 flex-wrap items-center gap-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={totpBusy !== null}
                          onClick={() =>
                            totpCode === null ? void showCurrentTotpCode() : hideTotpCode()
                          }
                        >
                          {totpCode === null ? <Eye size={13} /> : <EyeOff size={13} />}
                          {totpBusy === "show"
                            ? "Generating…"
                            : totpCode === null
                              ? "Show"
                              : "Hide"}
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={totpBusy !== null}
                          onClick={() => void copyCurrentTotpCode()}
                        >
                          {copiedField === "totp" ? <Check size={13} /> : <Copy size={13} />}
                          {totpBusy === "copy" ? "Copying…" : "Copy code"}
                        </Button>
                        {detail.canEdit && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={totpBusy !== null}
                            onClick={() => void removeTotp()}
                          >
                            <Trash2 size={13} />
                            {totpBusy === "remove" ? "Removing…" : "Remove"}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                <div className="border-t border-slate-100 px-4 py-3 dark:border-slate-800">
                  <div className="flex items-start gap-3">
                    <Fingerprint size={15} className="mt-0.5 shrink-0 text-slate-400" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
                        Software passkeys
                      </div>
                      {(detail.passkeys ?? []).length === 0 ? (
                        <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                          None saved. An AI Employee with Manage can create one while registering
                          this login in Genosyn&apos;s browser.
                        </p>
                      ) : (
                        <ul className="mt-2 divide-y divide-slate-100 dark:divide-slate-800">
                          {(detail.passkeys ?? []).map((passkey) => (
                            <li
                              key={passkey.id}
                              className="flex flex-col gap-2 py-3 first:pt-1 last:pb-1 sm:flex-row sm:items-center"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                                  {passkey.userDisplayName || passkey.userName || "Unnamed account"}
                                </div>
                                <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                                  <span>{passkey.rpId}</span>
                                  {passkey.userName &&
                                    passkey.userName !== passkey.userDisplayName && (
                                      <span>{passkey.userName}</span>
                                    )}
                                  <span>
                                    Added {new Date(passkey.createdAt).toLocaleDateString()}
                                  </span>
                                  {passkey.lastUsedAt && (
                                    <span>
                                      Last used {new Date(passkey.lastUsedAt).toLocaleDateString()}
                                    </span>
                                  )}
                                </div>
                              </div>
                              {detail.canEdit && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={passkeyBusy !== null}
                                  onClick={() => void removePasskey(passkey)}
                                >
                                  <Trash2 size={13} />
                                  {passkeyBusy === passkey.id ? "Deleting…" : "Delete"}
                                </Button>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {(detail.passkeys ?? []).length > 0 && (
                <div className="mt-3 rounded-lg border border-indigo-200 bg-indigo-50/60 px-3 py-2 text-xs leading-5 text-indigo-800 dark:border-indigo-900 dark:bg-indigo-950/30 dark:text-indigo-200">
                  Vault passkeys are encrypted software credentials for Genosyn&apos;s browser. They
                  never expose private-key material, use a Member&apos;s Touch ID or Face ID, or
                  operate in a Member browser.
                </div>
              )}
            </section>
          )}

          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-900 dark:bg-amber-950/30">
            <div className="flex items-start gap-2.5">
              <LockKeyhole
                size={16}
                className="mt-0.5 shrink-0 text-amber-700 dark:text-amber-300"
              />
              <p className="text-xs leading-5 text-amber-900 dark:text-amber-100">
                Reveal decrypts this value for this browser request only and hides it after 30
                seconds. Copy fetches the value without displaying it, then attempts to clear the
                clipboard after 30 seconds if your browser allows clipboard reads.
              </p>
            </div>
          </div>

          <section>
            <div className="mb-3 flex items-center gap-2">
              <ShieldCheck size={15} className="text-slate-400" />
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                Access
              </h3>
            </div>
            {detail.canShare ? (
              <VaultAccessPanel companyId={companyId} item={detail} />
            ) : (
              <div className="rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-3 dark:border-slate-700 dark:bg-slate-800/40">
                <div className="flex items-start gap-2.5">
                  <ShieldCheck size={16} className="mt-0.5 shrink-0 text-indigo-500" />
                  <div>
                    <div className="text-sm font-medium text-slate-800 dark:text-slate-100">
                      You have {detail.effectiveAccessLevel === "edit" ? "Edit" : "View"} access
                    </div>
                    <p className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">
                      Only the item&apos;s creator and company owners or admins can see or change
                      its Member access and AI Employee Grants.
                    </p>
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}

function DetailRow({
  icon,
  label,
  value,
  action,
  multiline = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  action?: React.ReactNode;
  multiline?: boolean;
}) {
  return (
    <div className="flex items-start gap-3 border-t border-slate-100 px-4 py-3 first:border-t-0 dark:border-slate-800">
      <span className="mt-0.5 shrink-0 text-slate-400">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
          {label}
        </div>
        <div
          className={
            multiline
              ? "mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-slate-700 dark:text-slate-200"
              : "mt-1 truncate text-sm text-slate-800 dark:text-slate-100"
          }
        >
          {value}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

function VaultTypeIcon({ item, large = false }: { item: VaultItem; large?: boolean }) {
  const icon =
    item.type === "login" ? (
      <LockKeyhole size={large ? 20 : 16} />
    ) : item.type === "api_key" ? (
      <KeyRound size={large ? 20 : 16} />
    ) : (
      <StickyNote size={large ? 20 : 16} />
    );
  return (
    <span
      className={`${large ? "h-11 w-11 rounded-xl" : "h-9 w-9 rounded-lg"} flex shrink-0 items-center justify-center bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300`}
    >
      {icon}
    </span>
  );
}
