import type { Config } from "tailwindcss";

import app from "./tailwind.config";

/**
 * The careers site's own Tailwind build: the App's theme, scanned over the
 * careers bundle alone, so an applicant downloads only the classes the
 * careers pages use rather than the whole App's.
 */
export default {
  ...app,
  content: ["./client/careers.html", "./client/careers-site/**/*.{ts,tsx}"],
} satisfies Config;
