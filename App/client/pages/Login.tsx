import React from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Building2, KeyRound, ShieldCheck } from "lucide-react";
import { startAuthentication } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import {
  api,
  type CompanySsoLinkResponse,
  type CompanySsoPublicStatus,
  type LoginResponse,
  type SsoPublicStatus,
  type TwoFactorLoginMethods,
  type TwoFactorLoginStatus,
} from "../lib/api";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { FormError } from "../components/ui/FormError";
import { Logo } from "../components/Logo";
import { clsx } from "../components/ui/clsx";

export default function Login({ onAuth }: { onAuth: () => Promise<void> }) {
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sso, setSso] = React.useState<SsoPublicStatus | null>(null);
  const [twoFactor, setTwoFactor] = React.useState<TwoFactorLoginMethods | null>(null);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Present on the /login/sso/:companySlug route — the company-SSO entry page.
  const { companySlug } = useParams<{ companySlug: string }>();
  // A failed SSO round-trip lands back here as /login?ssoError=… — surface it
  // in the same slot a bad password would use.
  const ssoError = searchParams.get("ssoError");
  // A company IdP asserted an email that already belongs to a Genosyn
  // account — the callback redirected here with a single-use confirmation
  // token, and the person proves that account's password before linking.
  const ssoLinkToken = searchParams.get("ssoLink");

  React.useEffect(() => {
    api
      .get<SsoPublicStatus>("/api/auth/sso/status")
      .then(setSso)
      .catch(() => setSso({ enabled: false, buttonLabel: null, companySso: false }));
  }, []);

  React.useEffect(() => {
    if (searchParams.get("twoFactor") !== "1") return;
    setLoading(true);
    api
      .get<TwoFactorLoginStatus>("/api/auth/login/two-factor")
      .then(async (status) => {
        if (status.requiresTwoFactor) {
          setTwoFactor(status.methods);
          return;
        }
        await onAuth();
        navigate("/");
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [navigate, onAuth, searchParams]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const result = await api.post<LoginResponse>("/api/auth/login", { email, password });
      if (result.requiresTwoFactor) {
        setPassword("");
        setTwoFactor(result.methods);
        return;
      }
      // Refresh App's auth state so the route tree flips from "anon" to
      // "ready" before we navigate — otherwise "/" bounces back to /login.
      await onAuth();
      navigate("/");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  if (twoFactor) {
    return (
      <AuthShell title={"Verify it's you"}>
        <TwoFactorPrompt
          methods={twoFactor}
          onComplete={async () => {
            await onAuth();
            navigate("/");
          }}
          onBack={() => {
            setTwoFactor(null);
            setError(null);
            navigate("/login", { replace: true });
          }}
        />
      </AuthShell>
    );
  }

  if (ssoLinkToken) {
    return (
      <AuthShell title={"Confirm it's you"}>
        <CompanySsoLinkConfirm token={ssoLinkToken} onTwoFactor={setTwoFactor} />
      </AuthShell>
    );
  }

  if (companySlug) {
    return (
      <AuthShell title="Sign in with SSO">
        <CompanySsoEntry companySlug={companySlug} ssoError={ssoError} />
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Welcome back">
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <FormError message={error ?? ssoError} />
        <Input
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <Input
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <Button type="submit" disabled={loading}>
          {loading ? "Signing in…" : "Sign in"}
        </Button>
        {sso?.enabled && (
          <>
            <div className="flex items-center gap-3 text-xs text-slate-400 dark:text-slate-500">
              <span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
              or
              <span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
            </div>
            {/* A real navigation, not a fetch — the server 302s the browser
                off to the identity provider. */}
            <a
              href="/api/auth/sso/start"
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-sm font-medium text-slate-900 transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
            >
              <KeyRound size={14} />
              {sso.buttonLabel ?? "Continue with SSO"}
            </a>
          </>
        )}
        {sso?.companySso && <CompanySsoQuietEntry />}
        <div className="flex items-center justify-between text-sm text-slate-500 dark:text-slate-400">
          <Link to="/signup" className="hover:text-indigo-600">
            Create account
          </Link>
          <Link to="/forgot" className="hover:text-indigo-600">
            Forgot password
          </Link>
        </div>
      </form>
    </AuthShell>
  );
}

function companySsoStartUrl(slug: string): string {
  return `/api/auth/sso/company/${encodeURIComponent(slug)}/start`;
}

/**
 * The quiet "Sign in with your company's SSO" affordance under the password
 * form on a Genosyn Cloud install. Clicking reveals a workspace-slug input;
 * Continue is a real navigation — the server 302s off to the company's IdP.
 */
function CompanySsoQuietEntry() {
  const [open, setOpen] = React.useState(false);
  const [slug, setSlug] = React.useState("");

  const go = () => {
    const trimmed = slug.trim();
    if (!trimmed) return;
    window.location.assign(companySsoStartUrl(trimmed));
  };

  if (!open) {
    return (
      <button
        type="button"
        className="self-center text-sm text-slate-500 hover:text-indigo-600 dark:text-slate-400"
        onClick={() => setOpen(true)}
      >
        Sign in with your company&apos;s SSO
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
      <Input
        label="Company workspace"
        placeholder="your-company"
        autoComplete="off"
        value={slug}
        onChange={(e) => setSlug(e.target.value)}
        onKeyDown={(e) => {
          // Enter here means "continue with SSO", not "submit the password form".
          if (e.key === "Enter") {
            e.preventDefault();
            go();
          }
        }}
        autoFocus
      />
      <p className="text-xs text-slate-400 dark:text-slate-500">
        The workspace name from your company&apos;s Genosyn URL, e.g.{" "}
        <code className="rounded bg-slate-100 px-1 py-0.5 font-mono dark:bg-slate-800">
          /c/your-company
        </code>
        .
      </p>
      <Button type="button" variant="secondary" onClick={go} disabled={!slug.trim()}>
        <Building2 size={14} /> Continue
      </Button>
    </div>
  );
}

/**
 * The /login/sso/:companySlug entry page — probes the company's public SSO
 * status and offers "Continue with …" directly, so companies can hand
 * members one bookmarkable link.
 */
function CompanySsoEntry({
  companySlug,
  ssoError,
}: {
  companySlug: string;
  ssoError: string | null;
}) {
  const [status, setStatus] = React.useState<CompanySsoPublicStatus | null>(null);

  React.useEffect(() => {
    api
      .get<CompanySsoPublicStatus>(
        `/api/auth/sso/company/${encodeURIComponent(companySlug)}/status`,
      )
      .then(setStatus)
      .catch(() => setStatus({ enabled: false, buttonLabel: null }));
  }, [companySlug]);

  return (
    <div className="flex flex-col gap-4">
      <FormError message={ssoError} />
      {status === null ? (
        <p className="text-center text-sm text-slate-500 dark:text-slate-400">Checking…</p>
      ) : status.enabled ? (
        <>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Sign in to the <span className="font-semibold">{companySlug}</span> workspace through
            your company&apos;s identity provider.
          </p>
          {/* A real navigation, not a fetch — the server 302s the browser
              off to the identity provider. */}
          <a
            href={companySsoStartUrl(companySlug)}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-sm font-medium text-slate-900 transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
          >
            <KeyRound size={14} />
            {status.buttonLabel ?? "Continue with SSO"}
          </a>
        </>
      ) : (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          SSO sign-in is not available for this workspace.
        </p>
      )}
      <div className="text-center text-sm">
        <Link to="/login" className="text-slate-500 hover:text-indigo-600 dark:text-slate-400">
          Back to password sign-in
        </Link>
      </div>
    </div>
  );
}

/**
 * Shown when a company IdP asserted an email that already belongs to a
 * Genosyn account. The email is deliberately NOT known client-side — the
 * single-use token carries everything server-side.
 */
function CompanySsoLinkConfirm({
  token,
  onTwoFactor,
}: {
  token: string;
  onTwoFactor: (methods: TwoFactorLoginMethods) => void;
}) {
  const [password, setPassword] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const result = await api.post<CompanySsoLinkResponse>("/api/auth/sso/company/link", {
        token,
        password,
      });
      if ("requiresTwoFactor" in result && result.requiresTwoFactor) {
        setPassword("");
        onTwoFactor(result.methods);
        return;
      }
      // Hard navigation so the whole app boots with the fresh session.
      window.location.assign("/");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      <div className="flex items-start gap-3 rounded-lg bg-slate-50 p-3 dark:bg-slate-800/60">
        <ShieldCheck size={18} className="mt-0.5 shrink-0 text-indigo-600 dark:text-indigo-400" />
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Your company&apos;s SSO matched an existing Genosyn account. Enter that account&apos;s
          password once to link them.
        </p>
      </div>
      <FormError message={error} />
      <Input
        label="Password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        autoFocus
      />
      <Button type="submit" disabled={loading}>
        {loading ? "Linking…" : "Link and sign in"}
      </Button>
      <div className="flex items-center justify-between text-sm text-slate-500 dark:text-slate-400">
        <Link to="/login" className="hover:text-indigo-600">
          Back to sign in
        </Link>
        <Link to="/forgot" className="hover:text-indigo-600">
          Forgot password
        </Link>
      </div>
    </form>
  );
}

function TwoFactorPrompt({
  methods,
  onComplete,
  onBack,
}: {
  methods: TwoFactorLoginMethods;
  onComplete: () => Promise<void>;
  onBack: () => void;
}) {
  const [code, setCode] = React.useState("");
  const [recoveryMode, setRecoveryMode] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api.post(
        recoveryMode ? "/api/auth/login/two-factor/recovery" : "/api/auth/login/two-factor/totp",
        { code },
      );
      await onComplete();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function verifyWebAuthn() {
    setError(null);
    setLoading(true);
    try {
      const optionsJSON = await api.post<PublicKeyCredentialRequestOptionsJSON>(
        "/api/auth/login/two-factor/webauthn/options",
        {},
      );
      const response = await startAuthentication({ optionsJSON });
      await api.post("/api/auth/login/two-factor/webauthn/verify", { response });
      await onComplete();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const showCode = recoveryMode ? methods.recovery : methods.totp;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3 rounded-lg bg-slate-50 p-3 dark:bg-slate-800/60">
        <ShieldCheck size={18} className="mt-0.5 shrink-0 text-indigo-600 dark:text-indigo-400" />
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Complete the second step with one of the methods registered to your account.
        </p>
      </div>
      <FormError message={error} />

      {methods.webAuthn && (
        <Button type="button" onClick={verifyWebAuthn} disabled={loading}>
          <KeyRound size={15} />
          Use passkey or security key
        </Button>
      )}

      {showCode && (
        <form className="flex flex-col gap-3" onSubmit={verifyCode}>
          {methods.webAuthn && (
            <div className="flex items-center gap-3 text-xs text-slate-400 dark:text-slate-500">
              <span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
              or
              <span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
            </div>
          )}
          <Input
            label={recoveryMode ? "Recovery code" : "Authenticator code"}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode={recoveryMode ? "text" : "numeric"}
            autoComplete={recoveryMode ? "off" : "one-time-code"}
            placeholder={recoveryMode ? "XXXXX-XXXXX-XXXXX-XXXXX" : "000000"}
            pattern={recoveryMode ? undefined : "[0-9]{6}"}
            required
            autoFocus
          />
          <Button type="submit" disabled={loading}>
            {loading ? "Verifying…" : "Verify"}
          </Button>
        </form>
      )}

      <div className="flex items-center justify-between text-sm">
        <button
          type="button"
          className="text-slate-500 hover:text-indigo-600 dark:text-slate-400"
          onClick={onBack}
        >
          Back to password
        </button>
        {methods.recovery && methods.totp && (
          <button
            type="button"
            className="text-slate-500 hover:text-indigo-600 dark:text-slate-400"
            onClick={() => {
              setRecoveryMode((value) => !value);
              setCode("");
              setError(null);
            }}
          >
            {recoveryMode ? "Use authenticator app" : "Use a recovery code"}
          </button>
        )}
        {methods.recovery && !methods.totp && !recoveryMode && (
          <button
            type="button"
            className="text-slate-500 hover:text-indigo-600 dark:text-slate-400"
            onClick={() => setRecoveryMode(true)}
          >
            Use a recovery code
          </button>
        )}
      </div>
    </div>
  );
}

export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  /** One line saying what this is, for anyone who has never seen Genosyn. */
  subtitle?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className={clsx("w-full", subtitle ? "max-w-md" : "max-w-sm")}>
        <div className="mb-6 flex flex-col items-center text-center">
          <Logo className="h-8 w-auto text-slate-900 dark:text-slate-100" />
          <h1 className="mt-5 text-xl font-semibold text-slate-900 dark:text-slate-100">{title}</h1>
          {subtitle && (
            <p className="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">{subtitle}</p>
          )}
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:bg-slate-900 dark:border-slate-700">
          {children}
        </div>
      </div>
    </div>
  );
}
