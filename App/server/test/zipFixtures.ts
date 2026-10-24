import JSZip from "jszip";

/** A zip that lists no files: its end-of-central-directory record alone. */
export function emptyZip(): Buffer {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(0x06054b50, 0);
  return record;
}

/** A zip holding `files`, in that order, each one deflated. */
export async function zipOf(files: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, body] of Object.entries(files)) zip.file(name, body, { createFolders: false });
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/**
 * `bytes` with its first entry's data damaged and its central directory
 * intact — what a damaged archive looks like to anything that reads only the
 * directory.
 */
export function withDamagedEntry(bytes: Buffer): Buffer {
  const damaged = Buffer.from(bytes);
  // The first entry's local header is at 0; its data follows its name and extra field.
  const data = 30 + damaged.readUInt16LE(26) + damaged.readUInt16LE(28);
  // A deflate block of the reserved type 3, so inflating it fails at once.
  damaged[data] = 0xff;
  return damaged;
}
