import { ArrowRight, BookHeart, CalendarClock, Sparkles } from "lucide-react";
import { Link } from "@/lib/router";
import { Callout, Code, DocLink, ExtLink, H2, P, PageHeader, Strong, UL, LI } from "@/docs/Prose";
import { GITHUB_URL } from "@/lib/constants";

export function Introduction() {
  return (
    <>
      <PageHeader
        eyebrow="Welcome"
        title="Build an autonomous company."
        lead={
          <>
            Genosyn is an open-source, self-hostable platform for running a company with{" "}
            <Strong>AI employees</Strong>. Each one has a written soul, a set of skills, and
            routines on a schedule. They wake up on their own, do the job, and report what they
            shipped — and only the decisions that need a person come back to you.
          </>
        }
      />

      <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Primitive
          icon={<BookHeart className="h-4 w-4" />}
          tag="Soul"
          body="One markdown document that defines how an employee thinks and what they refuse."
        />
        <Primitive
          icon={<Sparkles className="h-4 w-4" />}
          tag="Skills"
          body="Named markdown playbooks the employee follows when work matches the trigger."
        />
        <Primitive
          icon={<CalendarClock className="h-4 w-4" />}
          tag="Routines"
          body="Cron-scheduled briefs that start themselves. Genosyn runs them on time and saves a Run log."
        />
      </div>

      <H2 id="what-genosyn-is">What Genosyn is</H2>
      <P>
        A <Strong>Company</Strong> in Genosyn has human{" "}
        <DocLink to="/docs/vocabulary">Members</DocLink> and{" "}
        <DocLink to="/docs/employees">AI Employees</DocLink>. Each AI employee is a persistent
        persona — they have a name, a role, an <DocLink to="/docs/models">AI Model</DocLink>, and a
        body of work that accumulates over time. The whole employee fits in three editable text
        fields: a <DocLink to="/docs/soul">Soul</DocLink>, a list of{" "}
        <DocLink to="/docs/skills">Skills</DocLink>, and a calendar of{" "}
        <DocLink to="/docs/routines">Routines</DocLink>.
      </P>
      <P>
        Everything is plain markdown stored on the database row. You can read it, diff it, copy it,
        share it — there is no opaque &ldquo;agent configuration&rdquo; in another system. The
        scheduler is <Code>node-cron</Code>, which invokes the selected agent runtime with tools
        rooted in the employee&apos;s sandboxed directory and credentials scoped to that employee
        only.
      </P>

      <H2 id="who-its-for">Who it&apos;s for</H2>
      <UL>
        <LI>
          <Strong>Solo founders</Strong> who want a finance employee, a brand writer, and an on-call
          SRE without hiring three humans.
        </LI>
        <LI>
          <Strong>Small teams</Strong> tired of one-off LLM chatbots and want AI work that runs
          reliably, on time, with a paper trail.
        </LI>
        <LI>
          <Strong>Anyone</Strong> who prefers their tools open source, self-hosted, and
          bring-your-own-model: use Anthropic / OpenAI API keys, a custom OpenAI-compatible
          endpoint, or eligible ChatGPT subscription access for OpenAI on a trusted single-tenant
          install. Docker runs isolated coding with bubblewrap by default, and falls back to
          subscription work without coding where Linux namespaces are unavailable.
        </LI>
      </UL>

      <H2 id="design-principles">Design principles</H2>
      <UL>
        <LI>
          <Strong>Markdown everywhere.</Strong> Soul, Skills, and Routines are markdown. No
          proprietary DSL, no node graph you can&apos;t read out loud.
        </LI>
        <LI>
          <Strong>One Docker image.</Strong> Backend, frontend, cron, MCP servers — all in a single
          container. No microservice sprawl.
        </LI>
        <LI>
          <Strong>The database is the source of truth.</Strong> Model credentials are encrypted at
          rest in the database; everything else lives in SQLite (or Postgres, your call) too.
        </LI>
        <LI>
          <Strong>BYO model.</Strong> Genosyn doesn&apos;t resell AI. You bring an Anthropic /
          OpenAI API key, a custom OpenAI-compatible endpoint, or eligible ChatGPT subscription
          access for OpenAI on a trusted single-tenant install, then point each employee at the
          model you choose. The Docker default runs isolated coding and repository work with
          bubblewrap, subscriptions included. Claude subscription credentials
          are not supported; see <DocLink to="/docs/models">AI Models</DocLink>.
        </LI>
        <LI>
          <Strong>Fast feedback.</Strong> Everyday actions update the screen immediately while the
          server finishes in the background. Progress follows you between pages; if a request fails,
          Genosyn surfaces the error and restores the affected item or draft.
        </LI>
        <LI>
          <Strong>Room to work.</Strong> Operational pages expand to the full main pane, so tables,
          dashboards, and queues make useful use of large monitors while reading and writing
          surfaces retain focused line lengths.
        </LI>
        <LI>
          <Strong>Live by default.</Strong> Because your AI employees work on their own schedule,
          the screens stay live: a routine finishing, an employee moving a todo or leaving a
          comment, an invoice going out, a base record being written — the list or page you&apos;re
          looking at refreshes itself over a single WebSocket, no reload required. It works the same
          across browser tabs and, in shared-SaaS mode, across replicas.
        </LI>
      </UL>

      <H2 id="where-to-start">Where to start</H2>
      <P>
        If you&apos;ve never run Genosyn before, the fastest path is{" "}
        <DocLink to="/docs/install">Install</DocLink> →{" "}
        <DocLink to="/docs/employees">create your first AI employee</DocLink> →{" "}
        <DocLink to="/docs/routines">schedule a routine</DocLink>. That whole loop takes about ten
        minutes if Docker is already running.
      </P>
      <P>
        Once you&apos;re signed in, every session starts on <Strong>Home</Strong> — unread mentions
        and DMs, todos assigned to you, reviews and approvals waiting on your decision, the latest
        unread <DocLink to="/docs/tldrs">TLDR</DocLink>, today&apos;s AI activity, and shortcuts to
        every section. When something needs you — or a fresh recap is ready — it&apos;s the first
        thing you see.
      </P>
      <P>
        Home only shows you what it actually has. Every queue — the{" "}
        <DocLink to="/docs/decisions">decision stack</DocLink>, failed{" "}
        <DocLink to="/docs/routines">routines</DocLink>, mentions,{" "}
        <DocLink to="/docs/tasks">todos</DocLink>, reviews, unread messages, approvals, system
        health — disappears when it&apos;s empty rather than sitting there reporting that nothing is
        waiting. Dismissing a TLDR removes it from your Home only; its history remains available,
        and colleagues keep seeing it until they dismiss it themselves. So the page is only ever
        as long as your day is busy, and on a quiet one it says{" "}
        <Strong>Nothing needs you right now</Strong> and leaves it at that.
      </P>
      <P>
        To get anywhere else, press <Code>⌘K</Code> (<Code>Ctrl K</Code> on Windows and Linux). That
        opens the command palette: every section in one searchable list, with Essentials first —
        type a few letters, press <Code>↵</Code>, done. It answers to the words you already know, so
        &ldquo;cron&rdquo; finds <DocLink to="/docs/routines">Routines</DocLink> and
        &ldquo;slack&rdquo; finds Workspace. The section pill in the top nav opens the same palette
        if you&apos;d rather click.
      </P>
      <P>
        For pages you use every day, press <Code>G</Code> and then the page&apos;s letter:{" "}
        <Code>G H</Code> opens Home, <Code>G E</Code> opens AI Employees, and <Code>G R</Code> opens
        Routines. Pressing <Code>G</Code>
        shows the complete destination map, so you never have to guess. Press <Code>?</Code>{" "}
        anywhere outside an editor to open the full shortcut guide. Genosyn pauses global shortcuts
        while you type, and ordinary <Code>Tab</Code> navigation has clear, context-appropriate
        focus styling plus a skip-to-main link.
      </P>
      <P>
        Dropdown fields are searchable throughout Genosyn. Open one and start typing to narrow its
        choices; use the arrow keys and <Code>↵</Code> to select. Lists populated from live company
        data update their search results as new choices load, and grouped or multi-select fields use
        the same search interaction.
      </P>
      <P>
        The palette searches your company&apos;s content too, not just the section list. Type two or
        more characters and matching AI employees, skills, routines, notebooks, notes, bases,
        channels, projects, todos, customers, charts, dashboards, repositories, and pipelines appear
        grouped beneath the sections. It matches <em>names</em> — plus a few fields you&apos;d
        naturally reach for, like a customer&apos;s email, a channel&apos;s topic, or an
        employee&apos;s role — never document bodies. Press <Code>↵</Code> to open a result; a todo
        takes you to its project&apos;s board, ticket number in hand. Results respect what you can
        see: restricted projects and private channels you aren&apos;t in stay out of the list.
      </P>

      <Callout kind="tip" title="Open source, permissively licensed.">
        Genosyn ships under Apache 2.0. The source lives at{" "}
        <ExtLink href={GITHUB_URL}>github.com/genosyn/genosyn</ExtLink>. File issues, send PRs, fork
        it — that&apos;s what it&apos;s there for.
      </Callout>

      <div className="mt-12">
        <Link
          href="/docs/install"
          className="inline-flex items-center gap-2 rounded-xl bg-night-950 px-5 py-2.5 text-sm font-semibold text-white shadow-card transition hover:bg-tide-600"
        >
          Install Genosyn
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </>
  );
}

function Primitive({ icon, tag, body }: { icon: React.ReactNode; tag: string; body: string }) {
  return (
    <div className="rounded-xl border border-stone-900/[0.08] bg-white p-4 shadow-card">
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-paper-200 text-stone-700 ring-1 ring-stone-900/[0.08]">
          {icon}
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-500">
          {tag}
        </span>
      </div>
      <p className="mt-3 text-[13.5px] leading-[1.6] text-stone-700">{body}</p>
    </div>
  );
}
