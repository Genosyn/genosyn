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
                Bitbucket, a self-hosted Gitea, anything git speaks to. <Strong>Local</Strong> —
                created empty inside Genosyn with <Code>git init</Code> and no clone URL at all, so
                a versioned set of documents needs no git host. A local one can be connected to
                GitHub later without that having been the plan.
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
          can reach it and detects the default branch. The check uses the repository&apos;s token or
          SSH key when one is stored; otherwise it uses a pinned or sole GitHub Connection when one
          is available, and anonymous access when none is available.
        </LI>
      </OL>
      <P>
        A local repository is created with <Code>git init</Code> on the default branch you chose,
        plus one empty commit, so there is a revision to branch from and diff against before you
        write your first file. It has no remote and uses no authentication. It does not have to stay
        that way — see <Strong>Connect a local repository to GitHub</Strong> below.
      </P>

      <H2 id="connect">Connect a local repository to GitHub</H2>
      <P>
        A repository that started life inside Genosyn can be given a real remote later, and its
        existing history is pushed into it rather than re-created. Nobody mints or pastes a personal
        access token for this: the company authenticated GitHub once under{" "}
        <Strong>Settings → Integrations</Strong>, and connecting reuses that{" "}
        <DocLink to="/docs/integrations">Connection</DocLink>.
      </P>
      <OL>
        <LI>
          Pick one of the company&apos;s connected GitHub Connections. The account each one
          authenticates as is shown, so a personal and an organisation Connection are told apart.
        </LI>
        <LI>
          Give the repository a name on GitHub and, optionally, an organisation to own it. Left
          blank, it is created under the account the Connection authenticates as.
        </LI>
        <LI>
          Choose <Strong>private</Strong> or public. Private is the default.
        </LI>
        <LI>
          Genosyn creates it through the GitHub API — empty, with no README, licence, or{" "}
          <Code>.gitignore</Code>, so the first push is a clean fast-forward — and pushes the
          history into it.
        </LI>
      </OL>
      <P>
        The other route is to paste the clone URL of an <Strong>empty</Strong> repository you made
        yourself — on GitLab, Bitbucket, a self-hosted Gitea, anywhere — and let Genosyn push into
        that. A github.com HTTPS URL authenticates through a Connection as above; for any other host
        you can supply an HTTPS token or an SSH key in the same step, and it is stored encrypted
        exactly as it would be on a repository you cloned. Leave the credentials blank for a remote
        that accepts anonymous writes. A remote that already has commits is refused with an
        explanation rather than force-pushed — the right move there is usually to add the existing
        repository as a Repository of its own.
      </P>
      <UL>
        <LI>
          Every branch goes across <Strong>except</Strong> the AI work-session ones under{" "}
          <Code>genosyn/</Code>. Unreviewed AI work must not reach a remote through a button that
          says nothing about AI.
        </LI>
        <LI>
          Afterwards the repository has an <Code>origin</Code>, the current branch tracks it, and
          push, pull, and refresh behave exactly as they do for a repository that was cloned.
        </LI>
        <LI>
          Pushes to that github.com HTTPS remote keep authenticating through the same Connection, so
          the repository still stores no credential of its own. The token is resolved for each
          operation and never written to the repository.
        </LI>
        <LI>
          Connecting is <Strong>owner or admin</Strong> only, for the same reason pushing is, and it
          is written to the audit log. It is offered only for a local repository that has no remote
          yet — repointing one that already has an <Code>origin</Code> is a settings edit, not a
          connect.
        </LI>
      </UL>

      <H2 id="files">Browse and edit files</H2>
      <P>
        Opening a repository shows the working tree of a checkout Genosyn keeps on the server. The
        tree is read from disk rather than from git, so a file you just created appears before you
        have committed it. Symlinks and the <Code>.git</Code> directory are never listed, and one
        directory shows at most 2,000 entries.
      </P>
      <P>
        The tree respects <Code>.gitignore</Code>. Ignored entries are hidden, with a toggle that
        brings them back dimmed when you actually want one — without it a cloned code repository
        buries its own source under <Code>node_modules</Code> and spends the entry cap getting
        there.
      </P>
      <P>
        Open a file to edit it in place, with syntax highlighting for the language it is written in.
        You can create, rename, move, and delete files and folders. A new empty folder gets a{" "}
        <Code>.gitkeep</Code> so it survives a reload — git has no concept of an empty directory. A{" "}
        <Code>README</Code> at the root of the repository is rendered on its Overview page.
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
          <Strong>Search</Strong> finds text anywhere in the checkout: literal and case-insensitive,
          including files nobody has committed yet, skipping ignored ones. AI Employees have had the
          same search all along; Members have it now too.
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
          <Strong>Push.</Strong> Sends one branch to the remote using the stored credential, or the
          GitHub Connection the repository was connected with. Local repositories have nothing to
          push to until you connect them.
        </LI>
      </UL>

      <H2 id="work-sessions">Hand work to an AI Employee</H2>
      <P>
        A <Strong>work session</Strong> is a conversation with an AI Employee about one piece of
        work in a repository, and the reviewable result of it. Grant access first: open a
        repository&apos;s <Strong>AI access</Strong> page and add the employees that should be able
        to work on it. Any granted employee can be picked for a session, and it needs a connected{" "}
        <DocLink to="/docs/models">AI Model</DocLink> to run.
      </P>
      <P>
        The <Strong>AI work</Strong> page is a searchable session inbox. It groups sessions by what
        needs attention, so work that is running or ready to review does not disappear into finished
        work. Search by session title or employee, then open the result you need. Each session has
        its own URL, so you can come back tomorrow or send a colleague straight to the work you want
        them to review. Rename a session from its header when the instruction it was opened with
        stops describing it.
      </P>
      <P>
        On a phone or narrow window, the inbox becomes a compact session switcher above the open
        session instead of squeezing the list and the work into two columns. It keeps the same
        direct access to recent sessions, and the current session stays selected as you move between
        its views.
      </P>

      <H3 id="quick-start">Start with a useful brief</H3>
      <P>
        The quick-start surface keeps the employee picker and brief together. Suggested briefs give
        you a concrete starting point for common code and document work; choose one to adapt it, or
        write your own in plain language. An unfinished brief is saved for this repository, so
        opening an existing session or refreshing the page does not throw it away. Starting the
        session clears that saved draft.
      </P>
      <OL>
        <LI>Pick the employee, choose a suggested brief if it helps, and describe the outcome.</LI>
        <LI>
          Genosyn fetches from the remote and starts the session on the repository&apos;s{" "}
          <Strong>default branch</Strong> as it stands there — not on whatever branch the shared
          checkout happens to be sitting on, and not on a trunk that has been left behind. See{" "}
          <Strong>Where a session starts</Strong> below.
        </LI>
        <LI>
          It creates a git <Strong>worktree</Strong> for the session next to the shared checkout, on
          a fresh branch under <Code>genosyn/</Code>. Nobody else is editing it, and two sessions
          never collide.
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
        <LI>
          Follow the instruction and report in <Strong>Activity</Strong>. Every completed turn ends
          at a commit checkpoint showing what that turn alone changed. If it is not right yet, ask
          for changes in the composer — the same employee picks up in the same working copy, on the
          same branch, with everything it already did replayed to it, and commits the revision on
          top.
        </LI>
        <LI>
          Open <Strong>Changes</Strong> for the focused file-by-file diff and the review actions.
          When it is right, accept the work, send it on, or open a pull request for it.
        </LI>
      </OL>
      <P>
        <Strong>Activity</Strong> is the conversation and progress record: instructions, employee
        reports, and commit checkpoints in order. <Strong>Changes</Strong> is the review surface. It
        lists the changed files with their path, change type, and line counts; clicking one opens
        its diff, while <Strong>Expand all</Strong> opens every file. A change small enough to read
        at a glance opens itself. The checkpoint list shows how the work built up, while the file
        list always reviews everything the session branch contains.
      </P>
      <P>
        Merge, push, open or update pull request, and discard actions stay with the Changes review
        instead of being mixed into the activity transcript. Genosyn only shows actions that apply
        to the current state and explains authority boundaries, so a running session cannot look
        ready to publish.
      </P>
      <P>
        The inbox, quick-start surface, open session, and Changes view each show a loading state. If
        a request fails, the affected surface keeps the rest of the session visible and offers
        <Strong>Retry</Strong>; retrying a list or diff does not clear the quick-start draft or move
        you to another session. Empty states distinguish a repository with no sessions from a search
        with no matches. A failed employee turn is different from a page-load failure and remains in
        Activity, where you can ask the employee to try again on the same branch.
      </P>
      <KeyList
        rows={[
          { term: "running", def: "One of the employee's turns is in flight." },
          {
            term: "ready",
            def: "The last turn finished and left commits on the branch, waiting for you to review the diff and decide.",
          },
          {
            term: "empty",
            def: "The last turn finished without committing anything. Not a failure — “I read it and there is nothing to change” is a legitimate answer, and there is nothing to publish. Ask for changes if it should have done something.",
          },
          {
            term: "proposed",
            def: "The branch is pushed and a pull request is open on it. You can still ask for changes; pressing the button again pushes the new commits into the same pull request.",
          },
          {
            term: "published",
            def: "You merged the branch into the shared checkout, and for a remote repository it was pushed.",
          },
          {
            term: "discarded",
            def: "You rejected the work; the worktree and its branch are gone.",
          },
          {
            term: "failed",
            def: "The last turn errored, or its result could not be read afterwards. Ask again to retry on the same branch — earlier commits are kept.",
          },
        ]}
      />
      <P>
        Publishing merges the session&apos;s branch into whatever branch the shared checkout is on.
        The worktree shares the repository&apos;s object store, so the commits are already present
        and nothing has to be transferred. For a remote repository you can push in the same step.
        Merging refuses to run while the shared checkout has uncommitted changes of its own, and a
        merge that would conflict is aborted rather than left half-applied. Only{" "}
        <Code>published</Code> and <Code>discarded</Code> end a session; everything else still
        accepts another instruction.
      </P>

      <H3 id="session-base">Where a session starts</H3>
      <P>
        Work starts from the repository&apos;s <Strong>default branch</Strong>, brought up to date
        first. Genosyn fetches from the remote before every session and takes the trunk from{" "}
        <Code>origin/</Code> rather than from the shared checkout, so an employee is never handed a
        copy of the code from weeks ago and never produces a diff against history your team has
        already moved past.
      </P>
      <P>
        Where it can be done without costing you anything, the local default branch is
        fast-forwarded to match, so the branch list and the file tree stop showing a stale trunk
        too. Three things are deliberately left alone:
      </P>
      <UL>
        <LI>
          <Strong>Local commits you have not pushed.</Strong> Those are the trunk this installation
          actually has, so the session starts from them and nothing is rewritten.
        </LI>
        <LI>
          <Strong>A default branch that has diverged from the remote.</Strong> Reconciling that is a
          decision, not a refresh. Use <Strong>Pull</Strong> when you have decided.
        </LI>
        <LI>
          <Strong>Your uncommitted edits, always.</Strong> If the trunk cannot fast-forward without
          touching them, it is left behind instead. The session still starts from the remote&apos;s
          tip either way.
        </LI>
      </UL>
      <P>
        A session already under way keeps the base it started with. Asking for changes continues on
        the same branch rather than moving the ground under a diff you are in the middle of reading.
      </P>

      <H3 id="pull-requests">Opening a pull request</H3>
      <P>
        For a repository whose remote is on GitHub, <Strong>Open pull request</Strong> is the third
        thing you can do with reviewed work — instead of merging it here or pushing it straight on,
        it pushes the session&apos;s branch and opens a pull request against the repository&apos;s
        default branch, so the work enters whatever review your team already runs. The description
        is the employee&apos;s own report unless you write your own.
      </P>
      <P>
        The branch it opens against comes from GitHub, not from the value stored on the repository:
        Genosyn asks the API what the repository&apos;s default branch is and corrects its own
        record when they disagree. That matters for a repository whose trunk is not{" "}
        <Code>main</Code> — <Code>master</Code>, <Code>develop</Code>, a release branch — because
        the clone URL alone never says so. Cloning a remote repository and{" "}
        <Strong>Test connection</Strong> both record the real branch too, so the rest of the product
        stops guessing at it.
      </P>
      <P>
        Ask for changes afterwards and the button becomes <Strong>Update pull request</Strong>: the
        new commits are pushed onto the same branch and the pull request that is already open picks
        them up. Genosyn never opens a second one for the same branch. The credential comes from the
        repository&apos;s stored token or the company&apos;s{" "}
        <DocLink to="/docs/integrations">GitHub Connection</DocLink>, is used only by the server,
        and — like every push — this is owner and admin only.
      </P>

      <Callout kind="tip" title="This works on the standard Docker install.">
        The standard install can expose bubblewrap-isolated <Code>bash</Code> for other AI work, but
        the browser editor and Repository work sessions do not depend on it. Git runs against a
        server-owned checkout no model process can reach, and the employee&apos;s edits arrive
        through validated tool calls rather than a shell. If bubblewrap cannot start and boot falls
        back to disabled execution, these Repository surfaces still work.
      </Callout>

      <H3 id="sessions-from-chat">Asking for one in chat</H3>
      <P>
        You do not have to open the Repository page first. Ask an employee in ordinary chat to fix a
        bug, update a document, or make a change, and it starts its own work session with the{" "}
        <Code>start_repository_work_session</Code> tool. It can only send itself, and only at a
        repository it has already been granted.
      </P>
      <P>
        The session runs beside the conversation rather than inside it, so the employee replies
        straight away with a link to the repository&apos;s <Strong>AI work</Strong> page instead of
        making you wait — a session may take minutes, and you stay free to keep talking to the same
        employee meanwhile. It appears there exactly like one you started yourself, and you review,
        publish, or discard it the same way.
      </P>
      <Callout kind="warn" title="Starting work is not the same as shipping it.">
        Nothing changes about who decides. A session started from chat lands on its own branch and
        waits for a human, so an employee can begin work on its own and still cannot merge it, push
        it, or open a pull request. If one tells you a change is live, check the session — the
        branch reaching the remote is a step only a Member can take.
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
            def: "Browse the tree, search it, edit, create and delete files, commit, create and switch branches, read history and diffs, start AI work sessions, ask an open session for changes, and merge a session's work into the checkout.",
          },
          {
            term: "Owner / admin",
            def: "Push, pull, opening or updating a pull request for a session, connecting a local repository to a remote, and repository configuration — the clone URL, credentials, default branch, committer identity, and which AI Employees are granted access. Pushing a session's work while publishing it is admin too; merging it is not.",
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
          HTTPS github.com URL, Genosyn authenticates through one of the company&apos;s GitHub{" "}
          <DocLink to="/docs/integrations">Connections</DocLink> instead of a stored credential —
          the one the repository was connected with, or the only one there is. With several and
          nothing pinned it refuses rather than guessing which account should push the
          company&apos;s work. <Strong>Test connection</Strong> follows the same rule. Local
          repositories always use this mode; there is no remote to authenticate to.
        </LI>
        <LI>
          <Strong>HTTPS token / password.</Strong> A username plus a token:{" "}
          <Code>x-access-token</Code> for GitHub, <Code>oauth2</Code> for GitLab, your account name
          for Bitbucket. Use the narrowest repository scope your host offers.
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
          Nothing an AI Employee produced reaches the remote unless a Member reviews it and an owner
          or admin pushes it. Commits, pushes, work sessions, and publishes are all written to the
          audit log.
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
        execution mode is not <Code>disabled</Code>. The standard Docker install ships{" "}
        <Code>bubblewrap</Code>, so it is — unless boot found no usable Linux user namespaces and
        fell back, which is what a container created without{" "}
        <Code>--security-opt seccomp=unconfined --security-opt systempaths=unconfined</Code> does.{" "}
        <Code>genosyn upgrade</Code> recreates such a container with them. A
        subscription-authenticated model needs that working bubblewrap either way. See{" "}
        <DocLink to="/docs/models">AI Models</DocLink> for the modes and{" "}
        <DocLink to="/docs/self-hosting">Configuration</DocLink> for the setting. The browser editor
        and AI work sessions above need none of this.
      </Callout>
      <P>
        The two <Strong>AI access</Strong> levels apply to that checkout.{" "}
        <Strong>Work locally</Strong> tells the employee it may branch, edit, and commit there;{" "}
        <Strong>Reference only</Strong> keeps it for reading. Neither level places a reusable
        credential in a model-controlled tool, so a credentialed push is not something an employee
        can perform from its own shell — that is what publishing a work session, or a Member pushing
        the reported branch, is for. Existing checkouts are only fetched between Runs, never
        hard-reset, so work in progress survives.
      </P>
      <P>
        The default branch of that checkout is fast-forwarded before each Run when doing so cannot
        cost anything — the checkout is on the default branch, nothing is uncommitted, and the move
        is a fast-forward. Otherwise it is left exactly as it is, so an employee&apos;s
        half-finished work is never discarded to make it current.
      </P>

      <H3 id="vs-github">Repositories vs. the GitHub integration</H3>
      <P>
        The <DocLink to="/docs/integrations">GitHub integration</DocLink> is the right tool when an
        employee should call the GitHub API — open an issue, raise a pull request, leave a review —
        against repositories on a connected GitHub account. A Repository is the workspace itself: a
        real working tree that people and AI Employees edit and commit in, on any git host or on
        none. They compose, and the same Connection serves both: it can create the repository on
        GitHub in the first place, and once the change is prepared in the Repository and the branch
        is published, open the pull request for it.
      </P>

      <Callout kind="warn" title="Least privilege.">
        Scope tokens and deploy keys to exactly the repositories they need, and grant AI Employees
        only the repositories they work on — see{" "}
        <DocLink to="/docs/employees">AI Employees</DocLink>. Deleting a repository removes its
        grants, its work sessions, and its server-side checkout, and never touches the remote git
        repository — but a <Strong>local</Strong> repository has no remote, so unless you have
        connected it to one, deleting it deletes the only copy of its history.
      </Callout>
    </>
  );
}
