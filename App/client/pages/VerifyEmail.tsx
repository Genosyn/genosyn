import React from "react";
import { Link, useParams } from "react-router-dom";
import { CheckCircle2, Mail } from "lucide-react";
import { api } from "../lib/api";
import { Button } from "../components/ui/Button";
import { FormError } from "../components/ui/FormError";
import { Spinner } from "../components/ui/Spinner";
import { AuthShell } from "./Login";

export function VerifyEmailLink({ onVerified }: { onVerified: () => void }) {
  const { token } = useParams();
  const [status, setStatus] = React.useState<"loading" | "done" | "error">("loading");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!token) {
      setStatus("error");
      setError("The verification link is incomplete.");
      return;
    }
    void api
      .post("/api/auth/verify-email", { token })
      .then(() => {
        setStatus("done");
        onVerified();
      })
      .catch((err: Error) => {
        setError(err.message);
        setStatus("error");
      });
  }, [onVerified, token]);

  return (
    <AuthShell title="Verify your email">
      {status === "loading" ? (
        <div className="flex items-center gap-3 text-sm text-slate-600 dark:text-slate-300">
          <Spinner size={18} /> Checking your link…
        </div>
      ) : status === "done" ? (
        <div className="space-y-4 text-center">
          <CheckCircle2 className="mx-auto text-emerald-600" size={32} />
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Your email is verified. You can continue to Genosyn.
          </p>
          <Link
            className="inline-flex h-10 items-center justify-center rounded-lg bg-indigo-600 px-4 text-sm font-medium text-white transition hover:bg-indigo-700"
            to="/"
          >
            Continue
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          <FormError message={error} />
          <p className="text-sm text-slate-500">Request a fresh link after signing in.</p>
          <Link className="text-sm text-blue-600 hover:underline" to="/login">
            Return to sign in
          </Link>
        </div>
      )}
    </AuthShell>
  );
}

export function VerifyEmailRequired({ email }: { email: string }) {
  const [loading, setLoading] = React.useState(false);
  const [sent, setSent] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function resend() {
    setLoading(true);
    setError(null);
    try {
      await api.post("/api/auth/resend-verification", {});
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell title="Check your inbox">
      <div className="space-y-4 text-center">
        <Mail className="mx-auto text-blue-600" size={32} />
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Verify <span className="font-medium text-slate-900 dark:text-white">{email}</span> before
          creating or joining a company.
        </p>
        <FormError message={error} />
        {sent ? (
          <p className="text-sm text-emerald-700 dark:text-emerald-400">A fresh link was sent.</p>
        ) : null}
        <Button onClick={resend} disabled={loading}>
          {loading ? "Sending…" : "Resend verification email"}
        </Button>
      </div>
    </AuthShell>
  );
}
