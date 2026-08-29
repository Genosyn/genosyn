import React from "react";
import { Link } from "react-router-dom";
import { Lock } from "lucide-react";
import { Company, CompanyEntitlements } from "../lib/api";
import { buttonClassName } from "./ui/Button";
import { Card, CardBody } from "./ui/Card";

/**
 * Shown in place of a feature the company's edition or plan does not include
 * (M56). On Genosyn Cloud the way forward is the Settings → Billing page; on
 * a self-hosted install it is a Genosyn Enterprise license activated by a
 * master admin at Admin → License. The server's 402 remains the backstop —
 * this card just tells people before they hit it.
 */

const FEATURE_COPY: Record<
  "sso" | "auditLog",
  { name: string; sentence: string }
> = {
  sso: {
    name: "Single sign-on",
    sentence:
      "Let members sign in through your identity provider instead of a password.",
  },
  auditLog: {
    name: "Audit log",
    sentence:
      "A complete, append-only trail of every change made by members and AI Employees.",
  },
};

export function FeatureGateCard({
  feature,
  entitlements,
  company,
}: {
  feature: "sso" | "auditLog";
  entitlements: CompanyEntitlements;
  company: Company;
}) {
  const copy = FEATURE_COPY[feature];
  const cloud = entitlements.edition === "cloud";
  return (
    <Card>
      <CardBody className="flex flex-col items-start gap-3 p-6">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
          <Lock size={16} />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {copy.name} is available {cloud ? "on Scale" : "in Genosyn Enterprise"}
          </h2>
          <p className="mt-1 max-w-md text-sm text-slate-500 dark:text-slate-400">
            {copy.sentence}
          </p>
        </div>
        {cloud ? (
          company.role === "member" ? (
            // The Billing page is admin-gated server-side; a plain member
            // following the link would land on a 403, so point them at a
            // human instead.
            <p className="text-xs text-slate-400 dark:text-slate-500">
              Ask a company admin to upgrade the plan.
            </p>
          ) : (
            <Link
              to={`/c/${company.slug}/settings/billing`}
              className={buttonClassName({ size: "sm" })}
            >
              View plans
            </Link>
          )
        ) : (
          <>
            <a
              href="https://genosyn.com/pricing"
              target="_blank"
              rel="noreferrer"
              className={buttonClassName({ variant: "secondary", size: "sm" })}
            >
              See Genosyn Enterprise
            </a>
            <p className="text-xs text-slate-400 dark:text-slate-500">
              A master admin can activate a license at Admin &rarr; License.
            </p>
          </>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * Slim inline banner shown above a list that has reached its plan limit —
 * "you're at the cap, here's the way up". Purely informational: the creation
 * buttons stay enabled and the server's 402 remains the enforcement, surfaced
 * in the form's own FormError.
 */
export function PlanLimitBanner({
  message,
  company,
}: {
  message: string;
  company: Company;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 dark:border-slate-700 dark:bg-slate-800/60">
      <div className="flex min-w-0 items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
        <Lock size={14} className="shrink-0 text-slate-400 dark:text-slate-500" />
        <span>{message}</span>
      </div>
      {company.role === "member" ? (
        <span className="shrink-0 text-xs text-slate-400 dark:text-slate-500">
          Ask a company admin to upgrade.
        </span>
      ) : (
        <Link
          to={`/c/${company.slug}/settings/billing`}
          className="shrink-0 text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
        >
          View plans
        </Link>
      )}
    </div>
  );
}
