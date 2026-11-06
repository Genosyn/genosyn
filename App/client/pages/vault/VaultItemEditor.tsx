import React from "react";
import { Check, Copy, Eye, EyeOff, QrCode, RefreshCw, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { readAuthenticatorQr, type MigratedAuthenticator } from "@/lib/authenticatorQr";
import { copyToClipboard } from "@/lib/clipboard";
import { errorMessage } from "@/lib/errors";
import {
  generateVaultPassword,
  scheduleVaultClipboardClear,
  VAULT_ITEM_TYPES,
  vaultApi,
  type VaultItem,
  type VaultItemType,
  type VaultVisibility,
  vaultSecretLabel,
  vaultUsernameLabel,
} from "@/lib/vault";

export function VaultItemEditor({
  companyId,
  item,
  open,
  onClose,
  onSaved,
}: {
  companyId: string;
  item?: VaultItem;
  open: boolean;
  onClose: () => void;
  onSaved: (item: VaultItem) => void | Promise<void>;
}) {
  const [persistedItem, setPersistedItem] = React.useState<VaultItem | undefined>(item);
  const editing = !!persistedItem;
  const [type, setType] = React.useState<VaultItemType>(item?.type ?? "login");
  const [visibility, setVisibility] = React.useState<VaultVisibility>(
    item?.visibility ?? "restricted",
  );
  const [title, setTitle] = React.useState(item?.title ?? "");
  const [username, setUsername] = React.useState(item?.username ?? "");
  const [websiteUrl, setWebsiteUrl] = React.useState(item?.websiteUrl ?? "");
  const [notes, setNotes] = React.useState(item?.notes ?? "");
  const [secret, setSecret] = React.useState("");
  const [showSecret, setShowSecret] = React.useState(false);
  const [totpSetupKey, setTotpSetupKey] = React.useState("");
  const [showTotpSetupKey, setShowTotpSetupKey] = React.useState(false);
  const qrInput = React.useRef<HTMLInputElement>(null);
  const [readingQr, setReadingQr] = React.useState(false);
  const [qrRead, setQrRead] = React.useState(false);
  const [qrError, setQrError] = React.useState<string | null>(null);
  const [qrChoices, setQrChoices] = React.useState<MigratedAuthenticator[] | null>(null);
  const [generated, setGenerated] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const websiteOriginLocked =
    editing && type === "login" && (persistedItem?.passkeys.length ?? 0) > 0;

  React.useEffect(() => {
    if (!open) {
      setPersistedItem(item);
      setSecret("");
      setShowSecret(false);
      setTotpSetupKey("");
      setShowTotpSetupKey(false);
      setQrRead(false);
      setQrError(null);
      setQrChoices(null);
      setGenerated(false);
      setCopied(false);
      return;
    }
    setPersistedItem(item);
    setType(item?.type ?? "login");
    setVisibility(item?.visibility ?? "restricted");
    setTitle(item?.title ?? "");
    setUsername(item?.username ?? "");
    setWebsiteUrl(item?.websiteUrl ?? "");
    setNotes(item?.notes ?? "");
    setSecret("");
    setShowSecret(false);
    setTotpSetupKey("");
    setShowTotpSetupKey(false);
    setQrRead(false);
    setQrError(null);
    setQrChoices(null);
    setGenerated(false);
    setCopied(false);
    setBusy(false);
    setError(null);
  }, [item, open]);

  async function readQrImage(image: Blob) {
    setReadingQr(true);
    setQrError(null);
    setQrChoices(null);
    setQrRead(false);
    try {
      const found = await readAuthenticatorQr(image);
      if (found.length === 1) {
        setTotpSetupKey(found[0].uri);
        setQrRead(true);
      } else {
        setQrChoices(found);
      }
    } catch (cause) {
      setQrError(errorMessage(cause, "Could not read that image."));
    } finally {
      setReadingQr(false);
    }
  }

  /** A screenshot of the QR is the quickest way to get it here. */
  function handleQrPaste(event: React.ClipboardEvent) {
    const image = Array.from(event.clipboardData.files).find((file) =>
      file.type.startsWith("image/"),
    );
    if (!image) return;
    event.preventDefault();
    void readQrImage(image);
  }

  async function copyGeneratedSecret() {
    if (!secret) return;
    setError(null);
    if (await copyToClipboard(secret)) {
      setCopied(true);
      scheduleVaultClipboardClear(secret);
    } else {
      setError("Could not access the clipboard");
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const currentItem = persistedItem;
      const common = {
        type,
        title: title.trim(),
        username: type === "secure_note" ? "" : username.trim(),
        websiteUrl: type === "secure_note" ? "" : websiteUrl.trim(),
        notes: notes.trim(),
      };
      let saved = currentItem
        ? await vaultApi.updateItem(companyId, currentItem.id, {
            ...common,
            expectedVersion: currentItem.version,
            ...(currentItem.canShare ? { visibility } : {}),
            ...(secret ? { secret } : {}),
          })
        : await vaultApi.createItem(companyId, {
            ...common,
            visibility,
            secret,
            ...(type === "login" && totpSetupKey.trim()
              ? { totpSetupKey: totpSetupKey.trim() }
              : {}),
          });
      setPersistedItem(saved);
      if (currentItem && saved.type === "login" && totpSetupKey.trim()) {
        saved = await vaultApi.setTotp(companyId, saved.id, totpSetupKey.trim());
        setPersistedItem(saved);
      }
      await onSaved(saved);
    } catch (cause) {
      setError(errorMessage(cause, "The Vault item could not be saved."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => (busy ? undefined : onClose())}
      title={persistedItem ? `Edit ${persistedItem.title}` : "Add to Vault"}
      size="lg"
    >
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <FormError message={error} />

        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label="Item type"
            value={type}
            disabled={busy || editing}
            onChange={(event) => setType(event.target.value as VaultItemType)}
          >
            {VAULT_ITEM_TYPES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <Select
            label="Visibility"
            value={visibility}
            disabled={busy || persistedItem?.canShare === false}
            onChange={(event) => setVisibility(event.target.value as VaultVisibility)}
          >
            <option value="company">Everyone in the company</option>
            <option value="restricted">Only selected Members</option>
          </Select>
        </div>

        <Input
          label="Title"
          value={title}
          disabled={busy}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={
            type === "login" ? "GitHub" : type === "api_key" ? "Stripe live key" : "Recovery codes"
          }
          autoFocus
          required
        />

        {type !== "secure_note" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label={vaultUsernameLabel(type)}
              value={username}
              disabled={busy}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="off"
              placeholder={type === "login" ? "name@example.com" : "Production"}
            />
            <div>
              <Input
                label="Website"
                type="url"
                value={websiteUrl}
                disabled={busy || websiteOriginLocked}
                aria-describedby={
                  websiteOriginLocked ? "vault-website-passkey-origin-lock" : undefined
                }
                onChange={(event) => setWebsiteUrl(event.target.value)}
                placeholder="https://example.com"
                className="disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500 dark:disabled:bg-slate-800 dark:disabled:text-slate-400"
              />
              {websiteOriginLocked && (
                <p
                  id="vault-website-passkey-origin-lock"
                  className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400"
                >
                  Saved passkeys lock this login to its exact website origin. Remove all passkeys
                  before changing it.
                </p>
              )}
            </div>
          </div>
        )}

        <div>
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <label
              htmlFor="vault-secret-value"
              className="text-xs font-medium text-slate-600 dark:text-slate-300"
            >
              {vaultSecretLabel(type)}
              {editing && (
                <span className="ml-1 font-normal text-slate-400 dark:text-slate-500">
                  (leave blank to keep the current value)
                </span>
              )}
            </label>
            {type === "login" && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setSecret(generateVaultPassword());
                  setGenerated(true);
                  setCopied(false);
                  setShowSecret(true);
                }}
                className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700 disabled:opacity-50 dark:text-indigo-300 dark:hover:text-indigo-200"
              >
                <RefreshCw size={12} /> Generate strong password
              </button>
            )}
          </div>
          <div className="flex gap-2">
            {type === "secure_note" ? (
              <textarea
                id="vault-secret-value"
                rows={6}
                value={secret}
                disabled={busy}
                required={!editing}
                onChange={(event) => {
                  setSecret(event.target.value);
                  setGenerated(false);
                  setCopied(false);
                }}
                placeholder={
                  editing ? "Leave blank to keep the current note" : "Write the private note…"
                }
                className="min-w-0 flex-1 resize-y rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-60 dark:border-slate-600 dark:bg-slate-900"
              />
            ) : (
              <input
                id="vault-secret-value"
                type={showSecret ? "text" : "password"}
                value={secret}
                disabled={busy}
                required={!editing}
                autoComplete="new-password"
                onChange={(event) => {
                  setSecret(event.target.value);
                  setGenerated(false);
                  setCopied(false);
                }}
                placeholder={
                  editing ? "Leave blank to keep the current value" : vaultSecretLabel(type)
                }
                className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-60 dark:border-slate-600 dark:bg-slate-900"
              />
            )}
            {type !== "secure_note" && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!secret || busy}
                onClick={() => setShowSecret((current) => !current)}
                aria-label={showSecret ? "Hide value" : "Show value"}
                title={showSecret ? "Hide value" : "Show value"}
              >
                {showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
              </Button>
            )}
            {generated && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!secret || busy}
                onClick={() => void copyGeneratedSecret()}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
              </Button>
            )}
          </div>
        </div>

        {type === "login" && (
          <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-700 dark:bg-slate-800/40">
            <div className="mb-2 flex items-start gap-2.5">
              <Smartphone
                size={15}
                className="mt-0.5 shrink-0 text-indigo-500 dark:text-indigo-300"
              />
              <div>
                <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                  Authenticator code <span className="font-normal text-slate-400">(optional)</span>
                </div>
                <p className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">
                  Upload the QR code the site shows, or paste its setup key. A QR from Google
                  Authenticator&apos;s Transfer accounts works too. Genosyn encrypts it with this
                  login, so a granted AI Employee can sign in by itself and never sees the setup
                  key.
                </p>
              </div>
            </div>
            <div className="flex gap-2" onPaste={handleQrPaste}>
              <input
                id="vault-totp-setup-key"
                type={showTotpSetupKey ? "text" : "password"}
                value={totpSetupKey}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setTotpSetupKey(event.target.value)}
                placeholder={
                  persistedItem?.hasTotp
                    ? "Leave blank to keep the current authenticator"
                    : "Base32 setup key or otpauth:// URI"
                }
                aria-label="Authenticator setup key or otpauth URI"
                className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-60 dark:border-slate-600 dark:bg-slate-900"
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!totpSetupKey || busy}
                onClick={() => setShowTotpSetupKey((current) => !current)}
                aria-label={showTotpSetupKey ? "Hide setup key" : "Show setup key"}
                title={showTotpSetupKey ? "Hide setup key" : "Show setup key"}
              >
                {showTotpSetupKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy}
                loading={readingQr}
                onClick={() => qrInput.current?.click()}
                aria-label="Upload an image of the QR code"
                title="Upload an image of the QR code"
              >
                <QrCode size={14} />
                <span className="hidden sm:inline">QR</span>
              </Button>
              <input
                ref={qrInput}
                type="file"
                accept="image/*"
                className="hidden"
                aria-hidden
                tabIndex={-1}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void readQrImage(file);
                }}
              />
            </div>
            {qrChoices && (
              <div className="mt-2 space-y-1">
                <p className="text-xs font-medium text-slate-600 dark:text-slate-300">
                  That QR holds {qrChoices.length} accounts. Which one is this login?
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {qrChoices.map((choice) => (
                    <Button
                      key={choice.uri}
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setTotpSetupKey(choice.uri);
                        setQrChoices(null);
                      }}
                    >
                      {choice.label}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            {qrError && <FormError message={qrError} className="mt-2" />}
            {!qrChoices && !qrError && qrRead && totpSetupKey && (
              <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-300">
                Read the QR code. It&apos;s saved when you save this login.
              </p>
            )}
            {persistedItem?.hasTotp && totpSetupKey.trim() && (
              <p className="mt-2 text-xs leading-5 text-amber-700 dark:text-amber-300">
                Saving replaces the Vault setup key only. Make this change after replacing the
                authenticator on the external site, or the saved codes will stop working.
              </p>
            )}
          </div>
        )}

        <div>
          <label
            htmlFor="vault-item-notes"
            className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300"
          >
            Private context <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <textarea
            id="vault-item-notes"
            rows={3}
            value={notes}
            disabled={busy}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Account owner, rotation instructions, or other encrypted context…"
            className="w-full resize-y rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-60 dark:border-slate-600 dark:bg-slate-900"
          />
        </div>

        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-400">
          Vault values and private context are encrypted at rest. The stored value is never loaded
          into this form while editing; enter a replacement only when you want to rotate it.
        </div>

        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={!title.trim() || (!editing && !secret)}>
            {busy ? "Saving…" : editing ? "Save changes" : "Add to Vault"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
