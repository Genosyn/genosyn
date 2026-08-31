import React from "react";
import { Link, useParams } from "react-router-dom";
import {
  CheckCircle2,
  Link2,
  LogIn,
  MessageSquare,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  UserRound,
} from "lucide-react";

import { AuthShell } from "./Login";
import { Button, buttonClassName } from "../components/ui/Button";
import { FormError } from "../components/ui/FormError";
import { Spinner } from "../components/ui/Spinner";

/**
 * Where the AI Employee's one-time link lands (M59 — external chat surfaces).
 *
 * A person messaging an AI Employee from Slack, Microsoft Teams, WhatsApp or
 * Telegram is a stranger until they prove who they are, and the turn runs with
 * no requester: no Soul, no Skills, no Goals, no Policies, no company tools.
 * The proof is deliberately *not* the address the platform reports — Slack
 * Connect and Microsoft Teams federation both seat people from other tenants
 * in the same room, carrying an email their own tenant vouched for. The proof
 * is this page: a browser already signed in to Genosyn, whose session names
 * exactly one Member.
 *
 * Which is why opening the URL must not be the proof. The bind used to fire
 * from a mount effect, so forwarding the link was enough to attach the
 * opener's authority to the sender's chat account — a confused deputy, and a
 * link is the easiest thing in the world to forward ("can you check this?").
 * So the page reads the link first, names the external account out loud, and
 * waits: nothing is bound until somebody who can see that handle clicks the
 * button. The preview costs nothing and spends nothing, which is the only
 * reason it may run from an effect.
 *
 * The copy lives in {@link bindConfirmCopy} and {@link bindFailureFor} rather
 * than in the JSX, because "what am I agreeing to" and "what do I do now" are
 * the parts worth testing.
 */

/** The four surfaces, and the only place their display names are written. */
export const CHAT_SURFACE_LABELS: Record<string, string> = {
  slack: "Slack",
  // Never "Teams" on its own: Teams is Genosyn's own org-chart entity.
  "microsoft-teams": "Microsoft Teams",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
};

export const CHAT_SURFACE_PROVIDERS = Object.keys(CHAT_SURFACE_LABELS);

export function isChatSurfaceProvider(provider: string): boolean {
  return Object.hasOwn(CHAT_SURFACE_LABELS, provider);
}

/**
 * A provider id as a human says it. Unknown ids come back verbatim — a
 * Connection on a surface this build has never heard of is still worth
 * naming.
 */
export function chatSurfaceLabel(provider: string): string {
  return isChatSurfaceProvider(provider) ? CHAT_SURFACE_LABELS[provider] : provider;
}

export type BindFailureKind =
  | "signed_out"
  | "invalid"
  | "expired"
  | "taken"
  | "not_a_member"
  | "unreachable"
  | "unknown";

export type BindFailure = {
  kind: BindFailureKind;
  /** Page heading. */
  title: string;
  /** What happened. */
  message: string;
  /** What to do about it. Always present: nobody lands here on purpose. */
  fix: string;
  /** True when re-sending the same request could plausibly work. */
  retryable: boolean;
};

/**
 * Turn the endpoint's answer into something to read. Both calls share it: the
 * preview refuses a link for exactly the reasons the bind would, so a person
 * who is going to be turned away is turned away before being asked to agree
 * to anything.
 *
 * The statuses are not interchangeable and neither is the advice. An expired
 * link is replaced by sending the AI Employee another message — it re-mints
 * one on every unbound turn — and saying that out loud is the entire point of
 * the 410 case, because the person is still sitting in the conversation that
 * would produce it. A 403 can never be fixed by trying again, so it does not
 * offer to.
 *
 * `status` 0 means the request never got an answer at all.
 */
