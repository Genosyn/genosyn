/**
 * The two legal documents the site publishes. Genosyn Connect's pages link to
 * both (`CONNECT_PRIVACY_URL`, `CONNECT_TERMS_URL`), and Google's OAuth consent
 * screen requires the privacy policy, so their paths are permanent.
 */

export type LegalDoc = {
  path: "/privacy" | "/terms";
  title: string;
  description: string;
};

/** When either document last changed; both pages show it. ISO date. */
export const LEGAL_UPDATED = "2026-10-13";

/** Where privacy and terms questions go. */
export const LEGAL_CONTACT = "security@genosyn.com";

export const PRIVACY: LegalDoc = {
  path: "/privacy",
  title: "Privacy Policy",
  description:
    "What HackerBay, Inc. collects through genosyn.com and Genosyn Connect, how Connect handles Google user data, and what the self-hosted software never sends us.",
};

export const TERMS: LegalDoc = {
  path: "/terms",
  title: "Terms of Service",
  description:
    "The terms for using genosyn.com and Genosyn Connect, the hosted sign-in service. The Genosyn software itself is licensed under Apache 2.0.",
};

export const LEGAL_DOCS: LegalDoc[] = [PRIVACY, TERMS];
