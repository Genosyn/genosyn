import React from "react";
import { Check, Copy, ExternalLink, Loader2 } from "lucide-react";
import {
  api,
  type AIModel,
  type Company,
  type Employee,
  type SubscriptionDeviceSession,
} from "@/lib/api";
import { copyToClipboard } from "@/lib/clipboard";
import { errorMessage } from "@/lib/errors";
import { Button } from "@/components/ui/Button";
import { useDialog } from "@/components/ui/Dialog";
import { Disclosure } from "@/components/ui/Disclosure";
import { FormError } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";

/**
 * OpenAI subscription sign-in for one AI Model. The normal path starts the
 * server-side device flow and polls its short-lived session while the person
 * signs in in another tab. Business and Enterprise workspaces can instead
 * supply a directly issued access token, which stays behind its own Advanced
 * line because almost nobody needs it.
 *
 * It draws no box of its own: on a model still waiting it sits on the card, and
 * on a connected one inside the card's Advanced section. Only owners and admins
 * can sign in (`canManage`); anyone else sees whether it is signed in.
 */
export function SubscriptionPanel({
  company,
  emp,
  model,
  canManage,
  onSaved,
}: {
  company: Pick<Company, "id">;
  emp: Pick<Employee, "id">;
  model: AIModel;
  canManage: boolean;
  onSaved: () => void;
}) {
  const dialog = useDialog();
  const [deviceSession, setDeviceSession] = React.useState<SubscriptionDeviceSession | null>(null);
  const [starting, setStarting] = React.useState(false);
  const [cancelling, setCancelling] = React.useState(false);
  const [pollError, setPollError] = React.useState<string | null>(null);
  const [signInError, setSignInError] = React.useState<string | null>(null);
  const [codeCopied, setCodeCopied] = React.useState(false);
  const [accessToken, setAccessToken] = React.useState("");
  const [savingToken, setSavingToken] = React.useState(false);
  const [tokenError, setTokenError] = React.useState<string | null>(null);
  const connected = model.status === "connected";
  const deviceSignInAvailable = model.supportsSubscription && model.subscriptionAvailable;
  const base = `/api/companies/${company.id}/employees/${emp.id}/models/${model.id}/subscription`;

  const receiveDeviceSession = React.useCallback(
    (next: SubscriptionDeviceSession) => {
      setDeviceSession(next);
      setPollError(null);
      if (next.status === "succeeded") onSaved();
    },
    [onSaved],
  );

  const deviceSessionId = deviceSession?.id;
  const deviceSessionStatus = deviceSession?.status;

  React.useEffect(() => {
    if (!deviceSessionId || deviceSessionStatus !== "running") return;

    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await api.get<SubscriptionDeviceSession>(`${base}/device/${deviceSessionId}`);
        if (stopped) return;
        receiveDeviceSession(next);
        if (next.status === "running") timer = window.setTimeout(poll, 1_500);
      } catch (err) {
        if (stopped) return;
        setPollError((err as Error).message);
        timer = window.setTimeout(poll, 2_500);
      }
    };

    timer = window.setTimeout(poll, 1_000);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [base, deviceSessionId, deviceSessionStatus, receiveDeviceSession]);

  async function startDeviceSignIn() {
    setStarting(true);
    setPollError(null);
    setSignInError(null);
    setCodeCopied(false);
    try {
      receiveDeviceSession(await api.post<SubscriptionDeviceSession>(`${base}/device`));
    } catch (err) {
      setSignInError(errorMessage(err));
    } finally {
      setStarting(false);
    }
  }

  async function cancelDeviceSignIn() {
    if (!deviceSession || deviceSession.status !== "running") return;
    setCancelling(true);
    setSignInError(null);
    try {
      await api.del(`${base}/device/${deviceSession.id}`);
      setDeviceSession((current) =>
        current ? { ...current, status: "cancelled", error: null } : current,
      );
      setPollError(null);
    } catch (err) {
      setSignInError(errorMessage(err));
    } finally {
      setCancelling(false);
    }
  }

  async function saveAccessToken(e: React.FormEvent) {
    e.preventDefault();
    setTokenError(null);
    setSavingToken(true);
    try {
      await api.post(`${base}/access-token`, { accessToken });
      setAccessToken("");
      setDeviceSession(null);
      onSaved();
    } catch (err) {
      setTokenError(errorMessage(err));
    } finally {
      setSavingToken(false);
    }
  }

  const deviceRunning = deviceSession?.status === "running";
  const signedInAs =
    model.subscriptionCredentialKind === "accessToken"
      ? "Signed in with a Business or Enterprise access token."
      : "Signed in with a ChatGPT account.";

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {connected
          ? canManage
            ? `${signedInAs} Sign in again whenever the saved sign-in needs replacing.`
            : signedInAs
          : canManage
            ? "Sign in with the ChatGPT account this AI Model should use."
            : "Waiting for an owner or admin to sign in with ChatGPT."}
      </p>

      {canManage && !deviceSignInAvailable && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          Browser sign-in is unavailable:{" "}
          {model.subscriptionUnavailableReason ??
            "this Genosyn install does not support ChatGPT device sign-in."}
        </div>
      )}

      {!model.subscriptionShellAvailable && (
        <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
          Shell commands are off on this install. Work on this AI Model still uses the
          employee&apos;s granted company tools.
        </div>
      )}

      {deviceRunning && (
        <div
          className="flex flex-col gap-3 rounded-md bg-slate-50 p-3 dark:bg-slate-900"
          aria-live="polite"
        >
          <div className="flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-200">
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            Waiting for you to finish signing in
          </div>
          {deviceSession.loginUrl && (
            <a
              className="inline-flex w-fit items-center gap-1 text-sm font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-300 dark:hover:text-indigo-200"
              href={deviceSession.loginUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open ChatGPT sign-in <ExternalLink size={13} aria-hidden="true" />
            </a>
          )}
          {deviceSession.userCode && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-slate-500 dark:text-slate-400">One-time code</span>
              <code className="rounded-md border border-slate-200 bg-white px-2 py-1 text-sm font-semibold tracking-wider text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100">
                {deviceSession.userCode}
              </code>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={async () => {
                  const copied = await copyToClipboard(deviceSession.userCode ?? "");
                  if (!copied) {
                    void dialog.error("Copy it by hand from the field beside this button.", {
                      title: "Couldn’t copy the code",
                    });
                    return;
                  }
                  setCodeCopied(true);
                  window.setTimeout(() => setCodeCopied(false), 1500);
                }}
              >
                {codeCopied ? <Check size={13} /> : <Copy size={13} />}
                {codeCopied ? "Copied" : "Copy"}
              </Button>
            </div>
          )}
          {pollError && (
            <div className="text-xs text-amber-700 dark:text-amber-300">
              Could not check sign-in status ({pollError}). Retrying…
            </div>
          )}
        </div>
      )}

      {deviceSession?.status === "failed" && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {deviceSession.error ?? "ChatGPT sign-in failed. Start a new sign-in to try again."}
        </div>
      )}
      {deviceSession?.status === "cancelled" && (
        <div className="text-xs text-slate-500 dark:text-slate-400">Sign-in was cancelled.</div>
      )}
      {deviceSession?.status === "succeeded" && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
          ChatGPT subscription connected.
        </div>
      )}

      <FormError message={signInError} />

      {canManage && (deviceSignInAvailable || deviceRunning) && (
        <div className="flex flex-wrap gap-2">
          {deviceSignInAvailable && !deviceRunning && (
            <Button
              type="button"
              size="sm"
              variant={connected ? "secondary" : "primary"}
              onClick={startDeviceSignIn}
              loading={starting}
            >
              {starting
                ? "Starting…"
                : connected || deviceSession?.status === "succeeded"
                  ? "Sign in again with ChatGPT"
                  : "Sign in with ChatGPT"}
            </Button>
          )}
          {deviceRunning && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={cancelDeviceSignIn}
              loading={cancelling}
            >
              {cancelling ? "Cancelling…" : "Cancel sign-in"}
            </Button>
          )}
        </div>
      )}

      {canManage && model.subscriptionAvailable && (
        <Disclosure
          title="Business or Enterprise access token"
          summary={
            model.subscriptionCredentialKind === "accessToken"
              ? "In use"
              : "Only when your workspace issues one"
          }
        >
          <form className="flex flex-col gap-2" onSubmit={saveAccessToken}>
            <Input
              label="Access token"
              type="password"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              placeholder={
                model.subscriptionCredentialKind === "accessToken"
                  ? "•••••••• (replace the saved token)"
                  : "Paste an access token"
              }
              autoComplete="off"
              required
            />
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Use this only when your OpenAI Business or Enterprise workspace issues a direct access
              token. It is stored encrypted.
            </p>
            <FormError message={tokenError} />
            <div>
              <Button
                type="submit"
                size="sm"
                loading={savingToken}
                disabled={accessToken.trim().length === 0}
              >
                {savingToken
                  ? "Testing connection…"
                  : model.subscriptionCredentialKind === "accessToken"
                    ? "Replace access token"
                    : "Save access token"}
              </Button>
            </div>
          </form>
        </Disclosure>
      )}
    </div>
  );
}
