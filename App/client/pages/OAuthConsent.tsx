import React from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Building2, Cable, ExternalLink, ShieldAlert, ShieldX, UserRound } from "lucide-react";

import { AuthShell } from "./Login";
import { api, type AppConsentRequest } from "../lib/api";
import {
  appHost,
  authorizationPageError,
  consentGrants,
  consentLoginPath,
  consentRequestFromSearch,
  safeAppRedirect,
} from "../lib/appConsent";
import { errorMessage } from "../lib/errors";
import { Button, buttonClassName } from "../components/ui/Button";
import { FormError } from "../components/ui/FormError";
import { Spinner } from "../components/ui/Spinner";
import { clsx } from "../components/ui/clsx";

/**
 * Where an MCP client's sign-in lands: claude.ai, ChatGPT or any app asking
 * to use the Genosyn MCP server as the signed-in Member (`/oauth/consent`).
 *
 * The page names the app and — because an app's name is whatever it chose to
 * register — the address it will send the person back to, says what approving
 * gives it, and waits. Nothing is granted until the Member presses Allow; the
 * company is fixed when the app asked for one company's server, and chosen
 * here otherwise, among those the Member may connect apps to. Either answer
 * sends the browser back to the app.
 */
export default function OAuthConsent() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const pageError = params.get("error");
  const request = consentRequestFromSearch(location.search);
  if (pageError || !request) return <StoppedPanel code={pageError} />;
  return <ConsentFlow request={request} />;
}

/** Signed out: errors are shown as they are; a request waits for sign-in. */
export function OAuthConsentSignIn() {
  const location = useLocation();
  const pageError = new URLSearchParams(location.search).get("error");
  const request = consentRequestFromSearch(location.search);
  if (pageError || !request) return <StoppedPanel code={pageError} />;
  return <Navigate to={consentLoginPath(request)} replace />;
}

type State =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; details: AppConsentRequest }
  | { status: "leaving"; to: string; host: string };

