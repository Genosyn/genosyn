import React from "react";
import { useOutletContext } from "react-router-dom";
import { BookOpen, Check, Copy, KeyRound, Trash2 } from "lucide-react";
import { api, ApiKey, ApiKeyCreated, Company } from "../lib/api";
import { copyToClipboard } from "../lib/clipboard";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { FormError } from "../components/ui/FormError";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { Spinner } from "../components/ui/Spinner";
import { Modal } from "../components/ui/Modal";
import { EmptyState } from "../components/ui/EmptyState";
import { TopBar } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import type { SettingsOutletCtx } from "./SettingsLayout";

/**
 * Settings → API keys. Personal-not-shared programmatic tokens for the same
 * REST surface the web UI hits. Each key authenticates as the calling user
 * and is scoped to one company; the plaintext is shown exactly once on
 * create. Revocation is soft so audit history survives.
 */
export function SettingsApiKeys() {
  const { company } = useOutletContext<SettingsOutletCtx>();
  return (
    <>
      <TopBar title="API keys" />
      <ApiKeysCard company={company} />
    </>
  );
}

function ApiKeysCard({ company }: { company: Company }) {
  const [rows, setRows] = React.useState<ApiKey[] | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [justCreated, setJustCreated] = React.useState<ApiKeyCreated | null>(null);
  const { toast } = useToast();
  const dialog = useDialog();

  const reload = React.useCallback(async () => {
    try {
      const list = await api.get<ApiKey[]>(`/api/companies/${company.id}/api-keys`);
      setRows(list);
    } catch (err) {
      toast((err as Error).message, "error");
      setRows([]);
    }
  }, [company.id, toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">Personal access tokens</h2>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                Authenticate as you against the same REST surface the UI uses.
                Pass <code className="font-mono">Authorization: Bearer gen_…</code>.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <a
                href="/api/docs"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                <BookOpen size={12} /> API reference
              </a>
              <Button size="sm" onClick={() => setCreating(true)}>
                Generate key
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardBody>
          {rows === null ? (
            <Spinner />
          ) : rows.length === 0 ? (
            <EmptyState
              title="No API keys yet"
              description="Generate a key to script Genosyn from CI, your terminal, or any HTTP client."
            />
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {rows.map((k) => (
                <ApiKeyRow
                  key={k.id}
                  apiKey={k}
                  onRevoke={async () => {
                    const ok = await dialog.confirm({
                      title: `Revoke "${k.name}"?`,
                      message:
                        "Any process using this token will start getting 401s on the next request. This can't be undone.",
                      confirmLabel: "Revoke key",
                      variant: "danger",
                    });
                    if (!ok) return;
                    try {
                      await api.del(
                        `/api/companies/${company.id}/api-keys/${k.id}`,
                      );
                      await reload();
                    } catch (err) {
                      toast((err as Error).message, "error");
                    }
                  }}
                />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <CreateApiKeyModal
        open={creating}
        companyId={company.id}
        onClose={() => setCreating(false)}
        onCreated={async (created) => {
          setCreating(false);
          setJustCreated(created);
          await reload();
        }}
      />

      <NewKeyTokenModal
        created={justCreated}
        onClose={() => setJustCreated(null)}
      />
    </>
  );
}

function ApiKeyRow({
  apiKey,
  onRevoke,
}: {
  apiKey: ApiKey;
  onRevoke: () => void | Promise<void>;
}) {
  const revoked = !!apiKey.revokedAt;
  const expired =
    !!apiKey.expiresAt && new Date(apiKey.expiresAt).getTime() <= Date.now();
  return (
    <li className="flex items-center justify-between gap-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <KeyRound size={14} className="text-slate-400" />
          <span className="truncate font-medium text-slate-900 dark:text-slate-100">
            {apiKey.name}
          </span>
          <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {apiKey.prefix}…
          </code>
          {revoked && (
            <span className="rounded bg-rose-100 px-1.5 py-0.5 text-xs font-medium text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
              Revoked
            </span>
          )}
          {!revoked && expired && (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
              Expired
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
          <span>
            Created {new Date(apiKey.createdAt).toLocaleDateString()}
          </span>
          <span>
            {apiKey.lastUsedAt
              ? `Last used ${new Date(apiKey.lastUsedAt).toLocaleString()}`
              : "Never used"}
          </span>
          {apiKey.expiresAt && !revoked && (
            <span>
              {expired
                ? `Expired ${new Date(apiKey.expiresAt).toLocaleDateString()}`
                : `Expires ${new Date(apiKey.expiresAt).toLocaleDateString()}`}
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {!revoked && (
          <Button variant="ghost" size="sm" onClick={onRevoke}>
            <Trash2 size={12} /> Revoke
          </Button>
        )}
      </div>
    </li>
  );
}

function CreateApiKeyModal({
  open,
  companyId,
  onClose,
  onCreated,
}: {
  open: boolean;
  companyId: string;
  onClose: () => void;
  onCreated: (created: ApiKeyCreated) => void;
}) {
  const [name, setName] = React.useState("");
  const [expiresIn, setExpiresIn] = React.useState<"never" | "30d" | "90d" | "365d">(
    "never",
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setName("");
      setExpiresIn("never");
      setError(null);
    }
  }, [open]);

  function computeExpiresAt(): string | null {
    if (expiresIn === "never") return null;
    const days = expiresIn === "30d" ? 30 : expiresIn === "90d" ? 90 : 365;
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString();
  }

  return (
    <Modal open={open} onClose={onClose} title="Generate API key">
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          setBusy(true);
          try {
            const created = await api.post<ApiKeyCreated>(
              `/api/companies/${companyId}/api-keys`,
              { name: name.trim(), expiresAt: computeExpiresAt() },
            );
            onCreated(created);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <FormError message={error} />
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="GitHub Actions, local CLI, …"
          required
          autoFocus
        />
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
            Expires
          </label>
          <select
            value={expiresIn}
            onChange={(e) =>
              setExpiresIn(e.target.value as typeof expiresIn)
            }
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-900"
          >
            <option value="never">Never</option>
            <option value="30d">In 30 days</option>
            <option value="90d">In 90 days</option>
            <option value="365d">In 1 year</option>
          </select>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || name.trim().length === 0}>
            Generate
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function NewKeyTokenModal({
  created,
  onClose,
}: {
  created: ApiKeyCreated | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = React.useState(false);
  const { toast } = useToast();

  React.useEffect(() => {
    if (created) setCopied(false);
  }, [created]);

  if (!created) return null;

  return (
    <Modal open onClose={onClose} title="Copy your new API key" size="lg">
      <div className="flex flex-col gap-4">
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          This is the only time you&apos;ll see the full token. Store it
          somewhere safe (a password manager, your CI secrets, …) — if you
          lose it, generate a new one and revoke this one.
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
            Token
          </label>
          <div className="flex gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100">
              {created.token}
            </code>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={async () => {
                const ok = await copyToClipboard(created.token);
                if (ok) {
                  setCopied(true);
                  toast("Copied to clipboard", "success");
                } else {
                  toast("Could not access clipboard — copy manually", "error");
                }
              }}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}{" "}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
            Try it
          </label>
          <pre className="overflow-x-auto rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100">
{`curl -H "Authorization: Bearer ${created.token}" \\
  ${window.location.origin}/api/companies/<id>/employees`}
          </pre>
        </div>
        <div className="flex justify-end pt-2">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    </Modal>
  );
}
