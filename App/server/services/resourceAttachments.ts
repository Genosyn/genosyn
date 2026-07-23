import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { Resource } from "../db/entities/Resource.js";
import { Company } from "../db/entities/Company.js";
import { hasResourceAccess, resolveResourceFile } from "./resources.js";
import { exportResource } from "./resourceExport.js";
import { renderInvoicePdfBySlug } from "./invoiceHtml.js";
import { hasFinanceAccess } from "./financeGrants.js";
import type { ResolvedAttachment } from "../integrations/types.js";

/**
 * Turn `{resourceSlug, format}` specs from an AI employee into real bytes an
 * integration tool can attach to an outgoing message.
 *
 * This is the host side of `IntegrationRuntimeContext.resolveAttachments`.
 * It exists so providers can attach Resources without importing TypeORM:
 * the dispatcher hands them a closure, they hand it specs, they get bytes.
 * Everything that needs to know what a Resource is — the grant table, the
 * on-disk layout, the export renderer — stays on this side of that line.
 *
 * The identity in `args` is bound at closure-construction time by the
 * dispatcher, which takes it from the authenticated caller. It is
 * deliberately not re-read from anything the model can reach.
 */

/** Gmail's simple send endpoint tops out around 5 MB of assembled MIME, and
 *  base64 inflates by 4/3. Sized so a full set of attachments still leaves
 *  room for headers and the body; also keeps transient Buffers bounded on a
 *  request path that may already be forking Chromium for a render. */
export const ATTACHMENT_TOTAL_MAX_BYTES = 3.5 * 1024 * 1024;
export const ATTACHMENT_MAX_COUNT = 10;

/** `original` means "the file the human uploaded, byte for byte". The other
 *  four render `bodyText` through the same pipeline as the Download menu. */
export const ATTACHMENT_FORMATS = [
  "original",
  "pdf",
  "html",
  "md",
  "txt",
] as const;
export type AttachmentFormat = (typeof ATTACHMENT_FORMATS)[number];

/** A file from the company's Resources, named by slug. */
const resourceSpecSchema = z
  .object({
    resourceSlug: z.string().min(1),
    format: z.enum(ATTACHMENT_FORMATS).default("original"),
    filename: z.string().min(1).max(200).optional(),
  })
  .strict();

/** An invoice, rendered to a PDF on the fly and attached. Needs finance access. */
const invoiceSpecSchema = z
  .object({
    invoiceSlug: z.string().min(1),
    filename: z.string().min(1).max(200).optional(),
  })
  .strict();

export const resourceAttachmentSpecsSchema = z
  .array(z.union([resourceSpecSchema, invoiceSpecSchema]))
  .max(
    ATTACHMENT_MAX_COUNT,
    `At most ${ATTACHMENT_MAX_COUNT} attachments per message.`,
  );

type ResourceSpec = z.infer<typeof resourceSpecSchema>;
type InvoiceSpec = z.infer<typeof invoiceSpecSchema>;
export type ResourceAttachmentSpec = ResourceSpec | InvoiceSpec;

/** Content types for original uploads, keyed off the stored filename.
 *  Uploads only ever land as pdf / epub / video (`inferSourceKindFromFilename`). */
const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".epub": "application/epub+zip",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
};

const DEL_CODE = 127;
const FIRST_PRINTABLE_CODE = 32;

/**
 * Strip anything that would forge a MIME header or walk a path: control
 * characters, quotes, backslashes. A stray CR/LF in a filename injects
 * headers exactly like an unvalidated address does, and the filename lands
 * in `Content-Disposition` verbatim.
 *
 * Written as a code-point filter rather than a regex so the source carries
 * no literal control bytes.
 */
function safeFilename(name: string, fallback: string): string {
  const cleaned = Array.from(path.basename(name))
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      if (code < FIRST_PRINTABLE_CODE || code === DEL_CODE) return false;
      return ch !== '"' && ch !== "\\";
    })
    .join("")
    .trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

