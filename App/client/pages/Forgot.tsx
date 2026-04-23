import React from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { FormError } from "../components/ui/FormError";
import { AuthShell } from "./Login";

export default function Forgot() {
  const [email, setEmail] = React.useState("");
  const [sent, setSent] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api.post("/api/auth/forgot", { email });
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }
  return (
    <AuthShell title="Reset your password">
      {sent ? (
        <div className="text-sm text-slate-600 dark:text-slate-300">
          If an account exists for that email, a reset link has been sent. When SMTP is not
          configured, check your server console for the reset URL.
        </div>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <FormError message={error} />
          <Input
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <Button type="submit" disabled={loading}>
            {loading ? "Sending…" : "Send reset link"}
          </Button>
          <Link to="/login" className="text-sm text-slate-500 hover:text-indigo-600 dark:text-slate-400">
            Back to sign in
          </Link>
        </form>
      )}
    </AuthShell>
  );
}