export function bindFailureFor(status: number): BindFailure {
  if (status === 401) {
    return {
      kind: "signed_out",
      title: "Sign in to finish linking",
      message: "You are not signed in to Genosyn in this browser.",
      fix: "Sign in with your own account, then open the link again from the chat. Whoever is signed in here is the Member this chat account gets linked to, so use yours.",
      retryable: false,
    };
  }
  if (status === 403) {
    return {
      kind: "not_a_member",
      title: "Wrong Genosyn account",
      message:
        "You are signed in, but this conversation belongs to a company you are not a Member of.",
      fix: "Sign in with the account that holds that Membership, or ask an admin of that company to invite this one.",
      retryable: false,
    };
  }
  if (status === 404) {
    return {
      kind: "invalid",
      title: "This link is not valid",
      message:
        "Genosyn does not recognise it. Links are single-use, so this one has most likely been used already — or the address was cut short on its way out of the chat.",
      fix: "Copy the whole link from the message, or send the AI Employee anything at all and it will reply with a new one.",
      retryable: false,
    };
  }
  if (status === 409) {
    return {
      kind: "taken",
      title: "Already linked to someone else",
      message: "This chat account is linked to a different Genosyn Member.",
      fix: "If that was an old account of yours, an admin can unlink it at Settings → Integrations. Then message the AI Employee again for a fresh link.",
      retryable: false,
    };
  }
  if (status === 410) {
    return {
      kind: "expired",
      title: "This link has expired",
      message: "A link is only good for a few minutes after the AI Employee sends it.",
      fix: "Message the AI Employee again and it will reply with a fresh link. Nothing else needs redoing.",
      retryable: false,
    };
  }
  if (status === 0) {
    return {
      kind: "unreachable",
      title: "Could not reach Genosyn",
      message: "The request never got an answer, so nothing has been linked yet.",
      fix: "Check your connection and try again. The link keeps working for a few minutes.",
      retryable: true,
    };
  }
  return {
    kind: "unknown",
    title: "Could not finish linking",
    message: `Genosyn answered with an unexpected error (status ${status}).`,
    fix: "Try again. If it keeps failing, ask an admin to check the server logs.",
    retryable: true,
  };
}

/** What `POST /api/chat-surfaces/bind/preview` says the link would do. */
export type BindPreview = {
  identityId: string;
  provider: string;
  externalUserLabel: string | null;
  externalUserId: string;
  companyName: string;
  /** True when this Member already holds the binding and is re-proving it. */
  alreadyMine: boolean;
};

/**
 * The one string the reader is being asked to judge.
 *
 * The platform's display name when there is one, because "Anna Berg" is what
 * somebody can recognise or fail to recognise; the raw platform id otherwise,
 * because an unnamed account still has to be nameable. An all-whitespace label
 * counts as no label — WhatsApp will happily report one, and a confirmation
 * whose subject renders as a blank gap asks nothing.
 */
export function chatAccountLabel(
  preview: Pick<BindPreview, "externalUserLabel" | "externalUserId">,
): string {
  const label = preview.externalUserLabel?.trim();
  return label ? label : preview.externalUserId;
}

/**
 * The platform id, when it is not already what is on screen.
 *
 * A display name is chosen by the account holder and can be set to a
 * colleague's, so the id sits underneath it as the part nobody can borrow.
 * Null when the label *is* the id — printing it twice would suggest two
 * accounts.
 */
export function chatAccountIdHint(
  preview: Pick<BindPreview, "externalUserLabel" | "externalUserId">,
): string | null {
  return chatAccountLabel(preview) === preview.externalUserId ? null : preview.externalUserId;
}

export type BindConfirmCopy = {
  /** Page heading. */
  title: string;
  surface: string;
  /** The external account, named so it can be refused. */
  account: string;
  accountIdHint: string | null;
  /** What clicking confirm hands over. */
  grant: string;
  /** Why to read the handle first. */
  caution: string;
  confirmLabel: string;
  declineLabel: string;
};

/**
 * The question this page exists to ask.
 *
 * Every sentence names the surface and the handle, because the whole defence
 * against a forwarded link is a reader who looks at a line and thinks "that is
 * not me" — and a generic "link your chat account?" gives them nothing to
 * think it about. The grant is written in the direction the risk runs: not
 * "you gain a linked account" but "that account gains your access".
 *
 * `alreadyMine` is lighter because there is no new authority to hand out, only
 * a link being re-proved. It still asks: the token is live, and a person who
 * is looking at somebody else's handle should be told so either way.
 */
