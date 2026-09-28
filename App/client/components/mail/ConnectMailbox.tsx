import React from "react";
import { ArrowRight, ExternalLink, ShieldCheck } from "lucide-react";

import { api } from "../../lib/api";
import { connectWithOauth, type IntegrationOauthStart } from "@/lib/integrationOauth";
import {
  mailApi,
  type MailAccount,
  type MailboxConnectOption,
  type MailboxConnectPlan,
} from "../../lib/mail";
import { Button } from "../ui/Button";
import { FormError } from "../ui/FormError";
import { Input } from "../ui/Input";
import { Modal } from "../ui/Modal";
import { Spinner } from "../ui/Spinner";

/**
 * Connecting a mailbox, from the one thing the person already knows.
 *
 * Every earlier version of this screen was a picker over Connections that had
 * to exist first, which meant the flow began somewhere else entirely — on a
 * fresh install, in Google Cloud Console. Nowhere did it ask for the address,
 * even though the address is the only fact the person has and the only fact
 * from which everything else can be derived.
 *
 * So: one field. `POST /mail/connect/discover` turns the address into the
 * routes that will actually work on this install, and the form becomes either
 * a single Continue-with-Google button or a password box with the right
 * servers already filled in. The advanced fields exist and stay collapsed,
 * because the company whose mail server is not where its domain says it is
 * needs them and nobody else should have to look at them.
 */

/**
 * The Integration a route's OAuth app belongs to.
 *
 * `option.provider` names the *app* — the thing an admin registers once — and
 * the handshake wants the *Integration* id. They happen to be the same word for
 * Google and will not be for the next one, so the mapping is written down
 * rather than assumed.
 */
const INTEGRATION_FOR_OAUTH: Partial<Record<"google" | "microsoft", string>> = {
  google: "google",
};

export type ConnectMailboxProps = {
  companyId: string;
  /** Called once a mailbox exists. */
  onConnected: (account: MailAccount | null) => void | Promise<void>;
  autoFocus?: boolean;
  /**
   * False for a member who cannot connect one.
   *
   * Connecting a mailbox stores a company-wide credential, so the server gates
   * both of this form's actions on the admin role. Showing the field to
   * somebody who will be refused when they press Continue wastes their app
   * password and tells them nothing; the form says who to ask instead.
   */
  canConnect?: boolean;
};

type Phase =
  | { step: "address" }
  | { step: "choose"; plan: MailboxConnectPlan }
  | {
      step: "password";
      plan: MailboxConnectPlan;
      option: Extract<MailboxConnectOption, { kind: "imap" }>;
    };

