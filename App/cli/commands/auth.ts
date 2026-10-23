import {
  isInsecureRemote,
  isUuid,
  maskKey,
  parseBaseUrl,
  requireApiKey,
  requireBaseUrl,
  requireCompany,
  sameInstall,
  saveConfig,
  type Profile,
} from "../config.js";
import type { Context } from "../context.js";
import { CliError, usageError } from "../errors.js";
import { errorFromResponse, sendRequest, type HttpRequest } from "../http.js";
import { paint, renderTable } from "../output.js";

/**
 * Signing a computer in and out: `login`, `logout`, `profiles`, `whoami`.
 *
 * `login` checks the key against `GET /api/companies/{cid}/me` before saving
 * anything, so a profile on disk is one that worked. The key itself is never
 * printed — only `gen_` and its first characters, as Settings → API keys
 * shows it.
 */

type CompanyMe = {
  user?: { id?: string; email?: string; name?: string; handle?: string | null };
  company?: { id?: string; name?: string; slug?: string };
  role?: string;
  financeAccess?: string;
  authentication?: string;
  apiKey?: { id?: string; name?: string; prefix?: string; expiresAt?: string | null } | null;
};

async function fetchMe(
  context: Context,
  baseUrl: string,
  companyId: string,
  apiKey: string,
): Promise<CompanyMe> {
  const request: HttpRequest = {
    method: "GET",
    url: `${baseUrl}/api/companies/${encodeURIComponent(companyId)}/me`,
    headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
    operationId: "getCompanyMe",
  };
  const response = await sendRequest(request, context.http());
  if (response.status >= 400) throw errorFromResponse(response, request);
  if (!response.isJson || !response.json || typeof response.json !== "object") {
    throw new CliError("network", `${baseUrl} answered /me with something that isn't Genosyn.`, {
      hint: "Check the address; it should be the one you open Genosyn at.",
    });
  }
  return response.json as CompanyMe;
}

function describeMe(me: CompanyMe, extra: Array<[string, string]>, color: boolean): string {
  const name = me.user?.name ? `${me.user.name} <${me.user?.email ?? ""}>` : (me.user?.email ?? "");
  const expires = me.apiKey
    ? me.apiKey.expiresAt
      ? `expires ${me.apiKey.expiresAt.slice(0, 10)}`
      : "never expires"
    : "";
  const lines: Array<[string, string]> = [
    ["Member", name],
    [
      "Company",
      `${me.company?.name ?? ""}${me.company?.slug ? ` (${me.company.slug})` : ""} · ${me.company?.id ?? ""}`,
    ],
    ["Role", `${me.role ?? "?"} · Finance: ${me.financeAccess ?? "?"}`],
  ];
  if (me.apiKey) {
    lines.push(["Key", `${me.apiKey.name ?? ""} (${me.apiKey.prefix ?? ""}…) · ${expires}`]);
  }
  lines.push(...extra);
  return lines.map(([key, value]) => `${paint("dim", key.padEnd(8), color)}  ${value}`).join("\n");
}

async function readKey(context: Context): Promise<string> {
  const { io } = context;
  let key: string;
  if (context.flag("with-token")) {
    key = (await io.readStdin()).toString("utf8").trim();
    if (!key) throw usageError("--with-token read nothing from stdin.", 'Pipe the key in: echo "$KEY" | genosyn-api login --with-token …');
  } else if (io.env.GENOSYN_API_KEY?.trim()) {
    key = io.env.GENOSYN_API_KEY.trim();
  } else if (io.stdinIsTTY) {
    key = (await io.promptSecret("API key (input hidden): ")).trim();
  } else {
    throw usageError(
      "No API key: stdin isn't a terminal to ask at.",
      "Pipe the key in with --with-token, or set GENOSYN_API_KEY.",
    );
  }
  if (!key) throw usageError("The API key is empty.");
  if (!key.startsWith("gen_") || /\s/.test(key)) {
    throw usageError(
      "That isn't a Genosyn API key: keys start with gen_.",
      "Generate one at Settings → API keys.",
    );
  }
  return key;
}

