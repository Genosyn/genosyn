import { ArrowRight, BookHeart, CalendarClock, Sparkles } from "lucide-react";
import { Link } from "@/lib/router";
import {
  Callout,
  Code,
  DocLink,
  ExtLink,
  H2,
  P,
  PageHeader,
  Strong,
  UL,
  LI,
} from "@/docs/Prose";
import { GITHUB_URL } from "@/lib/constants";

export function Introduction() {
  return (
    <>
      <PageHeader
        eyebrow="Welcome"
        title="Run autonomous companies."
        lead={
          <>
            Genosyn is an open-source, self-hostable platform for hiring{" "}
            <Strong>AI employees</Strong>. Each one has a written soul, a set of
            skills, and routines on a schedule. They wake up, do their job, and
            report what they shipped.
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
          body="Cron-scheduled briefs. Genosyn runs them on time and saves a Run log."
        />
      </div>

      <H2 id="what-genosyn-is">What Genosyn is</H2>
      <P>
        A <Strong>Company</Strong> in Genosyn has human{" "}
        <DocLink to="/docs/vocabulary">Members</DocLink> and{" "}
        <DocLink to="/docs/employees">AI Employees</DocLink>. Each AI employee
        is a persistent persona — they have a name, a role, an{" "}
        <DocLink to="/docs/models">AI Model</DocLink>, and a body of work that
        accumulates over time. The whole employee fits in three editable text
        fields: a <DocLink to="/docs/soul">Soul</DocLink>, a list of{" "}
        <DocLink to="/docs/skills">Skills</DocLink>, and a calendar of{" "}
        <DocLink to="/docs/routines">Routines</DocLink>.
      </P>
      <P>
        Everything is plain markdown stored on the database row. You can read
        it, diff it, copy it, share it — there is no opaque &ldquo;agent
        configuration&rdquo; in another system. The runtime is{" "}
        <Code>node-cron</Code> running an in-process agent inside the
        employee&apos;s sandboxed directory, with credentials scoped to that
        employee only.
      </P>

      <H2 id="who-its-for">Who it&apos;s for</H2>
      <UL>
        <LI>
          <Strong>Solo founders</Strong> who want a finance employee, a brand
          writer, and an on-call SRE without hiring three humans.
        </LI>
        <LI>
          <Strong>Small teams</Strong> tired of one-off LLM chatbots and want
          AI work that runs reliably, on time, with a paper trail.
        </LI>
        <LI>
          <Strong>Anyone</Strong> who prefers their tools open source,
          self-hosted, and BYOK — bring your own Anthropic / OpenAI API keys
          (or a custom OpenAI-compatible endpoint).
        </LI>
      </UL>

      <H2 id="design-principles">Design principles</H2>
      <UL>
        <LI>
          <Strong>Markdown everywhere.</Strong> Soul, Skills, and Routines are
          markdown. No proprietary DSL, no node graph you can&apos;t read out
          loud.
        </LI>
        <LI>
          <Strong>One Docker image.</Strong> Backend, frontend, cron, MCP
          servers — all in a single container. No microservice sprawl.
        </LI>
        <LI>
          <Strong>The database is the source of truth.</Strong> Model
          credentials are encrypted at rest in the database; everything else
          lives in SQLite (or Postgres, your call) too.
        </LI>
        <LI>
          <Strong>BYO model.</Strong> Genosyn doesn&apos;t resell AI. You
          bring your own Anthropic / OpenAI API keys (or a custom
          OpenAI-compatible endpoint) and point each employee at the model you
          choose.
        </LI>
      </UL>

      <H2 id="where-to-start">Where to start</H2>
      <P>
        If you&apos;ve never run Genosyn before, the fastest path is{" "}
        <DocLink to="/docs/install">Install</DocLink> →{" "}
        <DocLink to="/docs/employees">create your first AI employee</DocLink> →{" "}
        <DocLink to="/docs/routines">schedule a routine</DocLink>. That whole
        loop takes about ten minutes if Docker is already running.
      </P>
      <P>
        Once you&apos;re signed in, every session starts on{" "}
        <Strong>Home</Strong> — unread mentions and DMs, todos assigned to
        you, reviews and approvals waiting on your decision, today&apos;s AI
        activity, and shortcuts to every section. When something needs you,
        it&apos;s the first thing you see.
      </P>
      <P>
        To get anywhere else, press <Code>⌘K</Code> (<Code>Ctrl K</Code> on
        Windows and Linux). That opens the command palette: every section in
        one searchable list, with Essentials first — type a few letters, press{" "}
        <Code>↵</Code>, done. It answers to the words you already know, so
        &ldquo;cron&rdquo; finds{" "}
        <DocLink to="/docs/routines">Routines</DocLink> and
        &ldquo;slack&rdquo; finds Workspace. The section pill in the top nav
        opens the same palette if you&apos;d rather click.
      </P>
      <P>
        The palette searches your company&apos;s content too, not just the
        section list. Type two or more characters and matching AI employees,
        skills, routines, notebooks, notes, bases, channels, projects, todos,
        customers, charts, dashboards, repositories, and pipelines appear
        grouped beneath the sections. It matches <em>names</em> — plus a few fields you&apos;d
        naturally reach for, like a customer&apos;s email, a channel&apos;s
        topic, or an employee&apos;s role — never document bodies. Press{" "}
        <Code>↵</Code> to open a result; a todo takes you to its
        project&apos;s board, ticket number in hand. Results respect what you
        can see: restricted projects and private channels you aren&apos;t in
        stay out of the list.
      </P>

      <Callout kind="tip" title="Open source, no strings.">
        Genosyn ships under MIT. The source lives at{" "}
        <ExtLink href={GITHUB_URL}>github.com/genosyn/genosyn</ExtLink>. File
        issues, send PRs, fork it — that&apos;s what it&apos;s there for.
      </Callout>

      <div className="mt-12">
        <Link
          href="/docs/install"
          className="inline-flex items-center gap-2 rounded-xl bg-zinc-950 px-5 py-2.5 text-sm font-semibold text-white shadow-card transition hover:bg-zinc-800"
        >
          Install Genosyn
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </>
  );
}

function Primitive({
  icon,
  tag,
  body,
}: {
  icon: React.ReactNode;
  tag: string;
  body: string;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-card">
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-zinc-100 text-zinc-700 ring-1 ring-zinc-200">
          {icon}
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
          {tag}
        </span>
      </div>
      <p className="mt-3 text-[13.5px] leading-[1.6] text-zinc-700">{body}</p>
    </div>
  );
}
