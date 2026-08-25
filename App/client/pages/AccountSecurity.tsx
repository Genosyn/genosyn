import React from "react";
import {
  Copy,
  Download,
  KeyRound,
  Plus,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Smartphone,
  Trash2,
  Usb,
} from "lucide-react";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { api, type TwoFactorStatus } from "../lib/api";
import { TopBar } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { FormError, FormSuccess } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { Spinner } from "../components/ui/Spinner";

type TotpSetup = {
  credentialId: string;
  secret: string;
  otpAuthUri: string;
  qrDataUrl: string;
};

type EnrollmentResult = {
  status: TwoFactorStatus;
  recoveryCodes: string[];
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString();
}

/**
 * Shown the one time a set of recovery codes exists in plaintext — right after
 * the first method is enrolled, or after a deliberate regeneration. Lives
 * inside whichever modal produced them so nobody has to hunt for it.
 */
function RecoveryCodes({ codes }: { codes: string[] }) {
  const [copyNotice, setCopyNotice] = React.useState<string | null>(null);
  const [copyError, setCopyError] = React.useState<string | null>(null);

  async function copy() {
    setCopyNotice(null);
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopyNotice("Recovery codes copied");
    } catch {
      setCopyError("Your browser could not copy the recovery codes");
    }
  }

  function download() {
    setCopyNotice(null);
    setCopyError(null);
    const contents = [
      "Genosyn recovery codes",
      "Each code can be used once. Store these somewhere safe.",
      "",
      ...codes,
      "",
    ].join("\n");
    const url = URL.createObjectURL(new Blob([contents], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "genosyn-recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/40">
      <p className="text-sm font-semibold text-amber-900 dark:text-amber-100">
        Save these codes now
      </p>
      <p className="mt-1 text-xs text-amber-800 dark:text-amber-200">
        They will not be shown again. Store them somewhere separate from your authenticator.
      </p>
      <div className="mt-3 grid grid-cols-1 gap-1 font-mono text-sm text-slate-900 sm:grid-cols-2 dark:text-slate-100">
        {codes.map((code) => (
          <span key={code}>{code}</span>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={copy}>
          <Copy size={14} /> Copy
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={download}>
          <Download size={14} /> Download
        </Button>
      </div>
      <FormSuccess message={copyNotice} className="mt-3" />
      <FormError message={copyError} className="mt-3" />
    </div>
  );
}

/**
 * Every security change re-proves the password, and each one asks for it in
 * its own modal at the moment it is needed — no page-level password box to
 * fill in first and no jumping between cards mid-flow.
 */
function ConfirmPasswordModal({
  open,
  title,
  description,
  confirmLabel,
  busyLabel,
  danger,
  result,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  busyLabel: string;
  danger?: boolean;
  /** Rendered in place of the form once the action has produced something to show. */
  result?: React.ReactNode;
  onCancel: () => void;
  onConfirm: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setPassword("");
      setError(null);
      setBusy(false);
    }
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!password) {
      setError("Enter your current password");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await onConfirm(password);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <Modal open={open} onClose={onCancel} title={title}>
        <div className="flex flex-col gap-4">
          {result}
          <div className="flex justify-end">
            <Button type="button" onClick={onCancel}>
              Done
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={onCancel} title={title}>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <div className="text-sm text-slate-600 dark:text-slate-300">{description}</div>
        <Input
          label="Current password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          autoFocus
        />
        <FormError message={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant={danger ? "danger" : "primary"} disabled={busy}>
            {busy ? busyLabel : confirmLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Name → scan → verify → save your codes, all in one modal. The Member never
 * loses their place, and the QR sits next to the field that consumes it.
 */
function AddAuthenticatorModal({
  open,
  onClose,
  onEnrolled,
}: {
  open: boolean;
  onClose: () => void;
  onEnrolled: (status: TwoFactorStatus) => void;
}) {
  const [name, setName] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [setup, setSetup] = React.useState<TotpSetup | null>(null);
  const [code, setCode] = React.useState("");
  const [recoveryCodes, setRecoveryCodes] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setName("");
    setPassword("");
    setSetup(null);
    setCode("");
    setRecoveryCodes([]);
    setError(null);
    setBusy(false);
  }, [open]);

  async function startSetup(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Give this authenticator a name");
      return;
    }
    if (!password) {
      setError("Enter your current password");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      setSetup(
        await api.post<TotpSetup>("/api/auth/two-factor/totp/setup", {
          currentPassword: password,
          name: name.trim(),
        }),
      );
      setPassword("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await api.post<EnrollmentResult>("/api/auth/two-factor/totp/verify", { code });
      onEnrolled(result.status);
      if (result.recoveryCodes.length > 0) {
        setRecoveryCodes(result.recoveryCodes);
        setSetup(null);
      } else {
        onClose();
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const step = recoveryCodes.length > 0 ? "codes" : setup ? "scan" : "name";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add authenticator app"
      size={step === "scan" ? "lg" : "md"}
    >
      {step === "name" && (
        <form className="flex flex-col gap-4" onSubmit={startSetup}>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Name this authenticator so you can tell it apart from the others, then confirm your
            password to get a QR code.
          </p>
          <Input
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. iPhone 1Password or Work laptop"
            maxLength={100}
            autoFocus
          />
          <Input
            label="Current password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
          <FormError message={error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Preparing…" : "Continue"}
            </Button>
          </div>
        </form>
      )}

      {step === "scan" && setup && (
        <form className="flex flex-col gap-4" onSubmit={verify}>
          <div className="grid gap-5 sm:grid-cols-[220px_1fr]">
            <img
              src={setup.qrDataUrl}
              alt="Authenticator app enrollment QR code"
              className="h-52 w-52 shrink-0 rounded-lg border border-slate-200 bg-white p-2 dark:border-slate-700"
            />
            <div className="flex flex-col gap-3">
              <div>
                <p className="text-sm font-medium">Scan this with {name.trim()}</p>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Can&apos;t scan it? Enter this secret manually:
                </p>
                <code className="mt-2 block break-all rounded-lg bg-slate-100 p-2 text-xs dark:bg-slate-800">
                  {setup.secret}
                </code>
              </div>
              <Input
                label="Six-digit verification code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                placeholder="000000"
                required
                autoFocus
              />
            </div>
          </div>
          <FormError message={error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Verifying…" : "Verify and add"}
            </Button>
          </div>
        </form>
      )}

      {step === "codes" && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Two-factor authentication is on. These recovery codes get you back in if you ever lose
            every enrolled method.
          </p>
          <RecoveryCodes codes={recoveryCodes} />
          <div className="flex justify-end">
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Name → password → the browser's own passkey/security-key prompt. */
function AddWebAuthnModal({
  kind,
  onClose,
  onEnrolled,
}: {
  kind: "passkey" | "security_key" | null;
  onClose: () => void;
  onEnrolled: (status: TwoFactorStatus) => void;
}) {
  const [name, setName] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [recoveryCodes, setRecoveryCodes] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const isSecurityKey = kind === "security_key";

  React.useEffect(() => {
    if (!kind) return;
    setName("");
    setPassword("");
    setRecoveryCodes([]);
    setError(null);
    setBusy(false);
  }, [kind]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!kind) return;
    if (!name.trim()) {
      setError(isSecurityKey ? "Give this security key a name" : "Give this passkey a name");
      return;
    }
    if (!password) {
      setError("Enter your current password");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const optionsJSON = await api.post<PublicKeyCredentialCreationOptionsJSON>(
        "/api/auth/two-factor/webauthn/options",
        { currentPassword: password, name: name.trim(), kind },
      );
      const response = await startRegistration({ optionsJSON });
      const result = await api.post<EnrollmentResult>("/api/auth/two-factor/webauthn/verify", {
        response,
      });
      onEnrolled(result.status);
      if (result.recoveryCodes.length > 0) {
        setRecoveryCodes(result.recoveryCodes);
        setPassword("");
      } else {
        onClose();
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={kind !== null}
      onClose={onClose}
      title={isSecurityKey ? "Add USB security key" : "Add passkey"}
    >
      {recoveryCodes.length > 0 ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Two-factor authentication is on. These recovery codes get you back in if you ever lose
            every enrolled method.
          </p>
          <RecoveryCodes codes={recoveryCodes} />
          <div className="flex justify-end">
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {isSecurityKey
              ? "Name the key, confirm your password, then touch the key when your browser asks."
              : "Name this device, confirm your password, then approve the prompt from your browser."}
          </p>
          <Input
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={isSecurityKey ? "e.g. Office YubiKey" : "e.g. MacBook Touch ID"}
            maxLength={100}
            autoFocus
          />
          <Input
            label="Current password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
          <FormError message={error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Waiting…" : isSecurityKey ? "Add security key" : "Add passkey"}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

/** One enrolled method: an authenticator app, a passkey, or a security key. */
function MethodRow({
  icon,
  name,
  detail,
  onRemove,
}: {
  icon: React.ReactNode;
  name: string;
  detail: string;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <span className="shrink-0 text-slate-500">{icon}</span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{name}</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">{detail}</p>
        </div>
      </div>
      <Button type="button" size="sm" variant="ghost" onClick={onRemove}>
        <Trash2 size={14} /> Remove
      </Button>
    </div>
  );
}

type PendingRemoval =
  | { kind: "totp"; id: string; name: string }
  | { kind: "webauthn"; id: string; name: string };

export function AccountSecurity() {
  const [status, setStatus] = React.useState<TwoFactorStatus | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [addingAuthenticator, setAddingAuthenticator] = React.useState(false);
  const [addingWebAuthn, setAddingWebAuthn] = React.useState<"passkey" | "security_key" | null>(
    null,
  );
  const [removing, setRemoving] = React.useState<PendingRemoval | null>(null);
  const [regenerating, setRegenerating] = React.useState(false);
  const [disabling, setDisabling] = React.useState(false);
  const [newCodes, setNewCodes] = React.useState<string[]>([]);
  const supportsWebAuthn = browserSupportsWebAuthn();

  const load = React.useCallback(async () => {
    try {
      setStatus(await api.get<TwoFactorStatus>("/api/auth/two-factor"));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function confirmRemoval(password: string) {
    if (!removing) return;
    const path =
      removing.kind === "totp"
        ? `/api/auth/two-factor/totp/${removing.id}/remove`
        : `/api/auth/two-factor/webauthn/${removing.id}/remove`;
    setStatus(await api.post<TwoFactorStatus>(path, { currentPassword: password }));
    setRemoving(null);
  }

  async function confirmRegenerate(password: string) {
    const result = await api.post<EnrollmentResult>("/api/auth/two-factor/recovery/regenerate", {
      currentPassword: password,
    });
    setStatus(result.status);
    setNewCodes(result.recoveryCodes);
  }

  function closeRegenerate() {
    setRegenerating(false);
    setNewCodes([]);
  }

  async function confirmDisable(password: string) {
    setStatus(
      await api.post<TwoFactorStatus>("/api/auth/two-factor/disable", {
        currentPassword: password,
      }),
    );
    setDisabling(false);
    setNewCodes([]);
  }

  return (
    <>
      <TopBar title="Security" />
      <div className="flex flex-col gap-4">
        <FormError message={error} />

        {!status ? (
          <Card>
            <CardBody className="flex items-center justify-center py-12">
              <Spinner size={22} />
            </CardBody>
          </Card>
        ) : (
          <>
            <Card>
              <CardBody className="flex items-center justify-between gap-4">
                <div className="flex items-start gap-3">
                  {status.enabled ? (
                    <ShieldCheck
                      size={20}
                      className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                    />
                  ) : (
                    <ShieldOff size={20} className="mt-0.5 shrink-0 text-slate-400" />
                  )}
                  <div>
                    <h2 className="text-sm font-semibold">Two-factor authentication</h2>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      {status.enabled
                        ? "Sign-in requires your password and one enrolled method. Genosyn asks for your password again before any change below."
                        : "Optional and currently off. Add any method below to turn it on."}
                    </p>
                  </div>
                </div>
                <span
                  className={
                    status.enabled
                      ? "shrink-0 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
                      : "shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                  }
                >
                  {status.enabled ? "Enabled" : "Off"}
                </span>
              </CardBody>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="flex items-center gap-2 text-sm font-semibold">
                      <Smartphone size={16} /> Authenticator apps
                    </h2>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      Six-digit codes from 1Password, Google Authenticator, Authy, or another TOTP
                      app. Add as many as you like — a code from any of them signs you in.
                    </p>
                  </div>
                  <Button type="button" size="sm" onClick={() => setAddingAuthenticator(true)}>
                    <Plus size={15} /> Add authenticator app
                  </Button>
                </div>
              </CardHeader>
              <CardBody>
                {status.totpCredentials.length === 0 ? (
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    No authenticator app enrolled yet.
                  </p>
                ) : (
                  <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
                    {status.totpCredentials.map((credential) => (
                      <MethodRow
                        key={credential.id}
                        icon={<Smartphone size={16} />}
                        name={credential.name}
                        detail={`Added ${formatDate(credential.createdAt)} · ${
                          credential.lastUsedAt
                            ? `last used ${formatDate(credential.lastUsedAt)}`
                            : "never used"
                        }`}
                        onRemove={() =>
                          setRemoving({
                            kind: "totp",
                            id: credential.id,
                            name: credential.name,
                          })
                        }
                      />
                    ))}
                  </div>
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="flex items-center gap-2 text-sm font-semibold">
                      <KeyRound size={16} /> Passkeys and security keys
                    </h2>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      Touch ID, Face ID, Windows Hello, a password manager passkey, or a FIDO2 USB
                      key such as YubiKey.
                    </p>
                  </div>
                  {supportsWebAuthn && (
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" size="sm" onClick={() => setAddingWebAuthn("passkey")}>
                        <KeyRound size={15} /> Add passkey
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => setAddingWebAuthn("security_key")}
                      >
                        <Usb size={15} /> Add security key
                      </Button>
                    </div>
                  )}
                </div>
              </CardHeader>
              <CardBody>
                {!supportsWebAuthn ? (
                  <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
                    This browser does not expose WebAuthn. Open Genosyn over HTTPS in a current
                    browser to add a passkey or security key.
                  </p>
                ) : status.webAuthnCredentials.length === 0 ? (
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    No passkey or security key enrolled yet.
                  </p>
                ) : (
                  <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
                    {status.webAuthnCredentials.map((credential) => (
                      <MethodRow
                        key={credential.id}
                        icon={
                          credential.kind === "security_key" ? (
                            <Usb size={16} />
                          ) : (
                            <KeyRound size={16} />
                          )
                        }
                        name={credential.name}
                        detail={`${credential.kind === "security_key" ? "Security key" : "Passkey"}${
                          credential.backedUp ? " · synced" : ""
                        } · added ${formatDate(credential.createdAt)}`}
                        onRemove={() =>
                          setRemoving({
                            kind: "webauthn",
                            id: credential.id,
                            name: credential.name,
                          })
                        }
                      />
                    ))}
                  </div>
                )}
              </CardBody>
            </Card>

            {status.enabled && (
              <Card>
                <CardHeader>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-semibold">Recovery codes</h2>
                      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                        Each code works once if every enrolled method is unavailable.{" "}
                        {status.recoveryCodesRemaining} remaining.
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => setRegenerating(true)}
                    >
                      <RefreshCw size={14} /> Generate new codes
                    </Button>
                  </div>
                </CardHeader>
              </Card>
            )}

            {status.enabled && (
              <Card className="border-red-200 dark:border-red-900">
                <CardHeader>
                  <h2 className="text-sm font-semibold text-red-700 dark:text-red-300">
                    Turn off two-factor authentication
                  </h2>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    Removes every authenticator app, passkey, security key, and recovery code.
                  </p>
                </CardHeader>
                <CardBody>
                  <Button type="button" variant="danger" onClick={() => setDisabling(true)}>
                    <ShieldOff size={15} /> Turn off two-factor authentication
                  </Button>
                </CardBody>
              </Card>
            )}
          </>
        )}
      </div>

      <AddAuthenticatorModal
        open={addingAuthenticator}
        onClose={() => setAddingAuthenticator(false)}
        onEnrolled={setStatus}
      />
      <AddWebAuthnModal
        kind={addingWebAuthn}
        onClose={() => setAddingWebAuthn(null)}
        onEnrolled={setStatus}
      />
      <ConfirmPasswordModal
        open={removing !== null}
        title={removing?.kind === "totp" ? "Remove authenticator app" : "Remove credential"}
        description={
          <>
            Codes from <span className="font-medium">{removing?.name}</span> will stop working. Your
            other enrolled methods are unaffected.
          </>
        }
        confirmLabel="Remove"
        busyLabel="Removing…"
        danger
        onCancel={() => setRemoving(null)}
        onConfirm={confirmRemoval}
      />
      <ConfirmPasswordModal
        open={regenerating}
        title="Generate new recovery codes"
        description="Every existing recovery code stops working the moment new ones are generated."
        confirmLabel="Generate"
        busyLabel="Generating…"
        result={newCodes.length > 0 ? <RecoveryCodes codes={newCodes} /> : undefined}
        onCancel={closeRegenerate}
        onConfirm={confirmRegenerate}
      />
      <ConfirmPasswordModal
        open={disabling}
        title="Turn off two-factor authentication"
        description="This removes every authenticator app, passkey, security key, and recovery code from your account."
        confirmLabel="Turn off"
        busyLabel="Turning off…"
        danger
        onCancel={() => setDisabling(false)}
        onConfirm={confirmDisable}
      />
    </>
  );
}
