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

export function inlineEnvCredentialHelper(username: string, envKey: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey)) {
    throw new Error(`Invalid credential environment variable: ${envKey}`);
  }

  return [
    "!f() {",
    `if [ "$1" = "get" ] && [ -n "$${envKey}" ]; then`,
    `printf 'username=%s\\npassword=%s\\n' ${shellQuote(username)} "$${envKey}";`,
    "fi;",
    "}; f",
  ].join(" ");
}

export async function configureEnvCredentialHelper(
  runGit: GitConfigRunner,
  username: string,
  envKey: string,
): Promise<void> {
  const helper = inlineEnvCredentialHelper(username, envKey);

  // An empty helper resets inherited system/global helpers. Add our inline
  // helper second so it is the only credential source Git consults.
  await clearEnvCredentialHelper(runGit);
  await runGit(["config", "--local", "--add", "credential.helper", helper]);
}

export async function clearEnvCredentialHelper(runGit: GitConfigRunner): Promise<void> {
  await runGit(["config", "--local", "--unset-all", "credential.helper"]).catch(() => {});
  await runGit(["config", "--local", "--add", "credential.helper", ""]);
}
