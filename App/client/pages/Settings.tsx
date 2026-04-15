import React from "react";
import { api, Company, Member } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { Spinner } from "../components/ui/Spinner";
import { Breadcrumbs, TopBar } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";

export default function Settings({
  company,
  onCompaniesChanged,
}: {
  company: Company;
  onCompaniesChanged: () => void;
}) {
  const [name, setName] = React.useState(company.name);
  const [members, setMembers] = React.useState<Member[] | null>(null);
  const [inviteEmail, setInviteEmail] = React.useState("");
  const { toast } = useToast();

  async function reload() {
    const m = await api.get<Member[]>(`/api/companies/${company.id}/members`);
    setMembers(m);
  }

  React.useEffect(() => {
    setName(company.name);
    reload().catch(() => setMembers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.id]);

  return (
    <>
      <div className="mb-3">
        <Breadcrumbs items={[{ label: "Settings" }]} />
      </div>
      <TopBar title="Settings" />
      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold">Company</h2>
          </CardHeader>
          <CardBody>
            <form
              className="flex items-end gap-3"
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await api.patch(`/api/companies/${company.id}`, { name });
                  onCompaniesChanged();
                  toast("Company updated", "success");
                } catch (err) {
                  toast((err as Error).message, "error");
                }
              }}
            >
              <div className="flex-1">
                <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <Button type="submit">Save</Button>
            </form>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold">Members</h2>
          </CardHeader>
          <CardBody className="flex flex-col gap-4">
            {members === null ? (
              <Spinner />
            ) : (
              <ul className="divide-y divide-slate-100">
                {members.map((m) => (
                  <li key={m.userId} className="flex items-center justify-between py-2 text-sm">
                    <div>
                      <div className="font-medium">{m.name ?? "(unknown)"}</div>
                      <div className="text-xs text-slate-500">{m.email}</div>
                    </div>
                    <span className="text-xs uppercase tracking-wide text-slate-400">
                      {m.role}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <form
              className="flex items-end gap-3 border-t border-slate-100 pt-4"
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await api.post(`/api/companies/${company.id}/invitations`, {
                    email: inviteEmail,
                  });
                  setInviteEmail("");
                  toast("Invite sent", "success");
                } catch (err) {
                  toast((err as Error).message, "error");
                }
              }}
            >
              <div className="flex-1">
                <Input
                  label="Invite by email"
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  required
                />
              </div>
              <Button type="submit">Send invite</Button>
            </form>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