export function bindConfirmCopy(preview: BindPreview): BindConfirmCopy {
  const surface = chatSurfaceLabel(preview.provider);
  const account = chatAccountLabel(preview);
  const shared = {
    surface,
    account,
    accountIdHint: chatAccountIdHint(preview),
  };
  if (preview.alreadyMine) {
    return {
      ...shared,
      title: `Re-confirm your ${surface} account`,
      grant: `${account} on ${surface} is already linked to you. Confirming leaves it that way: messages from that account go on being answered with your own access in ${preview.companyName}.`,
      caution: `If that is not your ${surface} handle, close this page instead — confirming would leave your access with whoever holds it.`,
      confirmLabel: `Confirm this ${surface} account`,
      declineLabel: "Cancel",
    };
  }
  return {
    ...shared,
    title: `Link this ${surface} account?`,
    grant: `Confirm and, from then on, every message from ${account} on ${surface} is answered with your Genosyn access: the AI Employee's Soul, Skills, Goals and Policies, and every tool your Membership of ${preview.companyName} reaches.`,
    caution: `Read the handle above before you confirm. If it is not yours — somebody forwarded you this link, or you are signed in as the wrong person — close this page. Opening a link proves nothing about who sent it.`,
    confirmLabel: `Link this ${surface} account`,
    declineLabel: "This is not me",
  };
}

export type BindDeclinedCopy = { title: string; message: string; note: string };

/**
 * The other ending, and it is not a failure. Somebody read a handle they did
 * not recognise and stopped, which is the page working — so it says what did
 * not happen, plainly, and how the person who actually holds that account
 * gets a link of their own.
 */
export function bindDeclinedCopy(preview: BindPreview): BindDeclinedCopy {
  const surface = chatSurfaceLabel(preview.provider);
  const account = chatAccountLabel(preview);
  return {
    title: "Nothing was linked",
    message: `${account} on ${surface} was not linked to your Genosyn account, and the link was not used.`,
    note: `Whoever holds that ${surface} account can get a link of their own by messaging the AI Employee from it, and opening it while signed in as themselves.`,
  };
}

type BoundIdentity = {
  id: string;
  provider: string;
  connectionId: string;
  externalUserLabel: string | null;
  boundAt: string | null;
};

type PageState =
  | { status: "previewing" }
  | { status: "confirm"; preview: BindPreview }
  | { status: "binding"; preview: BindPreview }
  | { status: "linked"; identity: BoundIdentity }
  | { status: "declined"; preview: BindPreview }
  // `preview` is what the retry button retries: with one, the bind failed and
  // the person is still standing behind their answer; without one, the link
  // was never read and there is nothing to re-confirm.
  | { status: "failed"; failure: BindFailure; preview: BindPreview | null };

type PostResult = { ok: true; data: unknown } | { ok: false; status: number };

async function postLink(
  path: string,
  body: { identityId: string; token: string },
): Promise<PostResult> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0 };
  }
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, data: await res.json().catch(() => null) };
}

