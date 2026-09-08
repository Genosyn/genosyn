import React from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Lock } from "lucide-react";
import { api, SignupStatus } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { FormError } from "../components/ui/FormError";
import { Spinner } from "../components/ui/Spinner";
import { AuthShell } from "./Login";
import {
  invitationAuthPath,
  invitationPath,
  invitationTokenFromSearch,
} from "../lib/invitationNavigation";

export default function Signup({ onAuth }: { onAuth: () => Promise<void> }) {
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // null → still checking whether registration is open on this instance.
  const [open, setOpen] = React.useState<boolean | null>(null);
  const [setupRequired, setSetupRequired] = React.useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const invitationToken = invitationTokenFromSearch(location.search);

  React.useEffect(() => {
    let alive = true;
    api
      .get<SignupStatus>("/api/auth/signup-status")
      .then((s) => {
        if (!alive) return;
        setOpen(s.open);
        setSetupRequired(s.setupRequired ?? false);
      })
      // If the probe fails, fall back to showing the form — the server still
      // enforces the policy, so a false "open" just yields a 403 on submit.
      .catch(() => alive && setOpen(true));
    return () => {
      alive = false;
    };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api.post("/api/auth/signup", {
        email,
        password,
        name,
        ...(invitationToken ? { invitationToken } : {}),
      });
      // See Login.tsx: refresh App's auth state before navigating so the
      // route tree flips from "anon" to "ready".
      await onAuth();
      navigate(invitationPath(invitationToken));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  if (open === null) {
    return (
      <AuthShell title="Create your account">
        <div className="flex justify-center py-4">
          <Spinner />
        </div>
      </AuthShell>
    );
  }

  if (setupRequired) {
    return (
      <AuthShell title="Initial setup required">
        <p className="text-sm text-slate-600 dark:text-slate-300">
          The operator must configure this instance&apos;s public HTTPS URL before accounts can be
          created. Ask the operator to complete initial setup, then reload this page.
        </p>
      </AuthShell>
    );
  }

  if (!open && !invitationToken) {
    return (
      <AuthShell title="Sign-ups are closed">
        <div className="flex flex-col items-center gap-4 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400">
            <Lock size={22} />
          </span>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            This Genosyn instance isn&apos;t accepting new sign-ups. Ask an administrator for an
            invitation, or sign in if you already have an account.
          </p>
          <Link
            to="/login"
            className="text-sm text-indigo-600 hover:underline dark:text-indigo-400"
          >
            Go to sign in
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Create your account"
      subtitle="Genosyn is an open-source platform for running a company with AI Employees. They have a written Soul, a set of Skills, and Routines on a schedule — they wake up, do the job, and report what they shipped."
    >
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <FormError message={error} />
        {invitationToken ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Use the email address this invitation was sent to. Verify your email, then return to the
            invitation to join the company.
          </p>
        ) : null}
        <Input
          label="Name"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
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
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={12}
          required
        />
        <Button type="submit" disabled={loading}>
          {loading ? "Creating…" : "Create account"}
        </Button>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Already have an account?{" "}
          <Link
            to={invitationAuthPath("login", invitationToken)}
            className="text-indigo-600 hover:underline dark:text-indigo-400"
          >
            Sign in
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}
