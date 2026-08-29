import React from "react";
import { useOutletContext } from "react-router-dom";
import { Check } from "lucide-react";
import { api, BillingSummary, PlanId } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { TopBar } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { FormError, FormSuccess } from "../components/ui/FormError";
import { Spinner } from "../components/ui/Spinner";
import { clsx } from "../components/ui/clsx";
import type { SettingsOutletCtx } from "./SettingsLayout";

/**
 * Settings → Billing (M56). The company's Plan on a Genosyn Cloud install:
 * what they're on, what it includes, and the way up. Checkout and the Stripe
 * billing portal are owner-only; admins can read everything. On a self-hosted
 * install (instance billing disabled) the page explains itself away.
 */

const PLAN_ORDER: Record<PlanId, number> = { free: 0, growth: 1, scale: 2 };

const PLAN_META: Record<PlanId, { name: string; blurb: string; bullets: string[] }> = {
  free: {
    name: "Free",
    blurb: "Try Genosyn with a starter team.",
    bullets: ["1 AI Employee", "2 Routines"],
  },
  growth: {
    name: "Growth",
    blurb: "For companies putting AI Employees to work.",
    bullets: [
      "Unlimited AI Employees",
      "Unlimited Routines",
      "Per-employee pricing",
    ],
  },
  scale: {
    name: "Scale",
    blurb: "Everything in Growth, plus enterprise controls.",
    bullets: [
      "Everything in Growth",
      "Single sign-on",
      "Audit log",
    ],
  },
};

