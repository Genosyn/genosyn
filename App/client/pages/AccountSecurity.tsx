import React from "react";
import {
  Copy,
  Download,
  KeyRound,
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
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";

type TotpSetup = {
  secret: string;
  otpAuthUri: string;
  qrDataUrl: string;
};

type EnrollmentResult = {
  status: TwoFactorStatus;
  recoveryCodes: string[];
};

export function AccountSecurity() {
  const [status, setStatus] = React.useState<TwoFactorStatus | null>(null);
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [credentialName, setCredentialName] = React.useState("");
  const [totpSetup, setTotpSetup] = React.useState<TotpSetup | null>(null);
  const [totpCode, setTotpCode] = React.useState("");
  const [recoveryCodes, setRecoveryCodes] = React.useState<string[]>([]);
  const [action, setAction] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const { toast } = useToast();
  const supportsWebAuthn = browserSupportsWebAuthn();

  const load = React.useCallback(async () => {
    try {
      setStatus(await api.get<TwoFactorStatus>("/api/auth/two-factor"));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  function requirePassword(): boolean {
    if (currentPassword) return true;
    setError("Enter your current password to change two-factor settings");
    return false;
  }

  function showNewRecoveryCodes(codes: string[]) {
    if (codes.length > 0) setRecoveryCodes(codes);
  }

  async function startTotpSetup() {
    if (!requirePassword()) return;
    setError(null);
    setAction("totp-setup");
    try {
      const setup = await api.post<TotpSetup>("/api/auth/two-factor/totp/setup", {
        currentPassword,
      });
      setTotpSetup(setup);
      setTotpCode("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAction(null);
    }
  }

  async function verifyTotp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setAction("totp-verify");
    try {
      const result = await api.post<EnrollmentResult>("/api/auth/two-factor/totp/verify", {
        code: totpCode,
      });
      setStatus(result.status);
      showNewRecoveryCodes(result.recoveryCodes);
      setTotpSetup(null);
      setTotpCode("");
      setCurrentPassword("");
      toast("Authenticator app enabled", "success");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAction(null);
    }
  }

  async function removeAuthenticatorApp() {
    if (!requirePassword()) return;
    if (!window.confirm("Remove the authenticator app from this account?")) return;
    setError(null);
    setAction("totp-remove");
    try {
      const next = await api.post<TwoFactorStatus>("/api/auth/two-factor/totp/remove", {
        currentPassword,
      });
      setStatus(next);
      setCurrentPassword("");
      if (!next.enabled) setRecoveryCodes([]);
      toast("Authenticator app removed", "success");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAction(null);
    }
  }

  async function addWebAuthn(kind: "passkey" | "security_key") {
    if (!supportsWebAuthn) {
      setError("This browser does not support passkeys or FIDO2 security keys");
      return;
    }
    if (!requirePassword()) return;
    if (!credentialName.trim()) {
      setError("Give this passkey or security key a name");
      return;
    }
    setError(null);
    setAction(`webauthn-${kind}`);
    try {
      const optionsJSON = await api.post<PublicKeyCredentialCreationOptionsJSON>(
        "/api/auth/two-factor/webauthn/options",
        {
          currentPassword,
          name: credentialName.trim(),
          kind,
        },
      );
      const response = await startRegistration({ optionsJSON });
      const result = await api.post<EnrollmentResult>("/api/auth/two-factor/webauthn/verify", {
        response,
      });
      setStatus(result.status);
      showNewRecoveryCodes(result.recoveryCodes);
      setCredentialName("");
      setCurrentPassword("");
      toast(kind === "passkey" ? "Passkey added" : "Security key added", "success");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAction(null);
    }
  }

  async function removeCredential(id: string, name: string) {
    if (!requirePassword()) return;
    if (!window.confirm(`Remove “${name}” from this account?`)) return;
    setError(null);
    setAction(`remove-${id}`);
    try {
      const next = await api.post<TwoFactorStatus>(`/api/auth/two-factor/webauthn/${id}/remove`, {
        currentPassword,
      });
      setStatus(next);
      setCurrentPassword("");
      if (!next.enabled) setRecoveryCodes([]);
      toast("Credential removed", "success");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAction(null);
    }
  }

  async function regenerateCodes() {
    if (!requirePassword()) return;
    if (
      !window.confirm(
        "Generate new recovery codes? Every existing recovery code will stop working.",
      )
    ) {
      return;
    }
    setError(null);
    setAction("recovery");
    try {
      const result = await api.post<EnrollmentResult>("/api/auth/two-factor/recovery/regenerate", {
        currentPassword,
      });
      setStatus(result.status);
      setRecoveryCodes(result.recoveryCodes);
      setCurrentPassword("");
      toast("Recovery codes regenerated", "success");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAction(null);
    }
  }

  async function turnOffTwoFactor() {
    if (!requirePassword()) return;
    if (!window.confirm("Turn off two-factor authentication and remove every enrolled method?")) {
      return;
    }
    setError(null);
    setAction("disable");
    try {
      const next = await api.post<TwoFactorStatus>("/api/auth/two-factor/disable", {
        currentPassword,
      });
      setStatus(next);
      setCurrentPassword("");
      setRecoveryCodes([]);
      setTotpSetup(null);
      toast("Two-factor authentication turned off", "success");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAction(null);
    }
  }

  async function copyRecoveryCodes() {
    try {
      await navigator.clipboard.writeText(recoveryCodes.join("\n"));
      toast("Recovery codes copied", "success");
    } catch {
      setError("Your browser could not copy the recovery codes");
    }
  }

  function downloadRecoveryCodes() {
    const contents = [
      "Genosyn recovery codes",
      "Each code can be used once. Store these somewhere safe.",
      "",
      ...recoveryCodes,
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
              <CardHeader>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h2 className="flex items-center gap-2 text-sm font-semibold">
                      {status.enabled ? (
                        <ShieldCheck size={16} className="text-emerald-600 dark:text-emerald-400" />
                      ) : (
                        <ShieldOff size={16} className="text-slate-400" />
                      )}
                      Two-factor authentication
                    </h2>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      {status.enabled
                        ? "Enabled — sign-in requires your password and one enrolled method."
                        : "Optional and currently off. Add any method below to turn it on."}
                    </p>
                  </div>
                  <span
                    className={
                      status.enabled
                        ? "rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
                        : "rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                    }
                  >
                    {status.enabled ? "Enabled" : "Off"}
                  </span>
                </div>
              </CardHeader>
              <CardBody>
                <Input
                  label="Current password"
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  autoComplete="current-password"
                  placeholder="Required before security changes"
                />
                <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                  Genosyn asks for your password before adding, removing, or resetting a method.
                </p>
              </CardBody>
            </Card>

            <Card>
              <CardHeader>
                <h2 className="flex items-center gap-2 text-sm font-semibold">
                  <Smartphone size={16} /> Authenticator app
                </h2>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Use a six-digit code from 1Password, Google Authenticator, Authy, or another TOTP
                  app.
                </p>
              </CardHeader>
              <CardBody>
                {status.totpEnabled ? (
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                        Authenticator app enrolled
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                        Six-digit codes can complete sign-in.
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="danger"
                      disabled={action !== null}
                      onClick={removeAuthenticatorApp}
                    >
                      <Trash2 size={14} /> Remove
                    </Button>
                  </div>
                ) : totpSetup ? (
                  <div className="grid gap-5 md:grid-cols-[240px_1fr]">
                    <img
                      src={totpSetup.qrDataUrl}
                      alt="Authenticator app enrollment QR code"
                      className="h-60 w-60 rounded-lg border border-slate-200 bg-white p-2 dark:border-slate-700"
                    />
                    <form className="flex flex-col justify-center gap-3" onSubmit={verifyTotp}>
                      <div>
                        <p className="text-sm font-medium">Scan this QR code</p>
                        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                          Can&apos;t scan it? Enter this secret manually:
                        </p>
                        <code className="mt-2 block break-all rounded-lg bg-slate-100 p-2 text-xs dark:bg-slate-800">
                          {totpSetup.secret}
                        </code>
                      </div>
                      <Input
                        label="Six-digit verification code"
                        value={totpCode}
                        onChange={(e) => setTotpCode(e.target.value)}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        pattern="[0-9]{6}"
                        placeholder="000000"
                        required
                      />
                      <div className="flex gap-2">
                        <Button type="submit" disabled={action !== null}>
                          {action === "totp-verify" ? "Verifying…" : "Verify and enable"}
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => setTotpSetup(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    </form>
                  </div>
                ) : (
                  <Button type="button" disabled={action !== null} onClick={startTotpSetup}>
                    <Smartphone size={15} />
                    {action === "totp-setup" ? "Preparing…" : "Set up authenticator app"}
                  </Button>
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader>
                <h2 className="flex items-center gap-2 text-sm font-semibold">
                  <KeyRound size={16} /> Passkeys and security keys
                </h2>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Use Touch ID, Face ID, Windows Hello, a password manager passkey, or a FIDO2 USB
                  key such as YubiKey.
                </p>
              </CardHeader>
              <CardBody className="flex flex-col gap-4">
                {status.webAuthnCredentials.length > 0 && (
                  <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
                    {status.webAuthnCredentials.map((credential) => (
                      <div
                        key={credential.id}
                        className="flex items-center justify-between gap-3 px-3 py-3"
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          {credential.kind === "security_key" ? (
                            <Usb size={16} className="shrink-0 text-slate-500" />
                          ) : (
                            <KeyRound size={16} className="shrink-0 text-slate-500" />
                          )}
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{credential.name}</p>
                            <p className="text-xs text-slate-500 dark:text-slate-400">
                              {credential.kind === "security_key" ? "Security key" : "Passkey"}
                              {credential.backedUp ? " · synced" : ""} · added{" "}
                              {new Date(credential.createdAt).toLocaleDateString()}
                            </p>
                          </div>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={action !== null}
                          onClick={() => removeCredential(credential.id, credential.name)}
                        >
                          <Trash2 size={14} /> Remove
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                {supportsWebAuthn ? (
                  <div className="flex flex-col gap-3">
                    <Input
                      label="Credential name"
                      value={credentialName}
                      onChange={(e) => setCredentialName(e.target.value)}
                      placeholder="e.g. MacBook Touch ID or Office YubiKey"
                      maxLength={100}
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        disabled={action !== null}
                        onClick={() => addWebAuthn("passkey")}
                      >
                        <KeyRound size={15} />
                        {action === "webauthn-passkey" ? "Waiting…" : "Add passkey"}
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={action !== null}
                        onClick={() => addWebAuthn("security_key")}
                      >
                        <Usb size={15} />
                        {action === "webauthn-security_key" ? "Waiting…" : "Add USB security key"}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
                    This browser does not expose WebAuthn. Open Genosyn over HTTPS in a current
                    browser to add a passkey or security key.
                  </p>
                )}
              </CardBody>
            </Card>

            {status.enabled && (
              <Card>
                <CardHeader>
                  <h2 className="text-sm font-semibold">Recovery codes</h2>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    Each code works once if your enrolled device is unavailable.{" "}
                    {status.recoveryCodesRemaining} remaining.
                  </p>
                </CardHeader>
                <CardBody className="flex flex-col gap-3">
                  {recoveryCodes.length > 0 && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/40">
                      <p className="text-sm font-semibold text-amber-900 dark:text-amber-100">
                        Save these codes now
                      </p>
                      <p className="mt-1 text-xs text-amber-800 dark:text-amber-200">
                        They will not be shown again. Store them somewhere separate from your
                        authenticator.
                      </p>
                      <div className="mt-3 grid grid-cols-1 gap-1 font-mono text-sm text-slate-900 sm:grid-cols-2 dark:text-slate-100">
                        {recoveryCodes.map((code) => (
                          <span key={code}>{code}</span>
                        ))}
                      </div>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={copyRecoveryCodes}
                        >
                          <Copy size={14} /> Copy
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={downloadRecoveryCodes}
                        >
                          <Download size={14} /> Download
                        </Button>
                      </div>
                    </div>
                  )}
                  <div>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={action !== null}
                      onClick={regenerateCodes}
                    >
                      <RefreshCw size={14} />
                      {action === "recovery" ? "Generating…" : "Generate new codes"}
                    </Button>
                  </div>
                </CardBody>
              </Card>
            )}

            {status.enabled && (
              <Card className="border-red-200 dark:border-red-900">
                <CardHeader>
                  <h2 className="text-sm font-semibold text-red-700 dark:text-red-300">
                    Turn off two-factor authentication
                  </h2>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    Removes the authenticator app, every passkey and security key, and all recovery
                    codes.
                  </p>
                </CardHeader>
                <CardBody>
                  <Button
                    type="button"
                    variant="danger"
                    disabled={action !== null}
                    onClick={turnOffTwoFactor}
                  >
                    <ShieldOff size={15} />
                    {action === "disable" ? "Turning off…" : "Turn off two-factor authentication"}
                  </Button>
                </CardBody>
              </Card>
            )}
          </>
        )}
      </div>
    </>
  );
}
