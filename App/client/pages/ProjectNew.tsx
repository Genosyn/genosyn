import React from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, Company, Project } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { TopBar } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";
import { useTasks } from "./TasksLayout";

export default function ProjectNew({ company }: { company: Company }) {
  const [name, setName] = React.useState("");
  const [key, setKey] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const navigate = useNavigate();
  const { companySlug } = useParams();
  const { toast } = useToast();
  const { reload } = useTasks();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const p = await api.post<Project>(`/api/companies/${company.id}/projects`, {
        name,
        description: description || undefined,
        key: key || undefined,
      });
      await reload();
      navigate(`/c/${companySlug}/tasks/p/${p.slug}`);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl p-8">
      <TopBar title="New project" />
      <Card>
        <CardHeader>
          <p className="text-sm text-slate-500">
            A project is a container for todos. Pick a short key (e.g.{" "}
            <span className="font-mono text-slate-700">ENG</span>) —
            it&apos;ll prefix todo numbers like{" "}
            <span className="font-mono text-slate-700">ENG-42</span>.
          </p>
        </CardHeader>
        <CardBody>
          <form className="flex flex-col gap-4" onSubmit={submit}>
            <Input
              label="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Engineering"
              required
            />
            <Input
              label="Key (optional)"
              value={key}
              onChange={(e) => setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
              placeholder="ENG"
              maxLength={6}
            />
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">
                Description (optional)
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What's the goal of this project?"
                rows={3}
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
              />
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={loading || !name}>
                {loading ? "Creating…" : "Create project"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => navigate(`/c/${companySlug}/tasks`)}
              >
                Cancel
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
