import {
  Callout,
  Code,
  DocLink,
  H2,
  H3,
  KeyList,
  LI,
  OL,
  P,
  PageHeader,
  Strong,
  UL,
} from "@/docs/Prose";

export function Repositories() {
  return (
    <>
      <PageHeader
        eyebrow="Engineering"
        title="Repositories"
        lead={
          <>
            A <Strong>Repository</Strong> is a version-controlled workspace your company owns — a
            service&apos;s source code, a quarter&apos;s strategy, a set of operating policies.
            Browse and edit it in the browser, commit and branch, read the history, or hand a piece
            of work to an AI Employee and merge what it produced after you have read the diff.
          </>
        }
      />

      <H2 id="what">What a Repository is</H2>
      <P>
        Every Repository is a plain git repository. Two fields decide how it behaves, and you set
        both when you create it:
      </P>
      <KeyList
        rows={[
          {
            term: "origin",
            def: (
              <>
                <Strong>Remote</Strong> — a clone of any HTTPS or SSH git URL: GitHub, GitLab,
                Bitbucket, a self-hosted Gitea, anything git speaks to.{" "}
                <Strong>Local</Strong> — created empty inside Genosyn with <Code>git init</Code> and
                no clone URL at all, so a versioned set of documents needs no git host.
              </>
            ),
          },
          {
            term: "kind",
            def: (
              <>
                <Strong>Code</Strong> or <Strong>Documents</Strong>. It changes the empty states,
                the editor defaults, and how an AI Employee is briefed — &ldquo;run the tests before
                you commit&rdquo; is useful advice in a service repo and noise in a folder of
                strategy memos. It restricts nothing: any file may live in any Repository.
              </>
            ),
          },
        ]}
      />
      <P>
        Find them under <Strong>Repositories</Strong> in the section menu. Nothing here is limited
        to engineers, and nothing here requires a git host, an account on one, or coding tools
        switched on.
      </P>

      <H2 id="create">Create a repository</H2>
      <OL>
        <LI>
          Open <Strong>Repositories</Strong> from the section menu and choose{" "}
          <Strong>Add repository</Strong>.
        </LI>
        <LI>
          Give it a name and choose whether it is <Strong>local</Strong> — created here and never
          pushed anywhere — or a clone of a repository that already exists.
        </LI>
        <LI>
          For a remote repository, paste the clone URL —{" "}
          <Code>https://github.com/acme/web.git</Code> or <Code>git@github.com:acme/web.git</Code> —
          and pick an <Strong>authentication</Strong> mode.
        </LI>
        <LI>
          Set the default branch and, optionally, a committer identity. Left blank, commits are
          committed as <Code>Genosyn</Code>.
        </LI>
        <LI>
          Open the repository. For a remote one, <Strong>Test connection</Strong> confirms Genosyn
          can reach it and detects the default branch.
        </LI>
      </OL>
      <P>
        A local repository is created with <Code>git init</Code> on the default branch you chose,
        plus one empty commit, so there is a revision to branch from and diff against before you
        write your first file. It has no remote and uses no authentication. Adding a clone URL to it
        later in <Strong>Settings</Strong> promotes it to a remote repository.
      </P>

      <H2 id="files">Browse and edit files</H2>
      <P>
        Opening a repository shows the working tree of a checkout Genosyn keeps on the server. The
        tree is read from disk rather than from git, so a file you just created appears before you
        have committed it. Symlinks and the <Code>.git</Code> directory are never listed, and one
        directory shows at most 2,000 entries.
      </P>
      <P>
        Open a file to edit it in place. You can create, rename, move, and delete files and folders.
        A new empty folder gets a <Code>.gitkeep</Code> so it survives a reload — git has no concept
        of an empty directory.
      </P>
      <UL>
        <LI>
          Files above <Strong>1 MB</Strong> are not rendered at all; the editor reports the size
          instead of hanging on a megabyte of text.
        </LI>
        <LI>
          Files above <Strong>256 KB</Strong> open read-only, as do binary files and any file you
          opened at an older revision.
        </LI>
        <LI>
          The changed-files list comes from <Code>git status</Code>. Review a per-file diff or the
          whole tree at once; files git has never seen are rendered as additions.
        </LI>
        <LI>
          Discarding changes is scoped to the paths you pick. There is no discard-everything button
          — on a checkout the whole company shares, that is not an action anyone can undo.
        </LI>
      </UL>

      <H2 id="version-control">Commit, branch, and history</H2>
      <P>
        Commit everything that changed or only the paths you select, with a message. The commit is
        attributed to <Strong>you</Strong>: <Code>git log</Code> shows the Member&apos;s name and
        email as the author, not the server. Commits are also recorded in the company audit log.
      </P>
      <UL>
        <LI>
          <Strong>Branches.</Strong> Create a branch from any revision, switch between branches, and
          see local branches alongside the <Code>origin/*</Code> ones.
        </LI>
        <LI>
          <Strong>History.</Strong> The commit log for the repository or for a single file, each
          commit with its own diff. Open a file at an older commit to read it as it was.
        </LI>
        <LI>
          <Strong>Refresh.</Strong> The editor reads local state so that nothing costs a network
          round trip; <Strong>Refresh</Strong> is the explicit &ldquo;go and talk to the
          remote&rdquo; that fetches.
        </LI>
        <LI>
          <Strong>Pull.</Strong> Fast-forward only. A branch that has diverged from the remote is
          reported as diverged rather than merged — there is no conflict resolution in the browser
          yet, and conflict markers in a web editor with no way out would be worse than a refusal.
        </LI>
        <LI>
          <Strong>Push.</Strong> Sends one branch to the remote using the stored credential. Local
          repositories have nothing to push to until you give them a URL.
        </LI>
      </UL>

      <H2 id="work-sessions">Hand work to an AI Employee</H2>
      <P>
        A <Strong>work session</Strong> is one request to an AI Employee to do something in a
        repository, and the reviewable result of that request. Grant access first: open a
        repository&apos;s <Strong>AI access</Strong> page and add the employees that should be able
        to work on it. Any granted employee can be picked for a session, and it needs a connected{" "}
        <DocLink to="/docs/models">AI Model</DocLink> to run.
      </P>
      <OL>
        <LI>Pick the employee and describe the work in plain language.</LI>
        <LI>
          Genosyn creates a git <Strong>worktree</Strong> for the session next to the shared
          checkout, on a fresh branch under <Code>genosyn/</Code>, branched from where the checkout
          is now. Nobody else is editing it, and two sessions never collide.
        </LI>
        <LI>
          The employee works only through six tools Genosyn runs on its behalf — list files, read,
          write, delete, search, and commit. It gets no shell and no filesystem access to the
          worktree.
        </LI>
        <LI>
          It commits its work and writes a short report of what it changed, what it left alone, and
          what it could not verify. Anything it leaves uncommitted is discarded when the session
          ends.
        </LI>
        <LI>Read the report and the diff, then publish the work or discard it.</LI>
      </OL>
      <KeyList
        rows={[
          { term: "running", def: "The employee's turn is in flight." },
          {
            term: "ready",
            def: "The turn finished and left commits on its branch, waiting for you to review the diff and decide.",
          },
          {
            term: "empty",
            def: "The turn finished without committing anything. Not a failure — “I read it and there is nothing to change” is a legitimate answer, and there is no branch to publish.",
          },
          {
            term: "published",
            def: "You merged the branch into the shared checkout, and for a remote repository it was pushed.",
          },
          { term: "discarded", def: "You rejected the work; the worktree and its branch are gone." },
          { term: "failed", def: "The turn errored, or its result could not be read afterwards." },
        ]}
      />
      <P>
        Publishing merges the session&apos;s branch into whatever branch the shared checkout is on.
        The worktree shares the repository&apos;s object store, so the commits are already present
        and nothing has to be transferred. For a remote repository you can push in the same step.
        Merging refuses to run while the shared checkout has uncommitted changes of its own, and a
        merge that would conflict is aborted rather than left half-applied.
      </P>

      <Callout kind="tip" title="This works on the standard Docker install.">
        The browser editor and AI work sessions need no coding tools, no bubblewrap, and no host
        command execution — the standard install has all of them switched off. Git runs against a
        server-owned checkout no model process can reach, and the employee&apos;s edits arrive
        through validated tool calls rather than a shell.
      </Callout>

      <H2 id="authority">Who can do what</H2>
      <P>
        Editing a file and committing it is the same class of act as writing a{" "}
        <DocLink to="/docs/bases">Base</DocLink> record or a note — locking it to admins would make
        a repository of strategy documents useless to the people who write them. What does require
        an owner or admin is everything that reaches outside the company, because a local commit can
        be undone by anyone and a push cannot be recalled.
      </P>
      <KeyList
        rows={[
          {
            term: "Any Member",
            def: "Browse the tree, edit, create and delete files, commit, create and switch branches, read history and diffs, start AI work sessions, and merge a session's work into the checkout.",
          },
          {
            term: "Owner / admin",
            def: "Push, pull, and repository configuration — the clone URL, credentials, default branch, committer identity, and which AI Employees are granted access. Pushing a session's work while publishing it is admin too; merging it is not.",
          },
        ]}
      />
      <Callout kind="warn" title="Repositories are read-only in shared SaaS mode.">
        In the multi-tenant hosted profile every write is refused until git can run in a dedicated
        egress worker. Browsing and reading still work. Use a single-tenant deployment for the
        editor, commits, and work sessions — see{" "}
        <DocLink to="/docs/saas-hosting">Shared SaaS mode</DocLink>.
      </Callout>

      <H2 id="security">Credentials and isolation</H2>
      <H3 id="auth">Authentication modes</H3>
      <UL>
        <LI>
          <Strong>None / GitHub Connection.</Strong> Public repositories clone anonymously. For an
          HTTPS GitHub URL, Genosyn can reuse a GitHub{" "}
          <DocLink to="/docs/integrations">Connection</DocLink> granted to the same employee. Local
          repositories always use this mode — there is no remote to authenticate to.
        </LI>
        <LI>
          <Strong>HTTPS token / password.</Strong> A username plus a token: <Code>x-access-token</Code>{" "}
          for GitHub, <Code>oauth2</Code> for GitLab, your account name for Bitbucket. Use the
          narrowest repository scope your host offers.
        </LI>
        <LI>
          <Strong>SSH private key.</Strong> A private key whose public half is a deploy key on your
          host. It is written into an App-private temporary directory for exactly one operation and
          removed afterwards, whether that operation succeeded or not.
        </LI>
      </UL>
      <P>
        Keep credentials and options out of the clone URL itself — Genosyn rejects them in every
        mode. Enter tokens and keys only in their own fields.
      </P>
      <H3 id="isolation">How the two checkouts are kept apart</H3>
      <UL>
        <LI>
          Credentials are encrypted at rest with AES-256-GCM, the same protection as model API keys,
          and are never returned to the client. The UI reports only whether one is stored.
        </LI>
        <LI>
          The shared checkout lives in Genosyn&apos;s private data directory, outside any tree a
          model can reach. That is precisely what lets it hold a real <Code>origin</Code> and push.
        </LI>
        <LI>
          A session worktree is writable only through the tools, and every path is checked: anything
          containing a <Code>.git</Code> segment or resolving outside the worktree is refused. An
          employee cannot write <Code>.git/config</Code>, install a hook, or point a symlink out of
          the tree.
        </LI>
        <LI>
          Nothing an AI Employee produced reaches the remote unless a Member reviews it and an
          owner or admin pushes it. Commits, pushes, work sessions, and publishes are all written to
          the audit log.
        </LI>
      </UL>

      <H2 id="employee-checkout">The per-employee checkout</H2>
      <P>
        Separately from everything above, a granted repository is also cloned into the AI
        Employee&apos;s own workspace at <Code>repositories/&lt;slug&gt;/</Code>, refreshed before
        each chat and each <DocLink to="/docs/routines">Routine Run</DocLink>. That checkout is for
        open-ended work — the employee uses ordinary <Code>git</Code> and the coding tools in it,
        runs tests, and reports the branch and commit it prepared.
      </P>
      <Callout kind="info" title="That older path does need coding execution.">
        The per-employee checkout is materialized only when coding tools are enabled and the
        execution mode is not <Code>disabled</Code> — which the standard Docker install is. A
        subscription-authenticated model additionally needs working Linux bubblewrap. See{" "}
        <DocLink to="/docs/models">AI Models</DocLink> for the modes and{" "}
        <DocLink to="/docs/self-hosting">Configuration</DocLink> for the setting. The browser editor
        and AI work sessions above need none of this.
      </Callout>
      <P>
        The two <Strong>AI access</Strong> levels apply to that checkout. <Strong>Work locally</Strong>{" "}
        tells the employee it may branch, edit, and commit there; <Strong>Reference only</Strong>{" "}
        keeps it for reading. Neither level places a reusable credential in a model-controlled tool,
        so a credentialed push is not something an employee can perform from its own shell — that is
        what publishing a work session, or a Member pushing the reported branch, is for. Existing
        checkouts are only fetched between Runs, never hard-reset, so work in progress survives.
      </P>

      <H3 id="vs-github">Repositories vs. the GitHub integration</H3>
      <P>
        The <DocLink to="/docs/integrations">GitHub integration</DocLink> is the right tool when an
        employee should call the GitHub API — open an issue, raise a pull request, leave a review —
        against repositories on a connected GitHub account. A Repository is the workspace itself: a
        real working tree that people and AI Employees edit and commit in, on any git host or on
        none. They compose. Prepare the change in the Repository, publish the branch, and let the
        GitHub Connection open the pull request for it.
      </P>

      <Callout kind="warn" title="Least privilege.">
        Scope tokens and deploy keys to exactly the repositories they need, and grant AI Employees
        only the repositories they work on — see{" "}
        <DocLink to="/docs/employees">AI Employees</DocLink>. Deleting a repository removes its
        grants, its work sessions, and its server-side checkout, and never touches the remote git
        repository — but a <Strong>local</Strong> repository has no remote, so deleting it deletes
        the only copy of its history.
      </Callout>
    </>
  );
}
