import React from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { AuthShell } from "./Login";
import { useToast } from "../components/ui/Toast";

export default function Forgot() {
  const [email, setEmail] = React.useState("");
  const [sent, setSent] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const { toast } = useToast();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post("/api/auth/forgot", { email });
      setSent(true);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }
  return (
    <AuthShell title="Reset your password">
      {sent ? (
        <div className="text-sm text-slate-600">
          If an account exists for that email, a reset link has been sent. When SMTP is not
          configured, check your server console for the reset URL.
        </div>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={submit}>
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
          <Link to="/login" className="text-sm text-slate-500 hover:text-indigo-600">
            Back to sign in
          </Link>
        </form>
      )}
    </AuthShell>
  );
}
