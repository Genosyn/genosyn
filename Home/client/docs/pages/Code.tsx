import {
  Callout,
  Code,
  DocLink,
  H2,
  H3,
  LI,
  OL,
  P,
  PageHeader,
  Pre,
  Strong,
  UL,
} from "@/docs/Prose";

export function CodeRepositories() {
  return (
    <>
      <PageHeader
        eyebrow="Engineering"
        title="Code Repositories"
        lead={
          <>
            Add any git repository to your company and grant the AI employees you choose access to
            work on it. When coding execution is enabled, each granted employee gets a real checkout
            in its workspace — read, branch, edit, test, and commit with ordinary <Code>git</Code>.
          </>
        }
      />

      <H2 id="what">What this is</H2>
      <P>
        A <Strong>Code Repository</Strong> is a provider-agnostic git repo the company registers
        under the <DocLink to="/docs">Code</DocLink> section. Point it at GitHub, GitLab, Bitbucket,
        or a self-hosted server over HTTPS or SSH. Unlike a read-only API integration, this gives
        employees an editable working tree when coding execution is enabled: the runner clones each
        granted repo into <Code>code-repos/&lt;slug&gt;/</Code> inside the employee&apos;s workspace
        before every chat and Routine Run, with the committer identity already configured.
        Credentials stay in the server-owned refresh operation and never enter that working tree.
      </P>

      <Callout kind="info" title="Access is opt-in, per employee.">
        Adding a repository does not expose it to anyone. You decide which employees can touch it,
        and whether each is reference-only or authorized to prepare a local change.
      </Callout>
      <Callout kind="info" title="Repository work needs an enabled coding mode.">
        Disabled execution, the standard Docker default, does not materialize repositories for chats
        or Routine Runs. A trusted host-mode install with <Code>allowUnsafeHostExecution</Code>{" "}
        acknowledged can prepare repositories for API-key and custom AI Models. To give an OpenAI
        subscription model repository access, use working bubblewrap on a source-managed Linux
        install; host mode rejects subscription auth.
      </Callout>

      <H2 id="add">Adding a repository</H2>
      <OL>
        <LI>
          Open <Strong>Code</Strong> from the section menu and click <Strong>Add repository</Strong>
          .
        </LI>
        <LI>
          Give it a name and paste the clone URL — <Code>https://github.com/acme/web.git</Code> or{" "}
          <Code>git@github.com:acme/web.git</Code>.
        </LI>
        <LI>
          Pick an <Strong>authentication</Strong> mode and supply credentials (below). Set the
          default branch and an optional committer identity.
        </LI>
        <LI>
          Open the repository and click <Strong>Test connection</Strong> to confirm Genosyn can
          reach it.
        </LI>
        <LI>
          Use the repository side menu to open <Strong>AI access</Strong>, add an employee, and
          choose <Strong>Work locally</Strong> when it should prepare branches and commits.
        </LI>
      </OL>

      <Callout kind="info" title="The Genosyn server needs git installed.">
        Repositories are cloned and fetched by shelling out to <Code>git</Code> on the Genosyn
        server, and SSH remotes also need an <Code>ssh</Code> client. The official Docker image
        bundles both, so there is nothing to install. On a bare-host install, make sure{" "}
        <Code>git</Code> (and <Code>openssh-client</Code>, for SSH auth) is on the server&apos;s{" "}
        <Code>PATH</Code> — otherwise <Strong>Test connection</Strong> reports that git is not
        installed on the server.
      </Callout>
      <Callout kind="warn" title="Shared SaaS restriction">
        Arbitrary repository remotes are read-only in the hosted profile until git clone/fetch can
        run in a dedicated egress worker. Use a granted GitHub Connection for fixed-host GitHub
        checkouts, or use this feature on a single-tenant deployment.
      </Callout>

      <H2 id="auth">Authentication</H2>
      <P>
        Credentials are encrypted at rest with the same AES-256-GCM key that protects model API
        keys. They are never shown back to you in plaintext — the UI only reports whether a
        credential is stored. Keep credentials and URL options out of the clone URL itself; Genosyn
        rejects them for every authentication mode, so enter tokens, passwords, and SSH keys only in
        their dedicated fields.
      </P>
      <UL>
        <LI>
          <Strong>None / GitHub Connection.</Strong> Public repositories clone anonymously. For an
          HTTPS GitHub URL, Genosyn automatically reuses a GitHub Connection granted to the same
          employee. An exact owner/repository allowlist match wins; when the employee has only one
          GitHub Connection, the Code Repository grant itself is the repository boundary. The token
          is used only by Genosyn&apos;s server-owned clone/refresh operation and is never exposed
          to the AI employee.
        </LI>
        <LI>
          <Strong>HTTPS token / password.</Strong> A username plus a personal access token (with the
          narrowest repository scope you can grant). The token is decrypted only for a short-lived
          server-owned git operation; it never lands in the checkout or the AI employee&apos;s shell
          environment. Username tips: <Code>x-access-token</Code> for GitHub, <Code>oauth2</Code>{" "}
          for GitLab, your account name for Bitbucket.
        </LI>
        <LI>
          <Strong>SSH private key.</Strong> Paste a private key whose public half is registered as a
          deploy key on your host. The key is materialized only in an App-private temporary
          directory for clone/refresh, then removed. Only the non-secret host-key cache persists,
          outside the employee workspace.
        </LI>
      </UL>
      <P>
        Authenticated clone and refresh operations contact only the configured repository from a
        private server-owned git workspace, then transfer the fetched objects into the employee
        checkout. Employee-written remote rewrites, proxy settings, and TLS settings are not read by
        that networked process. The checkout is left without a credential helper, SSH key path, or
        credentialed push URL.
      </P>

      <Callout kind="warn" title="Publishing authenticated branches is a human or governed step">
        AI employees can branch, edit, test, and commit locally. Genosyn does not place reusable
        repository credentials in model-controlled tools, so a credentialed remote cannot be pushed
        directly from the AI coding shell. Ask a Member to publish the reported branch and commit,
        or use a separately governed server-side delivery flow.
      </Callout>

      <H2 id="access">Granting access</H2>
      <P>
        Open a repository and choose <Strong>AI access</Strong> from its side menu. The page lists
        who can work on it and whether each employee is ready to open a GitHub pull request. Add an
        employee and choose a level:
      </P>
      <UL>
        <LI>
          <Strong>Work locally.</Strong> The employee may prepare a branch and local commits. This
          is the default when the point of adding a repository is to let an employee work on it.
        </LI>
        <LI>
          <Strong>Reference only.</Strong> The repo is cloned and kept refreshed for research. Any
          local changes remain unpublished, and the push URL is disabled.
        </LI>
      </UL>

      <H2 id="how-employees-use-it">How employees use it</H2>
      <P>
        Granted employees are told, in their prompt, which repositories are checked out, where, and
        how to hand off local changes. They work with ordinary git — no special tooling. The
        built-in <Code>genosyn</Code> MCP server also exposes a <Code>list_code_repositories</Code>{" "}
        tool so an employee can enumerate its repos and their local paths at any time.
      </P>
      <Pre lang="bash">{`cd code-repos/acme-web
git checkout -b fix/typo
# …edit files…
git commit -am "Fix typo in README"
git status --short --branch`}</Pre>
      <P>
        Existing checkouts are only <Code>git fetch</Code>ed between runs, never hard-reset — so a
        local branch an employee prepared in one Run is still there the next time it starts.
      </P>

      <H2 id="pull-requests">Writing code and handing off a pull request</H2>
      <P>
        Code editing needs no extra plugin or MCP server. Every AI employee has built-in tools for
        shell commands, file reads and writes, exact edits, directory listing, globbing, and search.
        A <Strong>Work locally</Strong> repository grant adds the working tree, while repository
        credentials remain server-owned.
      </P>
      <P>
        Opening a GitHub pull request uses the GitHub Connection&apos;s{" "}
        <Code>create_pull_request</Code> tool. Complete these steps once:
      </P>
      <OL>
        <LI>
          Add a GitHub Connection under <Strong>Code → Integrations</Strong> and allowlist the
          repository.
        </LI>
        <LI>
          Grant that Connection to the same employee from the employee&apos;s{" "}
          <Strong>Connections</Strong> page.
        </LI>
        <LI>
          On <Strong>Code → repository → AI access</Strong>, confirm the employee shows{" "}
          <Strong>PR ready</Strong>.
        </LI>
      </OL>
      <P>
        When the Code Repository uses <Strong>None / GitHub Connection</Strong>, the same grants let
        the Genosyn server refresh the checkout without copying the PAT into the repository or AI
        shell. A Member or governed delivery action must publish the local branch before the PR tool
        can open a pull request for it.
      </P>
      <P>
        You can then ask: “Create a branch, implement this change, run the tests, and send me a
        draft PR.” Genosyn carries the request through editing, tests, and a local commit, then
        reports the exact branch and commit that need publishing. It must not claim a push or pull
        request exists unless the corresponding operation actually succeeds.
      </P>

      <H3 id="vs-github">Code Repositories vs. the GitHub integration</H3>
      <P>
        The <DocLink to="/docs/integrations">GitHub integration</DocLink> is the right tool when you
        want an employee calling the GitHub API (issues, pull requests, reviews) against repos on a
        connected GitHub account. Code Repositories are for the editor-shaped workflow — a working
        tree to edit and commit in — and work against any git host, not just GitHub. Use both with a
        governed publish step for the full code-to-pull-request workflow.
      </P>

      <Callout kind="warn" title="Least privilege.">
        Scope tokens and deploy keys to exactly the repositories an employee needs, and prefer{" "}
        <Strong>Reference only</Strong> when an employee just needs to inspect code. Deleting a
        repository in Genosyn never deletes or changes the remote git repository.
      </Callout>
    </>
  );
}
