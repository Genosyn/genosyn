import React from "react";
import { useOutletContext } from "react-router-dom";
import { Camera } from "lucide-react";
import { api, Me } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { FormError } from "../components/ui/FormError";
import { Avatar, meAvatarUrl } from "../components/ui/Avatar";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { TopBar } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";
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

export function AccountProfile() {
  const { me, onCompaniesChanged } = useCtx();
  const [name, setName] = React.useState(me.name);
  const [email, setEmail] = React.useState(me.email);
  const [handle, setHandle] = React.useState(me.handle ?? "");
  const [savingProfile, setSavingProfile] = React.useState(false);
  const [profileError, setProfileError] = React.useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [savingPassword, setSavingPassword] = React.useState(false);
  const [passwordError, setPasswordError] = React.useState<string | null>(null);
  const { toast } = useToast();

  React.useEffect(() => {
    setName(me.name);
    setEmail(me.email);
    setHandle(me.handle ?? "");
  }, [me.id, me.name, me.email, me.handle]);

  const profileDirty =
    name.trim() !== me.name ||
    email.trim().toLowerCase() !== me.email ||
    handle.trim().toLowerCase() !== (me.handle ?? "");

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
                setSavingProfile(true);
                try {
                  const nextHandle = handle.trim().toLowerCase();
                  await api.patch<Me>("/api/auth/me", {
                    name: name.trim(),
                    email: email.trim().toLowerCase(),
                    handle: nextHandle === "" ? null : nextHandle,
                  });
                  onCompaniesChanged();
                  toast("Profile updated", "success");
                } catch (err) {
                  setProfileError((err as Error).message);
                } finally {
                  setSavingProfile(false);
                }
              }}
            >
              <FormError message={profileError} />
              <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
              <Input
                label="Email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
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
                  toast("Password changed", "success");
                } catch (err) {
                  setPasswordError((err as Error).message);
                } finally {
                  setSavingPassword(false);
                }
              }}
            >
              <FormError message={passwordError} />
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
 * Web Push opt-in for this browser. The toggle reflects this device only —
 * each browser/device subscribes separately (a phone PWA and a desktop
 * Chrome are two subscriptions). See client/lib/push.ts for the flow.
 */
function PushNotificationsCard() {
  const { toast } = useToast();
  const [state, setState] = React.useState<PushState>("unsupported");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    getPushState().then(setState);
  }, []);

  async function toggle() {
    setBusy(true);
    try {
      if (state === "subscribed") {
        await disablePush();
        toast("Push notifications disabled on this device.", "success");
      } else {
        await enablePush();
        toast("Push notifications enabled on this device.", "success");
      }
    } catch (err) {
      toast((err as Error).message, "error");
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
      <CardBody>
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
