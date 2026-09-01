import React from "react";
import { useOutletContext } from "react-router-dom";
import { AlertCircle, Camera, CheckCircle2, Mail } from "lucide-react";
import { api, Me } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { FormError, FormSuccess } from "../components/ui/FormError";
import { Avatar, meAvatarUrl } from "../components/ui/Avatar";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { TopBar } from "../components/AppShell";
import { disablePush, enablePush, getPushState, PushState } from "../lib/push";
import type { AccountOutletCtx } from "./AccountLayout";

/**
 * Account → Profile. Global to the signed-in user (name, email, @handle,
 * avatar, password, and this-device push) — deliberately not company-scoped,
 * which is why it lives under the Account section rather than company Settings.
 */

function useCtx(): AccountOutletCtx {
  return useOutletContext<AccountOutletCtx>();
}

/**
 * What `POST /api/auth/resend-verification` says actually happened to the mail.
 * `skipped` is an install with no email transport — the link went to the server
 * log, not to a mailbox — and `failed` is a transport that rejected it. Neither
 * is an error the person can fix by clicking again, so both get their own
 * sentence instead of a green "sent".
 */
export type ResendDelivery = "sent" | "skipped" | "failed" | "already_verified";

const RESEND_DELIVERIES: readonly ResendDelivery[] = [
  "sent",
  "skipped",
  "failed",
  "already_verified",
];

/** Narrow an unknown JSON field, so a server that predates `delivery` — or a
 *  proxy that rewrites the body — cannot put an arbitrary string on screen. */
export function isResendDelivery(value: unknown): value is ResendDelivery {
  return typeof value === "string" && (RESEND_DELIVERIES as readonly string[]).includes(value);
}

export type ResendOutcome = { tone: "success" | "error"; message: string };

/**
 * The sentence to show after a resend. Master admins are told where the link
 * went and which setting to fix, because they are the only ones who can fix it;
 * everyone else is told to ask, because naming an install-wide transport to an
 * ordinary Member is operator configuration they have no business reading.
 */
export function resendOutcomeCopy(
  delivery: ResendDelivery,
  opts: { email: string; isMasterAdmin: boolean },
): ResendOutcome {
  switch (delivery) {
    case "sent":
      return {
        tone: "success",
        message: `Verification link sent to ${opts.email}. It is valid for 24 hours.`,
      };
    case "already_verified":
      return { tone: "success", message: "This address is already verified." };
    case "skipped":
      return {
        tone: "error",
        message: opts.isMasterAdmin
          ? "This instance has no email transport, so the link was printed to the server log instead of being sent. Copy it from there, or configure a transport at Admin → Email transport."
          : "This instance has no email transport, so the link could not be sent. Ask an administrator to configure one.",
      };
    case "failed":
      return {
        tone: "error",
        message: opts.isMasterAdmin
          ? "The mail server rejected the verification email. Check the settings at Admin → Email transport, then try again."
          : "The verification email could not be delivered. Ask an administrator to check the instance email transport.",
      };
  }
}

/**
 * What the unverified block says above the button. A master admin gets told the
 * consequence they are already hitting — `requireMasterAdmin` refuses an
 * unverified account on every install, not only shared SaaS — rather than a
 * generic nudge that explains nothing about why Admin keeps refusing them.
 */
export function unverifiedNoticeCopy(opts: { isMasterAdmin: boolean }): string {
  return opts.isMasterAdmin
    ? "Genosyn emailed a link when this account was created. Open it to finish verifying — instance administration stays closed until this mailbox is proven."
    : "Genosyn emailed a link when this account was created. Open it to finish verifying this address.";
}

