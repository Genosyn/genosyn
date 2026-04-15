import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { AuthShell } from "./Login";
import { useToast } from "../components/ui/Toast";

export default function Signup({ onAuth }: { onAuth: () => Promise<void> }) {
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const navigate = useNavigate();
  const { toast } = useToast();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post("/api/auth/signup", { email, password, name });
      // See Login.tsx: refresh App's auth state before navigating so the
      // route tree flips from "anon" to "ready".
      await onAuth();
      navigate("/");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }
  return (
    <AuthShell title="Create your account">
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
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
          minLength={8}
          required
        />
        <Button type="submit" disabled={loading}>
          {loading ? "Creating…" : "Create account"}
        </Button>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Already have an account?{" "}
          <Link to="/login" className="text-indigo-600 hover:underline dark:text-indigo-400">
            Sign in
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}
