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
          Open <Strong>Repositories</Strong> from the section menu, choose{" "}
          <Strong>Add repository</Strong>, give it a name, and choose whether it is{" "}
          <Strong>local</Strong> — created here and never pushed anywhere — or a clone of a
          repository that already exists.
        </LI>
        <LI>
          For a remote repository, paste the clone URL —{" "}
          <Code>https://github.com/acme/web.git</Code> or <Code>git@github.com:acme/web.git</Code> —
          and pick an <Strong>authentication</Strong> mode. Set the default branch and, optionally,
          a committer identity; left blank, commits are committed as <Code>Genosyn</Code>.
        </LI>
        <LI>
          Open the repository. For a remote one, <Strong>Test connection</Strong> confirms Genosyn
          can reach it and detects the default branch, using the stored token or SSH key, else a
          pinned or sole Connection for that server, else anonymous access.
        </LI>
      </OL>
      <P>
        A local repository is created with <Code>git init</Code> on the default branch you chose,
        plus one empty commit, so there is a revision to branch from and diff against before you
        write your first file. It has no remote and uses no authentication — until you connect one.
      </P>

      <H2 id="connect">Connect a local repository to a git host</H2>
      <P>
        A repository that started life inside Genosyn can be given a real remote later, and its
        existing history is pushed into it rather than re-created. Nobody pastes a personal access
        token for this: the company authenticated GitHub once under{" "}
        <Strong>Settings → Integrations</Strong>, and connecting reuses that{" "}
        <DocLink to="/docs/integrations">Connection</DocLink>.
      </P>
      <OL>
        <LI>
          Pick one of the company&apos;s connected GitHub or Forgejo / Gitea Connections — each
          option names its server and the account it authenticates as — then give the repository a
          name there, optionally an organisation to own it, and choose <Strong>private</Strong> (the
          default) or public.
        </LI>
        <LI>
          Genosyn creates it through that server&apos;s API — empty, so the first push is a clean
          fast-forward — and pushes the history into it. Every branch goes across{" "}
          <Strong>except</Strong> the AI work-session ones under <Code>genosyn/</Code>: unreviewed
          AI work must not reach a remote through a button that says nothing about AI.
        </LI>
      </OL>
      <P>
        The other route is to paste the clone URL of an <Strong>empty</Strong> repository you made
        yourself, anywhere, and let Genosyn push into that. An HTTPS URL on a server the company has
        connected authenticates through that Connection; for any other host you can supply an HTTPS
        token or an SSH key in the same step, stored encrypted exactly as on a cloned repository. A
        remote that already has commits is refused with an explanation rather than force-pushed.
        Afterwards push, pull, and refresh behave exactly as they do for a repository that was
        cloned. Connecting is <Strong>owner or admin</Strong> only, for the same reason pushing is,
        and it is written to the audit log.
      </P>

      <H2 id="files">Browse and edit files</H2>
      <P>
        Opening a repository shows the working tree of a checkout Genosyn keeps on the server. The
        tree is read from disk rather than from git, so a file you just created appears before you
        have committed it. Symlinks and the <Code>.git</Code> directory are never listed, one
        directory shows at most 2,000 entries, and <Code>.gitignore</Code> is respected — ignored
        entries are hidden, with a toggle that brings them back dimmed.
      </P>
      <P>
        Open a file to edit it in place, with syntax highlighting. You can create, rename, move, and
        delete files and folders; a new empty folder gets a <Code>.gitkeep</Code> so it survives a
        reload, and a <Code>README</Code> at the root is rendered on the Overview page. Files above{" "}
        <Strong>1 MB</Strong> are not rendered at all; files above <Strong>256 KB</Strong> open
        read-only, as do binary files and any file opened at an older revision.{" "}
        <Strong>Search</Strong> finds text anywhere in the checkout, including files nobody has
        committed yet. The changed-files list comes from <Code>git status</Code>; discarding changes
        is scoped to the paths you pick — there is no discard-everything button on a checkout the
        whole company shares.
      </P>

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
          <Strong>Refresh</Strong> is the explicit &ldquo;go and talk to the remote&rdquo; that
          fetches. <Strong>Pull</Strong> is fast-forward only; a diverged branch is reported rather
          than merged. <Strong>Push</Strong> sends one branch using the stored credential or the
          Connection the repository was connected with.
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
        The <Strong>AI work</Strong> page is a searchable session inbox, grouped by what needs
        attention so running or ready-to-review work does not disappear into finished work. Each
        session has its own URL, so you can send a colleague straight to the work you want them to
        review. Rename a session from its header when the instruction it was opened with stops
        describing it, and <Strong>archive</Strong> one you are finished with. On a narrow window
        the inbox becomes a compact switcher above the open session.
      </P>

      <H3 id="quick-start">Start with a useful brief</H3>
      <P>
        The quick-start surface keeps the employee picker and brief together. Suggested briefs give
        you a concrete starting point; choose one to adapt it, or write your own in plain language.
        An unfinished brief is saved for this repository until the session starts.
      </P>
      <OL>
        <LI>Pick the employee, choose a suggested brief if it helps, and describe the outcome.</LI>
        <LI>
          Genosyn fetches from the remote and starts the session on the repository&apos;s{" "}
          <Strong>default branch</Strong> as it stands there — see{" "}
          <Strong>Where a session starts</Strong> below — in a git <Strong>worktree</Strong> of its
          own, on a fresh branch under <Code>genosyn/</Code>. Two sessions never collide.
        </LI>
        <LI>
          If the repository has an <Code>AGENTS.md</Code> at its root — or a <Code>CLAUDE.md</Code>{" "}
          when it has no <Code>AGENTS.md</Code> — it is included in the employee&apos;s briefing, so
          the work follows your conventions.
        </LI>
        <LI>
          The employee works through tools Genosyn runs on its behalf, and gets no filesystem access
          of its own. It can list the files and find them by name pattern, search their contents,
          read a file with line numbers, change one by exact replacement of text it copied from a
          read, create or delete a file, check its working copy&apos;s status and diff, keep a
          visible step list of its plan, and commit. Where your installation has the isolation for
          it, it can also <Strong>run commands</Strong> in its working copy — your tests, your
          linter, your build — so it verifies its own work before you read the diff. What it may run
          is yours to decide; see <DocLink to="#commands">Commands</DocLink>.
        </LI>
        <LI>
          It commits its work and writes a short report of what it changed, what it left alone, and
          what it could not verify. Anything it left uncommitted when the turn ends — because it hit
          its turn limit, was stopped, or failed — is committed for it as a checkpoint named as such,
          so nothing it wrote is lost and everything is in the diff you review.
        </LI>
        <LI>
          Follow the work in <Strong>Activity</Strong>. If it is not right yet, ask for changes in
          the composer — the same employee picks up in the same working copy, on the same branch,
          and commits the revision on top.
        </LI>
        <LI>
          Open <Strong>Changes</Strong> for the file-by-file diff and the review actions. When it is
          right, accept the work, send it on, or open a pull request for it.
        </LI>
      </OL>
      <P>
        <Strong>Activity</Strong> shows each brief, and under it a live feed of how the employee is
        going about it: every tool call as one line — <em>Read src/router.ts</em>,{" "}
        <em>Ran npm test → Exit 1</em> — with a spinner until its result lands, a red tint when it
        failed, and a chevron that opens the detail: the exact edit as removed and added text, the
        command and what it printed, the file that was read. The employee&apos;s narration appears
        between the calls as it thinks, and its step list is pinned at the top with{" "}
        <em>n of m done</em>. A finished turn folds the feed to one line —{" "}
        <em>14 tool calls · 3 files edited · 2 commands run</em> — above the report, and you can
        open it again whenever you want to check how a change came to be.
      </P>
      <P>
        While a turn runs, a <Strong>Stop</Strong> button sits in the session header. Stopping ends
        the turn where it is: whatever the employee had committed stays on the branch, anything it
        had edited and not yet committed becomes a checkpoint commit, and the session accepts
        another instruction — so a stop is a chance to redirect, not a discard. The stopped turn is
        marked as such in Activity, with whatever report it managed to write. A turn that reaches
        its limit of model turns before finishing is kept the same way, with a note saying so.
      </P>
      <P>
        <Strong>Changes</Strong> is the review surface. It lists the changed files with their path,
        change type, and line counts; clicking one opens its diff, while <Strong>Expand all</Strong>{" "}
        opens every file, and a change small enough to read at a glance opens itself. The checkpoint
        list shows how the work built up, while the file list always reviews everything the session
        branch contains. Merge, push, pull request, and discard live here rather than in the
        transcript, and only the actions that apply to the current state are shown. If a request
        fails, the affected surface keeps the rest of the session visible and offers{" "}
        <Strong>Retry</Strong>.
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
        Those are the session&apos;s states. Each turn inside it has one of its own — running, ok,
        failed, or <Strong>stopped</Strong> when a Member used the Stop button — and a stopped turn
        lands the session on <Code>ready</Code> or <Code>empty</Code> depending on whether it had
        committed anything, so the session stays open for another pass.
      </P>
      <P>
        Publishing merges the session&apos;s branch into whatever branch the shared checkout is on.
        The worktree shares the repository&apos;s object store, so the commits are already present.
        For a remote repository you can push in the same step. Merging refuses to run while the
        shared checkout has uncommitted changes of its own, and a merge that would conflict is
        aborted rather than left half-applied. Only <Code>published</Code> and{" "}
        <Code>discarded</Code> end a session; everything else still accepts another instruction.
      </P>

      <H3 id="archiving">Clearing the inbox</H3>
      <P>
        <Strong>Archive</Strong> a finished session to file it away: the inbox gets shorter and
        nothing else changes. The branch, the commits, the transcript, and the session&apos;s status
        are all left exactly as they were, and its URL keeps working — which is what makes archiving
        different from throwing the work away.
      </P>
      <UL>
        <LI>
          Archive from a session&apos;s header, or from its row in the inbox. There is no
          confirmation step, because there is nothing to undo; <Strong>Restore</Strong> puts it back
          exactly where it was. The archive lives behind the <Strong>Archive</Strong> toggle at the
          top of the inbox, and archived sessions leave the <Strong>needs attention</Strong> count.
        </LI>
        <LI>
          Asking an archived session for another pass restores it automatically, and a session with
          a turn in flight cannot be archived at all. Work running inside something filtered out of
          view is the one state an inbox must never produce.
        </LI>
      </UL>

      <H3 id="session-base">Where a session starts</H3>
      <P>
        Work starts from the repository&apos;s <Strong>default branch</Strong>, brought up to date
        first. Genosyn fetches from the remote before every session and takes the trunk from{" "}
        <Code>origin/</Code> rather than from the shared checkout, so an employee is never handed a
        copy of the code from weeks ago. Where it can be done without costing you anything, the
        local default branch is fast-forwarded to match. Three things are deliberately left alone:
        <Strong>local commits you have not pushed</Strong>, which are the trunk this installation
        actually has, so the session starts from them;{" "}
        <Strong>a default branch that has diverged from the remote</Strong>, because reconciling
        that is a decision, not a refresh — use <Strong>Pull</Strong> when you have decided; and{" "}
        <Strong>your uncommitted edits, always</Strong> — if the trunk cannot fast-forward without
        touching them, it is left behind instead, and the session still starts from the
        remote&apos;s tip.
      </P>
      <P>
        A session already under way keeps the base it started with. Asking for changes continues on
        the same branch rather than moving the ground under a diff you are in the middle of reading.
      </P>

      <H3 id="agents-md">AGENTS.md</H3>
      <P>
        If your repository keeps an <Code>AGENTS.md</Code> at its root, Genosyn reads it and
        includes it in the employee&apos;s briefing for every session; a repository that keeps a{" "}
        <Code>CLAUDE.md</Code> instead is read the same way. It is the ordinary convention for
        telling contributors how to work in a repository — the vocabulary to use, the stack, what
        gets a change sent back — and an employee that has read it produces work you merge rather
        than work you have to explain. Large guides are truncated in the briefing, and the employee
        is told to read the rest with its own file-reading tool. The file is treated as a document,
        not as instructions from you: it cannot widen what a session is allowed to do, and the tools
        a session gets are fixed regardless of what any file in the repository says.
      </P>

      <H3 id="commands">Commands</H3>
      <P>
        An employee that can only write files has to hand you work it hopes is right. One that can
        run your tests hands you work it has checked. On the repository&apos;s{" "}
        <Strong>Settings</Strong> page, under <Strong>Commands</Strong>, you choose which it is:
      </P>
      <UL>
        <LI>
          <Strong>No commands</Strong> — the employee reads, writes, and commits, and nothing else.
        </LI>
        <LI>
          <Strong>Allowed commands only</Strong> — the default. Anything matching the
          repository&apos;s list runs; anything else is refused, and the employee is told which part
          of its command was refused and that an owner or admin can add it. Leave the list empty to
          use Genosyn&apos;s built-in one, which covers the usual test, lint, and build tooling and
          leaves out the verbs a work session has no business reaching for — no <Code>curl</Code>,
          no <Code>ssh</Code>, no <Code>git push</Code>, no package-manager installs onto the host.
        </LI>
        <LI>
          <Strong>Every command</Strong> — no list and no check, for a repository whose own tooling
          needs more than a list can express.
        </LI>
      </UL>
      <P>
        A pattern is a command with an optional trailing <Code>*</Code> that matches the rest of it,
        so <Code>npm run *</Code> allows every npm script while <Code>npm test</Code> allows only
        itself. Every part of a chained command is checked separately —{" "}
        <Code>npm test &amp;&amp; curl example.com</Code> is refused for the second half — and the
        constructs that would hide what actually runs, such as <Code>$(…)</Code> and redirection,
        are refused rather than guessed at. Lines beginning with <Code>#</Code> are comments.
      </P>
      <Callout kind="info" title="The list is intent. The isolation is the boundary.">
        Whichever mode you pick, a command runs behind <Code>bubblewrap</Code> with the
        session&apos;s own worktree as its entire filesystem: no shared checkout, no other session,
        no rest of the server, no <Code>git</Code>, and no network unless your installation allows
        one. Where that isolation is unavailable — <Code>disabled</Code> or <Code>host</Code>{" "}
        execution — work sessions run without commands whatever this setting says. Genosyn does not
        give an AI Employee a shell outside a sandbox.
      </Callout>
      <Callout kind="warn" title="A working copy holds only what git tracks.">
        A session&apos;s worktree is created from the repository&apos;s history, so it has no{" "}
        <Code>node_modules</Code>, no virtualenv, and no vendor directory. A repository whose checks
        need those can fetch them only where your installation allows the sandbox a network (
        <Code>agent.codingTools.allowNetwork</Code> in <Code>config.ts</Code>, off by default).
        Without one, the employee tells you it could not install them rather than reporting checks
        it did not run.
      </Callout>
    </>
  );
}
