import React from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { KeyRound } from "lucide-react";
import { api, SsoPublicStatus } from "../lib/api";
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

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api.post("/api/auth/login", { email, password });
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

export function AuthShell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <Logo className="h-8 w-auto text-slate-900 dark:text-slate-100" />
          <h1 className="mt-5 text-xl font-semibold text-slate-900 dark:text-slate-100">{title}</h1>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:bg-slate-900 dark:border-slate-700">{children}</div>
      </div>
    </div>
  );
}
