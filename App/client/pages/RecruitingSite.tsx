import React from "react";
import { useOutletContext } from "react-router-dom";
import {
  ArrowUpRight,
  CheckCircle2,
  Clipboard,
  Code2,
  Globe,
  ImageUp,
  Link2,
  Lock,
  ShieldCheck,
  Trash2,
} from "lucide-react";

import { Button } from "../components/ui/Button";
import { useDialog } from "../components/ui/Dialog";
import { Disclosure } from "../components/ui/Disclosure";
import { EmptyState } from "../components/ui/EmptyState";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { ButtonSpinner } from "../components/ui/Spinner";
import { Textarea } from "../components/ui/Textarea";
import { copyToClipboard } from "../lib/clipboard";
import { errorMessage } from "../lib/errors";
import { recruitingApi, type RecruitingSettingsDto } from "../lib/recruiting";
import { canOpenSubpage, subpageAt } from "../lib/subpages";
import { accentForeground, normalizeAccentColor, type SiteVisibility } from "../../shared/recruiting";
import type { RecruitingOutletCtx } from "./RecruitingLayout";
import {
  ErrorPanel,
  LoadingPage,
  PageHeader,
  TonePill,
  cardClass,
  labelClass,
  pageClass,
  recruitingCrumbs,
} from "./RecruitingShared";

type Branding = {
  siteTitle: string;
  siteHeadline: string;
  siteIntro: string;
  websiteUrl: string;
  privacyPolicyUrl: string;
  accentColor: string;
  allowIndexing: boolean;
};

function brandingOf(settings: RecruitingSettingsDto): Branding {
  return {
    siteTitle: settings.site.title,
    siteHeadline: settings.site.headline,
    siteIntro: settings.site.intro,
    websiteUrl: settings.site.websiteUrl,
    privacyPolicyUrl: settings.site.privacyPolicyUrl,
    accentColor: settings.site.accentColor,
    allowIndexing: settings.site.allowIndexing,
  };
}

function sameBranding(a: Branding, b: Branding): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Which field a response is the save of: that field takes the server's version even while edited. */
type SavedPart = { branding?: boolean; domain?: boolean };

function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [state, setState] = React.useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      type="button"
      onClick={() => {
        // The shared helper falls back when the browser hides
        // `navigator.clipboard` — on a plain-HTTP self-hosted install a direct
        // call did nothing at all.
        void copyToClipboard(value).then((ok) => {
          setState(ok ? "copied" : "failed");
          setTimeout(() => setState("idle"), ok ? 1500 : 4000);
        });
      }}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
    >
      {state === "copied" ? <CheckCircle2 size={12} className="text-emerald-500" /> : <Clipboard size={12} />}
      {state === "copied" ? "Copied" : state === "failed" ? "Couldn’t copy — select it instead" : label}
    </button>
  );
}

export function RecruitingSitePage() {
  const { company } = useOutletContext<RecruitingOutletCtx>();
  if (!canOpenSubpage(subpageAt("/recruiting/site"), company)) {
    return (
      <div className={pageClass}>
        <PageHeader crumbs={recruitingCrumbs(`/c/${company.slug}/recruiting`, { label: "Careers site" })} title="Careers site" />
        <EmptyState title="Owners and admins set up the careers site" description="Ask an owner or admin to change how the careers site looks or where it lives." />
      </div>
    );
  }
  return <SiteSettings />;
}