/** A profile name from a company slug: lowercase letters, digits and dashes. */
export function profileNameFor(slug: string | undefined): string {
  const cleaned = (slug ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return cleaned || "default";
}

export async function commandLogin(context: Context, words: string[]): Promise<void> {
  const { io } = context;
  if (words.length > 1) throw usageError(`Unexpected argument: ${words.slice(1).join(" ")}.`);
  let urlInput = words[0] ?? context.value("url") ?? io.env.GENOSYN_URL?.trim();
  const interactive = io.stdinIsTTY && !!io.stderr.isTTY;
  if (!urlInput) {
    if (!interactive) {
      throw usageError(
        "login needs your install's address.",
        "Pass --url with the Base URL from Settings → API keys (it ends in /api/companies/<id>).",
      );
    }
    urlInput = await io.prompt("Base URL from Settings → API keys: ");
  }
  const { baseUrl, companyId: companyFromUrl } = parseBaseUrl(urlInput);
  let companyId = context.value("company") ?? companyFromUrl ?? io.env.GENOSYN_COMPANY?.trim();
  if (!companyId) {
    if (!interactive) {
      throw usageError(
        "login needs the company too.",
        "Use the Base URL from Settings → API keys, which ends in /api/companies/<id>, or add --company <id>.",
      );
    }
    companyId = (await io.prompt("Company id: ")).trim();
  }
  if (!isUuid(companyId)) {
    throw usageError(
      `"${companyId}" is not a company id.`,
      "It is the UUID at the end of the Base URL on Settings → API keys.",
    );
  }
  companyId = companyId.toLowerCase();
  const apiKey = await readKey(context);
  if (isInsecureRemote(baseUrl)) {
    context.warn(`${baseUrl} is plain http: the key crosses the network unencrypted. Prefer https.`);
  }

  const verify = !context.flag("no-verify");
  const me = verify ? await fetchMe(context, baseUrl, companyId, apiKey) : undefined;

  const loaded = context.config();
  const config = loaded.config;
  const chosen = context.value("profile");
  const name = chosen ?? profileNameFor(me?.company?.slug);
  const existing = config.profiles[name];
  if (
    existing &&
    !chosen &&
    !(sameInstall(existing.url, baseUrl) && existing.companyId === companyId)
  ) {
    throw usageError(
      `A profile named "${name}" already points at ${existing.url} (company ${existing.companyId}).`,
      "Name this one with --profile <name>.",
    );
  }
  const profile: Profile = {
    url: baseUrl,
    companyId,
    apiKey,
    ...(me?.company?.name ? { companyName: me.company.name } : {}),
    ...(me?.company?.slug ? { companySlug: me.company.slug } : {}),
    ...(me?.user?.email ? { memberEmail: me.user.email } : {}),
    ...(me?.apiKey?.name ? { keyName: me.apiKey.name } : {}),
    keyPrefix: me?.apiKey?.prefix ?? maskKey(apiKey)?.replace(/…$/, ""),
    savedAt: new Date(io.now()).toISOString(),
  };
  config.profiles[name] = profile;
  config.currentProfile = name;
  const file = saveConfig(io, config);
  context.configChanged();

  const result = {
    profile: name,
    url: baseUrl,
    company: me?.company ?? { id: companyId },
    user: me?.user ?? null,
    role: me?.role ?? null,
    financeAccess: me?.financeAccess ?? null,
    apiKey: me?.apiKey ?? { prefix: profile.keyPrefix },
    verified: verify,
    config: file,
  };
  const color = context.color;
  const human = me
    ? `${paint("green", "✓", color)} Logged in to ${me.company?.name ?? companyId} as ${me.user?.email ?? "?"} (${me.role ?? "?"}).\n${describeMe(me, [["Profile", `${name} · ${baseUrl}`]], color)}`
    : `${paint("green", "✓", color)} Saved profile ${name} for ${baseUrl} without checking the key.`;
  context.result(result, human);
}

function profileToDisplay(name: string, profile: Profile, current: boolean) {
  return {
    name,
    current,
    url: profile.url,
    companyId: profile.companyId,
    companyName: profile.companyName ?? null,
    member: profile.memberEmail ?? null,
    key: profile.apiKey ? `${profile.keyPrefix ?? maskKey(profile.apiKey)?.replace(/…$/, "")}…` : null,
    keyName: profile.keyName ?? null,
    savedAt: profile.savedAt ?? null,
  };
}

function profileToRemove(context: Context, words: string[]): string {
  const { config } = context.config();
  const name =
    words[0] ??
    context.value("profile") ??
    context.io.env.GENOSYN_PROFILE?.trim() ??
    config.currentProfile ??
    (Object.keys(config.profiles).length === 1 ? Object.keys(config.profiles)[0] : undefined);
  if (!name) {
    throw usageError(
      Object.keys(config.profiles).length ? "Which profile? Name it." : "There are no profiles to remove.",
      Object.keys(config.profiles).length
        ? `Profiles: ${Object.keys(config.profiles).join(", ")}.`
        : undefined,
    );
  }
  if (!config.profiles[name]) {
    throw usageError(
      `No profile named "${name}".`,
      Object.keys(config.profiles).length
        ? `Profiles: ${Object.keys(config.profiles).join(", ")}.`
        : undefined,
    );
  }
  return name;
}

function removeProfile(context: Context, name: string): void {
  const loaded = context.config();
  const config = loaded.config;
  delete config.profiles[name];
  if (config.currentProfile === name) {
    const remaining = Object.keys(config.profiles);
    config.currentProfile = remaining.length === 1 ? remaining[0] : undefined;
  }
  saveConfig(context.io, config);
  context.configChanged();
  context.result(
    { removed: name, currentProfile: config.currentProfile ?? null },
    `${paint("green", "✓", context.color)} Removed profile ${name} from this computer. The key keeps working until it is revoked at Settings → API keys.`,
  );
}

export async function commandLogout(context: Context, words: string[]): Promise<void> {
  if (words.length > 1) throw usageError(`Unexpected argument: ${words.slice(1).join(" ")}.`);
  removeProfile(context, profileToRemove(context, words));
}

export async function commandProfiles(context: Context, words: string[]): Promise<void> {
  const [sub = "list", ...rest] = words;
  const { config, path } = context.config();
  if (sub === "list" || sub === "ls") {
    if (rest.length) throw usageError(`Unexpected argument: ${rest.join(" ")}.`);
    const list = Object.entries(config.profiles).map(([name, profile]) =>
      profileToDisplay(name, profile, name === config.currentProfile),
    );
    if (!context.jsonOutput && context.value("select") === undefined) {
      if (list.length === 0) {
        context.write("No profiles yet. Run `genosyn-api login` to add one.\n");
        return;
      }
      context.write(
        renderTable(
          list.map((entry) => ({
            " ": entry.current ? "*" : "",
            name: entry.name,
            company: entry.companyName ?? entry.companyId,
            member: entry.member ?? "",
            url: entry.url,
            key: entry.key ?? "(none)",
          })),
          [" ", "name", "company", "member", "url", "key"],
          context.style(),
        ),
      );
      return;
    }
    context.result(list);
    return;
  }
  if (sub === "use" || sub === "switch") {
    const [name] = rest;
    if (!name || rest.length > 1) throw usageError("Usage: genosyn-api profiles use <name>");
    if (!config.profiles[name]) {
      throw usageError(
        `No profile named "${name}".`,
        Object.keys(config.profiles).length
          ? `Profiles: ${Object.keys(config.profiles).join(", ")}.`
          : "Run `genosyn-api login` to add one.",
      );
    }
    config.currentProfile = name;
    saveConfig(context.io, config);
    context.configChanged();
    context.result(
      { currentProfile: name },
      `${paint("green", "✓", context.color)} Now using ${name} (${config.profiles[name].url}).`,
    );
    return;
  }
  if (sub === "show") {
    if (rest.length > 1) throw usageError(`Unexpected argument: ${rest.slice(1).join(" ")}.`);
    const name = rest[0] ?? context.connection().profileName;
    if (!name || !config.profiles[name]) {
      throw usageError(name ? `No profile named "${name}".` : "No profile is in use.");
    }
    const shown = { ...profileToDisplay(name, config.profiles[name], name === config.currentProfile), config: path };
    context.result(shown);
    return;
  }
  if (sub === "remove" || sub === "rm" || sub === "delete") {
    if (rest.length !== 1) throw usageError("Usage: genosyn-api profiles remove <name>");
    removeProfile(context, profileToRemove(context, rest));
    return;
  }
  throw usageError(`Unknown profiles command "${sub}".`, "Use list, use, show or remove.");
}

export async function commandWhoami(context: Context, words: string[]): Promise<void> {
  if (words.length) throw usageError(`Unexpected argument: ${words.join(" ")}.`);
  const connection = context.connection();
  const baseUrl = requireBaseUrl(connection);
  const companyId = requireCompany(connection);
  const apiKey = requireApiKey(connection);
  const me = await fetchMe(context, baseUrl, companyId, apiKey);
  const extra: Array<[string, string]> = [
    ["Profile", `${connection.profileName ?? "(environment)"} · ${baseUrl}`],
  ];
  context.result(
    { ...me, profile: connection.profileName ?? null, url: baseUrl },
    describeMe(me, extra, context.color),
  );
}
