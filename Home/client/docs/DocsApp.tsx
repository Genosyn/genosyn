import { usePathname } from "@/lib/router";
import { DocsShell } from "@/docs/DocsShell";
import { Introduction } from "@/docs/pages/Introduction";
import { Install } from "@/docs/pages/Install";
import { MobileApp } from "@/docs/pages/MobileApp";
import { Security } from "@/docs/pages/Security";
import { Employees } from "@/docs/pages/Employees";
import { Soul } from "@/docs/pages/Soul";
import { Skills } from "@/docs/pages/Skills";
import { Routines } from "@/docs/pages/Routines";
import { Tags } from "@/docs/pages/Tags";
import { ToolDiscovery } from "@/docs/pages/ToolDiscovery";
import { Models } from "@/docs/pages/Models";
import { OpenSourceModels } from "@/docs/pages/OpenSourceModels";
import { Integrations } from "@/docs/pages/Integrations";
import { Browser } from "@/docs/pages/Browser";
import { CodeRepositories } from "@/docs/pages/Code";
import { Explore } from "@/docs/pages/Explore";
import { Marketing } from "@/docs/pages/Marketing";
import { WorkspaceChat } from "@/docs/pages/WorkspaceChat";
import { Email } from "@/docs/pages/Email";
import { Tasks } from "@/docs/pages/Tasks";
import { Pipelines } from "@/docs/pages/Pipelines";
import { Bases } from "@/docs/pages/Bases";
import { Customers } from "@/docs/pages/Customers";
import { Finance } from "@/docs/pages/Finance";
import { SelfHosting } from "@/docs/pages/SelfHosting";
import { Cli } from "@/docs/pages/Cli";
import { Kubernetes } from "@/docs/pages/Kubernetes";
import { SaasHosting } from "@/docs/pages/SaasHosting";
import { Vocabulary } from "@/docs/pages/Vocabulary";
import { NotFound } from "@/docs/pages/NotFound";

const PAGES: Record<string, () => JSX.Element> = {
  "/docs": Introduction,
  "/docs/install": Install,
  "/docs/mobile": MobileApp,
  "/docs/security": Security,
  "/docs/employees": Employees,
  "/docs/soul": Soul,
  "/docs/skills": Skills,
  "/docs/routines": Routines,
  "/docs/tags": Tags,
  "/docs/tool-discovery": ToolDiscovery,
  "/docs/models": Models,
  "/docs/open-source-models": OpenSourceModels,
  "/docs/integrations": Integrations,
  "/docs/browser": Browser,
  "/docs/code": CodeRepositories,
  "/docs/explore": Explore,
  "/docs/marketing": Marketing,
  "/docs/workspace-chat": WorkspaceChat,
  "/docs/email": Email,
  "/docs/tasks": Tasks,
  "/docs/pipelines": Pipelines,
  "/docs/bases": Bases,
  "/docs/customers": Customers,
  "/docs/finance": Finance,
  "/docs/self-hosting": SelfHosting,
  "/docs/cli": Cli,
  "/docs/kubernetes": Kubernetes,
  "/docs/saas-hosting": SaasHosting,
  "/docs/vocabulary": Vocabulary,
};

function normalizePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "" ? "/docs" : trimmed;
}

// Head metadata (title, description, canonical, JSON-LD) is handled centrally
// in App.tsx via lib/siteMeta.ts, which derives docs entries from nav.ts.
export function DocsApp() {
  const path = normalizePath(usePathname());
  const Page = PAGES[path] ?? NotFound;

  return (
    <DocsShell pathname={path}>
      <Page />
    </DocsShell>
  );
}