export default function LinkChat() {
  const { identityId, token } = useParams<{ identityId: string; token: string }>();
  const [state, setState] = React.useState<PageState>({ status: "previewing" });
  // React runs effects twice in development. The preview spends nothing, so a
  // second one would be harmless — but it would also race the first and could
  // swap the panel out from under a click, so it is keyed by the URL rather
  // than by the mount.
  const previewed = React.useRef<string | null>(null);

  const runPreview = React.useCallback(async () => {
    if (!identityId || !token) {
      setState({ status: "failed", failure: bindFailureFor(404), preview: null });
      return;
    }
    setState({ status: "previewing" });
    const res = await postLink("/api/chat-surfaces/bind/preview", { identityId, token });
    if (!res.ok) {
      setState({ status: "failed", failure: bindFailureFor(res.status), preview: null });
      return;
    }
    const preview = (res.data as { preview?: BindPreview } | null)?.preview;
    // A 200 with no preview leaves nothing to ask about, and a confirmation
    // with a hole where the handle goes is not a confirmation — it is a button
    // people press. Better to fail.
    if (!preview) {
      setState({ status: "failed", failure: bindFailureFor(500), preview: null });
      return;
    }
    setState({ status: "confirm", preview });
  }, [identityId, token]);

  const confirmBind = React.useCallback(
    async (preview: BindPreview) => {
      if (!identityId || !token) {
        setState({ status: "failed", failure: bindFailureFor(404), preview: null });
        return;
      }
      setState({ status: "binding", preview });
      const res = await postLink("/api/chat-surfaces/bind", { identityId, token });
      if (!res.ok) {
        setState({ status: "failed", failure: bindFailureFor(res.status), preview });
        return;
      }
      const identity = (res.data as { identity?: BoundIdentity } | null)?.identity;
      if (!identity) {
        setState({ status: "failed", failure: bindFailureFor(500), preview });
        return;
      }
      setState({ status: "linked", identity });
    },
    [identityId, token],
  );

  React.useEffect(() => {
    const key = `${identityId ?? ""}/${token ?? ""}`;
    if (previewed.current === key) return;
    previewed.current = key;
    void runPreview();
  }, [runPreview, identityId, token]);

  if (state.status === "previewing") {
    return (
      <AuthShell title="Linking your chat account">
        <div className="flex items-center justify-center gap-3 py-4 text-sm text-slate-500 dark:text-slate-400">
          <Spinner size={18} />
          <span>Checking your link…</span>
        </div>
      </AuthShell>
    );
  }

  if (state.status === "confirm" || state.status === "binding") {
    const { preview } = state;
    return (
      <ConfirmPanel
        preview={preview}
        busy={state.status === "binding"}
        onConfirm={() => void confirmBind(preview)}
        onDecline={() => setState({ status: "declined", preview })}
      />
    );
  }

  if (state.status === "linked") {
    return <LinkedPanel identity={state.identity} />;
  }

  if (state.status === "declined") {
    return <DeclinedPanel preview={state.preview} />;
  }

  const { preview } = state;
  const retry = () => {
    if (preview) {
      void confirmBind(preview);
      return;
    }
    void runPreview();
  };
  return <FailurePanel failure={state.failure} onRetry={retry} />;
}

function ConfirmPanel({
  preview,
  busy,
  onConfirm,
  onDecline,
}: {
  preview: BindPreview;
  busy: boolean;
  onConfirm: () => void;
  onDecline: () => void;
}) {
  const copy = bindConfirmCopy(preview);
  return (
    <AuthShell title={copy.title}>
      <div className="flex flex-col gap-5 text-sm leading-6 text-slate-600 dark:text-slate-300">
        <div className="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/60">
          <UserRound size={16} className="mt-0.5 shrink-0 text-slate-500 dark:text-slate-400" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
              {copy.surface} account
            </p>
            <p className="mt-1 break-words text-sm font-medium text-slate-900 dark:text-slate-100">
              {copy.account}
            </p>
            {copy.accountIdHint && (
              <p className="mt-0.5 break-all font-mono text-xs text-slate-500 dark:text-slate-400">
                {copy.accountIdHint}
              </p>
            )}
          </div>
        </div>
        <p>{copy.grant}</p>
        <p className="flex items-start gap-2 text-xs text-slate-500 dark:text-slate-400">
          <ShieldAlert size={12} className="mt-0.5 shrink-0" />
          <span>{copy.caution}</span>
        </p>
        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          <Button size="sm" variant="secondary" onClick={onDecline} disabled={busy}>
            {copy.declineLabel}
          </Button>
          <Button size="sm" onClick={onConfirm} disabled={busy}>
            {busy ? <Spinner size={12} /> : <Link2 size={12} />}
            {copy.confirmLabel}
          </Button>
        </div>
      </div>
    </AuthShell>
  );
}