export function makeResourceAttachmentResolver(args: {
  companyId: string;
  employeeId: string;
}): (specs: unknown) => Promise<ResolvedAttachment[]> {
  return async (specs: unknown) => {
    const parsed = resourceAttachmentSpecsSchema.safeParse(specs);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join(".") || "attachments"}: ${i.message}`)
        .join("; ");
      throw new Error(`Invalid attachments: ${detail}`);
    }
    if (parsed.data.length === 0) return [];

    const company = await AppDataSource.getRepository(Company).findOneBy({
      id: args.companyId,
    });
    if (!company) throw new Error("Company not found");

    const out: ResolvedAttachment[] = [];
    let total = 0;
    // Sequential on purpose: a rendered format forks Chromium, and running
    // several of those at once is worse than running them one at a time.
    for (const spec of parsed.data) {
      const resolved =
        "invoiceSlug" in spec
          ? await resolveInvoicePdf(spec, company, args.employeeId)
          : await resolveOne(spec, company, args.employeeId);
      total += resolved.content.length;
      if (total > ATTACHMENT_TOTAL_MAX_BYTES) {
        const mb = Math.floor(ATTACHMENT_TOTAL_MAX_BYTES / (1024 * 1024));
        throw new Error(
          `Attachments add up to more than ${mb} MB, which is over the limit for sending. Attach fewer files, or send a link to the resource page instead.`,
        );
      }
      out.push(resolved);
    }
    return out;
  };
}

/**
 * Render an invoice to a PDF and hand it back as an attachment. Gated on the
 * caller's finance grant (read is enough to export), not the resource grants —
 * finance is a company-wide subsystem, so any finance-granted employee may
 * attach any of the company's invoices.
 */
async function resolveInvoicePdf(
  spec: InvoiceSpec,
  company: Company,
  employeeId: string,
): Promise<ResolvedAttachment> {
  if (!(await hasFinanceAccess(employeeId, "read"))) {
    throw new Error(
      "You do not have finance access, so you cannot attach invoices. Ask an owner or admin to grant it under Finance → AI access.",
    );
  }
  const rendered = await renderInvoicePdfBySlug(company.id, spec.invoiceSlug);
  if (!rendered) {
    throw new Error(
      `Invoice "${spec.invoiceSlug}" not found. Use the finance tool (op: list_invoices) to find the slug.`,
    );
  }
  return {
    filename: safeFilename(spec.filename ?? rendered.filename, rendered.filename),
    contentType: "application/pdf",
    content: rendered.buffer,
  };
}

async function resolveOne(
  spec: ResourceSpec,
  company: Company,
  employeeId: string,
): Promise<ResolvedAttachment> {
  const row = await AppDataSource.getRepository(Resource).findOneBy({
    companyId: company.id,
    slug: spec.resourceSlug,
  });
  // One message for both "no such slug" and "no grant", so a missing grant
  // can't be used to probe which resources exist.
  const denied = `No access to resource "${spec.resourceSlug}", or it does not exist.`;
  if (!row) throw new Error(denied);
  if (!(await hasResourceAccess(employeeId, row.id, "read"))) {
    throw new Error(denied);
  }

  if (spec.format === "original") {
    if (!row.storageKey) {
      throw new Error(
        `Resource "${row.slug}" is a ${row.sourceKind} resource, so there is no original file to attach. Pass format: "pdf", "md", "txt", or "html" to attach its text rendered as a document instead.`,
      );
    }
    const abs = resolveResourceFile(company.slug, row.storageKey);
    if (!abs) {
      throw new Error(
        `The original file for resource "${row.slug}" is no longer on disk. Ask a human to re-upload it.`,
      );
    }
    const ext = path.extname(row.sourceFilename ?? abs).toLowerCase();
    return {
      filename: safeFilename(
        spec.filename ?? row.sourceFilename ?? `${row.slug}${ext}`,
        `${row.slug}${ext || ".bin"}`,
      ),
      contentType: MIME_BY_EXT[ext] ?? "application/octet-stream",
      content: await fs.promises.readFile(abs),
    };
  }

  if (!row.bodyText || row.bodyText.length === 0) {
    const original = row.storageKey
      ? ' Pass format: "original" to attach the uploaded file as-is.'
      : "";
    throw new Error(
      `Resource "${row.slug}" has no extracted text to render as ${spec.format}.${original}`,
    );
  }
  const artifact = await exportResource(row, spec.format);
  return {
    filename: safeFilename(
      spec.filename ?? artifact.filename,
      artifact.filename,
    ),
    contentType: artifact.mime,
    content: artifact.buffer,
  };
}