function formatCents(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

function statusChipClass(status: string | null): string {
  if (status === "active" || status === "trialing") {
    return "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300";
  }
  if (status === "past_due" || status === "unpaid" || status === "incomplete") {
    return "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300";
  }
  return "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300";
}

export function SettingsBilling() {
  const { company } = useOutletContext<SettingsOutletCtx>();
  const [summary, setSummary] = React.useState<BillingSummary | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [busyPlan, setBusyPlan] = React.useState<PlanId | null>(null);
  const [portalBusy, setPortalBusy] = React.useState(false);
  const checkoutHandledRef = React.useRef(false);

  const isOwner = company.role === "owner";

  const reload = React.useCallback(async () => {
    try {
      const next = await api.get<BillingSummary>(`/api/companies/${company.id}/billing`);
      setSummary(next);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load billing"));
    }
  }, [company.id]);

  // Returning from Stripe Checkout: `?checkout=success` means the
  // subscription very likely changed but the webhook may not have landed
  // yet — sync once so the page doesn't show the old plan, then strip the
  // param so a reload doesn't sync again.
  React.useEffect(() => {
    if (checkoutHandledRef.current) return;
    checkoutHandledRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const checkout = params.get("checkout");
    if (checkout) {
      params.delete("checkout");
      const qs = params.toString();
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${qs ? `?${qs}` : ""}`,
      );
    }
    if (checkout === "success") {
      setNotice("Subscription updated.");
      api
        .post<BillingSummary>(`/api/companies/${company.id}/billing/sync`)
        .then((next) => {
          setSummary(next);
          setLoadError(null);
        })
        .catch(() => reload());
      return;
    }
    void reload();
  }, [company.id, reload]);

  if (loadError) {
    return (
      <>
        <TopBar title="Billing" />
        <FormError message={loadError} />
      </>
    );
  }
  if (summary === null) {
    return (
      <>
        <TopBar title="Billing" />
        <Spinner />
      </>
    );
  }

  if (!summary.enabled) {
    return (
      <>
        <TopBar title="Billing" />
        <EmptyState
          title="Billing is not enabled on this install"
          description="Self-hosted Genosyn has no per-company plans — every company runs with unlimited AI Employees and Routines. Enterprise features are unlocked with a license."
          action={
            <a
              href="https://genosyn.com/pricing"
              target="_blank"
              rel="noreferrer"
              className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
            >
              See Genosyn plans and Enterprise licensing
            </a>
          }
        />
      </>
    );
  }

  async function openPortal() {
    if (portalBusy) return;
    setPortalBusy(true);
    setError(null);
    try {
      const { url } = await api.post<{ url: string }>(
        `/api/companies/${company.id}/billing/portal`,
      );
      window.location.assign(url);
    } catch (err) {
      setError(errorMessage(err));
      setPortalBusy(false);
    }
  }

  async function checkout(plan: PlanId) {
    if (plan === "free" || busyPlan) return;
    setBusyPlan(plan);
    setError(null);
    try {
      const { url } = await api.post<{ url: string }>(
        `/api/companies/${company.id}/billing/checkout`,
        { plan },
      );
      window.location.assign(url);
    } catch (err) {
      setError(errorMessage(err));
      setBusyPlan(null);
    }
  }

  const meta = PLAN_META[summary.plan];
  const limited = summary.limits.maxRoutines !== null;
  const priceFor = (plan: PlanId): string =>
    plan === "free"
      ? "$0"
      : plan === "growth"
        ? formatCents(summary.prices.growth.unitAmount)
        : formatCents(summary.prices.scale.unitAmount);

  return (
    <>
      <TopBar title="Billing" />
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold">{meta.name} plan</h2>
                {summary.status && (
                  <span
                    className={clsx(
                      "rounded-full px-2 py-0.5 text-[11px] font-medium capitalize",
                      statusChipClass(summary.status),
                    )}
                  >
                    {summary.status.replace(/_/g, " ")}
                  </span>
                )}
              </div>
              {summary.portalAvailable && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={openPortal}
                  disabled={!isOwner || portalBusy}
                  title={isOwner ? undefined : "Only the company owner can manage billing"}
                >
                  {portalBusy ? "Opening…" : "Manage billing"}
                </Button>
              )}
            </div>
          </CardHeader>
          <CardBody className="flex flex-col gap-1 text-sm text-slate-600 dark:text-slate-300">
            <div>
              {summary.aiEmployeeCount} AI Employee
              {summary.aiEmployeeCount === 1 ? "" : "s"}
              {summary.seatCount !== null && <> &middot; billed seats {summary.seatCount}</>}
            </div>
            {limited && (
              <div>
                {summary.routineCount} of {summary.limits.maxRoutines} Routines used
              </div>
            )}
            {summary.currentPeriodEnd && (
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Current period ends {new Date(summary.currentPeriodEnd).toLocaleDateString()}
              </div>
            )}
          </CardBody>
        </Card>

        <FormSuccess message={notice} />

        <div className="grid gap-4 sm:grid-cols-3">
          {(["free", "growth", "scale"] as const).map((plan) => (
            <PlanCard
              key={plan}
              plan={plan}
              price={priceFor(plan)}
              current={summary.plan === plan}
              upgrade={PLAN_ORDER[plan] > PLAN_ORDER[summary.plan]}
              isOwner={isOwner}
              stripeConfigured={summary.stripeConfigured}
              busy={busyPlan === plan}
              anyBusy={busyPlan !== null}
              onChoose={() => checkout(plan)}
            />
          ))}
        </div>

        <FormError message={error} />

        {!summary.stripeConfigured && (
          <p className="text-xs text-slate-400 dark:text-slate-500">
            Billing is not fully configured on this install yet — plan changes are
            unavailable until the operator finishes the Stripe setup.
          </p>
        )}
        {!isOwner && (
          <p className="text-xs text-slate-400 dark:text-slate-500">
            Only the company owner can change the plan or open the billing portal.
          </p>
        )}
      </div>
    </>
  );
}

function PlanCard({
  plan,
  price,
  current,
  upgrade,
  isOwner,
  stripeConfigured,
  busy,
  anyBusy,
  onChoose,
}: {
  plan: PlanId;
  price: string;
  current: boolean;
  upgrade: boolean;
  isOwner: boolean;
  stripeConfigured: boolean;
  busy: boolean;
  anyBusy: boolean;
  onChoose: () => void;
}) {
  const meta = PLAN_META[plan];
  const paid = plan !== "free";
  const label = `${upgrade ? "Upgrade" : "Switch"} to ${meta.name}`;
  return (
    <Card className={clsx("flex flex-col", current && "ring-1 ring-indigo-200 dark:ring-indigo-500/30")}>
      <CardBody className="flex flex-1 flex-col gap-3 p-5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{meta.name}</h3>
          {current && (
            <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300">
              Current plan
            </span>
          )}
        </div>
        <div className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
          {price}
          {paid && (
            <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
              {" "}
              / AI Employee / month
            </span>
          )}
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">{meta.blurb}</p>
        <ul className="flex flex-col gap-1.5 text-sm text-slate-600 dark:text-slate-300">
          {meta.bullets.map((bullet) => (
            <li key={bullet} className="flex items-start gap-2">
              <Check size={14} className="mt-0.5 shrink-0 text-emerald-500" />
              <span>{bullet}</span>
            </li>
          ))}
        </ul>
        <div className="mt-auto pt-2">
          {paid && !current && (
            <Button
              className="w-full"
              size="sm"
              variant={upgrade ? "primary" : "secondary"}
              disabled={!isOwner || !stripeConfigured || anyBusy}
              onClick={onChoose}
              title={
                !isOwner
                  ? "Only the company owner can change the plan"
                  : !stripeConfigured
                    ? "Billing is not fully configured yet"
                    : undefined
              }
            >
              {busy ? "Redirecting…" : label}
            </Button>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
