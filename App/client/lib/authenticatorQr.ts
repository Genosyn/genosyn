import {
  isOtpauthMigrationUri,
  readOtpauthMigrationUri,
  type MigratedAuthenticator,
} from "../../shared/otpauthMigration";

/**
 * Read an authenticator QR code from an image, in the browser. The image goes nowhere:
 * what comes out is the same setup key a person could have typed, and it reaches the
 * server only when they save the login, encrypted from there on.
 */

/** Big enough for a screenshot of a whole page, and no bigger than a canvas should be. */
const MAX_DIMENSION = 4096;

export type { MigratedAuthenticator };

function pixelsOf(image: ImageBitmap): { data: Uint8ClampedArray; width: number; height: number } {
  const scale = Math.min(1, MAX_DIMENSION / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("This browser can't read images.");
  context.drawImage(image, 0, 0, width, height);
  return { data: context.getImageData(0, 0, width, height).data, width, height };
}

/**
 * Each account the QR holds, as a URI the Vault takes. One from a site's own setup
 * page, and possibly several from Google Authenticator's Transfer accounts.
 */
export async function readAuthenticatorQr(image: Blob): Promise<MigratedAuthenticator[]> {
  if (image.size > 20_000_000) throw new Error("That image is too large. Try a smaller one.");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(image);
  } catch {
    throw new Error("That file isn't an image this browser can read.");
  }
  try {
    const { data, width, height } = pixelsOf(bitmap);
    // Only people adding an authenticator pay for loading this.
    const { default: jsQR } = await import("jsqr");
    const decoded = jsQR(data, width, height, { inversionAttempts: "attemptBoth" })?.data;
    if (!decoded) {
      throw new Error("No QR code found in that image. Try a closer screenshot of just the code.");
    }
    if (isOtpauthMigrationUri(decoded)) {
      const accounts = readOtpauthMigrationUri(decoded);
      if (accounts.length === 0) {
        throw new Error("That QR holds no time-based authenticator codes Genosyn can use.");
      }
      return accounts;
    }
    if (!decoded.trim().toLowerCase().startsWith("otpauth://totp/")) {
      throw new Error("That QR code isn't an authenticator code.");
    }
    return [{ label: "", uri: decoded.trim() }];
  } finally {
    bitmap.close();
  }
}
