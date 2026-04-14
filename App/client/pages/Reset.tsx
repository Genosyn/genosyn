import React from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { AuthShell } from "./Login";
import { useToast } from "../components/ui/Toast";

export default function Reset() {
  const { token } = useParams();
  const [password, setPassword] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const navigate = useNavigate();
  const { toast } = useToast();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setLoading(true);
    try {
      await api.post("/api/auth/reset", { token, password });
      toast("Password reset — please sign in", "success");
      navigate("/login");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }
  return (
    <AuthShell title="Set a new password">
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Input
          label="New password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={8}
          required
        />
        <Button type="submit" disabled={loading}>
          {loading ? "Saving…" : "Reset password"}
        </Button>
      </form>
    </AuthShell>
  );
}
