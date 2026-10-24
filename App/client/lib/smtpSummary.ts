/**
 * The closed Advanced line under Admin → Email transport's SMTP form: the
 * port, the TLS mode and the sender's display name. Most mail servers work on
 * the defaults (587, TLS chosen by the port, "Genosyn"), so these wait behind
 * one disclosure, and the line always names all three so none hides
 * (AGENTS.md §8).
 *
 *   { port: "587", secure: false, fromName: "Genosyn" } → "Port 587 · TLS by port · From “Genosyn”"
 */
export function describeSmtpAdvanced(values: {
  port: string;
  secure: boolean;
  fromName: string;
}): string {
  const port = values.port.trim() || "587";
  const name = values.fromName.trim();
  return [
    `Port ${port}`,
    values.secure ? "Implicit TLS" : "TLS by port",
    name ? `From “${name}”` : "No sender name",
  ].join(" · ");
}
