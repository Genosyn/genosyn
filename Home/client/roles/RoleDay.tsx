import { Mark } from "@/components/Marks";
import { type RoleDef, type RoleMoment } from "@/roles/data";
import {
  Body,
  Chip,
  DEPT_FULL,
  DEPT_TEXT,
  Field,
  Note,
  Pane,
  Row,
  Sheet,
  StateTag,
  Subhead,
  TextLink,
  type Dept,
} from "@/sections/Kit";

/**
 * One role's working day, and the rail that reads it back.
 *
 * Shared by the landing page's role switcher and by every role page, because
 * the day is the argument on both and two drawings of it would drift. The
 * schedule and the rail stay separate exports so a page can lay them out in
 * whatever grid it needs.
 *
 * ## The day is the clearest picture of the org chart on the site
 *
 * Two different bindings are at work here and they are not the same fact:
 *
 *   - **The pane's 3px top edge is the ROLE's department.** Robin is in
 *     Revenue; that never changes while you read her Tuesday.
 *   - **Each row's 3px spine is the department of the PRODUCT that hour of
 *     work happened in.** Robin's day runs through Revenue, then Email, then
 *     Workspace, so her rows are three different hues under one Revenue edge.
 *
 * That is what an employee actually is — someone who belongs to one department
 * and works across several — and drawing both bindings at once is the reason
 * this component earns the colour rather than just wearing it. Painting every
 * row in the role's own hue was tried first and it says nothing: eight
 * identical stripes are a border, not a legend.
 *
 * ## The one black row
 *
 * The header used to be a solid `bg-ink` bar, which spent the palette's one
 * hue-less value on chrome. It is now a Pane wearing its department edge, and
 * ink is reserved for the moment the day stopped: the Decision or Approval row
 * is filled black, so in a day of six or seven coloured rows the eye lands on
 * exactly one, and it is the one that needs a person. The `StateTag` on that
 * row inverts to ground-on-ink for the same reason a chip inverts anywhere
 * else — the human state is always the highest-contrast thing in view.
 */

/* -------------------------------------------------------------------------
   The two bindings
------------------------------------------------------------------------- */

/**
 * Role → department. Every role belongs to one, by discipline rather than by
 * which products it happens to touch: the Bookkeeper is Finance even on the
 * hour she spends in Explore.
 *
 * Keyed by slug rather than by `discipline`, because the discipline strings are
 * prose owned by `roles/data.ts` ("Sales development", "Customer support") and
 * a rename there would silently drop a role's hue. A slug is a route.
 *
 * `people` belongs to the Recruiter and to nothing else — it is the one hue
 * with no Board lane and no product behind it, which is exactly why it must
 * never be borrowed for emphasis somewhere a department is not being named.
 */
export const ROLE_DEPT: Record<string, Dept> = {
  sdr: "revenue",
  "executive-assistant": "workspace",
  marketer: "marketing",
  support: "email",
  bookkeeper: "finance",
  engineer: "repositories",
  recruiter: "people",
  analyst: "operations",
};

/** Operations is the fallback because it is the department that owns the
    plumbing — a role with no mapping is, by definition, unassigned work. */
export function roleDept(role: RoleDef): Dept {
  return ROLE_DEPT[role.slug] ?? "operations";
}

/** The department's own name, for chips and legends. Never the role's
    discipline: "Sales development" is the job, Revenue is the department. */
export const DEPT_LABEL: Record<Dept, string> = {
  finance: "Finance",
  repositories: "Repositories",
  marketing: "Marketing",
  workspace: "Workspace",
  email: "Email",
  revenue: "Revenue",
  operations: "Operations",
  people: "People",
};

/**
 * Product → department, keyed on the first segment of `RoleMoment.where`
 * ("Revenue · Sequences" → Revenue). Thirteen products, seven departments.
 *
 * The groupings that are not one-to-one, and why:
 *
 *   - Tasks, Notes, Bases and Resources are **Workspace**. They are the shared
 *     internal record — where a thing gets written down so somebody else can
 *     read it — which is the same job the Workspace pane does on the wall.
 *   - Customers is **Revenue**. An account record and a Deal are two views of
 *     one relationship, and splitting them would need an eighth hue.
 *   - Explore and Pipelines are **Operations**. Both are the substrate the
 *     company runs on rather than a department's own surface.
 *
 * Decisions and Approvals are deliberately absent. They are not products and
 * they are not a department: they are the human, and the human has no hue.
 */
const PRODUCT_DEPT: Record<string, Dept> = {
  Revenue: "revenue",
  Customers: "revenue",
  Email: "email",
  Finance: "finance",
  Repositories: "repositories",
  "Paid Marketing": "marketing",
  Workspace: "workspace",
  Tasks: "workspace",
  Notes: "workspace",
  Bases: "workspace",
  Resources: "workspace",
  Explore: "operations",
  Pipelines: "operations",
};

