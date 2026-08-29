import React from "react";
import { Copy, KeyRound } from "lucide-react";
import {
  api,
  AdminEnterpriseLicense,
  AdminEnterpriseLicenseIssued,
  AdminEnterpriseLicenses,
} from "../lib/api";
import { errorMessage } from "../lib/errors";
import { TopBar } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { FormError, FormSuccess } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Spinner } from "../components/ui/Spinner";
import { Textarea } from "../components/ui/Textarea";
import { useDialog } from "../components/ui/Dialog";
import { clsx } from "../components/ui/clsx";

/**
 * Admin → Enterprise Licenses (M56) — the ISSUER's side of licensing.
 * Licenses issued here unlock Genosyn Enterprise on customers' self-hosted
 * installs; only an install holding the Ed25519 signing private key can issue
 * (in practice, genosyn.com's own cloud). The full key appears exactly once,
 * in the issue response — only a masked preview is kept.
 */
export function AdminLicenses() {
  const [data, setData] = React.useState<AdminEnterpriseLicenses | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const dialog = useDialog();

  // Signing key card
  const [privateKey, setPrivateKey] = React.useState("");
  const [keySaving, setKeySaving] = React.useState(false);
  const [keyClearing, setKeyClearing] = React.useState(false);
  const [keyError, setKeyError] = React.useState<string | null>(null);

  // Issue form
  const [companyName, setCompanyName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [expiresAt, setExpiresAt] = React.useState("");
  const [seats, setSeats] = React.useState("");
  const [evaluation, setEvaluation] = React.useState(false);
  const [issuing, setIssuing] = React.useState(false);
  const [issueError, setIssueError] = React.useState<string | null>(null);
  const [issuedKey, setIssuedKey] = React.useState<string | null>(null);
  const [copyNotice, setCopyNotice] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    try {
      const d = await api.get<AdminEnterpriseLicenses>("/api/admin/licenses");
      setData(d);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the enterprise licenses"));
    }
  }, []);

  React.useEffect(() => {
    reload();
  }, [reload]);

  if (!data) {
    return (
      <>
        <TopBar title="Enterprise Licenses" />
        <Card>
          <CardBody>{loadError ? <FormError message={loadError} /> : <Spinner />}</CardBody>
        </Card>
      </>
    );
  }

  async function saveSigningKey(event: React.FormEvent) {
    event.preventDefault();
    if (!privateKey.trim() || keySaving) return;
    setKeySaving(true);
    setKeyError(null);
    try {
      await api.put("/api/admin/licenses/signing-key", { privateKey: privateKey.trim() });
      setPrivateKey("");
      await reload();
    } catch (err) {
      setKeyError(errorMessage(err));
    } finally {
      setKeySaving(false);
    }
  }

  async function clearSigningKey() {
    const ok = await dialog.confirm({
      title: "Clear the signing key?",
      message:
        "This install can no longer issue enterprise licenses until a key is configured again. Licenses already issued keep verifying.",
      confirmLabel: "Clear key",
      variant: "danger",
    });
    if (!ok) return;
    setKeyClearing(true);
    setKeyError(null);
    try {
      await api.del("/api/admin/licenses/signing-key");
      await reload();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t clear the signing key" });
    } finally {
      setKeyClearing(false);
    }
  }

  async function issue(event: React.FormEvent) {
    event.preventDefault();
    if (!companyName.trim() || !expiresAt || issuing) return;
    setIssuing(true);
    setIssueError(null);
    setIssuedKey(null);
    setCopyNotice(null);
    try {
      const seatsNumber = seats.trim() === "" ? null : Number(seats);
      const result = await api.post<AdminEnterpriseLicenseIssued>("/api/admin/licenses", {
        companyName: companyName.trim(),
        email: email.trim() === "" ? null : email.trim(),
        // The picker yields a bare date; a license "expires on" a day should
        // last through it, so pin the ISO instant to that day's end (UTC).
        expiresAt: new Date(`${expiresAt}T23:59:59.999Z`).toISOString(),
        seats: seatsNumber,
        evaluation,
      });
      setIssuedKey(result.key);
      setCompanyName("");
      setEmail("");
      setExpiresAt("");
      setSeats("");
      setEvaluation(false);
      await reload();
    } catch (err) {
      setIssueError(errorMessage(err));
    } finally {
      setIssuing(false);
    }
  }

  async function copyIssuedKey() {
    if (!issuedKey) return;
    setCopyNotice(null);
    try {
      await navigator.clipboard.writeText(issuedKey);
      setCopyNotice("License key copied");
    } catch (err) {
      void dialog.error(err, {
        title: "Couldn’t copy the key",
        message: "Select the key and copy it manually.",
      });
    }
  }

  return (
    <>
      <TopBar title="Enterprise Licenses" />
      <div className="flex flex-col gap-4">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Licenses issued here unlock Genosyn Enterprise on customers&apos;
          self-hosted installs. Keys verify offline against Genosyn&apos;s
          public keys, so only an install holding the signing private key can
          issue them — in practice, genosyn.com&apos;s own cloud.
        </p>

        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">Signing key</h2>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  The Ed25519 private key that signs every issued license.
                  Generate a keypair with{" "}
                  <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
                    npm run license:keygen
                  </code>
                  . Stored encrypted; never shown again.
                </p>
              </div>
              <span
                className={clsx(
                  "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                  data.signingConfigured
                    ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
                    : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
                )}
              >
                {data.signingConfigured ? "Configured" : "Not configured"}
              </span>
            </div>
          </CardHeader>
          <CardBody>
            <form className="flex flex-col gap-3" onSubmit={saveSigningKey}>
              <Textarea
                label="Private key (PEM)"
                className="min-h-[96px] font-mono text-xs"
                placeholder={
                  data.signingConfigured
                    ? "Stored — leave blank to keep, or paste a new key to replace it"
                    : "-----BEGIN PRIVATE KEY-----"
                }
                value={privateKey}
                onChange={(event) => setPrivateKey(event.target.value)}
                spellCheck={false}
              />
              <FormError message={keyError} />
              <div className="flex items-center justify-end gap-2">
                {data.signingConfigured && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={clearSigningKey}
                    disabled={keyClearing || keySaving}
                  >
                    {keyClearing ? "Clearing…" : "Clear key"}
                  </Button>
                )}
                <Button type="submit" size="sm" disabled={!privateKey.trim() || keySaving}>
                  {keySaving ? "Saving…" : "Save signing key"}
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold">Issue a license</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              {data.signingConfigured
                ? "The signed key is returned once, below — send it to the customer and it never appears again."
                : "Configure the signing key above before issuing licenses."}
            </p>
          </CardHeader>
          <CardBody>
            <form className="flex flex-col gap-3" onSubmit={issue}>
              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  label="Company name"
                  value={companyName}
                  onChange={(event) => setCompanyName(event.target.value)}
                  maxLength={200}
                  disabled={!data.signingConfigured}
                  required
                />
                <Input
                  label="Contact email (optional)"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  disabled={!data.signingConfigured}
                />
                <Input
                  label="Expires"
                  type="date"
                  value={expiresAt}
                  onChange={(event) => setExpiresAt(event.target.value)}
                  disabled={!data.signingConfigured}
                  required
                />
                <Input
                  label="Seats (optional — blank = unlimited)"
                  type="number"
                  min={1}
                  step={1}
                  value={seats}
                  onChange={(event) => setSeats(event.target.value)}
                  disabled={!data.signingConfigured}
                />
              </div>
              <label className="inline-flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-600"
                  checked={evaluation}
                  disabled={!data.signingConfigured}
                  onChange={(event) => setEvaluation(event.target.checked)}
                />
                <span className="font-medium">Evaluation license</span>
              </label>
              <p className="-mt-2 text-xs text-slate-400 dark:text-slate-500">
                Evaluation licenses expire hard — features turn off the day they
                lapse. Paid licenses keep features on past expiry with a renewal
                warning.
              </p>
              <FormError message={issueError} />
              <div className="flex justify-end">
                <Button
                  type="submit"
                  size="sm"
                  disabled={!data.signingConfigured || !companyName.trim() || !expiresAt || issuing}
                >
                  {issuing ? "Issuing…" : "Issue license"}
                </Button>
              </div>
            </form>

            {issuedKey && (
              <div className="mt-4 flex flex-col gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/60">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                    License key
                  </span>
                  <Button variant="secondary" size="sm" onClick={copyIssuedKey}>
                    <Copy size={14} /> Copy
                  </Button>
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-white p-3 font-mono text-xs text-slate-800 dark:bg-slate-900 dark:text-slate-200">
                  {issuedKey}
                </pre>
                <p className="text-xs font-medium text-red-600 dark:text-red-400">
                  This key will not be shown again — copy it now and deliver it
                  to the customer.
                </p>
                <FormSuccess message={copyNotice} />
              </div>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold">Issued licenses</h2>
          </CardHeader>
          <CardBody>
            {data.licenses.length === 0 ? (
              <EmptyState
                title="No licenses issued yet"
                description="Licenses you issue appear here with their masked key preview — the full key is only ever shown once, at issue time."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs font-medium uppercase tracking-wider text-slate-500 dark:border-slate-700 dark:text-slate-400">
                      <th className="py-2 pr-4">Company</th>
                      <th className="py-2 pr-4">Email</th>
                      <th className="py-2 pr-4">Expires</th>
                      <th className="py-2 pr-4">Seats</th>
                      <th className="py-2 pr-4">Key</th>
                      <th className="py-2">Created</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {data.licenses.map((license) => (
                      <LicenseRow key={license.id} license={license} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}

function LicenseRow({ license }: { license: AdminEnterpriseLicense }) {
  return (
    <tr>
      <td className="py-2 pr-4">
        <div className="flex items-center gap-2">
          <span className="font-medium text-slate-900 dark:text-slate-100">
            {license.companyName}
          </span>
          {license.evaluation && (
            <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300">
              Evaluation
            </span>
          )}
        </div>
      </td>
      <td className="py-2 pr-4 text-slate-600 dark:text-slate-300">{license.email ?? "—"}</td>
      <td className="py-2 pr-4 text-slate-600 dark:text-slate-300">
        {new Date(license.expiresAt).toLocaleDateString()}
      </td>
      <td className="py-2 pr-4 tabular-nums text-slate-600 dark:text-slate-300">
        {license.seats ?? "Unlimited"}
      </td>
      <td className="py-2 pr-4">
        <span className="inline-flex items-center gap-1.5 font-mono text-xs text-slate-600 dark:text-slate-300">
          <KeyRound size={12} className="shrink-0 text-slate-400 dark:text-slate-500" />
          {license.keyPreview}
        </span>
      </td>
      <td className="py-2 text-slate-600 dark:text-slate-300">
        {new Date(license.createdAt).toLocaleDateString()}
      </td>
    </tr>
  );
}
