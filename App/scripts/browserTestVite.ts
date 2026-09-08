import type { UserConfig } from "vite";

/**
 * The fixtures import real pages, including lazy document/auth surfaces. Vite's
 * normal discovery can find those dependencies between browser cases and swap
 * shared chunks after React has mounted. A cold CI run then loads two React
 * copies and fails inside hooks instead of testing the composer.
 *
 * Explicit optimization finishes before the server starts and never rescans
 * during a case. Keep this list aligned with package imports in client code;
 * asset imports such as the PDF worker's `?url` stay with Vite's asset handling.
 */
export const browserTestVite: Pick<UserConfig, "optimizeDeps"> = {
  optimizeDeps: {
    noDiscovery: true,
    include: [
      "react",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "react-dom",
      "react-dom/client",
      "react-router-dom",
      "lucide-react",
      "marked",
      "dompurify",
      "cronstrue",
      "@simplewebauthn/browser",
      "epubjs",
      "pdfjs-dist",
    ],
  },
};
