import React from "react";
import { useNavigate } from "react-router-dom";
import { api, Company } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { FormError } from "../components/ui/FormError";
import { AuthShell } from "./Login";

export default function Onboarding({ onDone }: { onDone: () => void }) {
  const [name, setName] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const navigate = useNavigate();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const c = await api.post<Company>("/api/companies", { name });
      onDone();
      navigate(`/c/${c.slug}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }
  return (
    <AuthShell title="Name your company">
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <FormError message={error} />
        <p className="text-sm text-slate-500 dark:text-slate-400">
          A company is your Genosyn tenant — it holds your team of humans and AI employees.
        </p>
        <Input
          label="Company name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <Button type="submit" disabled={loading}>
          {loading ? "Creating…" : "Create company"}
        </Button>
      </form>
    </AuthShell>
  );
}