function DeclinedPanel({ preview }: { preview: BindPreview }) {
  const copy = bindDeclinedCopy(preview);
  return (
    <AuthShell title={copy.title}>
      <div className="flex flex-col gap-5 text-sm leading-6 text-slate-600 dark:text-slate-300">
        <div className="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/60">
          <ShieldCheck size={16} className="mt-0.5 shrink-0 text-slate-500 dark:text-slate-400" />
          <p className="min-w-0 flex-1">{copy.message}</p>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">{copy.note}</p>
        <div className="flex justify-end pt-1">
          <Link to="/" className={buttonClassName({ variant: "secondary", size: "sm" })}>
            Open Genosyn
          </Link>
        </div>
      </div>
    </AuthShell>
  );
}

function LinkedPanel({ identity }: { identity: BoundIdentity }) {
  const surface = chatSurfaceLabel(identity.provider);
  return (
    <AuthShell title={`${surface} account linked`}>
      <div className="flex flex-col gap-5 text-sm leading-6 text-slate-600 dark:text-slate-300">
        <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
          <p className="min-w-0 flex-1 text-sm">
            {identity.externalUserLabel ? (
              <>
                <span className="font-medium">{identity.externalUserLabel}</span> on {surface} is
                now linked to your Genosyn Member account.
              </>
            ) : (
              <>This {surface} account is now linked to your Genosyn Member account.</>
            )}
          </p>
        </div>
        <p>
          Until now the AI Employee answered you as a stranger — no Soul, no Skills, no Goals, no
          Policies, and none of the company&apos;s tools. From here it answers you with your own
          access, in {surface} and in Genosyn alike.
        </p>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          You can go back to the conversation and carry on; there is nothing else to set up. An
          admin can cut this link at any time at Settings → Integrations, and it ends by itself if
          you leave the company.
        </p>
        <div className="flex justify-end pt-1">
          <Link to="/" className={buttonClassName({ size: "sm" })}>
            Open Genosyn
          </Link>
        </div>
      </div>
    </AuthShell>
  );
}

function FailurePanel({ failure, onRetry }: { failure: BindFailure; onRetry: () => void }) {
  return (
    <AuthShell title={failure.title}>
      <div className="flex flex-col gap-4 text-sm leading-6 text-slate-600 dark:text-slate-300">
        {failure.kind === "signed_out" ? (
          // Not a failure of the link — the link is fine, the browser is
          // anonymous. A red banner here would read as "this is broken".
          <div className="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/60">
            <LogIn size={16} className="mt-0.5 shrink-0 text-slate-500 dark:text-slate-400" />
            <p className="min-w-0 flex-1">{failure.message}</p>
          </div>
        ) : (
          <FormError message={failure.message} />
        )}
        <p>{failure.fix}</p>
        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          {failure.kind === "signed_out" ? (
            // A whole-document load rather than a client-side <Link>: this
            // page is registered in both route trees, and a session that died
            // between load and POST leaves the app still rendering the
            // signed-in tree, where /login is not a route and would bounce to
            // a company home that answers 401 to everything. Reloading re-asks
            // /api/auth/me and lands on the real login screen either way.
            <Button size="sm" onClick={() => window.location.assign("/login")}>
              <LogIn size={12} /> Sign in
            </Button>
          ) : (
            // Deliberately not "sign in as someone else" on a 403: the person
            // is already signed in, and /login would bounce them straight back
            // out to their own company home without explaining why.
            <Link to="/" className={buttonClassName({ variant: "secondary", size: "sm" })}>
              Open Genosyn
            </Link>
          )}
          {failure.retryable && (
            <Button size="sm" variant="secondary" onClick={onRetry}>
              <RefreshCw size={12} /> Try again
            </Button>
          )}
        </div>
        <p className="flex items-start gap-2 border-t border-slate-100 pt-4 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
          <MessageSquare size={12} className="mt-0.5 shrink-0" />
          <span>
            Nothing has changed for now: the AI Employee keeps answering you as a stranger, without
            the company&apos;s Skills or tools, until a link goes through.
          </span>
        </p>
      </div>
    </AuthShell>
  );
}
