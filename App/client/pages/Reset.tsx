import React from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { FormError } from "../components/ui/FormError";
import { PASSWORD_MIN_LENGTH } from "../../shared/password";
import { AuthShell } from "./Login";

/**
 * Sets a password from a one-time link: a forgotten password's reset link, or
 * the setup link of an account an administrator added (`?setup=1`), which
 * is someone's first password rather than a new one.
 */
export default function Reset() {
  const { token } = useParams();
  const [searchParams] = useSearchParams();
  const setup = searchParams.get("setup") === "1";
  const [password, setPassword] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const navigate = useNavigate();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setError(null);
    setLoading(true);
    try {
      await api.post("/api/auth/reset", { token, password });
      navigate("/login");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }
  return (
    <AuthShell title={setup ? "Choose your password" : "Set a new password"}>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <FormError message={error} />
        <Input
          label={setup ? "Password" : "New password"}
          type="password"
          autoComplete="new-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={PASSWORD_MIN_LENGTH}
          required
        />
        <Button type="submit" loading={loading}>
          {loading ? "Saving…" : setup ? "Set password" : "Reset password"}
        </Button>
      </form>
    </AuthShell>
  );
}
