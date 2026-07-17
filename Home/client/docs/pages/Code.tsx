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
            Add any git repository to your company and grant the AI employees
            you choose access to work on it. Each granted employee gets a real
            checkout in its workspace — read, branch, commit, and{" "}
            <Strong>push</Strong>, all with ordinary <Code>git</Code>.
          </>
        }
      />

      <H2 id="what">What this is</H2>
      <P>
        A <Strong>Code Repository</Strong> is a provider-agnostic git repo the
        company registers under the <DocLink to="/docs">Code</DocLink> section.
        Point it at GitHub, GitLab, Bitbucket, or a self-hosted server over
        HTTPS or SSH. Unlike a read-only API integration, this gives employees
        an editable working tree: the runner clones each granted repo into{" "}
        <Code>code-repos/&lt;slug&gt;/</Code> inside the employee&apos;s
        workspace before every chat and routine run, with credentials and the
        committer identity already wired up.
      </P>

      <Callout kind="info" title="Access is opt-in, per employee.">
        Adding a repository does not expose it to anyone. You decide which
        employees can touch it, and whether each may only read or also push.
      </Callout>

      <H2 id="add">Adding a repository</H2>
      <OL>
        <LI>
          Open <Strong>Code</Strong> from the section menu and click{" "}
          <Strong>Add repository</Strong>.
        </LI>
        <LI>
          Give it a name and paste the clone URL —{" "}
          <Code>https://github.com/acme/web.git</Code> or{" "}
          <Code>git@github.com:acme/web.git</Code>.
        </LI>
        <LI>
          Pick an <Strong>authentication</Strong> mode and supply credentials
          (below). Set the default branch and an optional committer identity.
        </LI>
        <LI>
          Open the repository and click <Strong>Test connection</Strong> to
          confirm Genosyn can reach it.
        </LI>
        <LI>
          Use the repository side menu to open <Strong>AI access</Strong>, add
          an employee, and choose <Strong>Read &amp; push</Strong> when it should
          deliver branches or pull requests.
        </LI>
      </OL>

      <Callout kind="info" title="The Genosyn server needs git installed.">
        Repositories are cloned and fetched by shelling out to <Code>git</Code>{" "}
        on the Genosyn server, and SSH remotes also need an <Code>ssh</Code>{" "}
        client. The official Docker image bundles both, so there is nothing to
        install. On a bare-host install, make sure <Code>git</Code> (and{" "}
        <Code>openssh-client</Code>, for SSH auth) is on the server&apos;s{" "}
        <Code>PATH</Code> — otherwise <Strong>Test connection</Strong> reports
        that git is not installed on the server.
      </Callout>

      <H2 id="auth">Authentication</H2>
      <P>
        Credentials are encrypted at rest with the same AES-256-GCM key that
        protects model API keys. They are never shown back to you in plaintext
        — the UI only reports whether a credential is stored.
      </P>
      <UL>
        <LI>
          <Strong>None.</Strong> Public repository. Clones work; pushing is
          rejected by the remote.
        </LI>
        <LI>
          <Strong>HTTPS token / password.</Strong> A username plus a personal
          access token (with repo read/write scope). The token is handed to
          git at run time through an environment variable and{" "}
          <Strong>never lands on disk</Strong>. Username tips:{" "}
          <Code>x-access-token</Code> for GitHub, <Code>oauth2</Code> for
          GitLab, your account name for Bitbucket.
        </LI>
        <LI>
          <Strong>SSH private key.</Strong> Paste a private key whose public
          half is registered as a deploy key on your host. The key is written
          into the employee&apos;s gitignored workspace only while a checkout
          exists, and pinned via <Code>core.sshCommand</Code> with host keys
          accepted on first contact.
        </LI>
      </UL>

      <H2 id="access">Granting access</H2>
      <P>
        Open a repository and choose <Strong>AI access</Strong> from its side
        menu. The page lists who can work on it and whether each employee is
        ready to open a GitHub pull request. Add an employee and choose a level:
      </P>
      <UL>
        <LI>
          <Strong>Read &amp; push.</Strong> Full access — the employee may
          commit and <Code>git push</Code>. This is the default, since the
          point of adding a repo is usually to let an employee work on it.
        </LI>
        <LI>
          <Strong>Read only.</Strong> The repo is cloned and kept fetched; the
          employee can read, branch, and commit locally, but the push URL is
          disabled so an accidental push fails fast.
        </LI>
      </UL>

      <H2 id="how-employees-use-it">How employees use it</H2>
      <P>
        Granted employees are told, in their prompt, which repositories are
        checked out, where, and whether they may push. They work with ordinary
        git — no special tooling. The built-in <Code>genosyn</Code> MCP server
        also exposes a <Code>list_code_repositories</Code> tool so an employee
        can enumerate its repos and their local paths at any time.
      </P>
      <Pre lang="bash">{`cd code-repos/acme-web
git checkout -b fix/typo
# …edit files…
git commit -am "Fix typo in README"
git push -u origin fix/typo`}</Pre>
      <P>
        Existing checkouts are only <Code>git fetch</Code>ed between runs, never
        hard-reset — so a branch an employee pushed in one run is still there
        the next time it starts.
      </P>

      <H2 id="pull-requests">Writing code and opening a pull request</H2>
      <P>
        Code editing needs no extra plugin or MCP server. Every AI employee has
        built-in tools for shell commands, file reads and writes, exact edits,
        directory listing, globbing, and search. A <Strong>Read &amp; push</Strong>{" "}
        repository grant adds the working tree and git credentials.
      </P>
      <P>
        Opening a GitHub pull request uses the GitHub Connection&apos;s{" "}
        <Code>create_pull_request</Code> tool. Complete these steps once:
      </P>
      <OL>
        <LI>
          Add a GitHub Connection under <Strong>Settings → Integrations</Strong>{" "}
          and allowlist the repository.
        </LI>
        <LI>
          Grant that Connection to the same employee from the employee&apos;s{" "}
          <Strong>Connections</Strong> page.
        </LI>
        <LI>
          On <Strong>Code → repository → AI access</Strong>, confirm the
          employee shows <Strong>PR ready</Strong>.
        </LI>
      </OL>
      <P>
        You can then ask: “Create a branch, implement this change, run the
        tests, and send me a draft PR.” Genosyn tells the employee to carry the
        request through editing, tests, commit, push, and the PR tool. It must
        not claim a pull request exists unless the GitHub call succeeds; when
        the Connection grant is missing, it reports the pushed branch and the
        missing setup instead.
      </P>

      <H3 id="vs-github">Code Repositories vs. the GitHub integration</H3>
      <P>
        The <DocLink to="/docs/integrations">GitHub integration</DocLink> is the
        right tool when you want an employee calling the GitHub API (issues,
        pull requests, reviews) against repos on a connected GitHub account. Code
        Repositories are for the editor-shaped workflow — a working tree to
        commit and push to — and work against any git host, not just GitHub.
        Use both for the full code-to-pull-request workflow.
      </P>

      <Callout kind="warn" title="Least privilege.">
        Scope tokens and deploy keys to exactly the repositories an employee
        needs, and prefer <Strong>read only</Strong> when an employee just
        needs to reference code. Deleting a repository in Genosyn revokes every
        grant; the remote git repository is never touched.
      </Callout>
    </>
  );
}
