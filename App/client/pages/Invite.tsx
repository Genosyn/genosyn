import React from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { AuthShell } from "./Login";
import { Button } from "../components/ui/Button";
import { useToast } from "../components/ui/Toast";

export default function Invite() {
  const { token } = useParams();
  const [loading, setLoading] = React.useState(false);
  const navigate = useNavigate();
  const { toast } = useToast();

  async function accept() {
    if (!token) return;
    setLoading(true);
    try {
      await api.post("/api/invitations/accept", { token });
      toast("Invitation accepted", "success");
      navigate("/");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }
  return (
    <AuthShell title="Accept invitation">
      <div className="flex flex-col gap-4 text-sm text-slate-600 dark:text-slate-300">
        <p>You&apos;ve been invited to join a company on Genosyn.</p>
        <Button onClick={accept} disabled={loading}>
          {loading ? "Accepting…" : "Accept invitation"}
        </Button>
      </div>
    </AuthShell>
  );
}