export function AccountProfile() {
  const { me, onCompaniesChanged } = useCtx();
  const [name, setName] = React.useState(me.name);
  const [email, setEmail] = React.useState(me.email);
  const [handle, setHandle] = React.useState(me.handle ?? "");
  const [savingProfile, setSavingProfile] = React.useState(false);
  const [profileError, setProfileError] = React.useState<string | null>(null);
  const [profileNotice, setProfileNotice] = React.useState<string | null>(null);
  const [profileCurrentPassword, setProfileCurrentPassword] = React.useState("");
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [savingPassword, setSavingPassword] = React.useState(false);
  const [passwordError, setPasswordError] = React.useState<string | null>(null);
  const [passwordNotice, setPasswordNotice] = React.useState<string | null>(null);

  React.useEffect(() => {
    setName(me.name);
    setEmail(me.email);
    setHandle(me.handle ?? "");
  }, [me.id, me.name, me.email, me.handle]);

  const profileDirty =
    name.trim() !== me.name ||
    email.trim().toLowerCase() !== me.email ||
    handle.trim().toLowerCase() !== (me.handle ?? "");
  const emailChanged = email.trim().toLowerCase() !== me.email;

  return (
    <>
      <TopBar title="Profile" />
      <div className="flex flex-col gap-4">
        <ProfileAvatarCard me={me} onCompaniesChanged={onCompaniesChanged} />
        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold">Personal details</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              This name and email appear on your account and on any invitations you send.
            </p>
          </CardHeader>
          <CardBody>
            <form
              className="flex flex-col gap-3"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!profileDirty) return;
                setProfileError(null);
                setProfileNotice(null);
                setSavingProfile(true);
                try {
                  const nextHandle = handle.trim().toLowerCase();
                  const result = await api.patch<Me & { pendingEmail?: string | null }>(
                    "/api/auth/me",
                    {
                      name: name.trim(),
                      email: email.trim().toLowerCase(),
                      handle: nextHandle === "" ? null : nextHandle,
                      currentPassword: emailChanged ? profileCurrentPassword : undefined,
                    },
                  );
                  setProfileCurrentPassword("");
                  // A saved profile shows itself: the fields resync and the
                  // Save button goes quiet. A pending email change does not —
                  // the field snaps back to the old address, so say where the
                  // confirmation link went.
                  if (result.pendingEmail) {
                    setEmail(me.email);
                    setProfileNotice(`Check ${result.pendingEmail} to confirm the change`);
                  }
                  onCompaniesChanged();
                } catch (err) {
                  setProfileError((err as Error).message);
                } finally {
                  setSavingProfile(false);
                }
              }}
            >
              <FormError message={profileError} />
              <FormSuccess message={profileNotice} />
              <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
              <Input
                label="Email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              <EmailVerificationNotice me={me} onVerified={onCompaniesChanged} />
              {emailChanged ? (
                <div>
                  <Input
                    label="Current password"
                    type="password"
                    value={profileCurrentPassword}
                    onChange={(e) => setProfileCurrentPassword(e.target.value)}
                    autoComplete="current-password"
                    required
                  />
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    We&apos;ll keep your current email until you confirm the link sent to the new
                    address.
                  </p>
                </div>
              ) : null}
              <div>
                <Input
                  label="Handle"
                  value={handle}
                  onChange={(e) => setHandle(e.target.value.toLowerCase())}
                  placeholder="e.g. jami"
                  pattern="[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?"
                  autoComplete="off"
                />
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Your @handle for workspace-chat mentions. 2–32 chars, lowercase
                  letters/digits/hyphens.
                </p>
              </div>
              <div className="flex justify-end pt-1">
                <Button type="submit" disabled={!profileDirty || savingProfile}>
                  {savingProfile ? "Saving…" : "Save changes"}
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>

        <PushNotificationsCard />

        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold">Change password</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              At least 12 characters. You&apos;ll stay signed in after changing it.
            </p>
          </CardHeader>
          <CardBody>
            <form
              className="flex flex-col gap-3"
              onSubmit={async (e) => {
                e.preventDefault();
                setPasswordNotice(null);
                if (newPassword.length < 12) {
                  setPasswordError("New password must be at least 12 characters");
                  return;
                }
                if (newPassword !== confirmPassword) {
                  setPasswordError("New passwords don't match");
                  return;
                }
                setPasswordError(null);
                setSavingPassword(true);
                try {
                  await api.post("/api/auth/password", { currentPassword, newPassword });
                  setCurrentPassword("");
                  setNewPassword("");
                  setConfirmPassword("");
                  // Emptied password fields look exactly like untouched ones,
                  // so this is the only sign the change went through.
                  setPasswordNotice("Password changed");
                } catch (err) {
                  setPasswordError((err as Error).message);
                } finally {
                  setSavingPassword(false);
                }
              }}
            >
              <FormError message={passwordError} />
              <FormSuccess message={passwordNotice} />
              <Input
                label="Current password"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
              <Input
                label="New password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                minLength={12}
                required
              />
              <Input
                label="Confirm new password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                minLength={12}
                required
              />
              <div className="flex justify-end pt-1">
                <Button
                  type="submit"
                  disabled={
                    savingPassword ||
                    currentPassword.length === 0 ||
                    newPassword.length === 0 ||
                    confirmPassword.length === 0
                  }
                >
                  {savingPassword ? "Saving…" : "Change password"}
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>
      </div>
    </>
  );
}

/**
 * Whether the account's own address is proven, and the way to prove it.
 *
 * It sits under the email field rather than in a card of its own because the
 * question it answers is about that exact value. Until this shipped the only
 * Resend button in the app lived on the full-page gate, which
 * `emailVerificationRequired()` raises in shared SaaS mode alone — so a
 * self-hosted operator refused by `requireMasterAdmin` was told to verify an
 * email with nothing anywhere to click.
 */
