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
      </OL>

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
        On a repository&apos;s page, the <Strong>Employee access</Strong> panel
        lists who can work on it. Add an employee and choose a level:
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

      <H3 id="vs-github">Code Repositories vs. the GitHub integration</H3>
      <P>
        The <DocLink to="/docs/integrations">GitHub integration</DocLink> is the
        right tool when you want an employee calling the GitHub API (issues,
        PRs, reviews) against repos on a connected GitHub account. Code
        Repositories are for the editor-shaped workflow — a working tree to
        commit and push to — and work against any git host, not just GitHub.
        You can use both.
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
