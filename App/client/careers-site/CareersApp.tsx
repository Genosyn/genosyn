import React from "react";
import { Link, Route, Routes, useLocation, useParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, Briefcase, Clock, Globe2, Lock, MapPin, Search, Users, Wallet } from "lucide-react";

import {
  EMPLOYMENT_TYPE_LABELS,
  WORKPLACE_TYPE_LABELS,
  type EmploymentType,
  type WorkplaceType,
} from "../../shared/recruiting";
import { ApplyForm } from "./ApplyForm";
import { CareersApiError, fetchOpening, fetchSite } from "./api";
import {
  EMPTY_FILTERS,
  applyByLabel,
  distinctValues,
  filterOpenings,
  groupByDepartment,
  hasActiveFilters,
  postedLabel,
  type OpeningFilters,
} from "./lib";
import type { CareersBootstrap, PublicOpening, PublicOpeningCard, PublicSite } from "./types";
import {
  LoadingPage,
  Markdown,
  MessagePage,
  Pill,
  SiteFooter,
  SiteHeader,
  accentButton,
  brandStyle,
  quietButton,
} from "./ui";

/**
 * The careers site: a front page of open roles and one page per Opening with
 * its application form. The server sends the first page's data inside the
 * HTML, so the first paint needs no request; moving between pages fetches.
 */

const filterSelect =
  "rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700 shadow-sm focus:border-[color:var(--accent)] focus:outline-none focus:ring-4 focus:ring-[color:var(--accent-ring)]";

function useDocumentTitle(title: string) {
  React.useEffect(() => {
    document.title = title;
  }, [title]);
}