function EmailVerificationNotice({ me, onVerified }: { me: Me; onVerified: () => void }) {
  const [sending, setSending] = React.useState(false);
  const [outcome, setOutcome] = React.useState<ResendOutcome | null>(null);

  // A stale sentence about an address that has since changed, or that another
  // tab has since verified, is worse than no sentence.
  React.useEffect(() => {
    setOutcome(null);
  }, [me.id, me.email, me.emailVerified]);

  async function resend() {
    setSending(true);
    setOutcome(null);
    try {
      const result = await api.post<{ ok: boolean; delivery?: unknown }>(
        "/api/auth/resend-verification",
        {},
      );
      const delivery = isResendDelivery(result?.delivery) ? result.delivery : "sent";
      setOutcome(resendOutcomeCopy(delivery, { email: me.email, isMasterAdmin: me.isMasterAdmin }));
      // Verified in another tab while this one sat open: re-read `me` so the
      // block below swaps itself for the verified line.
      if (delivery === "already_verified") onVerified();
    } catch (err) {
      setOutcome({ tone: "error", message: errorMessage(err) });
    } finally {
      setSending(false);
    }
  }

  if (me.emailVerified) {
    return (
      <p className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
          <CheckCircle2 size={10} /> Verified
        </span>
        <span>{me.email} is confirmed.</span>
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/60 dark:bg-amber-950/30">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-200">
          <AlertCircle size={10} /> Unverified
        </span>
        <span className="text-xs font-medium text-amber-900 dark:text-amber-100">{me.email}</span>
      </div>
      <p className="text-xs text-amber-800 dark:text-amber-200">
        {unverifiedNoticeCopy({ isMasterAdmin: me.isMasterAdmin })}
      </p>
      {outcome?.tone === "error" ? <FormError message={outcome.message} /> : null}
      {outcome?.tone === "success" ? <FormSuccess message={outcome.message} /> : null}
      <div className="flex justify-end">
        {/* Inside the profile form — without an explicit type this submits it. */}
        <Button type="button" size="sm" variant="secondary" onClick={resend} disabled={sending}>
          <Mail size={12} /> {sending ? "Sending…" : "Resend verification email"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Web Push opt-in for this browser. The toggle reflects this device only —
 * each browser/device subscribes separately (a phone PWA and a desktop
 * Chrome are two subscriptions). See client/lib/push.ts for the flow.
 */
function PushNotificationsCard() {
  const [state, setState] = React.useState<PushState>("unsupported");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    getPushState().then(setState);
  }, []);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      // The status line below re-reads the subscription either way, so it
      // already says whether this device is on or off.
      if (state === "subscribed") {
        await disablePush();
      } else {
        await enablePush();
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      setState(await getPushState());
    }
  }

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold">Push notifications</h2>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          Mentions, review requests, and approvals as native notifications on this device — even
          when Genosyn is closed. Enable separately on each device you use; on iPhone/iPad, install
          Genosyn to your home screen first.
        </p>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <FormError message={error} />
        <div className="flex items-center justify-between gap-4">
          <div className="text-sm text-slate-700 dark:text-slate-200">
            {state === "unsupported" && "This browser doesn't support push notifications."}
            {state === "denied" &&
              "Notifications are blocked for this site — allow them in your browser settings, then come back."}
            {state === "subscribed" && "Enabled on this device."}
            {state === "unsubscribed" && "Not enabled on this device yet."}
          </div>
          <Button
            onClick={toggle}
            disabled={busy || state === "unsupported" || state === "denied"}
            variant={state === "subscribed" ? "secondary" : "primary"}
          >
            {busy ? "Working…" : state === "subscribed" ? "Disable" : "Enable"}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

function ProfileAvatarCard({ me, onCompaniesChanged }: { me: Me; onCompaniesChanged: () => void }) {
  const [avatarKey, setAvatarKey] = React.useState<string | null>(me.avatarKey ?? null);
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    setAvatarKey(me.avatarKey ?? null);
  }, [me.id, me.avatarKey]);

  async function upload(file: File) {
    setError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/auth/me/avatar", {
        method: "POST",
        credentials: "same-origin",
        body: fd,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let msg = res.statusText;
        try {
          msg = JSON.parse(text).error ?? msg;
        } catch {
          if (text) msg = text;
        }
        throw new Error(msg);
      }
      const data = (await res.json()) as { avatarKey: string };
      setAvatarKey(data.avatarKey);
      onCompaniesChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function remove() {
    setError(null);
    try {
      await api.del("/api/auth/me/avatar");
      setAvatarKey(null);
      onCompaniesChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold">Profile picture</h2>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          Shown next to your name in workspace chat and the top bar. PNG, JPEG, GIF, or WebP up to
          5&nbsp;MB.
        </p>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <FormError message={error} />
        <div className="flex items-center gap-4">
          <Avatar name={me.name || me.email} size="xl" src={meAvatarUrl(avatarKey)} />
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) upload(f);
              }}
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
            >
              <Camera size={12} /> {uploading ? "Uploading…" : "Upload new"}
            </Button>
            {avatarKey && (
              <Button size="sm" variant="ghost" onClick={remove} disabled={uploading}>
                Remove
              </Button>
            )}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
