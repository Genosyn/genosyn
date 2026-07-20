import React from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { KeyRound, ShieldCheck } from "lucide-react";
import { startAuthentication } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import {
  api,
  type LoginResponse,
  type SsoPublicStatus,
  type TwoFactorLoginMethods,
  type TwoFactorLoginStatus,
} from "../lib/api";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { FormError } from "../components/ui/FormError";
import { Logo } from "../components/Logo";

export default function Login({ onAuth }: { onAuth: () => Promise<void> }) {
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sso, setSso] = React.useState<SsoPublicStatus | null>(null);
  const [twoFactor, setTwoFactor] = React.useState<TwoFactorLoginMethods | null>(null);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // A failed SSO round-trip lands back here as /login?ssoError=… — surface it
  // in the same slot a bad password would use.
  const ssoError = searchParams.get("ssoError");

  React.useEffect(() => {
    api
      .get<SsoPublicStatus>("/api/auth/sso/status")
      .then(setSso)
      .catch(() => setSso({ enabled: false, buttonLabel: null }));
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

  return (
    <AuthShell title="Welcome back">
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <FormError message={error ?? ssoError} />
        <Input
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <Input
          label="Password"
          type="password"
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

export function AuthShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <Logo className="h-8 w-auto text-slate-900 dark:text-slate-100" />
          <h1 className="mt-5 text-xl font-semibold text-slate-900 dark:text-slate-100">{title}</h1>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:bg-slate-900 dark:border-slate-700">
          {children}
        </div>
      </div>
    </div>
  );
}