function OpeningRow({ opening }: { opening: PublicOpeningCard }) {
  return (
    <li>
      <Link
        to={`/openings/${opening.slug}`}
        className="group flex items-center gap-4 px-5 py-5 transition hover:bg-slate-50 focus:outline-none focus-visible:bg-slate-50 sm:px-6"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-semibold text-slate-900 transition group-hover:text-[color:var(--accent)]">
              {opening.title}
            </span>
            {opening.visibility === "internal" ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                <Lock aria-hidden className="h-3 w-3" /> Internal
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-slate-500">{opening.meta}</p>
          {opening.summary ? <p className="mt-2 line-clamp-2 text-sm text-slate-600">{opening.summary}</p> : null}
        </div>
        <div className="hidden shrink-0 text-right sm:block">
          {opening.compensation ? (
            <p className="text-sm font-medium text-slate-800">{opening.compensation}</p>
          ) : null}
          <p className="mt-1 text-xs text-slate-400">{postedLabel(opening.publishedAt)}</p>
        </div>
        <ArrowRight
          aria-hidden
          className="h-5 w-5 shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-[color:var(--accent)]"
        />
      </Link>
    </li>
  );
}

function Filters({
  openings,
  filters,
  onChange,
}: {
  openings: PublicOpeningCard[];
  filters: OpeningFilters;
  onChange: (filters: OpeningFilters) => void;
}) {
  const departments = distinctValues(openings, "department");
  const locations = distinctValues(openings, "location");
  const workplaces = distinctValues(openings, "workplace") as WorkplaceType[];
  const types = distinctValues(openings, "employmentType") as EmploymentType[];
  return (
    <div className="mt-6 flex flex-col gap-3 lg:flex-row lg:items-center">
      <label className="relative flex-1">
        <span className="sr-only">Search openings</span>
        <Search aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          type="search"
          value={filters.query}
          onChange={(event) => onChange({ ...filters, query: event.target.value })}
          placeholder="Search roles"
          className="w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-10 pr-3 text-sm shadow-sm placeholder:text-slate-400 focus:border-[color:var(--accent)] focus:outline-none focus:ring-4 focus:ring-[color:var(--accent-ring)]"
        />
      </label>
      <div className="grid grid-cols-2 gap-3 sm:flex sm:flex-wrap">
        {departments.length > 1 ? (
          <select
            aria-label="Team"
            className={filterSelect}
            value={filters.department}
            onChange={(event) => onChange({ ...filters, department: event.target.value })}
          >
            <option value="">All teams</option>
            {departments.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        ) : null}
        {locations.length > 1 ? (
          <select
            aria-label="Location"
            className={filterSelect}
            value={filters.location}
            onChange={(event) => onChange({ ...filters, location: event.target.value })}
          >
            <option value="">All locations</option>
            {locations.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        ) : null}
        {workplaces.length > 1 ? (
          <select
            aria-label="Workplace"
            className={filterSelect}
            value={filters.workplace}
            onChange={(event) => onChange({ ...filters, workplace: event.target.value as WorkplaceType | "" })}
          >
            <option value="">Remote or on-site</option>
            {workplaces.map((value) => (
              <option key={value} value={value}>
                {WORKPLACE_TYPE_LABELS[value]}
              </option>
            ))}
          </select>
        ) : null}
        {types.length > 1 ? (
          <select
            aria-label="Type"
            className={filterSelect}
            value={filters.employmentType}
            onChange={(event) =>
              onChange({ ...filters, employmentType: event.target.value as EmploymentType | "" })
            }
          >
            <option value="">All types</option>
            {types.map((value) => (
              <option key={value} value={value}>
                {EMPLOYMENT_TYPE_LABELS[value]}
              </option>
            ))}
          </select>
        ) : null}
      </div>
    </div>
  );
}

function HomePage({
  site,
  initial,
}: {
  site: PublicSite;
  initial: PublicOpeningCard[] | null;
}) {
  const [openings, setOpenings] = React.useState<PublicOpeningCard[] | null>(initial);
  const [error, setError] = React.useState("");
  const [filters, setFilters] = React.useState<OpeningFilters>(EMPTY_FILTERS);
  useDocumentTitle(`Careers at ${site.name}`);

  React.useEffect(() => {
    if (initial) return;
    let cancelled = false;
    fetchSite(site.apiPath)
      .then((result) => {
        if (!cancelled) setOpenings(result.openings);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "The openings could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [initial, site.apiPath]);

  const visible = openings ? filterOpenings(openings, filters) : [];
  const groups = groupByDepartment(visible);
  const total = openings?.length ?? 0;

  return (
    <main>
      <section className="border-b border-slate-100 bg-gradient-to-b from-[color:var(--accent-soft)] to-white">
        <div className="mx-auto max-w-5xl px-5 pb-14 pt-16 sm:px-8 sm:pt-20">
          <p className="text-sm font-semibold uppercase tracking-[0.14em] text-[color:var(--accent)]">
            Careers at {site.name}
          </p>
          <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
            {site.headline || `Do the best work of your life at ${site.name}.`}
          </h1>
          {site.intro ? <Markdown source={site.intro} className="mt-6 max-w-2xl text-lg text-slate-600" /> : null}
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <a href="#openings" className={accentButton}>
              {openings === null
                ? "See open roles"
                : total === 0
                  ? "No open roles right now"
                  : `See ${total} open ${total === 1 ? "role" : "roles"}`}
              <ArrowRight aria-hidden className="h-4 w-4" />
            </a>
            {site.viewer.member && site.visibility === "public" ? (
              <span className="text-sm text-slate-500">Members also see internal openings.</span>
            ) : null}
          </div>
        </div>
      </section>

      <section id="openings" className="mx-auto max-w-5xl scroll-mt-6 px-5 pb-24 pt-14 sm:px-8">
        <div className="flex items-end justify-between gap-4">
          <h2 className="text-2xl font-semibold tracking-tight text-slate-950">Open roles</h2>
          {openings && total > 0 ? (
            <p className="text-sm text-slate-500">
              {hasActiveFilters(filters) ? `${visible.length} of ${total}` : total} {total === 1 ? "opening" : "openings"}
            </p>
          ) : null}
        </div>

        {error ? (
          <div className="mt-8 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</div>
        ) : openings === null ? (
          <LoadingPage />
        ) : total === 0 ? (
          <div className="mt-8 rounded-3xl border border-dashed border-slate-200 px-6 py-16 text-center">
            <Briefcase aria-hidden className="mx-auto h-8 w-8 text-slate-300" />
            <p className="mt-4 text-base font-medium text-slate-900">No open roles right now</p>
            <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
              We are not hiring for anything at the moment. Check back soon
              {site.websiteUrl ? (
                <>
                  , or learn more about us at{" "}
                  <a href={site.websiteUrl} className="font-medium text-[color:var(--accent)] hover:underline">
                    our website
                  </a>
                </>
              ) : null}
              .
            </p>
          </div>
        ) : (
          <>
            {total > 3 ? <Filters openings={openings} filters={filters} onChange={setFilters} /> : null}
            {visible.length === 0 ? (
              <div className="mt-8 rounded-3xl border border-dashed border-slate-200 px-6 py-12 text-center">
                <p className="text-base font-medium text-slate-900">No roles match</p>
                <button type="button" onClick={() => setFilters(EMPTY_FILTERS)} className={`${quietButton} mt-5`}>
                  Clear filters
                </button>
              </div>
            ) : (
              <div className="mt-8 space-y-10">
                {groups.map((group) => (
                  <div key={group.department || "_"}>
                    {groups.length > 1 || group.department ? (
                      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-500">
                        {group.department || "Other roles"}
                        <span className="font-normal text-slate-400">{group.openings.length}</span>
                      </h3>
                    ) : null}
                    <ul className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                      {group.openings.map((opening) => (
                        <OpeningRow key={opening.slug} opening={opening} />
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}

function Fact({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 text-slate-400">{icon}</span>
      <div>
        <dt className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</dt>
        <dd className="mt-0.5 text-sm font-medium text-slate-800">{children}</dd>
      </div>
    </div>
  );
}

function OpeningPage({
  site,
  initial,
}: {
  site: PublicSite;
  initial: PublicOpening | null;
}) {
  const { openingSlug = "" } = useParams<{ openingSlug: string }>();
  const startWith = initial && initial.slug === openingSlug ? initial : null;
  const [opening, setOpening] = React.useState<PublicOpening | null>(startWith);
  const [missing, setMissing] = React.useState(false);
  const [error, setError] = React.useState("");
  useDocumentTitle(opening ? `${opening.title} · ${site.name}` : `Careers at ${site.name}`);

  React.useEffect(() => {
    if (opening && opening.slug === openingSlug) return;
    let cancelled = false;
    setOpening(null);
    setMissing(false);
    setError("");
    fetchOpening(site.apiPath, openingSlug)
      .then((result) => {
        if (!cancelled) setOpening(result.opening);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof CareersApiError && cause.status === 404) setMissing(true);
        else setError(cause instanceof Error ? cause.message : "This opening could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
    // `opening` is deliberately left out: only a new slug should refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openingSlug, site.apiPath]);

  React.useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [openingSlug]);

  if (missing) return <NotFoundPage site={site} />;
  if (error) {
    return (
      <MessagePage
        title="Something went wrong"
        body={error}
        action={
          <Link to="/" className={quietButton}>
            All openings
          </Link>
        }
      />
    );
  }
  if (!opening) return <LoadingPage />;

  const applyBy = applyByLabel(opening.applyBy);

  return (
    <main className="mx-auto max-w-5xl px-5 pb-24 pt-8 sm:px-8 sm:pt-10">
      <Link to="/" className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-900">
        <ArrowLeft aria-hidden className="h-4 w-4" /> All openings
      </Link>
      <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[color:var(--accent)]">{opening.department || site.name}</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">{opening.title}</h1>
          <div className="mt-5 flex flex-wrap gap-2">
            <Pill tone="accent">{EMPLOYMENT_TYPE_LABELS[opening.employmentType]}</Pill>
            <Pill>{WORKPLACE_TYPE_LABELS[opening.workplace]}</Pill>
            {opening.location ? <Pill>{opening.location}</Pill> : null}
            {opening.visibility === "internal" ? <Pill>Internal</Pill> : null}
          </div>
          {opening.summary ? <p className="mt-6 text-lg leading-relaxed text-slate-600">{opening.summary}</p> : null}
          <Markdown source={opening.description} className="mt-8" />
          <section id="apply" className="mt-14 scroll-mt-6">
            {opening.accepting ? (
              <ApplyForm site={site} opening={opening} />
            ) : (
              <div className="rounded-3xl border border-slate-200 bg-slate-50 p-8 text-center">
                <h2 className="text-lg font-semibold text-slate-900">This opening is closed</h2>
                <p className="mt-2 text-sm text-slate-600">It is no longer taking applications. Thank you for your interest.</p>
                <Link to="/" className={`${quietButton} mt-6`}>
                  See open roles
                </Link>
              </div>
            )}
          </section>
        </div>
        <aside className="h-fit lg:sticky lg:top-8">
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <dl className="space-y-5">
              {opening.compensation ? (
                <Fact icon={<Wallet aria-hidden className="h-4 w-4" />} label="Pay">
                  {opening.compensation}
                </Fact>
              ) : null}
              <Fact icon={<Briefcase aria-hidden className="h-4 w-4" />} label="Type">
                {EMPLOYMENT_TYPE_LABELS[opening.employmentType]}
              </Fact>
              <Fact icon={<Globe2 aria-hidden className="h-4 w-4" />} label="Workplace">
                {WORKPLACE_TYPE_LABELS[opening.workplace]}
              </Fact>
              {opening.location ? (
                <Fact icon={<MapPin aria-hidden className="h-4 w-4" />} label="Location">
                  {opening.location}
                </Fact>
              ) : null}
              {opening.headcount > 1 ? (
                <Fact icon={<Users aria-hidden className="h-4 w-4" />} label="Hiring">
                  {opening.headcount} people
                </Fact>
              ) : null}
              {applyBy || opening.publishedAt ? (
                <Fact icon={<Clock aria-hidden className="h-4 w-4" />} label="Timing">
                  {applyBy ?? postedLabel(opening.publishedAt)}
                </Fact>
              ) : null}
            </dl>
            {opening.accepting ? (
              <a href="#apply" className={`${accentButton} mt-7 w-full`}>
                Apply now
              </a>
            ) : null}
          </div>
        </aside>
      </div>
    </main>
  );
}

function NotFoundPage({ site }: { site: PublicSite | null }) {
  useDocumentTitle(site ? `Not found · ${site.name}` : "Not found");
  return (
    <MessagePage
      title="We could not find that page"
      body="The opening may have closed, or the link may be mistyped."
      action={
        site ? (
          <Link to="/" className={accentButton}>
            See open roles
          </Link>
        ) : undefined
      }
    />
  );
}

function MembersOnlyPage({ signInUrl }: { signInUrl: string }) {
  useDocumentTitle("Careers");
  return (
    <MessagePage
      title="This careers site is for Members"
      body="Sign in with the account you use for this company, then open this page again."
      action={
        <a href={signInUrl} className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white hover:bg-slate-800">
          Sign in
        </a>
      }
    />
  );
}

function useScrollToHash() {
  const location = useLocation();
  React.useEffect(() => {
    if (!location.hash) return;
    const target = document.getElementById(location.hash.slice(1));
    target?.scrollIntoView({ behavior: "smooth" });
  }, [location]);
}

export function CareersApp({ bootstrap }: { bootstrap: CareersBootstrap | null }) {
  useScrollToHash();
  const location = useLocation();
  // The server's "not found" describes the page it rendered; after the
  // visitor navigates away, the router decides.
  const [firstPath] = React.useState(location.pathname);
  if (!bootstrap || bootstrap.kind === "members_only") {
    return (
      <div className="min-h-screen bg-white">
        <MembersOnlyPage signInUrl={bootstrap?.signInUrl ?? "/login"} />
      </div>
    );
  }
  const site = bootstrap.site;
  if (!site) {
    return (
      <div className="min-h-screen bg-white">
        <NotFoundPage site={null} />
      </div>
    );
  }
  return (
    <div className="flex min-h-screen flex-col bg-white" style={brandStyle(site.accentColor)}>
      <SiteHeader site={site} />
      <div className="flex-1">
        {bootstrap.kind === "not_found" && location.pathname === firstPath ? (
          <NotFoundPage site={site} />
        ) : (
          <Routes>
            <Route
              path="/"
              element={<HomePage site={site} initial={bootstrap.kind === "home" ? bootstrap.openings : null} />}
            />
            <Route
              path="/openings/:openingSlug"
              element={<OpeningPage site={site} initial={bootstrap.opening} />}
            />
            <Route path="*" element={<NotFoundPage site={site} />} />
          </Routes>
        )}
      </div>
      <SiteFooter site={site} />
    </div>
  );
}