function momentDept(moment: RoleMoment): Dept | undefined {
  return PRODUCT_DEPT[moment.where.split("·")[0]];
}

/** Position on the 24-hour strip. */
const pct = (hours: number) => `${(hours / 24) * 100}%`;

/** The employee stopped here — a Decision it wrote, or an Approval it hit. */
function isStop(moment: RoleMoment): moment is RoleMoment & { kind: "decision" | "approval" } {
  return moment.kind === "decision" || moment.kind === "approval";
}

const STOP_WORD = { decision: "Decision", approval: "Approval" } as const;

/* -------------------------------------------------------------------------
   The day
------------------------------------------------------------------------- */

export function DaySchedule({ role }: { role: RoleDef }) {
  const dept = roleDept(role);

  // Counted and named separately: a Decision and an Approval are different
  // stops (see the note on RoleMoment.kind), and a header that called one the
  // other would undo the distinction the rest of the page is making.
  const decisions = role.day.filter((moment) => moment.kind === "decision").length;
  const approvals = role.day.filter((moment) => moment.kind === "approval").length;
  const stops = [
    decisions && `${decisions} ${decisions === 1 ? "DECISION" : "DECISIONS"}`,
    approvals && `${approvals} ${approvals === 1 ? "APPROVAL" : "APPROVALS"}`,
  ].filter(Boolean);

  return (
    <Pane dept={dept}>
      {/* Pane's own `title`/`meta` header holds two strings and this one holds
          five, so the header is drawn here. The chip is the legend key for the
          edge above it: without it the reader has a coloured pane and no way
          to learn what the colour means. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-hairline px-4 pt-5 pb-3">
        <Chip dept={dept}>{DEPT_LABEL[dept]}</Chip>
        <span className="t-h3 text-[15px] text-ink">Tuesday</span>
        <span className="text-[13px] leading-5 text-ink2">{`${role.person} · ${role.name}`}</span>
        <span className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1">
          {/* `Sheet` and not `Field`: this is a label the page is saying out
              loud, and t-data is reserved for strings the software emitted.
              The count beside it is emitted, so the two faces differ on
              purpose even though they sit in the same group. */}
          <Sheet>SAMPLE DAY</Sheet>
          <Field>{[`${role.day.length} RUNS`, ...stops].join("·")}</Field>
        </span>
      </div>

      <Strip role={role} />

      {/* No horizontal padding: the rows are full-bleed so their department
          spines sit on the pane's own left edge and read as one column of
          colour rather than eight floating tabs. */}
      <div className="pb-1">
        {role.day.map((moment) => (
          <MomentRow key={moment.time} moment={moment} />
        ))}
      </div>
    </Pane>
  );
}

/**
 * The day as a 24-hour strip.
 *
 * **A moment is drawn as a tick, not as a bar, and that is a truth claim.** On
 * the board in the hero every bar's width is the Run's duration, because the
 * data carries one. A `RoleMoment` carries a start and nothing else, so
 * inventing a width here would be the one thing this whole design is against:
 * a rectangle that looks like measurement and is not. Ticks say what is known.
 *
 * Each tick carries its product's department hue, so the strip is the day's
 * org chart at a glance — the reader sees three colours cluster in the morning
 * and a fourth appear at 17:45 before reading a single word. The ticks used to
 * be uniformly `bg-ink`, which drew the machine's work in the human's colour
 * and left the stop with nothing of its own.
 *
 * The stop gets the treatment the 09:30 arrival line gets on the board — a
 * flag in a reserved row above the lane and a 2px ink rule down through it.
 * Anchoring the flag beside the tick was tried first and the label ran over
 * the next two ticks; more to the point, this is the same event as 09:30. It
 * is the boundary where the machine hands the day back to a person, and it is
 * the only thing on the strip with no hue.
 *
 * It is `aria-hidden` and it costs nothing to hide: every moment on it is
 * printed in full, in order, in the rows underneath. Below `md` it is not
 * rendered at all rather than squeezed, because a timeline that reflows at
 * 375px has stopped being a timeline.
 */
