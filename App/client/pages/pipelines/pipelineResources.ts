import React from "react";
import {
  api,
  type Base,
  type IntegrationConnection,
  type PipelineNodeCatalogEntry,
  type Project,
} from "@/lib/api";
import { workspaceApi, type WorkspaceChannel, type WorkspaceDirectory } from "@/lib/workspace";

export type PipelineIntegrationTool = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: boolean;
  };
};

export type PipelineCatalogResponse = {
  catalog: PipelineNodeCatalogEntry[];
  integrationTools: Record<string, PipelineIntegrationTool[]>;
};

export type PipelineResources = {
  channels: WorkspaceChannel[];
  projects: Project[];
  bases: Base[];
  employees: WorkspaceDirectory["employees"];
  connections: IntegrationConnection[];
  loading: boolean;
};

const EMPTY_RESOURCES: PipelineResources = {
  channels: [],
  projects: [],
  bases: [],
  employees: [],
  connections: [],
  loading: true,
};

/** Load the company objects that Pipeline fields can point at. Individual
 * failures stay isolated so one unavailable surface does not break editing. */
export function usePipelineResources(companyId: string): PipelineResources {
  const [resources, setResources] = React.useState(EMPTY_RESOURCES);

  React.useEffect(() => {
    let cancelled = false;
    setResources(EMPTY_RESOURCES);
    async function load() {
      const [channels, projects, bases, directory, connections] = await Promise.allSettled([
        workspaceApi.listChannels(companyId),
        api.get<Project[]>(`/api/companies/${companyId}/projects`),
        api.get<Base[]>(`/api/companies/${companyId}/bases`),
        workspaceApi.directory(companyId),
        api.get<IntegrationConnection[]>(
          `/api/companies/${companyId}/integrations/connections`,
        ),
      ]);
      if (cancelled) return;
      setResources({
        channels:
          channels.status === "fulfilled"
            ? channels.value.filter((channel) => channel.kind !== "dm" && !channel.archivedAt)
            : [],
        projects: projects.status === "fulfilled" ? projects.value : [],
        bases: bases.status === "fulfilled" ? bases.value : [],
        employees: directory.status === "fulfilled" ? directory.value.employees : [],
        connections: connections.status === "fulfilled" ? connections.value : [],
        loading: false,
      });
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  return resources;
}
