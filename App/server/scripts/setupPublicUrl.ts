import { AppDataSource, initDb } from "../db/datasource.js";
import { initialPublicUrl, initializePublicUrl } from "../services/publicUrlSetup.js";

/** Run from App, or /app in the container, using its ordinary boot configuration. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--url") {
    throw new Error("Usage: setupPublicUrl --url https://genosyn.example.com");
  }
  // Validate before opening the database or applying pending migrations.
  const publicUrl = initialPublicUrl(args[1]);
  try {
    await initDb();
    await initializePublicUrl(publicUrl);
    // Only the public origin is printed; no credentials or setup tokens exist.
    console.log(`Public URL configured: ${publicUrl}`);
    console.log("You can now register the configured bootstrap operator and verify its email.");
  } finally {
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  }
}

void main().catch((error: unknown) => {
  // Driver failures can carry connection details. Keep setup output generic.
  const message = error instanceof Error && !AppDataSource.isInitialized ? error.message : "";
  console.error(
    message.startsWith("Usage:") ||
      message.startsWith("Public URL") ||
      message.startsWith("Shared SaaS") ||
      message.startsWith("A different public URL")
      ? message
      : "Public URL setup failed. Check the database configuration and migration status.",
  );
  process.exitCode = 1;
});
