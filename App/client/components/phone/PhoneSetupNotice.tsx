import { Link } from "react-router-dom";
import { Globe, Plug } from "lucide-react";
import type { PhoneSetup } from "../../lib/phone";

/**
 * What stands between this install and a working phone: a Twilio account, and
 * for calls, a public URL Twilio can reach. Texts work without the second —
 * the heartbeat fetches them — so it is a notice, not a wall.
 */
export function PhoneSetupNotice({
  companySlug,
  setup,
}: {
  companySlug: string;
  setup: PhoneSetup;
}) {
  if (setup.connections.length === 0) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <Plug size={16} className="mt-0.5 shrink-0 text-slate-400" />
        <div className="min-w-0">
          <p className="font-medium text-slate-900 dark:text-slate-100">Connect Twilio first</p>
          <p className="mt-0.5 text-slate-500 dark:text-slate-400">
            Phone numbers are reserved in your own Twilio account. Add it with its Account SID and
            Auth Token at{" "}
            <Link
              to={`/c/${companySlug}/settings/integrations`}
              className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
            >
              Settings → Integrations
            </Link>
            .
          </p>
        </div>
      </div>
    );
  }
  if (setup.publicUrl.reachable) return null;
  return (
    <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950/30">
      <Globe size={16} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="min-w-0 text-amber-900 dark:text-amber-100">
        <p className="font-medium">Calls need a public URL</p>
        <p className="mt-0.5 text-amber-800 dark:text-amber-200">
          {setup.publicUrl.configured
            ? `Twilio cannot reach ${setup.publicUrl.url ?? "this install"} from the internet.`
            : "This install has no public URL yet."}{" "}
          Texts still work — Genosyn fetches them from Twilio every minute, so verification codes
          arrive — but calls cannot be answered or placed until a master admin sets a public HTTPS
          address at Admin → General → Public URL.
        </p>
      </div>
    </div>
  );
}
