import { isIP } from "node:net";

/**
 * Configure a repository-local Git credential helper that reads a token from
 * an environment variable supplied only for the current AI employee turn.
 *
 * The helper is inline on purpose. Employee workspaces are remounted at
 * `/workspace` in bubblewrap mode, so an absolute path written outside the
 * sandbox cannot be executed from inside it.
 */

type GitConfigRunner = (args: string[]) => Promise<unknown>;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function isSafeGitHost(host: string): boolean {
  if (host.startsWith("[") && host.endsWith("]")) {
    return isIP(host.slice(1, -1)) === 6;
  }
  const labels = (host.endsWith(".") ? host.slice(0, -1) : host).split(".");
  return labels.every((label) => !!label && !label.startsWith("-") && !label.endsWith("-"));
}

export const SAFE_GIT_REMOTE_URL_MESSAGE =
  "Enter a plain http(s), ssh://, or user@host:path clone URL without embedded credentials or options.";

/**
 * Reject remote URLs that Git could interpret as carrying credentials or URL
 * options. The error deliberately omits the rejected value so a legacy secret
 * cannot be copied into logs.
 */
export function assertSafeGitRemoteUrl(remoteUrl: string): void {
  const reject = (): never => {
    throw new Error(SAFE_GIT_REMOTE_URL_MESSAGE);
  };

  if (
    !remoteUrl ||
    remoteUrl !== remoteUrl.trim() ||
    /[\0\s?#]/.test(remoteUrl) ||
    remoteUrl.includes("\\")
  ) {
    reject();
  }

  if (!remoteUrl.includes("://")) {
    const match = remoteUrl.match(
      /^([A-Za-z0-9_][A-Za-z0-9._-]*)@(\[[^\]]+\]|[A-Za-z0-9_][A-Za-z0-9._-]*):\/?[^\s?#]+$/,
    );
    const host = match?.[2] ?? "";
    if (!match || !isSafeGitHost(host)) reject();
    return;
  }

  if (!/^(?:https?|ssh):\/\//i.test(remoteUrl)) reject();

  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    throw new Error(SAFE_GIT_REMOTE_URL_MESSAGE);
  }
  if (
    !["http:", "https:", "ssh:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    !isSafeGitHost(parsed.hostname) ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    reject();
  }

  const authority = remoteUrl.slice(remoteUrl.indexOf("://") + 3).split("/", 1)[0] ?? "";
  const userInfoEnd = authority.lastIndexOf("@");
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    if (userInfoEnd !== -1) reject();
  } else if (userInfoEnd !== -1) {
    const username = authority.slice(0, userInfoEnd);
    if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(username)) reject();
  }
}

export function assertSafeCredentialToken(token: string): void {
  if (/[\0\r\n]/.test(token)) {
    throw new Error("Git credential token contains an invalid line break.");
  }
}

export function inlineEnvCredentialHelper(
  username: string,
  envKey: string,
  remoteUrl: string,
): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey)) {
    throw new Error(`Invalid credential environment variable: ${envKey}`);
  }
  if (/[\0\r\n]/.test(username)) {
    throw new Error("Invalid Git credential username.");
  }
  const scope = httpsCredentialScope(remoteUrl);

  return [
    "!f() {",
    "protocol= host= credential_path=;",
    "while IFS='=' read -r key value; do",
    'case "$key" in',
    'protocol) protocol="$value" ;;',
    'host) host="$value" ;;',
    'path) credential_path="$value" ;;',
    "esac;",
    "done;",
    "normalized_host=$(printf '%s' \"$host\" | tr '[:upper:]' '[:lower:]');",
    'case "$normalized_host" in *:443) normalized_host=${normalized_host%:443} ;; esac;',
    `if [ "$1" = "get" ] && [ "$protocol" = ${shellQuote("https")} ] && [ "$normalized_host" = ${shellQuote(scope.host)} ] && [ "$credential_path" = ${shellQuote(scope.path)} ] && [ -n "$${envKey}" ]; then`,
    `printf 'username=%s\\npassword=%s\\n' ${shellQuote(username)} "$${envKey}";`,
    "fi;",
    "}; f",
  ].join(" ");
}

export function httpsCredentialScope(remoteUrl: string): {
  protocol: "https";
  host: string;
  path: string;
} {
  try {
    assertSafeGitRemoteUrl(remoteUrl);
  } catch {
    throw new Error("Git credentials require a plain https:// remote URL.");
  }
  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    throw new Error("Git credentials require a valid https:// remote URL.");
  }
  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname.includes("%")
  ) {
    throw new Error("Git credentials require a plain https:// remote URL.");
  }
  const credentialPath = parsed.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!credentialPath) {
    throw new Error("Git credential remote URL must include a repository path.");
  }
  return {
    protocol: "https",
    host: parsed.host.toLowerCase(),
    path: credentialPath,
  };
}

export async function configureEnvCredentialHelper(
  runGit: GitConfigRunner,
  username: string,
  envKey: string,
  remoteUrl: string,
): Promise<void> {
  const helper = inlineEnvCredentialHelper(username, envKey, remoteUrl);

  // An empty helper resets inherited system/global helpers. Add our inline
  // helper second so it is the only credential source Git consults.
  await clearEnvCredentialHelper(runGit);
  await runGit(["config", "--local", "credential.useHttpPath", "true"]);
  await runGit(["config", "--local", "--add", "credential.helper", helper]);
}

export async function clearEnvCredentialHelper(runGit: GitConfigRunner): Promise<void> {
  await runGit(["config", "--local", "--unset-all", "credential.helper"]).catch(() => {});
  await runGit(["config", "--local", "--add", "credential.helper", ""]);
  await runGit(["config", "--local", "--unset-all", "credential.useHttpPath"]).catch(() => {});
}

/** Branch names are user input that reaches Git as an argument. */
export function assertSafeBranchName(name: string): void {
  if (!name || name.length > 200) throw new Error("Enter a branch name.");
  if (!/^[A-Za-z0-9._\-/]+$/.test(name)) {
    throw new Error("Branch names may use letters, numbers, dot, dash, underscore, and slash.");
  }
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/")) {
    throw new Error("That branch name is not valid.");
  }
  if (name.includes("..") || name.includes("//") || name.endsWith(".lock")) {
    throw new Error("That branch name is not valid.");
  }
}