function SiteSettings() {
  const { company } = useOutletContext<RecruitingOutletCtx>();
  const crumbs = recruitingCrumbs(`/c/${company.slug}/recruiting`, { label: "Careers site" });
  const dialog = useDialog();
  const recruiting = recruitingApi(company.id);
  const [settings, setSettings] = React.useState<RecruitingSettingsDto | null>(null);
  const [loadError, setLoadError] = React.useState("");
  const [branding, setBranding] = React.useState<Branding | null>(null);
  const [saving, setSaving] = React.useState<string | null>(null);
  // Each card shows its own failures, beside the control that failed.
  const [siteError, setSiteError] = React.useState<string | null>(null);
  const [brandingError, setBrandingError] = React.useState<string | null>(null);
  const [domainInput, setDomainInput] = React.useState("");
  const [domainError, setDomainError] = React.useState<string | null>(null);
  const [check, setCheck] = React.useState<{ verified: boolean; cnameTargets: string[]; pointsHere: boolean } | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const settingsRef = React.useRef<RecruitingSettingsDto | null>(null);

  /**
   * Take the settings the server sent. A field someone is still editing keeps
   * its unsaved text — turning the site on must not throw away a headline
   * nobody has saved yet — unless this response is the save of that field.
   */
  const apply = React.useCallback((next: RecruitingSettingsDto, saved: SavedPart = {}) => {
    const previous = settingsRef.current;
    settingsRef.current = next;
    setSettings(next);
    setBranding((current) =>
      saved.branding || !current || !previous || sameBranding(current, brandingOf(previous)) ? brandingOf(next) : current,
    );
    setDomainInput((current) =>
      saved.domain || !previous || current === (previous.domain.name ?? "") ? (next.domain.name ?? "") : current,
    );
  }, []);

  const load = React.useCallback(() => {
    setLoadError("");
    recruitingApi(company.id)
      .settings()
      .then((next) => apply(next))
      .catch((err: unknown) => setLoadError(errorMessage(err, "Could not load the careers site")));
  }, [company.id, apply]);

  React.useEffect(() => {
    load();
  }, [load]);

  /** Turn the site on or off, or change who sees it. */
  async function patchSite(key: string, body: Record<string, unknown>) {
    setSaving(key);
    setSiteError(null);
    try {
      apply(await recruiting.updateSettings(body));
    } catch (err) {
      setSiteError(errorMessage(err, "Could not save"));
    } finally {
      setSaving(null);
    }
  }

  async function toggleSite() {
    if (!settings) return;
    if (settings.site.enabled) {
      const ok = await dialog.confirm({
        title: "Turn off the careers site?",
        message:
          "Its Openings stop being listed and nobody can apply until you turn it back on. Openings, applications and these settings stay as they are.",
        confirmLabel: "Turn off",
      });
      if (!ok) return;
    }
    await patchSite("enabled", { siteEnabled: !settings.site.enabled });
  }

  async function chooseVisibility(next: SiteVisibility) {
    if (!settings || settings.site.visibility === next) return;
    if (next === "internal" && settings.site.enabled) {
      const ok = await dialog.confirm({
        title: "Make the careers site internal?",
        message: `The public site goes away${settings.domain.live ? `, ${settings.domain.name} stops serving it,` : ""} and only signed-in Members can see its Openings and apply. Links people outside the company already have stop working.`,
        confirmLabel: "Make it internal",
      });
      if (!ok) return;
    }
    await patchSite(`visibility-${next}`, { siteVisibility: next });
  }

  async function saveBranding() {
    if (!branding) return;
    setSaving("branding");
    setBrandingError(null);
    try {
      apply(await recruiting.updateSettings(branding), { branding: true });
    } catch (err) {
      setBrandingError(errorMessage(err, "Could not save"));
    } finally {
      setSaving(null);
    }
  }

  async function saveDomain(event: React.FormEvent) {
    event.preventDefault();
    if (!settings) return;
    const next = domainInput.trim() || null;
    const current = settings.domain.name;
    if (settings.domain.live && current && next !== current) {
      const ok = await dialog.confirm({
        title: next ? `Move the careers site to ${next}?` : `Disconnect ${current}?`,
        message: next
          ? `${current} stops serving the careers site straight away, and links to it break. ${next} serves it once its DNS is verified.`
          : `${current} stops serving the careers site straight away, and links to it break. The site stays at ${settings.site.installUrl.replace(/^https?:\/\//, "")}.`,
        confirmLabel: next ? "Move it" : "Disconnect",
      });
      if (!ok) return;
    }
    setSaving("domain");
    setDomainError(null);
    setCheck(null);
    try {
      apply(await recruiting.setDomain(next), { domain: true });
    } catch (err) {
      setDomainError(errorMessage(err, "Could not save the domain"));
    } finally {
      setSaving(null);
    }
  }

  if (loadError) {
    return (
      <div className={pageClass}>
        <PageHeader crumbs={crumbs} title="Careers site" />
        <ErrorPanel message={loadError} onRetry={load} />
      </div>
    );
  }
  if (!settings || !branding) return <LoadingPage />;

  const dirty = !sameBranding(branding, brandingOf(settings));
  const accent = normalizeAccentColor(branding.accentColor) ?? settings.site.accentColor;
  const visibility = settings.site.visibility;
  const siteBusy = saving === "enabled" || (saving?.startsWith("visibility-") ?? false);
  const logoBusy = saving === "logo" || saving === "logo-remove";

  return (
    <div className={pageClass}>
      <PageHeader
        crumbs={crumbs}
        title="Careers site"
        description="Where people find your Openings and apply. Run it publicly on Genosyn's address or your own domain, or keep it internal for Members."
        action={
          settings.site.enabled ? (
            <a href={settings.site.url} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
              Open the site <ArrowUpRight size={13} />
            </a>
          ) : undefined
        }
      />

      <section className={`${cardClass} p-5`}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className={`mt-0.5 flex h-9 w-9 items-center justify-center rounded-lg ${settings.site.enabled ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10" : "bg-slate-100 text-slate-500 dark:bg-slate-800"}`}>
              <Globe size={17} />
            </span>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                  {settings.site.enabled ? "The careers site is live" : "The careers site is off"}
                </h2>
                {settings.site.enabled ? <TonePill tone="good">Live</TonePill> : <TonePill tone="neutral">Off</TonePill>}
              </div>
              <p className="mt-0.5 text-xs text-slate-500">
                {settings.site.enabled ? (
                  <>
                    At{" "}
                    <a href={settings.site.url} target="_blank" rel="noreferrer" className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                      {settings.site.url.replace(/^https?:\/\//, "")}
                    </a>
                    {settings.domain.live ? ` and ${settings.site.installUrl.replace(/^https?:\/\//, "")}` : ""}
                  </>
                ) : (
                  "Openings can be drafted and published, but nobody can see or apply to them until the site is on."
                )}
              </p>
            </div>
          </div>
          <Button
            variant={settings.site.enabled ? "secondary" : "primary"}
            loading={saving === "enabled"}
            disabled={siteBusy}
            onClick={() => void toggleSite()}
          >
            {settings.site.enabled ? "Turn off" : "Turn on"}
          </Button>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {(
            [
              {
                value: "public" as SiteVisibility,
                icon: <Globe size={15} />,
                title: "Public",
                body: "Anyone can browse open roles and apply. Use Genosyn's address, or connect your own domain below.",
              },
              {
                value: "internal" as SiteVisibility,
                icon: <Lock size={15} />,
                title: "Internal",
                body: "Only signed-in Members of the company see it — an internal careers site for moves and referrals.",
              },
            ] as const
          ).map((option) => {
            const pending = saving === `visibility-${option.value}`;
            return (
              <button
                key={option.value}
                type="button"
                disabled={siteBusy}
                aria-busy={pending || undefined}
                onClick={() => void chooseVisibility(option.value)}
                className={
                  visibility === option.value
                    ? "rounded-lg border border-indigo-500 bg-indigo-50/60 p-4 text-left disabled:cursor-not-allowed dark:bg-indigo-500/10"
                    : "rounded-lg border border-slate-200 p-4 text-left hover:bg-slate-50 disabled:cursor-not-allowed dark:border-slate-700 dark:hover:bg-slate-800/50"
                }
                aria-pressed={visibility === option.value}
              >
                <span className="flex items-center gap-2 text-sm font-medium text-slate-900 dark:text-white">
                  {pending ? <ButtonSpinner size={15} /> : option.icon} {option.title}
                </span>
                <span className="mt-1 block text-xs text-slate-500">{option.body}</span>
              </button>
            );
          })}
        </div>
        <FormError className="mt-4" message={siteError} />
      </section>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <section className={`${cardClass} p-5`}>
          <h2 className="text-sm font-semibold text-slate-900 dark:text-white">How it looks</h2>
          <div className="mt-4 grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label="Name on the site" value={branding.siteTitle} placeholder={company.name} onChange={(event) => setBranding({ ...branding, siteTitle: event.target.value })} />
              <div>
                <label className="text-sm font-medium text-slate-700 dark:text-slate-300" htmlFor="accent">
                  Accent color
                </label>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    id="accent-picker"
                    type="color"
                    aria-label="Pick the accent color"
                    value={accent}
                    onChange={(event) => setBranding({ ...branding, accentColor: event.target.value })}
                    className="h-10 w-12 cursor-pointer rounded-lg border border-slate-200 bg-white p-1 dark:border-slate-700"
                  />
                  <Input id="accent" value={branding.accentColor} onChange={(event) => setBranding({ ...branding, accentColor: event.target.value })} className="font-mono" />
                </div>
              </div>
            </div>
            <Input label="Headline" value={branding.siteHeadline} placeholder={`Do the best work of your life at ${company.name}.`} onChange={(event) => setBranding({ ...branding, siteHeadline: event.target.value })} />
            <Textarea
              label="Introduction"
              rows={5}
              value={branding.siteIntro}
              onChange={(event) => setBranding({ ...branding, siteIntro: event.target.value })}
              hint="Markdown. Who you are, what you are building, and why someone would want to join."
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label="Your website" value={branding.websiteUrl} placeholder="https://example.com" onChange={(event) => setBranding({ ...branding, websiteUrl: event.target.value })} />
              <Input label="Privacy policy" value={branding.privacyPolicyUrl} placeholder="https://example.com/privacy" onChange={(event) => setBranding({ ...branding, privacyPolicyUrl: event.target.value })} />
            </div>
            <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
              <input type="checkbox" className="mt-0.5 h-4 w-4 rounded border-slate-300" checked={branding.allowIndexing} onChange={(event) => setBranding({ ...branding, allowIndexing: event.target.checked })} />
              <span>
                Let search engines list it
                <span className="block text-xs text-slate-500">
                  Public Openings carry the job-posting data Google for Jobs reads. Internal sites and unlisted Openings are never indexed.
                </span>
              </span>
            </label>
            <div>
              <span className={labelClass}>Logo</span>
              <div className="flex items-center gap-3">
                {settings.site.logoUrl ? (
                  <img src={settings.site.logoUrl} alt="" className="h-12 w-12 rounded-lg border border-slate-200 object-contain p-1 dark:border-slate-700" />
                ) : (
                  <span className="flex h-12 w-12 items-center justify-center rounded-lg text-sm font-semibold" style={{ background: accent, color: accentForeground(accent) }}>
                    {(branding.siteTitle || company.name).slice(0, 2).toUpperCase()}
                  </span>
                )}
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    setSaving("logo");
                    setBrandingError(null);
                    recruiting
                      .uploadLogo(file)
                      .then((next) => apply(next))
                      .catch((err: unknown) => setBrandingError(errorMessage(err, "Could not upload the logo")))
                      .finally(() => {
                        setSaving(null);
                        if (fileRef.current) fileRef.current.value = "";
                      });
                  }}
                />
                <Button variant="secondary" size="sm" loading={saving === "logo"} disabled={logoBusy} onClick={() => fileRef.current?.click()}>
                  <ImageUp size={13} /> {settings.site.logoUrl ? "Replace" : "Upload"}
                </Button>
                {settings.site.logoUrl ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={saving === "logo-remove"}
                    disabled={logoBusy}
                    onClick={() => {
                      setSaving("logo-remove");
                      setBrandingError(null);
                      recruiting
                        .removeLogo()
                        .then((next) => apply(next))
                        .catch((err: unknown) => setBrandingError(errorMessage(err, "Could not remove the logo")))
                        .finally(() => setSaving(null));
                    }}
                  >
                    <Trash2 size={13} /> Remove
                  </Button>
                ) : null}
                <span className="text-xs text-slate-500">PNG, JPEG, GIF or WebP, up to 2 MB.</span>
              </div>
            </div>
          </div>
          <div className="mt-6 flex flex-col gap-3 border-t border-slate-100 pt-5 sm:flex-row sm:items-center sm:justify-between dark:border-slate-800">
            <FormError message={brandingError} />
            <div className="flex gap-2 sm:ml-auto">
              <Button variant="secondary" disabled={!dirty || saving !== null} onClick={() => setBranding(brandingOf(settings))}>
                Discard changes
              </Button>
              <Button loading={saving === "branding"} disabled={!dirty} onClick={() => void saveBranding()}>
                Save
              </Button>
            </div>
          </div>
        </section>

        <aside>
          <span className={labelClass}>Preview</span>
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700">
            <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
              {settings.site.logoUrl ? (
                <img src={settings.site.logoUrl} alt="" className="h-6 w-6 rounded object-contain" />
              ) : (
                <span className="flex h-6 w-6 items-center justify-center rounded text-[10px] font-semibold" style={{ background: accent, color: accentForeground(accent) }}>
                  {(branding.siteTitle || company.name).slice(0, 2).toUpperCase()}
                </span>
              )}
              <span className="text-sm font-semibold text-slate-900">{branding.siteTitle || company.name}</span>
              <span className="text-sm text-slate-400">Careers</span>
            </div>
            <div className="px-5 py-6">
              <p className="text-xs font-medium" style={{ color: accent }}>
                Careers at {branding.siteTitle || company.name}
              </p>
              <p className="mt-2 text-lg font-semibold leading-snug tracking-tight text-slate-950">
                {branding.siteHeadline || `Do the best work of your life at ${branding.siteTitle || company.name}.`}
              </p>
              <span className="mt-4 inline-flex rounded-lg px-3 py-1.5 text-xs font-semibold" style={{ background: accent, color: accentForeground(accent) }}>
                See open roles
              </span>
            </div>
          </div>
        </aside>
      </div>

      <section className={`${cardClass} mt-6 p-5`}>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-slate-800">
            <Link2 size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Your own domain</h2>
              {settings.domain.name ? (
                settings.domain.live ? (
                  <TonePill tone="good">
                    <ShieldCheck size={11} /> Verified and live
                  </TonePill>
                ) : settings.domain.verifiedAt ? (
                  <TonePill tone="warn">Verified — turns on with a public site</TonePill>
                ) : (
                  <TonePill tone="warn">Waiting for DNS</TonePill>
                )
              ) : null}
            </div>
            <p className="mt-0.5 text-xs text-slate-500">
              Put the careers site on a domain you own, like careers.{(company.slug || "example").split("-")[0]}.com, and link to
              it from your website. Only a public site is served there, and nothing else from Genosyn is.
            </p>
            <form className="mt-4 flex flex-col gap-2 sm:flex-row" onSubmit={(event) => void saveDomain(event)}>
              <Input aria-label="Domain" value={domainInput} onChange={(event) => setDomainInput(event.target.value)} placeholder="careers.example.com" className="sm:w-80" />
              <Button type="submit" variant="secondary" loading={saving === "domain"} disabled={(domainInput.trim() || null) === settings.domain.name}>
                {settings.domain.name && !domainInput.trim() ? "Disconnect" : "Save domain"}
              </Button>
            </form>
            <FormError className="mt-2" message={domainError} />

            {settings.domain.name && settings.domain.record ? (
              <div className="mt-5 space-y-4">
                <p className="text-sm text-slate-700 dark:text-slate-300">Add these two records where you manage DNS for {settings.domain.name}:</p>
                <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
                  <table className="w-full text-xs">
                    <thead className="text-left border-b border-slate-200 bg-slate-50/80 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-400">
                      <tr>
                        <th className="px-3 py-2 font-medium">Type</th>
                        <th className="px-3 py-2 font-medium">Name</th>
                        <th className="px-3 py-2 font-medium">Value</th>
                        <th className="px-3 py-2 font-medium">Why</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-mono dark:divide-slate-800">
                      <tr>
                        <td className="px-3 py-2">CNAME</td>
                        <td className="px-3 py-2">{settings.domain.name}</td>
                        <td className="px-3 py-2">
                          <span className="mr-2">{settings.domain.cnameTarget}</span>
                          <CopyButton value={settings.domain.cnameTarget} />
                        </td>
                        <td className="px-3 py-2 font-sans text-slate-500">Sends visitors to this install</td>
                      </tr>
                      <tr>
                        <td className="px-3 py-2">TXT</td>
                        <td className="px-3 py-2">{settings.domain.record.name}</td>
                        <td className="px-3 py-2">
                          <span className="mr-2 break-all">{settings.domain.record.value}</span>
                          <CopyButton value={settings.domain.record.value} />
                        </td>
                        <td className="px-3 py-2 font-sans text-slate-500">Proves the domain is yours</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    loading={saving === "verify"}
                    onClick={() => {
                      setSaving("verify");
                      setDomainError(null);
                      recruiting
                        .verifyDomain()
                        .then((result) => {
                          apply(result.settings);
                          setCheck(result.check);
                        })
                        .catch((err: unknown) => setDomainError(errorMessage(err, "Could not check DNS")))
                        .finally(() => setSaving(null));
                    }}
                  >
                    {settings.domain.verifiedAt ? "Check again" : "Verify"}
                  </Button>
                  {settings.domain.checkedAt ? (
                    <span className="text-xs text-slate-500">Last checked {new Date(settings.domain.checkedAt).toLocaleString()}</span>
                  ) : null}
                </div>
                {settings.domain.error && !settings.domain.verifiedAt ? (
                  <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">{settings.domain.error}</p>
                ) : null}
                {check ? (
                  <p className="text-xs text-slate-600 dark:text-slate-300">
                    {check.pointsHere
                      ? "The CNAME points here."
                      : check.cnameTargets.length
                        ? `The CNAME points to ${check.cnameTargets.join(", ")}, not ${settings.domain.cnameTarget}. If you use a proxy or an A record instead, that is fine.`
                        : "No CNAME found — fine if you route the domain another way (an A record or a proxy)."}
                  </p>
                ) : null}
                <Disclosure title="Certificates and your reverse proxy" summary="HTTPS for the new domain">
                  <div className="space-y-2 text-xs text-slate-600 dark:text-slate-300">
                    <p>
                      Whatever serves HTTPS for this install must also serve it for {settings.domain.name}. With Caddy, on-demand TLS
                      can ask Genosyn which domains to issue for:
                    </p>
                    <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 text-[11px] text-slate-100">{`{
  on_demand_tls {
    ask http://localhost:8471/api/careers/domains/check
  }
}
https:// {
  tls { on_demand }
  reverse_proxy localhost:8471
}`}</pre>
                    <p>On Kubernetes, add the domain to your Ingress&apos;s hosts and certificate. The Self-hosting docs have both.</p>
                  </div>
                </Disclosure>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <section className={`${cardClass} mt-6 p-5`}>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-slate-800">
            <Code2 size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Show openings on your own website</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              A public JSON feed of every open, public Opening — title, team, location, pay and link — that any page can fetch.
              Internal and unlisted Openings never appear in it.
            </p>
            {/* The address scrolls on its own; Copy stays in reach beside it. */}
            <div className="mt-3 flex items-center gap-2">
              <div className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-slate-50 px-3 py-2 font-mono text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                <span className="whitespace-nowrap">{settings.site.feedUrl}</span>
              </div>
              <CopyButton value={settings.site.feedUrl} />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