function Strip({ role }: { role: RoleDef }) {
  const stop = role.day.find(isStop);

  return (
    <div aria-hidden className="hidden border-b border-hairline px-5 pt-4 pb-2 md:block">
      <div className="relative pt-7">
        <div className="hours absolute top-7 right-0 bottom-6 left-0" />

        {/* Quarter marks, so the eye has something to measure against without
            turning the strip into graph paper. */}
        {[6, 12, 18].map((hour) => (
          <div
            key={hour}
            className="absolute top-7 bottom-6 w-px bg-rule"
            style={{ left: pct(hour) }}
          />
        ))}

        {stop && (
          <>
            <span
              className="arrive-in rounded-chip absolute top-0 z-10 flex h-6 items-center gap-1.5 bg-ink px-2 text-ground"
              style={{ left: pct(stop.at) }}
            >
              <Mark state={stop.kind} className="h-2.5 w-2.5" />
              <span className="t-data whitespace-nowrap text-[10px] leading-none">
                {`${stop.time} ${STOP_WORD[stop.kind].toUpperCase()}`}
              </span>
            </span>
            {/* Every worked day in the roster stops between 11:00 and 16:00, so
                the flag is left-anchored and has room to run. */}
            <span
              className="arrive-in absolute top-7 bottom-6 w-0.5 bg-ink"
              style={{ left: pct(stop.at) }}
            />
          </>
        )}

        <div className="relative h-[2.375rem] border-b border-hairline">
          {/* The stop is drawn by the ink rule above, so it does not also get a
              tick: two marks for one event reads as two events. */}
          {role.day
            .filter((moment) => !isStop(moment))
            .map((moment) => {
              const dept = momentDept(moment);
              return (
                <span
                  key={moment.time}
                  // `bg-rule` and not `bg-ink` for an unmapped product: ink on
                  // this strip means "a person is needed", and a tick that
                  // simply has no department must not claim that.
                  className={`absolute top-1/2 h-[1.375rem] w-[3px] -translate-y-1/2 ${
                    dept ? DEPT_FULL[dept] : "bg-rule"
                  }`}
                  style={{ left: pct(moment.at) }}
                />
              );
            })}
        </div>

        <div className="relative h-6">
          {[0, 6, 12, 18].map((hour) => (
            <span
              key={hour}
              className="t-data absolute top-1.5 text-[10px] leading-none text-muted"
              style={{ left: pct(hour) }}
            >
              {`${String(hour).padStart(2, "0")}:00`}
            </span>
          ))}
          <span className="t-data absolute top-1.5 right-0 text-[10px] leading-none text-muted">
            24:00
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * One hour of the day: clock, state, what happened, where it happened.
 *
 * The product line is a plain mono span rather than `Field`, and that is the
 * one place this file steps outside the kit on purpose: `Field` hard-codes
 * `text-muted`, and this line is where the department is named in words. The
 * spine says which hue, the line says which department — a legend needs both
 * halves or it is decoration.
 */
function MomentRow({ moment }: { moment: RoleMoment }) {
  if (isStop(moment)) {
    return <StopRow moment={moment} />;
  }

  const dept = momentDept(moment);

  return (
    <Row dept={dept} className="pr-4 last:border-b-0 sm:pr-5">
      <Field className="w-[3.25rem] shrink-0 sm:w-[3.75rem]">{moment.time}</Field>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {/* The mark stays `muted`. An icon is never coloured on this site:
              the hue is carried by the spine, which is a department, and a
              second coloured object in the same row would read as a second
              fact. */}
          <Mark state="run" className="h-3 w-3 text-muted" />
          <h3 className="text-[15px] leading-6 text-ink">{moment.title}</h3>
        </div>

        <Body className="mt-2 max-w-[70ch] text-[14px] leading-6">{moment.body}</Body>
        <span
          className={`t-data mt-3 block text-[11px] leading-4 ${
            dept ? DEPT_TEXT[dept] : "text-muted"
          }`}
        >
          {moment.where}
        </span>
      </div>
    </Row>
  );
}

/**
 * The hour the day stopped.
 *
 * Drawn here rather than through `Row` because `Row` cannot express a filled
 * row — it offers a hue spine, and this row's whole point is that it has no
 * hue. The geometry is copied from `Row` exactly (the same `-mt-px`, the same
 * `border-y`, the same `py-4`) so it sits in the stack without a seam of its
 * own; only the fill differs, which is the intended reading: same day, same
 * list, one black line across it.
 *
 * The mark inside the `StateTag` is the Decision / Approval distinction drawn
 * rather than captioned — one shape open on the right because it is waiting,
 * the other barred because the system got in the way — and it means the two
 * states are still told apart with the colour turned off.
 *
 * `where` is "Decisions" or "Approvals" here, which is why it takes no hue:
 * neither is a department, and both are the one queue that is yours.
 */
function StopRow({ moment }: { moment: RoleMoment & { kind: "decision" | "approval" } }) {
  return (
    <div className="relative -mt-px flex items-start gap-x-6 gap-y-2 border-y border-ink bg-ink py-4 pr-4 pl-4 text-ground last:border-b-0 sm:pr-5">
      <span className="t-data w-[3.25rem] shrink-0 text-[11px] leading-4 text-hairline sm:w-[3.75rem]">
        {moment.time}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {/* Inverted with `!`, because `StateTag` bakes in `bg-ink text-ground`
              and this is the one surface where that skin would vanish. The
              inversion is not a special case: ground on ink is 16.43:1, so the
              human state stays the highest-contrast thing in view either way. */}
          <StateTag state={moment.kind} className="!bg-ground !text-ink">
            <Mark state={moment.kind} className="h-2.5 w-2.5" />
            {STOP_WORD[moment.kind]}
          </StateTag>
          <h3 className="text-[15px] leading-6 text-ground">{moment.title}</h3>
        </div>

        <p className="mt-2 max-w-[70ch] text-[14px] leading-6 text-hairline">{moment.body}</p>
        <span className="t-data mt-3 block text-[11px] leading-4 text-dim">{moment.where}</span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------
   The rail
------------------------------------------------------------------------- */

/**
 * The right rail: who this is, what the day produced, and what it asked.
 *
 * The two tallies are the inversion stated twice in one column. What the day
 * produced carries the role's department hue as a single 3px spine, because it
 * is the machine's output; what it brought back carries an ink spine, because
 * it is yours. A spine per row was tried and it stutters — one bar down a
 * group says "this whole block belongs to one thing", which is the fact.
 *
 * `identity` draws the who-is-this block. The role page turns it off — the
 * hero two screens up has already introduced the employee, and repeating the
 * name, the summary and a link to the page you are already on is the kind of
 * duplication that makes a page feel padded.
 *
 * The department is a `Chip` — it is the key for the coloured spine further
 * down this same column, and a legend stated in grey is not a legend. The
 * discipline stays a `Sheet` beside it: "Sales development" is the job, not a
 * department, and a hue only ever means its department. The heading dropped
 * from the `t-h2` ramp to `t-h3` at the same time — a 3.25rem headline inside
 * a 20rem column is a heading that has escaped its column, and `t-h3` is the
 * ramp the kit reserves for exactly this.
 *
 * The questions used to sit in a tinted box with a shield icon on it, which
 * spent colour on a decoration and labelled every question a Decision whether
 * it was one or not. They are now plain rows under a column header, and the
 * note underneath states the split rather than the box implying it.
 */
export function RoleRail({ role, identity = true }: { role: RoleDef; identity?: boolean }) {
  const dept = roleDept(role);

  return (
    <div className="flex flex-col gap-12">
      {identity && (
        <div>
          {/* The chip names the DEPARTMENT, not the discipline. Colouring
              `role.discipline` broke the legend outright: the Assistant's
              discipline string is "Operations", so the rail printed the word
              Operations in the Workspace hue while the Analyst's tab and
              roster spine two hundred pixels away were the real Operations
              hue — two colours, one word. The discipline is still stated, in
              grey, beside it, because it is the job and not a department. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Chip dept={dept}>{DEPT_LABEL[dept]}</Chip>
            <Sheet>{role.discipline}</Sheet>
          </div>
          <Subhead className="mt-3">{role.name}</Subhead>
          <Body className="mt-4">{role.summary}</Body>
          <TextLink href={`/roles/${role.slug}`} className="mt-6">
            {`Read the ${role.name} page`}
          </TextLink>
        </div>
      )}

      <div>
        <Sheet>By the end of the day</Sheet>
        <div className="relative mt-4 pl-4">
          <span aria-hidden className={`absolute inset-y-0 left-0 w-[3px] ${DEPT_FULL[dept]}`} />
          {role.outputs.map((output) => (
            <Row key={output.label} className="items-baseline last:border-b-0">
              {/* A produced figure, set at figure size rather than in the
                  heading ramp: it is a count the software would print, so it
                  is tabular and it is not a heading. */}
              <span className="t-h2 tabular w-[5.5rem] shrink-0 text-[1.5rem] leading-none text-ink">
                {output.value}
              </span>
              <Body className="min-w-0 flex-1 text-[13px] leading-5">{output.label}</Body>
            </Row>
          ))}
        </div>
      </div>

      <div>
        <Sheet>What it brought back</Sheet>
        <div className="relative mt-4 pl-4">
          <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-ink" />
          {role.decisions.map((question) => (
            <Row key={question} className="last:border-b-0">
              <Body className="text-[13px] leading-5">{question}</Body>
            </Row>
          ))}
        </div>
        <Note className="mt-5 text-[15px] leading-[1.65]">
          A Decision is the employee choosing to ask. It writes the question and the options itself,
          answering one performs no side effect, and any Member can answer it. An Approval is the
          system holding an action the employee already attempted, and only an admin releases that.
        </Note>
      </div>
    </div>
  );
}
