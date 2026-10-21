import type {
  EmploymentType,
  OpeningFormSettings,
  OpeningQuestion,
  OpeningVisibility,
  WorkplaceType,
} from "../../shared/recruiting";

/**
 * The careers site's view of the server's public DTOs
 * (`server/services/recruiting/site.ts` and `pages.ts`). Nothing here carries
 * criteria, scores or screeners: a careers site publishes the role, never how
 * applicants are judged.
 */

export type PublicSite = {
  companySlug: string;
  name: string;
  headline: string;
  intro: string;
  websiteUrl: string;
  privacyPolicyUrl: string;
  accentColor: string;
  logoUrl: string | null;
  visibility: "public" | "internal";
  url: string;
  apiPath: string;
  viewer: { member: boolean; name: string; email: string };
};

export type PublicOpeningCard = {
  slug: string;
  title: string;
  summary: string;
  department: string;
  location: string;
  workplace: WorkplaceType;
  employmentType: EmploymentType;
  visibility: OpeningVisibility;
  meta: string;
  compensation: string | null;
  publishedAt: string | null;
  applyBy: string | null;
  url: string;
};

export type PublicOpening = PublicOpeningCard & {
  description: string;
  headcount: number;
  accepting: boolean;
  status: "draft" | "open" | "closed";
  form: OpeningFormSettings;
  questions: OpeningQuestion[];
};

export type CareersBootstrap = {
  kind: "home" | "opening" | "not_found" | "members_only";
  basePath: string;
  site: PublicSite | null;
  openings: PublicOpeningCard[];
  opening: PublicOpening | null;
  signInUrl: string;
};