function ConsentFlow({ request }: { request: string }) {
  const [state, setState] = React.useState<State>({ status: "loading" });

  React.useEffect(() => {
    let cancelled = false;
    api
      .get<AppConsentRequest>(`/api/oauth/consent?request=${encodeURIComponent(request)}`)
      .then((details) => {
        if (!cancelled) setState({ status: "ready", details });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: "failed", message: errorMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [request]);

  if (state.status === "loading") {
    return (
      <AuthShell title="Connect an app">
        <div className="flex items-center justify-center gap-3 py-4 text-sm text-slate-500 dark:text-slate-400">
          <Spinner size={18} />
          <span>Checking the request…</span>
        </div>
      </AuthShell>
    );
  }
  if (state.status === "failed") {
    return (
      <AuthShell title="This request can't be approved">
        <div className="flex flex-col gap-4 text-sm leading-6 text-slate-600 dark:text-slate-300">
          <FormError message={state.message} />
          <div className="flex justify-end">
            <a href="/" className={buttonClassName({ variant: "secondary", size: "sm" })}>
              Open Genosyn
            </a>
          </div>
        </div>
      </AuthShell>
    );
  }
  if (state.status === "leaving") {
    return (
      <AuthShell title={`Returning you to ${state.host}`}>
        <div className="flex items-center justify-center gap-3 py-4 text-sm text-slate-500 dark:text-slate-400">
          <Spinner size={18} />
          <a href={state.to} className="underline underline-offset-2">
            Continue to {state.host}
          </a>
        </div>
      </AuthShell>
    );
  }
  return (
    <ConsentPanel
      request={request}
      details={state.details}
      onLeave={(to) =>
        setState({ status: "leaving", to, host: appHost(state.details.app.redirectOrigin) })
      }
    />
  );
}

function ConsentPanel({
  request,
  details,
  onLeave,
}: {
  request: string;
  details: AppConsentRequest;
  onLeave: (to: string) => void;
}) {
  const fixed = details.requestedCompanyId !== null;
  const firstAllowed = details.companies.find((company) => company.canConnect);
  const [companyId, setCompanyId] = React.useState<string | null>(
    (firstAllowed ?? details.companies[0])?.id ?? null,
  );
  const [busy, setBusy] = React.useState<"allow" | "deny" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const company = details.companies.find((candidate) => candidate.id === companyId) ?? null;
  const host = appHost(details.app.redirectOrigin);

  async function answer(decision: "allow" | "deny") {
    setError(null);
    setBusy(decision);
    try {
      const result = await api.post<{ redirectTo: string }>("/api/oauth/consent", {
        request,
        decision,
        ...(decision === "allow" && !fixed && companyId ? { companyId } : {}),
      });
      const to = safeAppRedirect(result.redirectTo);
      if (!to)
        throw new Error("The app's return address is not a web address, so Genosyn stopped here.");
      onLeave(to);
      window.location.assign(to);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(null);
    }
  }

  return (
    <AuthShell
      title={`Connect ${details.app.name} to Genosyn`}
      subtitle={`${details.app.name} is asking to use Genosyn as you.`}
    >
      <div className="flex flex-col gap-5 text-sm leading-6 text-slate-600 dark:text-slate-300">
        <div className="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/60">
          <Cable size={16} className="mt-0.5 shrink-0 text-slate-500 dark:text-slate-400" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
              App
            </p>
            <p className="mt-1 break-words font-medium text-slate-900 dark:text-slate-100">
              {details.app.name}
            </p>
            <p className="mt-0.5 break-all text-xs text-slate-500 dark:text-slate-400">
              Returns you to{" "}
              <span className="font-medium text-slate-700 dark:text-slate-200">{host}</span>
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
          <UserRound size={16} className="mt-0.5 shrink-0 text-slate-500 dark:text-slate-400" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
              As
            </p>
            <p className="mt-1 break-words font-medium text-slate-900 dark:text-slate-100">
              {details.member.name}
            </p>
            <p className="break-all text-xs text-slate-500 dark:text-slate-400">
              {details.member.email} ·{" "}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-indigo-600"
                onClick={async () => {
                  await api.post("/api/auth/logout").catch(() => undefined);
                  window.location.assign(consentLoginPath(request));
                }}
              >
                Use another account
              </button>
            </p>
          </div>
        </div>

        <CompanyChoice
          details={details}
          fixed={fixed}
          value={companyId}
          onChange={(id) => {
            setCompanyId(id);
            setError(null);
          }}
        />

        {company?.canConnect && (
          <ul className="flex list-disc flex-col gap-1.5 pl-5">
            {consentGrants(company, details.app.name).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}

        <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-2.5 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          <ShieldAlert size={14} className="mt-0.5 shrink-0" />
          <span>
            Only allow this if you started connecting {details.app.name} yourself, from {host}. An
            app&apos;s name is whatever it chose to call itself.
          </span>
        </p>

        <FormError message={error} />

        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void answer("deny")}
            loading={busy === "deny"}
            disabled={busy !== null}
          >
            Deny
          </Button>
          <Button
            size="sm"
            onClick={() => void answer("allow")}
            loading={busy === "allow"}
            disabled={busy !== null || !company?.canConnect}
          >
            Allow
          </Button>
        </div>
      </div>
    </AuthShell>
  );
}

function CompanyChoice({
  details,
  fixed,
  value,
  onChange,
}: {
  details: AppConsentRequest;
  fixed: boolean;
  value: string | null;
  onChange: (id: string) => void;
}) {
  if (details.companies.length === 0) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-rose-800 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-200">
        <ShieldX size={16} className="mt-0.5 shrink-0" />
        <p className="min-w-0 flex-1">
          {fixed
            ? "This app asked for a company you are not a member of. Use the account that is, or deny the request."
            : "You are not a member of any company yet, so there is nothing to connect the app to."}
        </p>
      </div>
    );
  }
  if (fixed || details.companies.length === 1) {
    const company = details.companies[0];
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-start gap-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
          <Building2 size={16} className="mt-0.5 shrink-0 text-slate-500 dark:text-slate-400" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Company
            </p>
            <p className="mt-1 break-words font-medium text-slate-900 dark:text-slate-100">
              {company.name}
            </p>
          </div>
        </div>
        {!company.canConnect && company.reason && <FormError message={company.reason} />}
      </div>
    );
  }
  const selected = details.companies.find((company) => company.id === value);
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-xs mb-1 font-medium text-slate-500 dark:text-slate-400">
        Company
      </legend>
      {details.companies.map((company) => (
        <label
          key={company.id}
          className={clsx(
            "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2",
            company.id === value
              ? "border-indigo-500 bg-indigo-50/60 dark:border-indigo-400 dark:bg-indigo-950/30"
              : "border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800/60",
          )}
        >
          <input
            type="radio"
            name="company"
            value={company.id}
            checked={company.id === value}
            onChange={() => onChange(company.id)}
            className="h-4 w-4 accent-indigo-600"
          />
          <span className="min-w-0 flex-1 break-words font-medium text-slate-900 dark:text-slate-100">
            {company.name}
          </span>
          {!company.canConnect && (
            <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">Not allowed</span>
          )}
        </label>
      ))}
      {selected && !selected.canConnect && selected.reason && (
        <FormError message={selected.reason} />
      )}
    </fieldset>
  );
}

function StoppedPanel({ code }: { code: string | null }) {
  const copy = authorizationPageError(code);
  return (
    <AuthShell title={copy.title}>
      <div className="flex flex-col gap-5 text-sm leading-6 text-slate-600 dark:text-slate-300">
        <div className="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/60">
          <ShieldX size={16} className="mt-0.5 shrink-0 text-slate-500 dark:text-slate-400" />
          <p className="min-w-0 flex-1">{copy.message}</p>
        </div>
        <div className="flex justify-end">
          <a href="/" className={buttonClassName({ variant: "secondary", size: "sm" })}>
            <ExternalLink size={12} /> Open Genosyn
          </a>
        </div>
      </div>
    </AuthShell>
  );
}