export function ConnectMailboxForm({
  companyId,
  onConnected,
  autoFocus,
  canConnect = true,
}: ConnectMailboxProps) {
  const [email, setEmail] = React.useState("");
  const [phase, setPhase] = React.useState<Phase>({ step: "address" });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [waitingForOauth, setWaitingForOauth] = React.useState(false);
  const oauthController = React.useRef<AbortController | null>(null);

  // Password step
  const [password, setPassword] = React.useState("");
  const [advanced, setAdvanced] = React.useState(false);
  const [imapHost, setImapHost] = React.useState("");
  const [imapPort, setImapPort] = React.useState("");
  const [smtpHost, setSmtpHost] = React.useState("");
  const [smtpPort, setSmtpPort] = React.useState("");
  const [username, setUsername] = React.useState("");

  React.useEffect(
    () => () => {
      oauthController.current?.abort();
    },
    [companyId],
  );

  async function lookUp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { plan } = await mailApi.discoverConnect(companyId, email);
      const first = plan.options[0];
      // One usable password route and nothing to choose between: skip the
      // menu and put the person straight in front of the field they need.
      if (plan.options.length === 1 && first?.kind === "imap") {
        applyDefaults(first);
        setPhase({ step: "password", plan, option: first });
      } else {
        setPhase({ step: "choose", plan });
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  function applyDefaults(option: Extract<MailboxConnectOption, { kind: "imap" }>) {
    setImapHost(option.imap.host);
    setImapPort(String(option.imap.port));
    setSmtpHost(option.smtp.host);
    setSmtpPort(String(option.smtp.port));
  }

  async function startOauth(option: Extract<MailboxConnectOption, { kind: "oauth" }>) {
    const provider = INTEGRATION_FOR_OAUTH[option.provider];
    if (!provider) {
      setError(`Genosyn cannot sign in with ${option.provider} yet.`);
      return;
    }
    setBusy(true);
    setError(null);
    const controller = new AbortController();
    oauthController.current = controller;
    try {
      await connectWithOauth({
        companyId,
        signal: controller.signal,
        onWaiting: () => setWaitingForOauth(true),
        start: () =>
          api.post<IntegrationOauthStart>(`/api/companies/${companyId}/integrations/oauth/start`, {
            provider,
            label: email.trim(),
            scopeGroups: option.scopeGroups,
            linkMailbox: true,
          }),
      });
      await onConnected(null);
    } catch (err) {
      if (!controller.signal.aborted) setError(errorText(err));
    } finally {
      oauthController.current = null;
      setWaitingForOauth(false);
      setBusy(false);
    }
  }

  async function connectWithPassword(e: React.FormEvent) {
    e.preventDefault();
    if (phase.step !== "password") return;
    setBusy(true);
    setError(null);
    try {
      const { account } = await mailApi.connectImap(companyId, {
        address: phase.plan.email,
        password,
        username: username.trim() || undefined,
        imapHost: imapHost.trim() || undefined,
        imapPort: Number(imapPort) || undefined,
        smtpHost: smtpHost.trim() || undefined,
        smtpPort: Number(smtpPort) || undefined,
      });
      setPassword("");
      await onConnected(account);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (!canConnect) {
    return (
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Connecting a mailbox stores a credential the whole company uses, so an owner or admin has to
        do it. Ask one of them to add it — after that you can read and answer mail here like anyone
        else.
      </p>
    );
  }

  if (phase.step === "address") {
    return (
      <form onSubmit={lookUp} className="space-y-3">
        <Input
          label="Email address"
          type="email"
          autoFocus={autoFocus}
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
        />
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Genosyn works out the rest from the address.
        </p>
        <FormError message={error} />
        <Button type="submit" disabled={busy || !email.trim()}>
          {busy ? (
            <Spinner size={13} />
          ) : (
            <>
              Continue <ArrowRight size={14} className="ml-1" />
            </>
          )}
        </Button>
      </form>
    );
  }

  const { plan } = phase;

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 truncate text-sm font-medium text-slate-800 dark:text-slate-200">
          {plan.email}
        </p>
        <button
          type="button"
          disabled={busy}
          className="shrink-0 text-xs text-slate-500 underline hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
          onClick={() => {
            setPhase({ step: "address" });
            setError(null);
          }}
        >
          Change
        </button>
      </div>

      <SourceNote plan={plan} />

      {plan.unsupportedReason ? (
        <FormError message={plan.unsupportedReason} />
      ) : phase.step === "choose" ? (
        <div className="space-y-2">
          <FormError message={error} />
          {plan.options.map((option, index) => (
            <OptionRow
              key={index}
              option={option}
              busy={busy}
              onPick={() => {
                setError(null);
                if (option.kind === "oauth") void startOauth(option);
                else {
                  applyDefaults(option);
                  setPhase({ step: "password", plan, option });
                }
              }}
            />
          ))}
          {plan.options.some((option) => option.kind === "oauth" && option.hostedSignIn) && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Genosyn handles Google sign-in. Your mailbox syncs directly with Google on this
              installation.
            </p>
          )}
          {waitingForOauth && (
            <div className="flex items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
              <p role="status">Waiting for sign-in…</p>
              <button
                type="button"
                className="underline"
                onClick={() => oauthController.current?.abort()}
              >
                Cancel sign-in
              </button>
            </div>
          )}
        </div>
      ) : (
        <form onSubmit={connectWithPassword} className="space-y-3">
          {phase.option.password && (
            <div className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
              <ShieldCheck size={14} className="mt-0.5 shrink-0" />
              <span>
                {phase.option.password.summary}{" "}
                {phase.option.password.url && (
                  <a
                    href={phase.option.password.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 underline"
                  >
                    Create one <ExternalLink size={11} />
                  </a>
                )}
              </span>
            </div>
          )}
          <Input
            label="Password"
            type="password"
            autoFocus
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
          <button
            type="button"
            className="text-xs text-slate-500 underline hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
            onClick={() => setAdvanced((v) => !v)}
          >
            {advanced ? "Hide server settings" : "Server settings"}
          </button>
          {advanced && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Input
                label="IMAP server"
                value={imapHost}
                onChange={(e) => setImapHost(e.target.value)}
              />
              <Input
                label="IMAP port"
                inputMode="numeric"
                value={imapPort}
                onChange={(e) => setImapPort(e.target.value)}
              />
              <Input
                label="SMTP server"
                value={smtpHost}
                onChange={(e) => setSmtpHost(e.target.value)}
              />
              <Input
                label="SMTP port"
                inputMode="numeric"
                value={smtpPort}
                onChange={(e) => setSmtpPort(e.target.value)}
              />
              <Input
                label="Login name"
                className="sm:col-span-2"
                placeholder={plan.email}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
          )}
          <FormError message={error} />
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={busy || !password}>
              {busy ? <Spinner size={13} /> : "Connect mailbox"}
            </Button>
            {plan.options.length > 1 && (
              <button
                type="button"
                className="text-xs text-slate-500 underline hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                onClick={() => setPhase({ step: "choose", plan })}
              >
                Other ways to connect
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * One connect route, as a row the person can press.
 *
 * A route that cannot work here gets no button at all, only the reason. A
 * greyed-out primary button next to a live one reads, at a glance, as two
 * buttons — and the one thing this dialog must never do is invite somebody to
 * press the option that will fail.
 */
function OptionRow({
  option,
  busy,
  onPick,
}: {
  option: MailboxConnectOption;
  busy: boolean;
  onPick: () => void;
}) {
  const title =
    option.kind === "oauth" ? option.label : `Sign in with a password (${option.imap.host})`;
  return (
    <div className="rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700">
      <div className="flex items-center justify-between gap-3">
        <span
          className={
            option.ready
              ? "min-w-0 truncate text-sm text-slate-700 dark:text-slate-300"
              : "min-w-0 truncate text-sm text-slate-400 dark:text-slate-500"
          }
        >
          {title}
        </span>
        {option.ready && (
          <Button size="sm" disabled={busy} onClick={onPick}>
            {busy ? <Spinner size={13} /> : "Continue"}
          </Button>
        )}
      </div>
      {option.blockedReason && (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{option.blockedReason}</p>
      )}
    </div>
  );
}

/**
 * Where the settings came from.
 *
 * Worth one quiet line: "we know this provider" and "we guessed from the
 * domain" ask for very different amounts of scepticism from the person about
 * to type a password, and the second is the case where opening Server
 * settings is a good idea.
 */
function SourceNote({ plan }: { plan: MailboxConnectPlan }) {
  const note =
    plan.providerKey === "google"
      ? "Sign in with Google to connect your mailbox."
      : plan.source === "guess"
        ? `No published settings for ${plan.domain} — these are the usual ones. Check them under Server settings if the connection is refused.`
        : plan.source === "mx"
          ? `${plan.domain} receives its mail through ${plan.displayName}.`
          : plan.source === "builtin"
            ? `${plan.displayName} settings, filled in for you.`
            : `Settings published by ${plan.domain}.`;
  return <p className="text-xs text-slate-500 dark:text-slate-400">{note}</p>;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}

/** The same form inside a modal, for the pages that open it over a list. */
export function ConnectMailboxDialog({
  companyId,
  open,
  onClose,
  onConnected,
  canConnect = true,
}: {
  companyId: string;
  open: boolean;
  onClose: () => void;
  onConnected: (account: MailAccount | null) => void | Promise<void>;
  canConnect?: boolean;
}) {
  if (!open) return null;
  return (
    <Modal
      open
      onClose={onClose}
      title="Connect a mailbox"
      description="Enter your email address to find the right sign-in."
    >
      <ConnectMailboxForm
        companyId={companyId}
        onConnected={onConnected}
        canConnect={canConnect}
        autoFocus
      />
    </Modal>
  );
}
