import { useEffect } from "react";
import { usePathname } from "@/lib/router";
import { DocsShell } from "@/docs/DocsShell";
import { findPageMeta } from "@/docs/nav";
import { Introduction } from "@/docs/pages/Introduction";
import { Install } from "@/docs/pages/Install";
import { MobileApp } from "@/docs/pages/MobileApp";
import { Employees } from "@/docs/pages/Employees";
import { Soul } from "@/docs/pages/Soul";
import { Skills } from "@/docs/pages/Skills";
import { Routines } from "@/docs/pages/Routines";
import { Models } from "@/docs/pages/Models";
import { OpenSourceModels } from "@/docs/pages/OpenSourceModels";
import { Integrations } from "@/docs/pages/Integrations";
import { Explore } from "@/docs/pages/Explore";
import { Tasks } from "@/docs/pages/Tasks";
import { Customers } from "@/docs/pages/Customers";
import { Finance } from "@/docs/pages/Finance";
import { SelfHosting } from "@/docs/pages/SelfHosting";
import { Cli } from "@/docs/pages/Cli";
import { Kubernetes } from "@/docs/pages/Kubernetes";
import { Vocabulary } from "@/docs/pages/Vocabulary";
import { NotFound } from "@/docs/pages/NotFound";

const PAGES: Record<string, () => JSX.Element> = {
  "/docs": Introduction,
  "/docs/install": Install,
  "/docs/mobile": MobileApp,
  "/docs/employees": Employees,
  "/docs/soul": Soul,
  "/docs/skills": Skills,
  "/docs/routines": Routines,
  "/docs/models": Models,
  "/docs/open-source-models": OpenSourceModels,
  "/docs/integrations": Integrations,
  "/docs/explore": Explore,
  "/docs/tasks": Tasks,
  "/docs/customers": Customers,
  "/docs/finance": Finance,
  "/docs/self-hosting": SelfHosting,
  "/docs/cli": Cli,
  "/docs/kubernetes": Kubernetes,
  "/docs/vocabulary": Vocabulary,
};

function normalizePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "" ? "/docs" : trimmed;
}

export function DocsApp() {
  const path = normalizePath(usePathname());
  const Page = PAGES[path] ?? NotFound;
  const meta = findPageMeta(path);

  useEffect(() => {
    const suffix = meta ? `${meta.title} · Genosyn Docs` : "Genosyn Docs";
    document.title = suffix;
  }, [meta]);

  return (
    <DocsShell pathname={path}>
      <Page />
    </DocsShell>
  );
}
