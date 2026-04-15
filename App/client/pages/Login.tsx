import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Logo } from "../components/Logo";
import { useToast } from "../components/ui/Toast";

export default function Login({ onAuth }: { onAuth: () => Promise<void> }) {
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const navigate = useNavigate();
  const { toast } = useToast();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post("/api/auth/login", { email, password });
      // Refresh App's auth state so the route tree flips from "anon" to
      // "ready" before we navigate — otherwise "/" bounces back to /login.
      await onAuth();
      navigate("/");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell title="Welcome back">
      <form className="flex flex-col gap-4" onSubmit={submit}>
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
        <div className="flex items-center justify-between text-sm text-slate-500">
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
          <Logo className="h-8 w-auto text-slate-900" />
          <h1 className="mt-5 text-xl font-semibold text-slate-900">{title}</h1>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">{children}</div>
      </div>
    </div>
  );
}
