import { forgeFetch, pageSizeParam, type ForgeEndpoint } from "./client.js";

/**
 * The repositories a Connection's token can see, for the allowlist picker.
 *
 * Separate from the `list_repos` tool an AI Employee calls: this one is for a
 * human choosing which repositories to materialize, so it returns exactly the
 * five fields that picker renders and nothing else. Keeping it here rather
 * than inline in the route is what AGENTS.md §7 asks for, and it is also what
 * lets one picker serve both forges.
 *
 * One page is the cap, deliberately. The picker filters within what it was
 * given and the list is ordered by recent activity, so a hundred repositories
 * is the useful window; paging through a five-thousand-repository organisation
 * to render a checkbox list would be slower and no more usable.
 */
export type DiscoverableForgeRepo = {
  owner: string;
  name: string;
  defaultBranch: string;
  description: string;
  private: boolean;
};

const PAGE_SIZE = 100;

export async function listAccessibleForgeRepos(
  endpoint: ForgeEndpoint,
  token: string,
): Promise<DiscoverableForgeRepo[]> {
  const query: Record<string, string | number> = { [pageSizeParam(endpoint.flavor)]: PAGE_SIZE };
  if (endpoint.flavor === "github") {
    query.sort = "updated";
    query.affiliation = "owner,collaborator,organization_member";
  }
  const payload = await forgeFetch(endpoint, token, "/user/repos", { query });
  if (!Array.isArray(payload)) return [];
  return payload
    .map(
      (row) =>
        row as {
          owner?: { login?: unknown };
          name?: unknown;
          default_branch?: unknown;
          description?: unknown;
          private?: unknown;
        },
    )
    .filter((row) => typeof row.owner?.login === "string" && typeof row.name === "string")
    .map((row) => ({
      owner: row.owner!.login as string,
      name: row.name as string,
      defaultBranch: typeof row.default_branch === "string" ? row.default_branch : "main",
      description: typeof row.description === "string" ? row.description : "",
      private: Boolean(row.private),
    }));
}
