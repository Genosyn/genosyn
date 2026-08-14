import React from "react";
import { Check, Copy, Eye, EyeOff, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { copyToClipboard } from "@/lib/clipboard";
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
  const editing = !!item;
  const { toast } = useToast();
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
  const [generated, setGenerated] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      setSecret("");
      setShowSecret(false);
      setGenerated(false);
      setCopied(false);
      return;
    }
    setType(item?.type ?? "login");
    setVisibility(item?.visibility ?? "restricted");
    setTitle(item?.title ?? "");
    setUsername(item?.username ?? "");
    setWebsiteUrl(item?.websiteUrl ?? "");
    setNotes(item?.notes ?? "");
    setSecret("");
    setShowSecret(false);
    setGenerated(false);
    setCopied(false);
    setBusy(false);
    setError(null);
  }, [item, open]);

  async function copyGeneratedSecret() {
    if (!secret) return;
    if (await copyToClipboard(secret)) {
      setCopied(true);
      scheduleVaultClipboardClear(secret);
      toast(
        "Generated password copied. Clipboard will clear after 30 seconds when supported.",
        "success",
      );
    } else {
      toast("Could not access the clipboard", "error");
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const common = {
        type,
        title: title.trim(),
        username: type === "secure_note" ? "" : username.trim(),
        websiteUrl: type === "secure_note" ? "" : websiteUrl.trim(),
        notes: notes.trim(),
      };
      const saved = editing
        ? await vaultApi.updateItem(companyId, item.id, {
            ...common,
            expectedVersion: item.version,
            ...(item.canShare ? { visibility } : {}),
            ...(secret ? { secret } : {}),
          })
        : await vaultApi.createItem(companyId, { ...common, visibility, secret });
      await onSaved(saved);
      toast(editing ? "Vault item updated" : "Vault item created", "success");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The Vault item could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => (busy ? undefined : onClose())}
      title={editing ? `Edit ${item.title}` : "Add to Vault"}
      size="lg"
    >
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <FormError message={error} />

        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label="Item type"
            value={type}
            disabled={busy}
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
            disabled={busy || (editing && !item.canShare)}
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
            <Input
              label="Website"
              type="url"
              value={websiteUrl}
              disabled={busy}
              onChange={(event) => setWebsiteUrl(event.target.value)}
              placeholder="https://example.com"
            />
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
          <Button type="submit" disabled={busy || !title.trim() || (!editing && !secret)}>
            {busy ? "Saving…" : editing ? "Save changes" : "Add to Vault"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
