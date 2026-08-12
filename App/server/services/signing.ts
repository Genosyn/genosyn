import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadImage } from "@napi-rs/canvas";
import fontkit, { type Font as FontkitFont } from "@pdf-lib/fontkit";
import multer from "multer";
import { degrees, PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, rgb } from "pdf-lib";
import { EntityManager, FindOptionsWhere, In, LessThanOrEqual } from "typeorm";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { CustomerContract } from "../db/entities/CustomerContract.js";
import {
  EmployeeSigningGrant,
  SIGNING_ACCESS_LEVELS,
  SIGNING_ACCESS_RANK,
  SigningAccessLevel,
} from "../db/entities/EmployeeSigningGrant.js";
import { Resource } from "../db/entities/Resource.js";
import {
  SIGNATURE_ENVELOPE_STATUSES,
  SIGNATURE_ROUTING_MODES,
  SignatureEnvelope,
  SignatureEnvelopeStatus,
  SignatureRoutingMode,
} from "../db/entities/SignatureEnvelope.js";
import {
  SignatureEvent,
  SignatureEventActorKind,
  SignatureEventType,
} from "../db/entities/SignatureEvent.js";
import {
  SIGNATURE_FIELD_TYPES,
  SignatureField,
  SignatureFieldType,
} from "../db/entities/SignatureField.js";
import {
  SIGNATURE_RECIPIENT_ROLES,
  SignatureRecipient,
  SignatureRecipientRole,
} from "../db/entities/SignatureRecipient.js";
import { normalizeEmail } from "../lib/emailAddress.js";
import { sendEmail } from "./email.js";
import { companyDir, ensureDir } from "./paths.js";
import { getPublicUrl } from "./publicUrl.js";
import { hasResourceAccess, pdfBufferToText, resolveResourceFile } from "./resources.js";

const MAX_PDF_BYTES = 25 * 1024 * 1024;
export const MAX_SIGNATURE_PDF_PAGES = 200;
const MAX_FIELD_VALUE_BYTES = 512 * 1024;
const MAX_SIGNATURE_IMAGE_DIMENSION = 4096;
const MAX_SIGNATURE_IMAGE_PIXELS = 4_000_000;
const TOKEN_BYTES = 32;
const SHA256_HEX = /^[a-f0-9]{64}$/;
let signatureExpiryTimer: ReturnType<typeof setInterval> | null = null;
let signingFinalizationFailureForTests: Error | null = null;

export function injectSigningFinalizationFailureForTests(error: Error | null): void {
  if (process.env.NODE_ENV === "production" && error) {
    throw new Error("Signing finalization failure injection is test-only");
  }
  signingFinalizationFailureForTests = error;
}

type SigningFontAsset = {
  bytes: Uint8Array;
  coverage: FontkitFont;
};

type EmbeddedSigningFont = SigningFontAsset & {
  font: PDFFont;
};

type EmbeddedSigningFonts = {
  regular: EmbeddedSigningFont[];
  signature: EmbeddedSigningFont[];
};

const SIGNING_FONT_FILES = {
  regular: "NotoSans-Regular.ttf",
  italic: "NotoSans-Italic.ttf",
  arabic: "NotoSansArabic-Regular.ttf",
  cjk: "NotoSansSC-Regular.ttf",
} as const;

let signingFontAssetsPromise: Promise<
  Record<keyof typeof SIGNING_FONT_FILES, SigningFontAsset>
> | null = null;

export class SigningValidationError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "SigningValidationError";
  }
}

export class SigningNotFoundError extends Error {
  readonly statusCode = 404;

  constructor(message = "Signature request not found") {
    super(message);
    this.name = "SigningNotFoundError";
  }
}

export class SigningConflictError extends Error {
  readonly statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = "SigningConflictError";
  }
}

export type SigningActor =
  | {
      actorKind: "user" | "ai" | "system";
      actorId?: string | null;
    }
  | { kind: "user" | "ai" | "system"; id?: string | null }
  | { userId: string }
  | { employeeId: string };

export type SignatureRecipientInput = {
  id?: string;
  key?: string;
  role: SignatureRecipientRole;
  name: string;
  email: string;
  routingOrder?: number;
  fields?: Omit<SignatureFieldInput, "recipientId" | "recipientKey" | "recipientEmail">[];
};

export type SignatureFieldInput = {
  id?: string;
  recipientId?: string;
  recipientKey?: string;
  recipientEmail?: string;
  type: SignatureFieldType;
  label?: string;
  placeholder?: string;
  required?: boolean;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  sortOrder?: number;
};

export type SignatureFieldValue =
  | string
  | boolean
  | null
  | { kind?: "typed"; text?: string; value?: string }
  | { kind: "drawn"; dataUrl: string };

type NormalizedActor = {
  actorKind: SignatureEventActorKind;
  actorId: string | null;
};

type DraftDefinition = {
  recipients?: SignatureRecipientInput[];
  fields?: SignatureFieldInput[];
};

export type SignatureEnvelopeDetail = {
  envelope: SignatureEnvelope;
  recipients: SignatureRecipient[];
  fields: Array<SignatureField & { value: SignatureFieldValue }>;
  events: Array<SignatureEvent & { metadata: Record<string, unknown> }>;
};

function signingRoot(companySlug: string): string {
  return path.join(companyDir(companySlug), "signature-envelopes");
}

function customerContractsRoot(companySlug: string): string {
  return path.join(companyDir(companySlug), "customer-contracts");
}

export function resolveSigningStoragePath(companySlug: string, storageKey: string): string | null {
  const root = signingRoot(companySlug);
  const safeKey = path.basename(storageKey);
  if (safeKey !== storageKey) return null;
  const absolute = path.join(root, safeKey);
  if (!absolute.startsWith(`${root}${path.sep}`)) return null;
  return absolute;
}

export const signingUploadMiddleware = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => {
      const temporaryRoot = path.join(companyDir(".uploads"), "signature-envelopes");
      ensureDir(temporaryRoot);
      callback(null, temporaryRoot);
    },
    filename: (_req, _file, callback) => {
      callback(null, `${crypto.randomUUID()}.pdf.upload`);
    },
  }),
  limits: { fileSize: MAX_PDF_BYTES, files: 1 },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (file.mimetype !== "application/pdf" && extension !== ".pdf") {
      callback(new SigningValidationError("Only PDF documents can be signed"));
      return;
    }
    callback(null, true);
  },
}).single("file");

export function generateSignatureRecipientToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashSignatureRecipientToken(token: string): string {
  if (!token || token.length > 512) return "";
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function sha256Buffer(buffer: Uint8Array): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  if (value instanceof Date) return value.toISOString();
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

type ManifestField = Pick<SignatureField, "id" | "type" | "pageNumber" | "sortOrder" | "valueJson">;

function orderedManifestFields(fields: ManifestField[]): ManifestField[] {
  return [...fields].sort(
    (left, right) =>
      left.pageNumber - right.pageNumber ||
      left.sortOrder - right.sortOrder ||
      left.id.localeCompare(right.id),
  );
}

/** Bind exactly what was accepted for one recipient to their completion event. */
export function signatureFieldValueManifestSha256(fields: ManifestField[]): string {
  const manifest = orderedManifestFields(fields).map((field) => ({
    fieldId: field.id,
    type: field.type,
    valueJson: field.valueJson,
  }));
  return sha256Buffer(Buffer.from(canonicalJson({ version: 1, fields: manifest }), "utf8"));
}

function signatureDefinitionManifestSha256(
  envelope: SignatureEnvelope,
  recipients: SignatureRecipient[],
  fields: SignatureField[],
): string {
  const definition = {
    version: 1,
    envelope: {
      id: envelope.id,
      title: envelope.title,
      message: envelope.message,
      routingMode: envelope.routingMode,
      expiresAt: envelope.expiresAt?.toISOString() ?? null,
      originalSha256: envelope.originalSha256,
      originalPageCount: envelope.originalPageCount,
    },
    recipients: [...recipients]
      .sort(
        (left, right) => left.routingOrder - right.routingOrder || left.id.localeCompare(right.id),
      )
      .map((recipient) => ({
        id: recipient.id,
        role: recipient.role,
        name: recipient.name,
        email: recipient.email,
        routingOrder: recipient.routingOrder,
      })),
    fields: [...fields]
      .sort(
        (left, right) =>
          left.pageNumber - right.pageNumber ||
          left.sortOrder - right.sortOrder ||
          left.id.localeCompare(right.id),
      )
      .map((field) => ({
        id: field.id,
        recipientId: field.recipientId,
        type: field.type,
        label: field.label,
        placeholder: field.placeholder,
        required: field.required,
        pageNumber: field.pageNumber,
        x: field.x,
        y: field.y,
        width: field.width,
        height: field.height,
        sortOrder: field.sortOrder,
      })),
  };
  return sha256Buffer(Buffer.from(canonicalJson(definition), "utf8"));
}

function signingFontAssetDirectory(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets/fonts");
}

async function signingFontAssets(): Promise<
  Record<keyof typeof SIGNING_FONT_FILES, SigningFontAsset>
> {
  signingFontAssetsPromise ??= Promise.all(
    Object.entries(SIGNING_FONT_FILES).map(async ([key, filename]) => {
      const bytes = await fs.promises.readFile(path.join(signingFontAssetDirectory(), filename));
      return [key, { bytes, coverage: fontkit.create(bytes) }] as const;
    }),
  ).then(
    (entries) =>
      Object.fromEntries(entries) as unknown as Record<
        keyof typeof SIGNING_FONT_FILES,
        SigningFontAsset
      >,
  );
  return signingFontAssetsPromise;
}

async function assertSigningTextSupported(text: string, label: string): Promise<void> {
  const safe = pdfSafeText(text);
  const assets = await signingFontAssets();
  const candidates = [assets.regular, assets.arabic, assets.cjk];
  for (const character of safe) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (!candidates.some((entry) => entry.coverage.hasGlyphForCodePoint(codePoint))) {
      throw new SigningValidationError(
        `${label} contains a character that cannot be embedded in the completed PDF (U+${codePoint
          .toString(16)
          .toUpperCase()
          .padStart(4, "0")})`,
      );
    }
  }
}

async function embedSigningFonts(
  pdf: PDFDocument,
  text: { regular: string[]; signature: string[] },
): Promise<EmbeddedSigningFonts> {
  const assets = await signingFontAssets();
  pdf.registerFontkit(fontkit);
  type FontKey = keyof typeof SIGNING_FONT_FILES;
  const needed = new Set<FontKey>();
  const collect = (values: string[], preferred: "regular" | "italic") => {
    if (values.some(Boolean)) needed.add(preferred);
    for (const value of values) {
      for (const character of value) {
        const codePoint = character.codePointAt(0);
        if (codePoint === undefined || assets[preferred].coverage.hasGlyphForCodePoint(codePoint)) {
          continue;
        }
        if (assets.arabic.coverage.hasGlyphForCodePoint(codePoint)) needed.add("arabic");
        else if (assets.cjk.coverage.hasGlyphForCodePoint(codePoint)) needed.add("cjk");
        else if (assets.regular.coverage.hasGlyphForCodePoint(codePoint)) needed.add("regular");
        // Unsupported evidence characters are escaped before drawing. Signer
        // values have already failed preflight in assertSigningTextSupported.
      }
    }
  };
  collect(text.regular, "regular");
  collect(text.signature, "italic");
  const embeddedEntries = await Promise.all(
    [...needed].map(
      async (key) =>
        [
          key,
          {
            ...assets[key],
            // fontkit's CJK subset output silently drops glyphs in common PDF
            // viewers. Embed Noto Sans SC intact whenever CJK text is present;
            // the smaller Latin and Arabic fonts remain compact subsets.
            font: await pdf.embedFont(assets[key].bytes, { subset: key !== "cjk" }),
          },
        ] as const,
    ),
  );
  const embedded = Object.fromEntries(embeddedEntries) as Partial<
    Record<FontKey, EmbeddedSigningFont>
  >;
  const present = (keys: FontKey[]) =>
    keys.flatMap((key) => (embedded[key] ? [embedded[key] as EmbeddedSigningFont] : []));
  return {
    regular: present(["regular", "arabic", "cjk"]),
    signature: present(["italic", "arabic", "cjk", "regular"]),
  };
}

function cleanText(value: unknown, label: string, max: number, required = true): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (required && !result) throw new SigningValidationError(`${label} is required`);
  if (result.length > max) {
    throw new SigningValidationError(`${label} must be ${max} characters or fewer`);
  }
  return result;
}

function normalizeActor(actor?: SigningActor): NormalizedActor {
  if (!actor) return { actorKind: "system", actorId: null };
  if ("userId" in actor) return { actorKind: "user", actorId: actor.userId };
  if ("employeeId" in actor) return { actorKind: "ai", actorId: actor.employeeId };
  if ("actorKind" in actor) {
    return { actorKind: actor.actorKind, actorId: actor.actorId ?? null };
  }
  return { actorKind: actor.kind, actorId: actor.id ?? null };
}

async function requireActorAccess(
  companyId: string,
  actor: NormalizedActor,
  required: SigningAccessLevel,
): Promise<void> {
  if (actor.actorKind !== "ai") return;
  if (!actor.actorId) throw new SigningValidationError("AI Employee actor id is required");
  if (
    !(await hasSigningAccess({ companyId, employeeId: actor.actorId, requiredAccess: required }))
  ) {
    throw new SigningConflictError(
      `This AI Employee needs ${required} signing access for that action`,
    );
  }
}

function validDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const result = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(result.getTime())) {
    throw new SigningValidationError("Expiration must be a valid date");
  }
  return result;
}

function flattenDraftDefinition(definition: DraftDefinition): {
  recipients?: SignatureRecipientInput[];
  fields?: SignatureFieldInput[];
} {
  if (!definition.recipients) return definition;
  const fields = [...(definition.fields ?? [])];
  const recipients = definition.recipients.map((recipient, index) => {
    const key = recipient.key || recipient.id || `recipient-${index}`;
    for (const nested of recipient.fields ?? []) {
      fields.push({ ...nested, recipientKey: key });
    }
    const { fields: _fields, ...withoutFields } = recipient;
    return { ...withoutFields, key };
  });
  return { recipients, fields };
}

export function validateSignatureFieldCoordinates(
  field: Pick<SignatureFieldInput, "pageNumber" | "x" | "y" | "width" | "height">,
  pageCount: number,
): void {
  if (!Number.isInteger(field.pageNumber) || field.pageNumber < 1 || field.pageNumber > pageCount) {
    throw new SigningValidationError(`Field page must be between 1 and ${pageCount}`);
  }
  for (const [key, value] of Object.entries({
    x: field.x,
    y: field.y,
    width: field.width,
    height: field.height,
  })) {
    if (!Number.isFinite(value)) {
      throw new SigningValidationError(`Field ${key} must be a finite number`);
    }
  }
  if (
    field.x < 0 ||
    field.y < 0 ||
    field.width <= 0 ||
    field.height <= 0 ||
    field.x > 1 ||
    field.y > 1 ||
    field.width > 1 ||
    field.height > 1 ||
    field.x + field.width > 1 + Number.EPSILON ||
    field.y + field.height > 1 + Number.EPSILON
  ) {
    throw new SigningValidationError(
      "Field coordinates and dimensions must fit inside the normalized page bounds",
    );
  }
}

type ValidatedPdf = {
  buffer: Buffer;
  pageCount: number;
  sha256: string;
  documentText: string;
};

async function validatePdfBytes(buffer: Buffer): Promise<ValidatedPdf> {
  if (!buffer.length) throw new SigningValidationError("The PDF is empty");
  if (buffer.length > MAX_PDF_BYTES) {
    throw new SigningValidationError("The PDF must be 25 MB or smaller");
  }
  if (!buffer.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
    throw new SigningValidationError("The uploaded file is not a valid PDF");
  }
  let pdf: PDFDocument;
  try {
    pdf = await PDFDocument.load(buffer, { updateMetadata: false });
  } catch {
    throw new SigningValidationError(
      "The PDF is invalid or password protected. Upload an unencrypted PDF.",
    );
  }
  const pageCount = pdf.getPageCount();
  if (pageCount < 1) throw new SigningValidationError("The PDF has no pages");
  if (pageCount > MAX_SIGNATURE_PDF_PAGES) {
    throw new SigningValidationError(`The PDF must have ${MAX_SIGNATURE_PDF_PAGES} pages or fewer`);
  }
  let documentText = "";
  try {
    documentText = (await pdfBufferToText(buffer))
      .split("\0")
      .join("")
      .slice(0, 1024 * 1024);
  } catch {
    // A valid image-only PDF is still signable; extraction is an AI drafting aid.
  }
  return { buffer, pageCount, sha256: sha256Buffer(buffer), documentText };
}

async function readAndValidatePdf(filePath: string): Promise<ValidatedPdf> {
  let buffer: Buffer;
  try {
    buffer = await fs.promises.readFile(filePath);
  } catch {
    throw new SigningValidationError("The uploaded PDF could not be read");
  }
  return validatePdfBytes(buffer);
}

function eventHashPayload(event: {
  companyId: string;
  envelopeId: string;
  recipientId: string | null;
  type: SignatureEventType;
  actorKind: SignatureEventActorKind;
  actorId: string | null;
  ipAddress: string;
  userAgent: string;
  metadataJson: string;
  previousHash: string;
  createdAt: Date;
}): string {
  let metadata: unknown = {};
  try {
    metadata = JSON.parse(event.metadataJson);
  } catch {
    metadata = event.metadataJson;
  }
  return canonicalJson({
    version: 1,
    companyId: event.companyId,
    envelopeId: event.envelopeId,
    recipientId: event.recipientId,
    type: event.type,
    actorKind: event.actorKind,
    actorId: event.actorId,
    ipAddress: event.ipAddress,
    userAgent: event.userAgent,
    metadata,
    previousHash: event.previousHash,
    createdAt: event.createdAt.toISOString(),
  });
}

async function appendSignatureEvent(
  manager: EntityManager,
  params: {
    companyId: string;
    envelopeId: string;
    recipientId?: string | null;
    type: SignatureEventType;
    actor: NormalizedActor;
    ipAddress?: string;
    userAgent?: string;
    metadata?: Record<string, unknown>;
    now?: Date;
  },
): Promise<SignatureEvent> {
  // Postgres permits two parallel signers to finish at once. Serialize every
  // chain append on the envelope row so they cannot both choose the same head.
  if (AppDataSource.options.type === "postgres") {
    await manager
      .getRepository(SignatureEnvelope)
      .createQueryBuilder("envelope")
      .setLock("pessimistic_write")
      .where("envelope.id = :id", { id: params.envelopeId })
      .andWhere("envelope.companyId = :companyId", { companyId: params.companyId })
      .getOne();
  }
  const repository = manager.getRepository(SignatureEvent);
  const previous = await repository.findOne({
    where: { companyId: params.companyId, envelopeId: params.envelopeId },
    order: { createdAt: "DESC", id: "DESC" },
  });
  const requestedTime = params.now ?? new Date();
  const createdAt =
    previous && requestedTime.getTime() <= previous.createdAt.getTime()
      ? new Date(previous.createdAt.getTime() + 1)
      : requestedTime;
  const event = repository.create({
    companyId: params.companyId,
    envelopeId: params.envelopeId,
    recipientId: params.recipientId ?? null,
    type: params.type,
    actorKind: params.actor.actorKind,
    actorId: params.actor.actorId,
    ipAddress: cleanNetworkValue(params.ipAddress, 255),
    userAgent: cleanNetworkValue(params.userAgent, 2048),
    metadataJson: canonicalJson(params.metadata ?? {}),
    previousHash: previous?.eventHash ?? "",
    eventHash: "",
    createdAt,
  });
  event.eventHash = sha256Buffer(Buffer.from(eventHashPayload(event)));
  return repository.save(event);
}

async function findEnvelopeForUpdate(
  manager: EntityManager,
  companyId: string,
  envelopeId: string,
): Promise<SignatureEnvelope | null> {
  if (AppDataSource.options.type === "postgres") {
    return manager
      .getRepository(SignatureEnvelope)
      .createQueryBuilder("envelope")
      .setLock("pessimistic_write")
      .where("envelope.id = :envelopeId", { envelopeId })
      .andWhere("envelope.companyId = :companyId", { companyId })
      .getOne();
  }
  return manager.getRepository(SignatureEnvelope).findOneBy({
    id: envelopeId,
    companyId,
  });
}

function cleanNetworkValue(value: string | undefined, max: number): string {
  return stripUnsafeControlCharacters(value ?? "")
    .trim()
    .slice(0, max);
}

function stripUnsafeControlCharacters(value: string): string {
  return value
    .split("\0")
    .join(" ")
    .replace(/[\r\n]/g, " ");
}

export async function verifySignatureEventChain(params: {
  companyId: string;
  envelopeId: string;
}): Promise<{
  valid: boolean;
  count: number;
  headHash: string;
  error: string;
}> {
  const events = await AppDataSource.getRepository(SignatureEvent).find({
    where: { companyId: params.companyId, envelopeId: params.envelopeId },
    order: { createdAt: "ASC", id: "ASC" },
  });
  let previousHash = "";
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const expected = sha256Buffer(Buffer.from(eventHashPayload(event)));
    if (event.previousHash !== previousHash) {
      return {
        valid: false,
        count: events.length,
        headHash: previousHash,
        error: `Event ${index + 1} does not point to the previous event`,
      };
    }
    if (!SHA256_HEX.test(event.eventHash) || event.eventHash !== expected) {
      return {
        valid: false,
        count: events.length,
        headHash: previousHash,
        error: `Event ${index + 1} hash is invalid`,
      };
    }
    previousHash = event.eventHash;
  }
  return {
    valid: true,
    count: events.length,
    headHash: previousHash,
    error: "",
  };
}

async function assertCustomer(companyId: string, customerId: string | null): Promise<void> {
  if (!customerId) return;
  const customer = await AppDataSource.getRepository(Customer).findOneBy({
    id: customerId,
    companyId,
  });
  if (!customer) throw new SigningValidationError("Customer does not belong to this company");
}

async function createEnvelopeFromPdf(params: {
  company: Company;
  pdf: ValidatedPdf;
  filename: string;
  title: string;
  message?: string;
  customerId?: string | null;
  routingMode?: SignatureRoutingMode;
  expiresAt?: Date | string | null;
  recipients?: SignatureRecipientInput[];
  fields?: SignatureFieldInput[];
  actor?: SigningActor;
}): Promise<SignatureEnvelopeDetail> {
  const actor = normalizeActor(params.actor);
  await requireActorAccess(params.company.id, actor, "draft");
  await assertCustomer(params.company.id, params.customerId ?? null);
  const title = cleanText(params.title, "Title", 255);
  const message = cleanText(params.message ?? "", "Message", 10_000, false);
  const routingMode = params.routingMode ?? "parallel";
  if (!SIGNATURE_ROUTING_MODES.includes(routingMode)) {
    throw new SigningValidationError("Routing mode must be parallel or ordered");
  }
  const expiresAt = validDate(params.expiresAt);
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw new SigningValidationError("Expiration must be in the future");
  }

  const storageKey = `original-${crypto.randomUUID()}.pdf`;
  const absolute = resolveSigningStoragePath(params.company.slug, storageKey);
  if (!absolute) throw new Error("Could not create signature storage path");
  ensureDir(signingRoot(params.company.slug));
  await fs.promises.writeFile(absolute, params.pdf.buffer, { flag: "wx", mode: 0o600 });

  let envelopeId = "";
  try {
    envelopeId = await AppDataSource.transaction(async (manager) => {
      const repository = manager.getRepository(SignatureEnvelope);
      const envelope = await repository.save(
        repository.create({
          companyId: params.company.id,
          customerId: params.customerId ?? null,
          title,
          message,
          status: "draft",
          routingMode,
          originalFilename: cleanFilename(params.filename),
          originalMimeType: "application/pdf",
          originalSizeBytes: params.pdf.buffer.length,
          originalStorageKey: storageKey,
          originalPageCount: params.pdf.pageCount,
          documentText: params.pdf.documentText,
          originalSha256: params.pdf.sha256,
          completedStorageKey: null,
          completedSizeBytes: 0,
          completedSha256: "",
          customerContractId: null,
          expiresAt,
          sentAt: null,
          completedAt: null,
          declinedAt: null,
          declineReason: "",
          voidedAt: null,
          voidReason: "",
          expiredAt: null,
          createdByUserId: actor.actorKind === "user" ? actor.actorId : null,
          createdByEmployeeId: actor.actorKind === "ai" ? actor.actorId : null,
        }),
      );
      await appendSignatureEvent(manager, {
        companyId: envelope.companyId,
        envelopeId: envelope.id,
        type: "envelope_created",
        actor,
        metadata: {
          originalSha256: envelope.originalSha256,
          originalSizeBytes: envelope.originalSizeBytes,
          originalPageCount: envelope.originalPageCount,
        },
      });
      if (params.recipients) {
        await replaceDraftParticipants(manager, envelope, {
          recipients: params.recipients,
          fields: params.fields ?? [],
        });
      }
      return envelope.id;
    });
  } catch (error) {
    await fs.promises.unlink(absolute).catch(() => undefined);
    throw error;
  }
  return getSignatureEnvelopeDetail({ companyId: params.company.id, envelopeId });
}

function cleanFilename(filename: string): string {
  const basename = stripUnsafeControlCharacters(path.basename(filename || "document.pdf"));
  return (basename || "document.pdf").slice(0, 255);
}

export async function createSignatureEnvelopeFromUpload(params: {
  company: Company;
  file: Express.Multer.File;
  title: string;
  message?: string;
  customerId?: string | null;
  routingMode?: SignatureRoutingMode;
  expiresAt?: Date | string | null;
  recipients?: SignatureRecipientInput[];
  fields?: SignatureFieldInput[];
  actor: SigningActor;
}): Promise<SignatureEnvelopeDetail> {
  try {
    const pdf = await readAndValidatePdf(params.file.path);
    return await createEnvelopeFromPdf({
      ...params,
      pdf,
      filename: params.file.originalname,
    });
  } finally {
    // Multer's upload path is temporary; the validated immutable copy is stored below.
    await fs.promises.unlink(params.file.path).catch(() => undefined);
  }
}

export async function createSignatureEnvelopeFromResource(params: {
  company: Company;
  resourceId?: string;
  resourceSlug?: string;
  employeeId: string;
  title?: string;
  message?: string;
  customerId?: string | null;
  routingMode?: SignatureRoutingMode;
  expiresAt?: Date | string | null;
  recipients?: SignatureRecipientInput[];
  fields?: SignatureFieldInput[];
  actor?: SigningActor;
}): Promise<SignatureEnvelopeDetail> {
  const actor = normalizeActor(params.actor ?? { employeeId: params.employeeId });
  if (actor.actorKind !== "ai" || actor.actorId !== params.employeeId) {
    throw new SigningValidationError(
      "Resource signing drafts must identify the acting AI Employee",
    );
  }
  await requireActorAccess(params.company.id, actor, "draft");
  const where: FindOptionsWhere<Resource> = { companyId: params.company.id };
  if (params.resourceId) where.id = params.resourceId;
  else if (params.resourceSlug) where.slug = params.resourceSlug;
  else throw new SigningValidationError("Resource id or slug is required");
  const resource = await AppDataSource.getRepository(Resource).findOneBy(where);
  if (!resource) throw new SigningNotFoundError("PDF Resource not found");
  if (resource.sourceKind !== "pdf" || !resource.storageKey) {
    throw new SigningValidationError("The Resource must be an uploaded PDF");
  }
  if (!(await hasResourceAccess(params.employeeId, resource.id, "read"))) {
    throw new SigningConflictError("This AI Employee cannot read that PDF Resource");
  }
  const absolute = resolveResourceFile(params.company.slug, resource.storageKey);
  if (!absolute) throw new SigningNotFoundError("The PDF Resource file is missing");
  const pdf = await readAndValidatePdf(absolute);
  const definition = flattenDraftDefinition({
    recipients: params.recipients,
    fields: params.fields,
  });
  return createEnvelopeFromPdf({
    ...params,
    actor: { actorKind: "ai", actorId: params.employeeId },
    title: params.title ?? resource.title,
    filename: resource.sourceFilename ?? `${resource.slug}.pdf`,
    pdf,
    recipients: definition.recipients,
    fields: definition.fields,
  });
}

/**
 * Normalize structurally valid participant rows. A PATCH may preserve blank or
 * not-yet-valid contact details; create-with-definition and send both opt into
 * readiness checks so an invitation can never target an incomplete address.
 */
function normalizeRecipients(
  inputs: SignatureRecipientInput[],
  options: { requireReady?: boolean } = {},
): Array<Omit<SignatureRecipientInput, "fields"> & { key: string; routingOrder: number }> {
  const requireReady = options.requireReady ?? true;
  if (!Array.isArray(inputs) || (requireReady && !inputs.length)) {
    throw new SigningValidationError("Add at least one signer");
  }
  const emails = new Set<string>();
  const keys = new Set<string>();
  const result = inputs.map((input, index) => {
    if (!SIGNATURE_RECIPIENT_ROLES.includes(input.role)) {
      throw new SigningValidationError("Recipient role must be signer or copy");
    }
    const name = cleanText(input.name, `Recipient ${index + 1} name`, 255, false);
    if (requireReady && !name) {
      throw new SigningValidationError(`Recipient ${index + 1} needs a name before sending`);
    }
    const enteredEmail = cleanText(input.email, `Recipient ${index + 1} email`, 320, false);
    const normalizedEmail = normalizeEmail(enteredEmail);
    if (requireReady && !normalizedEmail) {
      throw new SigningValidationError(
        `${name || `Recipient ${index + 1}`} needs a valid email address before sending`,
      );
    }
    const email = normalizedEmail ?? enteredEmail;
    if (requireReady && emails.has(email)) {
      throw new SigningValidationError("Recipient email addresses must be unique before sending");
    }
    if (requireReady) emails.add(email);
    const routingOrder = input.routingOrder ?? index;
    if (!Number.isInteger(routingOrder) || routingOrder < 0 || routingOrder > 10_000) {
      throw new SigningValidationError("Recipient routing order must be a non-negative integer");
    }
    const key = cleanText(input.key ?? input.id ?? `recipient-${index}`, "Recipient key", 255);
    if (keys.has(key)) throw new SigningValidationError("Recipient keys must be unique");
    keys.add(key);
    return { ...input, name, email, key, routingOrder };
  });
  if (requireReady && !result.some((recipient) => recipient.role === "signer")) {
    throw new SigningValidationError("Add at least one signer");
  }
  return result;
}

async function replaceDraftParticipants(
  manager: EntityManager,
  envelope: SignatureEnvelope,
  definition: { recipients: SignatureRecipientInput[]; fields: SignatureFieldInput[] },
  options: { requireReady?: boolean } = {},
): Promise<void> {
  const flattened = flattenDraftDefinition(definition);
  const requireReady = options.requireReady ?? true;
  const normalizedRecipients = normalizeRecipients(flattened.recipients ?? [], { requireReady });
  const recipientRepository = manager.getRepository(SignatureRecipient);
  const fieldRepository = manager.getRepository(SignatureField);
  const oldRecipients = await recipientRepository.findBy({
    companyId: envelope.companyId,
    envelopeId: envelope.id,
  });
  if (oldRecipients.length) {
    await fieldRepository.delete({
      companyId: envelope.companyId,
      envelopeId: envelope.id,
    });
    await recipientRepository.delete({
      companyId: envelope.companyId,
      envelopeId: envelope.id,
    });
  }
  const byReference = new Map<string, SignatureRecipient>();
  const ambiguousReferences = new Set<string>();
  const savedRecipients: SignatureRecipient[] = [];
  for (const input of normalizedRecipients) {
    const saved = await recipientRepository.save(
      recipientRepository.create({
        companyId: envelope.companyId,
        envelopeId: envelope.id,
        role: input.role,
        name: input.name,
        email: input.email,
        routingOrder: input.routingOrder,
        status: "waiting",
        tokenHash: null,
        lastDeliveryStatus: "pending",
        lastDeliveryError: "",
        lastDeliveredAt: null,
        reminderCount: 0,
        viewedAt: null,
        consentedAt: null,
        completedAt: null,
        declinedAt: null,
        declineReason: "",
        ipAddress: "",
        userAgent: "",
      }),
    );
    savedRecipients.push(saved);
    for (const reference of [input.id, input.key, input.email]) {
      const normalizedReference = reference?.trim().toLowerCase();
      if (!normalizedReference) continue;
      const existing = byReference.get(normalizedReference);
      if (existing && existing.id !== saved.id) ambiguousReferences.add(normalizedReference);
      else byReference.set(normalizedReference, saved);
    }
  }
  const inputs = flattened.fields ?? [];
  const signatureOwners = new Set<string>();
  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index];
    if (!SIGNATURE_FIELD_TYPES.includes(input.type)) {
      throw new SigningValidationError(`Field ${index + 1} type is invalid`);
    }
    validateSignatureFieldCoordinates(input, envelope.originalPageCount);
    const reference = input.recipientId ?? input.recipientKey ?? input.recipientEmail;
    if (!reference) throw new SigningValidationError(`Field ${index + 1} needs a recipient`);
    const normalizedReference = reference.trim().toLowerCase();
    if (ambiguousReferences.has(normalizedReference)) {
      throw new SigningValidationError(`Field ${index + 1} recipient reference is ambiguous`);
    }
    const recipient = byReference.get(normalizedReference);
    if (!recipient) {
      throw new SigningValidationError(`Field ${index + 1} recipient was not found`);
    }
    if (recipient.role !== "signer") {
      throw new SigningValidationError("Copy recipients cannot own signing fields");
    }
    const required = input.required ?? true;
    if (input.type === "signature" && required) signatureOwners.add(recipient.id);
    await fieldRepository.save(
      fieldRepository.create({
        companyId: envelope.companyId,
        envelopeId: envelope.id,
        recipientId: recipient.id,
        type: input.type,
        label: cleanText(input.label ?? "", "Field label", 255, false),
        placeholder: cleanText(input.placeholder ?? "", "Field placeholder", 255, false),
        required,
        pageNumber: input.pageNumber,
        x: input.x,
        y: input.y,
        width: input.width,
        height: input.height,
        valueJson: "null",
        completedAt: null,
        sortOrder: Number.isFinite(input.sortOrder) ? Number(input.sortOrder) : index,
      }),
    );
  }
  for (const recipient of savedRecipients) {
    if (requireReady && recipient.role === "signer" && !signatureOwners.has(recipient.id)) {
      throw new SigningValidationError(
        `${recipient.name} needs at least one required signature field`,
      );
    }
  }
}

export async function listSignatureEnvelopes(params: {
  companyId: string;
  status?: SignatureEnvelopeStatus | string;
  customerId?: string;
  q?: string;
}): Promise<
  Array<SignatureEnvelope & { recipientCount: number; completedRecipientCount: number }>
> {
  if (
    params.status &&
    !SIGNATURE_ENVELOPE_STATUSES.includes(params.status as SignatureEnvelopeStatus)
  ) {
    throw new SigningValidationError("Signature request status is invalid");
  }
  const where: FindOptionsWhere<SignatureEnvelope> = { companyId: params.companyId };
  if (params.status) where.status = params.status as SignatureEnvelopeStatus;
  if (params.customerId) where.customerId = params.customerId;
  let envelopes = await AppDataSource.getRepository(SignatureEnvelope).find({
    where,
    order: { updatedAt: "DESC" },
  });
  const query = params.q?.trim().toLowerCase();
  if (query) {
    envelopes = envelopes.filter((envelope) =>
      `${envelope.title} ${envelope.originalFilename}`.toLowerCase().includes(query),
    );
  }
  const ids = envelopes.map((envelope) => envelope.id);
  const recipients = ids.length
    ? await AppDataSource.getRepository(SignatureRecipient).findBy({ envelopeId: In(ids) })
    : [];
  return envelopes.map((envelope) => {
    const signers = recipients.filter(
      (recipient) => recipient.envelopeId === envelope.id && recipient.role === "signer",
    );
    return Object.assign(envelope, {
      recipientCount: signers.length,
      completedRecipientCount: signers.filter((recipient) => recipient.status === "completed")
        .length,
    });
  });
}

function parseFieldValue(valueJson: string): SignatureFieldValue {
  try {
    return JSON.parse(valueJson) as SignatureFieldValue;
  } catch {
    return null;
  }
}

function parseEventMetadata(metadataJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

type VerifiedRecipientEvidence = {
  consentedAt: Date;
  completedAt: Date;
  ipAddress: string;
  userAgent: string;
  metadata: Record<string, unknown>;
};

function verifiedEvidenceManifests(params: {
  envelope: SignatureEnvelope;
  recipients: SignatureRecipient[];
  fields: SignatureField[];
  events: SignatureEvent[];
}): {
  definitionManifestSha256: string;
  valueManifestSha256ByRecipient: Map<string, string>;
  recipientEvidenceByRecipient: Map<string, VerifiedRecipientEvidence>;
} {
  const sentEvent = params.events.find((event) => event.type === "envelope_sent");
  const sentMetadata = sentEvent ? parseEventMetadata(sentEvent.metadataJson) : {};
  const recordedDefinition = sentMetadata.definitionManifestSha256;
  // Compare the stored sent manifest with the current persisted definition.
  // A deadline passing does not mutate `expiresAt`; substituting the value
  // copied into the sent event would instead hide an unauthorized post-send
  // deadline change from the integrity check.
  const currentDefinition = signatureDefinitionManifestSha256(
    params.envelope,
    params.recipients,
    params.fields,
  );
  if (
    typeof recordedDefinition !== "string" ||
    !SHA256_HEX.test(recordedDefinition) ||
    recordedDefinition !== currentDefinition
  ) {
    throw new SigningConflictError(
      "The frozen signature request definition failed its integrity check",
    );
  }

  const valueManifestSha256ByRecipient = new Map<string, string>();
  const recipientEvidenceByRecipient = new Map<string, VerifiedRecipientEvidence>();
  for (const recipient of params.recipients.filter((row) => row.role === "signer")) {
    const consentEvents = params.events.filter(
      (event) => event.type === "recipient_consented" && event.recipientId === recipient.id,
    );
    const completionEvents = params.events.filter(
      (event) => event.type === "recipient_completed" && event.recipientId === recipient.id,
    );
    if (consentEvents.length !== 1 || completionEvents.length !== 1) {
      throw new SigningConflictError(`${recipient.name}'s signing evidence is incomplete`);
    }
    const consent = consentEvents[0];
    const completion = completionEvents[0];
    if (
      consent.actorKind !== "recipient" ||
      consent.actorId !== recipient.id ||
      completion.actorKind !== "recipient" ||
      completion.actorId !== recipient.id ||
      completion.createdAt.getTime() < consent.createdAt.getTime()
    ) {
      throw new SigningConflictError(`${recipient.name}'s signing evidence is invalid`);
    }
    const metadata = parseEventMetadata(completion.metadataJson);
    const recordedManifest = metadata.valueManifestSha256;
    const currentManifest = signatureFieldValueManifestSha256(
      params.fields.filter((field) => field.recipientId === recipient.id),
    );
    if (
      typeof recordedManifest !== "string" ||
      !SHA256_HEX.test(recordedManifest) ||
      recordedManifest !== currentManifest
    ) {
      throw new SigningConflictError(
        `${recipient.name}'s accepted field values failed their integrity check`,
      );
    }
    if (
      !Number.isInteger(metadata.timezoneOffsetMinutes) ||
      Number(metadata.timezoneOffsetMinutes) < -840 ||
      Number(metadata.timezoneOffsetMinutes) > 840 ||
      typeof metadata.signingCalendarDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(metadata.signingCalendarDate) ||
      !(
        metadata.timeZone === null ||
        metadata.timeZone === undefined ||
        typeof metadata.timeZone === "string"
      )
    ) {
      throw new SigningConflictError(`${recipient.name}'s signing-time evidence is invalid`);
    }
    valueManifestSha256ByRecipient.set(recipient.id, currentManifest);
    recipientEvidenceByRecipient.set(recipient.id, {
      consentedAt: consent.createdAt,
      completedAt: completion.createdAt,
      ipAddress: completion.ipAddress,
      userAgent: completion.userAgent,
      metadata,
    });
  }
  return {
    definitionManifestSha256: currentDefinition,
    valueManifestSha256ByRecipient,
    recipientEvidenceByRecipient,
  };
}

export async function getSignatureEnvelopeDetail(params: {
  companyId: string;
  envelopeId: string;
}): Promise<SignatureEnvelopeDetail> {
  const envelope = await AppDataSource.getRepository(SignatureEnvelope).findOneBy({
    id: params.envelopeId,
    companyId: params.companyId,
  });
  if (!envelope) throw new SigningNotFoundError();
  const [recipients, fields, events] = await Promise.all([
    AppDataSource.getRepository(SignatureRecipient).find({
      where: { companyId: params.companyId, envelopeId: envelope.id },
      order: { routingOrder: "ASC", createdAt: "ASC" },
    }),
    AppDataSource.getRepository(SignatureField).find({
      where: { companyId: params.companyId, envelopeId: envelope.id },
      order: { pageNumber: "ASC", sortOrder: "ASC" },
    }),
    AppDataSource.getRepository(SignatureEvent).find({
      where: { companyId: params.companyId, envelopeId: envelope.id },
      order: { createdAt: "ASC", id: "ASC" },
    }),
  ]);
  return {
    envelope,
    recipients,
    fields: fields.map((field) =>
      Object.assign(field, { value: parseFieldValue(field.valueJson) }),
    ),
    events: events.map((event) =>
      Object.assign(event, { metadata: parseEventMetadata(event.metadataJson) }),
    ),
  };
}

export async function updateSignatureEnvelopeDraft(params: {
  companyId: string;
  envelopeId: string;
  expectedUpdatedAt?: string | null;
  title?: string;
  message?: string;
  customerId?: string | null;
  routingMode?: SignatureRoutingMode;
  expiresAt?: Date | string | null;
  recipients?: SignatureRecipientInput[];
  fields?: SignatureFieldInput[];
  actor: SigningActor;
}): Promise<SignatureEnvelopeDetail> {
  const actor = normalizeActor(params.actor);
  await requireActorAccess(params.companyId, actor, "draft");
  if (params.customerId !== undefined) await assertCustomer(params.companyId, params.customerId);
  await AppDataSource.transaction(async (manager) => {
    const repository = manager.getRepository(SignatureEnvelope);
    const envelope = await findEnvelopeForUpdate(manager, params.companyId, params.envelopeId);
    if (!envelope) throw new SigningNotFoundError();
    if (envelope.status !== "draft") {
      throw new SigningConflictError("A sent signature request cannot be changed");
    }
    if (params.expectedUpdatedAt) {
      const expectedUpdatedAt = new Date(params.expectedUpdatedAt);
      if (
        !Number.isFinite(expectedUpdatedAt.getTime()) ||
        expectedUpdatedAt.getTime() !== envelope.updatedAt.getTime()
      ) {
        throw new SigningConflictError(
          "This draft changed since you opened it. Reload the latest version before saving.",
        );
      }
    }
    if (params.title !== undefined) envelope.title = cleanText(params.title, "Title", 255);
    if (params.message !== undefined) {
      envelope.message = cleanText(params.message, "Message", 10_000, false);
    }
    if (params.customerId !== undefined) envelope.customerId = params.customerId;
    if (params.routingMode !== undefined) {
      if (!SIGNATURE_ROUTING_MODES.includes(params.routingMode)) {
        throw new SigningValidationError("Routing mode must be parallel or ordered");
      }
      envelope.routingMode = params.routingMode;
    }
    if (params.expiresAt !== undefined) {
      envelope.expiresAt = validDate(params.expiresAt);
    }
    // Replacing only recipients/fields must still advance the envelope's
    // optimistic revision. Move it by at least one millisecond so two rapid
    // saves cannot receive the same revision even on a coarse clock.
    envelope.updatedAt = new Date(Math.max(Date.now(), envelope.updatedAt.getTime() + 1));
    await repository.save(envelope);
    if (params.recipients !== undefined) {
      await replaceDraftParticipants(
        manager,
        envelope,
        {
          recipients: params.recipients,
          fields: params.fields ?? [],
        },
        { requireReady: false },
      );
    } else if (params.fields !== undefined) {
      throw new SigningValidationError("Recipients are required when replacing fields");
    }
    await appendSignatureEvent(manager, {
      companyId: envelope.companyId,
      envelopeId: envelope.id,
      type: "envelope_updated",
      actor,
      metadata: {
        recipientsReplaced: params.recipients !== undefined,
      },
    });
  });
  return getSignatureEnvelopeDetail(params);
}

export async function duplicateSignatureEnvelope(params: {
  company: Company;
  envelopeId: string;
  title?: string;
  actor: SigningActor;
}): Promise<SignatureEnvelopeDetail> {
  const detail = await getSignatureEnvelopeDetail({
    companyId: params.company.id,
    envelopeId: params.envelopeId,
  });
  const source = resolveSigningStoragePath(params.company.slug, detail.envelope.originalStorageKey);
  if (!source || !fs.existsSync(source)) throw new SigningNotFoundError("Original PDF is missing");
  const pdf = await readAndValidatePdf(source);
  const keyByRecipient = new Map(
    detail.recipients.map((recipient) => [recipient.id, recipient.id]),
  );
  return createEnvelopeFromPdf({
    company: params.company,
    pdf,
    filename: detail.envelope.originalFilename,
    title: params.title ?? `Copy of ${detail.envelope.title}`,
    message: detail.envelope.message,
    customerId: detail.envelope.customerId,
    routingMode: detail.envelope.routingMode,
    recipients: detail.recipients.map((recipient) => ({
      key: keyByRecipient.get(recipient.id),
      role: recipient.role,
      name: recipient.name,
      email: recipient.email,
      routingOrder: recipient.routingOrder,
    })),
    fields: detail.fields.map((field) => ({
      recipientKey: keyByRecipient.get(field.recipientId),
      type: field.type,
      label: field.label,
      placeholder: field.placeholder,
      required: field.required,
      pageNumber: field.pageNumber,
      x: field.x,
      y: field.y,
      width: field.width,
      height: field.height,
      sortOrder: field.sortOrder,
    })),
    actor: params.actor,
  });
}

async function requireCompany(companyId: string): Promise<Company> {
  const company = await AppDataSource.getRepository(Company).findOneBy({ id: companyId });
  if (!company) throw new SigningNotFoundError("Company not found");
  return company;
}

async function assertEnvelopeSourceReadyToSend(params: {
  company: Company;
  envelope: SignatureEnvelope;
  recipients: SignatureRecipient[];
  fields: SignatureField[];
}): Promise<void> {
  const originalPath = resolveSigningStoragePath(
    params.company.slug,
    params.envelope.originalStorageKey,
  );
  if (!originalPath) throw new SigningNotFoundError("The original PDF is missing");
  let original: Buffer;
  try {
    original = await fs.promises.readFile(originalPath);
  } catch {
    throw new SigningNotFoundError("The original PDF is missing");
  }
  if (
    original.length !== Number(params.envelope.originalSizeBytes) ||
    sha256Buffer(original) !== params.envelope.originalSha256
  ) {
    throw new SigningConflictError("The original PDF failed its integrity check");
  }
  // Exercise every immutable page placement before invitations exist. This
  // catches missing pages, unsupported rotations, and malformed CropBoxes even
  // for fields whose human-supplied value is not known until signing time.
  let pdf: PDFDocument;
  try {
    pdf = await PDFDocument.load(original, { updateMetadata: false });
  } catch {
    throw new SigningConflictError("The original PDF failed its integrity check");
  }
  if (pdf.getPageCount() !== params.envelope.originalPageCount) {
    throw new SigningConflictError("The original PDF failed its integrity check");
  }
  const pages = pdf.getPages();
  for (const field of params.fields) {
    const page = pages[field.pageNumber - 1];
    if (!page) throw new SigningValidationError("A signing field references a missing page");
    const box = normalizedFieldBoxForPage(page, field);
    if (
      ![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
      box.width <= 0 ||
      box.height <= 0
    ) {
      throw new SigningValidationError("A signing field has invalid PDF geometry");
    }
  }

  // Name, email, and date fields are filled by Genosyn rather than the signer.
  // Render representative immutable values now so an undersized field cannot
  // become a sent envelope that its recipient has no way to repair.
  const recipientsById = new Map(params.recipients.map((recipient) => [recipient.id, recipient]));
  const serverDerivedFields = params.fields.flatMap((field) => {
    const recipient = recipientsById.get(field.recipientId);
    if (!recipient) {
      throw new SigningValidationError("A signing field references a missing recipient");
    }
    const value =
      field.type === "name"
        ? recipient.name
        : field.type === "email"
          ? recipient.email
          : field.type === "date"
            ? "2000-12-31"
            : null;
    return value === null
      ? []
      : [Object.assign(new SignatureField(), field, { valueJson: canonicalJson(value) })];
  });
  if (serverDerivedFields.length) {
    await assertCompletedValuesRenderable({ original, fields: serverDerivedFields });
  }
}

async function assertEnvelopeReadyToSend(
  manager: EntityManager,
  company: Company,
  envelope: SignatureEnvelope,
): Promise<{ recipients: SignatureRecipient[]; fields: SignatureField[] }> {
  const recipients = await manager.getRepository(SignatureRecipient).find({
    where: { companyId: envelope.companyId, envelopeId: envelope.id },
    order: { routingOrder: "ASC", createdAt: "ASC" },
  });
  normalizeRecipients(
    recipients.map((recipient) => ({
      id: recipient.id,
      role: recipient.role,
      name: recipient.name,
      email: recipient.email,
      routingOrder: recipient.routingOrder,
    })),
  );
  const signers = recipients.filter((recipient) => recipient.role === "signer");
  if (!signers.length) throw new SigningValidationError("Add at least one signer");
  const fields = await manager.getRepository(SignatureField).findBy({
    companyId: envelope.companyId,
    envelopeId: envelope.id,
  });
  for (const field of fields) {
    validateSignatureFieldCoordinates(field, envelope.originalPageCount);
  }
  for (const signer of signers) {
    if (
      !fields.some(
        (field) => field.recipientId === signer.id && field.type === "signature" && field.required,
      )
    ) {
      throw new SigningValidationError(
        `${signer.name} needs at least one required signature field`,
      );
    }
  }
  await assertSigningTextSupported(envelope.title, "Title");
  for (const recipient of recipients) {
    await assertSigningTextSupported(recipient.name, `${recipient.name}'s recipient name`);
    await assertSigningTextSupported(recipient.email, `${recipient.name}'s email address`);
  }
  if (
    envelope.status !== "completed" &&
    envelope.expiresAt &&
    envelope.expiresAt.getTime() <= Date.now()
  ) {
    throw new SigningValidationError("Choose a future expiration before sending");
  }
  await assertEnvelopeSourceReadyToSend({ company, envelope, recipients, fields });
  return { recipients, fields };
}

type PendingDelivery = { recipient: SignatureRecipient; token: string };

type DeliveryAttempt = {
  recipient: SignatureRecipient;
  tokenHash: string;
  result: Awaited<ReturnType<typeof sendEmail>>;
  reminder: boolean;
};

function invitationMessage(
  company: Company,
  envelope: SignatureEnvelope,
  recipient: SignatureRecipient,
  token: string,
  reminder: boolean,
): Parameters<typeof sendEmail>[0] {
  const link = `${getPublicUrl()}/sign/${encodeURIComponent(token)}`;
  const prefix = reminder ? "Reminder: " : "";
  const expiry = envelope.expiresAt
    ? `\n\nThis request expires ${envelope.expiresAt.toISOString()}.`
    : "";
  const note = envelope.message ? `\n\n${envelope.message}` : "";
  const text = [
    `Hello ${recipient.name},`,
    "",
    `${company.name} asked you to review and sign “${envelope.title}”.`,
    note,
    "",
    `Review and sign: ${link}`,
    expiry,
    "",
    "This private link is for you. Do not forward it.",
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  const html = `<p>Hello ${escapeHtml(recipient.name)},</p>
<p>${escapeHtml(company.name)} asked you to review and sign <strong>${escapeHtml(envelope.title)}</strong>.</p>
${envelope.message ? `<p>${escapeHtml(envelope.message)}</p>` : ""}
<p><a href="${escapeHtml(link)}">Review and sign</a></p>
${envelope.expiresAt ? `<p>This request expires ${escapeHtml(envelope.expiresAt.toISOString())}.</p>` : ""}
<p>This private link is for you. Do not forward it.</p>`;
  return {
    to: recipient.email,
    subject: `${prefix}Signature requested: ${envelope.title}`,
    text,
    html,
    companyId: envelope.companyId,
    purpose: "signature",
    triggeredByUserId: envelope.createdByUserId,
    // The real message contains the recipient's bearer credential. Keep the
    // delivery audit useful without persisting an impersonation link.
    bodyPreview: [
      `Hello ${recipient.name},`,
      "",
      `${company.name} asked you to review and sign “${envelope.title}”.`,
      "",
      "Review and sign: [private signing link redacted]",
    ].join("\n"),
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function persistDeliveryResults(
  envelope: SignatureEnvelope,
  actor: NormalizedActor,
  deliveries: DeliveryAttempt[],
): Promise<void> {
  await AppDataSource.transaction(async (manager) => {
    // A terminal lifecycle transition revokes every token. Serialize against
    // that transition and never append a misleading delivery event afterward.
    const currentEnvelope = await findEnvelopeForUpdate(manager, envelope.companyId, envelope.id);
    if (
      !currentEnvelope ||
      (currentEnvelope.status !== "sent" && currentEnvelope.status !== "in_progress")
    ) {
      return;
    }
    const repository = manager.getRepository(SignatureRecipient);
    for (const delivery of deliveries.sort((a, b) =>
      a.recipient.id.localeCompare(b.recipient.id),
    )) {
      const recipient = await repository.findOneBy({
        id: delivery.recipient.id,
        companyId: envelope.companyId,
        envelopeId: envelope.id,
      });
      if (
        !recipient ||
        recipient.tokenHash !== delivery.tokenHash ||
        recipient.status === "completed" ||
        recipient.status === "declined"
      ) {
        continue;
      }
      recipient.lastDeliveryStatus = delivery.result.status;
      recipient.lastDeliveryError = delivery.result.errorMessage;
      recipient.lastDeliveredAt = new Date();
      await repository.save(recipient);
      await appendSignatureEvent(manager, {
        companyId: envelope.companyId,
        envelopeId: envelope.id,
        recipientId: recipient.id,
        type:
          delivery.result.status === "failed"
            ? "recipient_delivery_failed"
            : delivery.reminder
              ? "reminder_sent"
              : "recipient_sent",
        actor,
        metadata: {
          deliveryStatus: delivery.result.status,
          transport: delivery.result.transport,
          emailLogId: delivery.result.logId,
          reminderCount: recipient.reminderCount,
          error: delivery.result.errorMessage,
        },
      });
    }
  });
}

async function deliverPending(
  company: Company,
  envelope: SignatureEnvelope,
  pending: PendingDelivery[],
  actor: NormalizedActor,
  reminder: boolean,
): Promise<void> {
  const deliveries = await Promise.all(
    pending.map(async ({ recipient, token }) => ({
      recipient,
      tokenHash: hashSignatureRecipientToken(token),
      reminder,
      result: await sendEmail(invitationMessage(company, envelope, recipient, token, reminder)),
    })),
  );
  await persistDeliveryResults(envelope, actor, deliveries);
}

/**
 * Select and activate the next signer group while holding the envelope's
 * lifecycle lock. The plaintext credentials are returned to the caller for
 * delivery only after the transaction commits; only their hashes persist.
 */
async function selectNextSignerGroup(
  manager: EntityManager,
  params: { companyId: string; envelopeId: string; now?: Date },
): Promise<{ envelope: SignatureEnvelope | null; pending: PendingDelivery[] }> {
  const envelope = await findEnvelopeForUpdate(manager, params.companyId, params.envelopeId);
  const now = params.now ?? new Date();
  if (
    !envelope ||
    (envelope.status !== "sent" && envelope.status !== "in_progress") ||
    (envelope.expiresAt && envelope.expiresAt.getTime() <= now.getTime())
  ) {
    return { envelope, pending: [] };
  }
  const repository = manager.getRepository(SignatureRecipient);
  const signers = await repository.find({
    where: {
      companyId: envelope.companyId,
      envelopeId: envelope.id,
      role: "signer",
    },
    order: { routingOrder: "ASC", createdAt: "ASC" },
  });
  const waiting = signers.filter((recipient) => recipient.status === "waiting");
  if (!waiting.length) return { envelope, pending: [] };
  let selected: SignatureRecipient[];
  if (envelope.routingMode === "parallel") {
    selected = waiting;
  } else {
    const active = signers.some(
      (recipient) => recipient.status === "sent" || recipient.status === "viewed",
    );
    if (active) return { envelope, pending: [] };
    const nextOrder = Math.min(...waiting.map((recipient) => recipient.routingOrder));
    selected = waiting.filter((recipient) => recipient.routingOrder === nextOrder);
  }
  const pending: PendingDelivery[] = [];
  for (const recipient of selected) {
    const token = generateSignatureRecipientToken();
    recipient.tokenHash = hashSignatureRecipientToken(token);
    recipient.status = "sent";
    recipient.lastDeliveryStatus = "pending";
    recipient.lastDeliveryError = "";
    recipient.lastDeliveredAt = null;
    await repository.save(recipient);
    pending.push({ recipient, token });
  }
  return { envelope, pending };
}

async function haveAllSignersCompleted(
  manager: EntityManager,
  params: { companyId: string; envelopeId: string },
): Promise<boolean> {
  const repository = manager.getRepository(SignatureRecipient);
  const [signerCount, completedSignerCount] = await Promise.all([
    repository.countBy({
      companyId: params.companyId,
      envelopeId: params.envelopeId,
      role: "signer",
    }),
    repository.countBy({
      companyId: params.companyId,
      envelopeId: params.envelopeId,
      role: "signer",
      status: "completed",
    }),
  ]);
  return signerCount > 0 && completedSignerCount === signerCount;
}

export async function sendSignatureEnvelope(params: {
  companyId: string;
  envelopeId: string;
  expectedUpdatedAt?: string | null;
  actor: SigningActor;
}): Promise<SignatureEnvelopeDetail> {
  const actor = normalizeActor(params.actor);
  await requireActorAccess(params.companyId, actor, "send");
  const company = await requireCompany(params.companyId);
  const activation = await AppDataSource.transaction(async (manager) => {
    const repository = manager.getRepository(SignatureEnvelope);
    const row = await findEnvelopeForUpdate(manager, params.companyId, params.envelopeId);
    if (!row) throw new SigningNotFoundError();
    if (row.status !== "draft") {
      throw new SigningConflictError("Only a draft signature request can be sent");
    }
    if (params.expectedUpdatedAt) {
      const expectedUpdatedAt = new Date(params.expectedUpdatedAt);
      if (
        !Number.isFinite(expectedUpdatedAt.getTime()) ||
        expectedUpdatedAt.getTime() !== row.updatedAt.getTime()
      ) {
        throw new SigningConflictError(
          "This draft changed since you reviewed it. Reload the latest version before sending.",
        );
      }
    }
    const { recipients, fields } = await assertEnvelopeReadyToSend(manager, company, row);
    row.status = "sent";
    row.sentAt = new Date();
    await repository.save(row);
    await appendSignatureEvent(manager, {
      companyId: row.companyId,
      envelopeId: row.id,
      type: "envelope_sent",
      actor,
      metadata: {
        routingMode: row.routingMode,
        signerCount: recipients.filter((recipient) => recipient.role === "signer").length,
        copyCount: recipients.filter((recipient) => recipient.role === "copy").length,
        expiresAt: row.expiresAt?.toISOString() ?? null,
        definitionManifestSha256: signatureDefinitionManifestSha256(row, recipients, fields),
      },
    });
    const selected = await selectNextSignerGroup(manager, {
      companyId: row.companyId,
      envelopeId: row.id,
    });
    return { envelope: row, pending: selected.pending };
  });
  await deliverPending(company, activation.envelope, activation.pending, actor, false);
  return getSignatureEnvelopeDetail(params);
}

export async function remindSignatureRecipient(params: {
  companyId: string;
  envelopeId: string;
  recipientId: string;
  actor: SigningActor;
}): Promise<SignatureEnvelopeDetail> {
  const actor = normalizeActor(params.actor);
  await requireActorAccess(params.companyId, actor, "send");
  const company = await requireCompany(params.companyId);
  const { envelope, recipient, token } = await AppDataSource.transaction(async (manager) => {
    const envelope = await findEnvelopeForUpdate(manager, params.companyId, params.envelopeId);
    if (!envelope) throw new SigningNotFoundError();
    if (envelope.status !== "sent" && envelope.status !== "in_progress") {
      throw new SigningConflictError("This signature request is no longer active");
    }
    if (envelope.expiresAt && envelope.expiresAt.getTime() <= Date.now()) {
      throw new SigningConflictError("This signature request has expired");
    }
    const repository = manager.getRepository(SignatureRecipient);
    const recipient = await repository.findOneBy({
      id: params.recipientId,
      companyId: params.companyId,
      envelopeId: params.envelopeId,
    });
    if (
      !recipient ||
      recipient.role !== "signer" ||
      (recipient.status !== "sent" && recipient.status !== "viewed")
    ) {
      throw new SigningConflictError("Only an active signer can receive a reminder");
    }
    const token = generateSignatureRecipientToken();
    recipient.tokenHash = hashSignatureRecipientToken(token);
    recipient.reminderCount += 1;
    recipient.lastDeliveryStatus = "pending";
    recipient.lastDeliveryError = "";
    await repository.save(recipient);
    return { envelope, recipient, token };
  });
  await deliverPending(company, envelope, [{ recipient, token }], actor, true);
  return getSignatureEnvelopeDetail(params);
}

export async function deleteSignatureEnvelope(params: {
  companyId: string;
  envelopeId: string;
}): Promise<boolean> {
  const result = await AppDataSource.transaction(async (manager) => {
    const repository = manager.getRepository(SignatureEnvelope);
    const envelope = await findEnvelopeForUpdate(manager, params.companyId, params.envelopeId);
    if (!envelope) throw new SigningNotFoundError();
    if (envelope.status !== "draft") {
      throw new SigningConflictError("Only a draft signature request can be deleted");
    }
    await manager.getRepository(SignatureEvent).delete({
      companyId: params.companyId,
      envelopeId: envelope.id,
    });
    await manager.getRepository(SignatureField).delete({
      companyId: params.companyId,
      envelopeId: envelope.id,
    });
    await manager.getRepository(SignatureRecipient).delete({
      companyId: params.companyId,
      envelopeId: envelope.id,
    });
    await repository.delete({ id: envelope.id, companyId: params.companyId });
    return {
      originalStorageKey: envelope.originalStorageKey,
      completedStorageKey: envelope.completedStorageKey,
    };
  });
  const company = await requireCompany(params.companyId);
  for (const storageKey of [result.originalStorageKey, result.completedStorageKey]) {
    if (!storageKey) continue;
    const absolute = resolveSigningStoragePath(company.slug, storageKey);
    if (absolute) await fs.promises.unlink(absolute).catch(() => undefined);
  }
  return true;
}

export async function voidSignatureEnvelope(params: {
  companyId: string;
  envelopeId: string;
  reason?: string;
  actor: SigningActor;
}): Promise<SignatureEnvelopeDetail> {
  const actor = normalizeActor(params.actor);
  await requireActorAccess(params.companyId, actor, "send");
  const reason = cleanText(params.reason ?? "", "Void reason", 2000, false);
  await AppDataSource.transaction(async (manager) => {
    const repository = manager.getRepository(SignatureEnvelope);
    const envelope = await findEnvelopeForUpdate(manager, params.companyId, params.envelopeId);
    if (!envelope) throw new SigningNotFoundError();
    if (["completed", "declined", "voided", "expired"].includes(envelope.status)) {
      throw new SigningConflictError("This signature request can no longer be voided");
    }
    envelope.status = "voided";
    envelope.voidedAt = new Date();
    envelope.voidReason = reason;
    await repository.save(envelope);
    const recipients = await manager.getRepository(SignatureRecipient).findBy({
      companyId: params.companyId,
      envelopeId: envelope.id,
    });
    for (const recipient of recipients) recipient.tokenHash = null;
    if (recipients.length) await manager.getRepository(SignatureRecipient).save(recipients);
    await appendSignatureEvent(manager, {
      companyId: params.companyId,
      envelopeId: envelope.id,
      type: "envelope_voided",
      actor,
      metadata: { reason },
    });
  });
  return getSignatureEnvelopeDetail(params);
}

export function isValidSignatureRecipientToken(token: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  try {
    return Buffer.from(token, "base64url").length === TOKEN_BYTES;
  } catch {
    return false;
  }
}

export type PublicSignatureContext = {
  company: Pick<Company, "name" | "slug">;
  envelope: Pick<
    SignatureEnvelope,
    | "id"
    | "title"
    | "message"
    | "status"
    | "routingMode"
    | "originalFilename"
    | "originalPageCount"
    | "expiresAt"
    | "sentAt"
    | "completedAt"
  > & { finalizationPending: boolean };
  recipient: Pick<
    SignatureRecipient,
    "id" | "name" | "email" | "role" | "status" | "viewedAt" | "completedAt"
  >;
  fields: Array<
    Pick<
      SignatureField,
      | "id"
      | "recipientId"
      | "type"
      | "label"
      | "placeholder"
      | "required"
      | "pageNumber"
      | "x"
      | "y"
      | "width"
      | "height"
      | "sortOrder"
    > & { value: SignatureFieldValue }
  >;
};

async function publicContextForRecipient(
  envelope: SignatureEnvelope,
  recipient: SignatureRecipient,
): Promise<PublicSignatureContext> {
  const [company, fields, finalizationPending] = await Promise.all([
    requireCompany(envelope.companyId),
    AppDataSource.getRepository(SignatureField).find({
      where: {
        companyId: envelope.companyId,
        envelopeId: envelope.id,
        recipientId: recipient.id,
      },
      order: { pageNumber: "ASC", sortOrder: "ASC" },
    }),
    envelope.status === "in_progress" && recipient.status === "completed"
      ? haveAllSignersCompleted(AppDataSource.manager, {
          companyId: envelope.companyId,
          envelopeId: envelope.id,
        })
      : Promise.resolve(false),
  ]);
  return {
    company: { name: company.name, slug: company.slug },
    envelope: {
      id: envelope.id,
      title: envelope.title,
      message: envelope.message,
      status: envelope.status,
      routingMode: envelope.routingMode,
      originalFilename: envelope.originalFilename,
      originalPageCount: envelope.originalPageCount,
      expiresAt: envelope.expiresAt,
      sentAt: envelope.sentAt,
      completedAt: envelope.completedAt,
      finalizationPending,
    },
    recipient: {
      id: recipient.id,
      name: recipient.name,
      email: recipient.email,
      role: recipient.role,
      status: recipient.status,
      viewedAt: recipient.viewedAt,
      completedAt: recipient.completedAt,
    },
    fields: fields.map((field) => ({
      id: field.id,
      recipientId: field.recipientId,
      type: field.type,
      label: field.label,
      placeholder: field.placeholder,
      required: field.required,
      pageNumber: field.pageNumber,
      x: field.x,
      y: field.y,
      width: field.width,
      height: field.height,
      sortOrder: field.sortOrder,
      value: parseFieldValue(field.valueJson),
    })),
  };
}

export async function lookupSignatureRecipientByToken(params: {
  token: string;
}): Promise<PublicSignatureContext | null> {
  if (!isValidSignatureRecipientToken(params.token)) return null;
  const recipient = await AppDataSource.getRepository(SignatureRecipient).findOneBy({
    tokenHash: hashSignatureRecipientToken(params.token),
    role: "signer",
  });
  if (!recipient) return null;
  const envelope = await AppDataSource.getRepository(SignatureEnvelope).findOneBy({
    id: recipient.envelopeId,
    companyId: recipient.companyId,
  });
  if (!envelope) return null;
  if (
    envelope.status !== "completed" &&
    envelope.expiresAt &&
    envelope.expiresAt.getTime() <= Date.now()
  ) {
    const awaitingFinalization =
      envelope.status === "in_progress" &&
      recipient.status === "completed" &&
      (await haveAllSignersCompleted(AppDataSource.manager, {
        companyId: envelope.companyId,
        envelopeId: envelope.id,
      }));
    if (!awaitingFinalization) {
      await expireSignatureEnvelopes({ now: new Date(), companyId: envelope.companyId });
      return null;
    }
  }
  const active =
    (envelope.status === "sent" || envelope.status === "in_progress") &&
    (recipient.status === "sent" || recipient.status === "viewed");
  const completed =
    (envelope.status === "in_progress" || envelope.status === "completed") &&
    recipient.status === "completed";
  if (!active && !completed) return null;
  return publicContextForRecipient(envelope, recipient);
}

export async function markSignatureViewed(params: {
  token: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<PublicSignatureContext> {
  const context = await lookupSignatureRecipientByToken({ token: params.token });
  if (!context) throw new SigningNotFoundError("This signing link is invalid or expired");
  const tokenHash = hashSignatureRecipientToken(params.token);
  await AppDataSource.transaction(async (manager) => {
    const recipientRepository = manager.getRepository(SignatureRecipient);
    const envelopeRepository = manager.getRepository(SignatureEnvelope);
    let recipient = await recipientRepository.findOneBy({
      id: context.recipient.id,
      tokenHash,
    });
    if (!recipient) throw new SigningNotFoundError("This signing link is no longer valid");
    const envelope = await findEnvelopeForUpdate(
      manager,
      recipient.companyId,
      recipient.envelopeId,
    );
    if (!envelope || (envelope.status !== "sent" && envelope.status !== "in_progress")) {
      throw new SigningConflictError("This signature request is no longer active");
    }
    // The envelope lock may have waited behind another public action. Reload
    // the recipient under that lock so a stale pre-lock status cannot make a
    // token complete or decline twice.
    const currentRecipient = await recipientRepository.findOneBy({
      id: recipient.id,
      tokenHash,
    });
    if (
      !currentRecipient ||
      (currentRecipient.status !== "sent" && currentRecipient.status !== "viewed")
    ) {
      throw new SigningConflictError("This signing link is no longer active");
    }
    recipient = currentRecipient;
    recipient.ipAddress = cleanNetworkValue(params.ipAddress, 255) || recipient.ipAddress;
    recipient.userAgent = cleanNetworkValue(params.userAgent, 2048) || recipient.userAgent;
    if (!recipient.viewedAt) {
      const now = new Date();
      recipient.viewedAt = now;
      recipient.status = "viewed";
      envelope.status = "in_progress";
      await recipientRepository.save(recipient);
      await envelopeRepository.save(envelope);
      await appendSignatureEvent(manager, {
        companyId: recipient.companyId,
        envelopeId: recipient.envelopeId,
        recipientId: recipient.id,
        type: "recipient_viewed",
        actor: { actorKind: "recipient", actorId: recipient.id },
        ipAddress: recipient.ipAddress,
        userAgent: recipient.userAgent,
      });
    } else {
      await recipientRepository.save(recipient);
    }
  });
  const refreshed = await lookupSignatureRecipientByToken({ token: params.token });
  if (!refreshed) throw new SigningNotFoundError("This signing link is no longer valid");
  return refreshed;
}

function providedValuesToMap(
  values:
    | Record<string, SignatureFieldValue>
    | Array<{ fieldId: string; value: SignatureFieldValue; type?: string }>,
): Map<string, SignatureFieldValue> {
  if (Array.isArray(values)) {
    return new Map(
      values
        .filter((entry) => entry && typeof entry.fieldId === "string")
        .map((entry) => [entry.fieldId, entry.value]),
    );
  }
  if (!values || typeof values !== "object") {
    throw new SigningValidationError("Field values must be an object or array");
  }
  return new Map(Object.entries(values));
}

function signatureText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const candidate = record.text ?? record.value;
  return typeof candidate === "string" ? candidate : "";
}

type SignatureImageDimensions = { width: number; height: number };

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function pngDimensions(bytes: Buffer): SignatureImageDimensions | null {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, signature.length).equals(signature) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  ) {
    return null;
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function jpegDimensions(bytes: Buffer): SignatureImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (length < 7) return null;
      return {
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
      };
    }
    offset += length;
  }
  return null;
}

function isStructurallyCompleteJpeg(bytes: Buffer): boolean {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let offset = 2;
  let sawFrame = false;
  let sawScan = false;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return false;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return false;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0x00 || marker === 0xd8) return false;
    if (marker === 0xd9) return sawFrame && sawScan && offset === bytes.length;
    if (marker === 0x01) continue;
    if (marker >= 0xd0 && marker <= 0xd7) return false;
    if (offset + 2 > bytes.length) return false;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return false;
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (length < 8) return false;
      const componentCount = bytes[offset + 7];
      if (componentCount < 1 || length !== 8 + componentCount * 3) return false;
      sawFrame = true;
    }
    if (marker !== 0xda) {
      offset += length;
      continue;
    }
    if (!sawFrame || length < 6) return false;
    const scanComponentCount = bytes[offset + 2];
    if (scanComponentCount < 1 || length !== 6 + scanComponentCount * 2) return false;
    sawScan = true;
    offset += length;
    let foundMarker = false;
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      let markerOffset = offset + 1;
      while (markerOffset < bytes.length && bytes[markerOffset] === 0xff) markerOffset += 1;
      if (markerOffset >= bytes.length) return false;
      const entropyMarker = bytes[markerOffset];
      if (entropyMarker === 0x00 || (entropyMarker >= 0xd0 && entropyMarker <= 0xd7)) {
        offset = markerOffset + 1;
        continue;
      }
      foundMarker = true;
      break;
    }
    if (!foundMarker) return false;
  }
  return false;
}

function assertSafeSignatureImageDimensions(
  mime: "png" | "jpeg",
  bytes: Buffer,
): SignatureImageDimensions {
  const dimensions = mime === "png" ? pngDimensions(bytes) : jpegDimensions(bytes);
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1) {
    throw new SigningValidationError("Drawn signature image is invalid");
  }
  if (
    dimensions.width > MAX_SIGNATURE_IMAGE_DIMENSION ||
    dimensions.height > MAX_SIGNATURE_IMAGE_DIMENSION ||
    dimensions.width * dimensions.height > MAX_SIGNATURE_IMAGE_PIXELS
  ) {
    throw new SigningValidationError(
      `Drawn signature images must be at most ${MAX_SIGNATURE_IMAGE_DIMENSION}px per side and ${MAX_SIGNATURE_IMAGE_PIXELS.toLocaleString("en-US")} pixels total`,
    );
  }
  return dimensions;
}

async function validateImageDataUrl(
  value: unknown,
): Promise<{ kind: "drawn"; dataUrl: string } | null> {
  const dataUrl =
    typeof value === "string" && value.startsWith("data:image/")
      ? value
      : value && typeof value === "object"
        ? typeof (value as Record<string, unknown>).dataUrl === "string"
          ? String((value as Record<string, unknown>).dataUrl)
          : ""
        : "";
  if (!dataUrl) return null;
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
  if (!match) throw new SigningValidationError("Drawn signatures must be PNG or JPEG images");
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > MAX_FIELD_VALUE_BYTES) {
    throw new SigningValidationError("Drawn signature image is too large");
  }
  // Buffer.from is deliberately forgiving. Reject non-canonical encodings,
  // then make pdf-lib decode the payload now, inside the signing transaction,
  // instead of discovering a corrupt PNG/JPEG only after the recipient has
  // already been committed as completed.
  const canonicalPayload = bytes.toString("base64").replace(/=+$/, "");
  if (canonicalPayload !== match[2].replace(/=+$/, "")) {
    throw new SigningValidationError("Drawn signature image is invalid");
  }
  const mime = match[1].toLowerCase() as "png" | "jpeg";
  const dimensions = assertSafeSignatureImageDimensions(mime, bytes);
  try {
    if (mime === "jpeg") {
      // pdf-lib only inspects JPEG metadata before embedding. Decode every
      // pixel up front so truncated/corrupt DCT streams cannot survive input
      // validation and fail later, after signing evidence has been persisted.
      if (!isStructurallyCompleteJpeg(bytes)) throw new Error("JPEG structure is incomplete");
      const decoded = await loadImage(bytes);
      if (decoded.width !== dimensions.width || decoded.height !== dimensions.height) {
        throw new Error("JPEG dimensions changed during decode");
      }
    }
    const validationPdf = await PDFDocument.create();
    if (mime === "png") await validationPdf.embedPng(bytes);
    // pdf-lib's JPEG parser reads from the start of the backing ArrayBuffer
    // and ignores a Node Buffer's byteOffset. Copy the validated slice so
    // small, pooled canvas JPEGs are embedded from their actual first byte.
    else await validationPdf.embedJpg(Uint8Array.from(bytes));
  } catch {
    throw new SigningValidationError("Drawn signature image is invalid");
  }
  return { kind: "drawn", dataUrl };
}

async function normalizeCompletedFieldValue(
  field: SignatureField,
  recipient: SignatureRecipient,
  provided: SignatureFieldValue | undefined,
  signingCalendarDate: string,
): Promise<SignatureFieldValue> {
  if (field.type === "name") return recipient.name;
  if (field.type === "email") return recipient.email;
  if (field.type === "date") return signingCalendarDate;
  if (field.type === "checkbox") {
    const checked = provided === true;
    if (field.required && !checked) {
      throw new SigningValidationError(`${field.label || "Required checkbox"} must be checked`);
    }
    return checked;
  }
  if (field.type === "signature" || field.type === "initials") {
    const image = await validateImageDataUrl(provided);
    if (image) return image;
    const text = signatureText(provided);
    if (!text.trim()) {
      if (field.required) {
        throw new SigningValidationError(`${field.label || field.type} is required`);
      }
      return null;
    }
    if (text.length > 255) {
      throw new SigningValidationError(`${field.label || field.type} is too long`);
    }
    return { kind: "typed", text };
  }
  const text = typeof provided === "string" ? provided : "";
  if (field.required && !text.trim()) {
    throw new SigningValidationError(`${field.label || "Text field"} is required`);
  }
  if (text.length > 10_000) {
    throw new SigningValidationError(`${field.label || "Text field"} is too long`);
  }
  return text.length ? text : null;
}

function signingTimeEvidence(params: {
  now: Date;
  timezoneOffsetMinutes?: number;
  timeZone?: string;
}): { timezoneOffsetMinutes: number; timeZone: string | null; signingCalendarDate: string } {
  const timezoneOffsetMinutes = params.timezoneOffsetMinutes ?? 0;
  if (
    !Number.isInteger(timezoneOffsetMinutes) ||
    timezoneOffsetMinutes < -840 ||
    timezoneOffsetMinutes > 840
  ) {
    throw new SigningValidationError("Timezone offset must be between -840 and 840 minutes");
  }
  const timeZone = params.timeZone?.trim() || null;
  if (timeZone) {
    if (timeZone.length > 100 || !/^[A-Za-z0-9._+\-/]+$/.test(timeZone)) {
      throw new SigningValidationError("Signer timezone is invalid");
    }
    try {
      new Intl.DateTimeFormat("en", { timeZone }).format(params.now);
    } catch {
      throw new SigningValidationError("Signer timezone is invalid");
    }
  }
  return {
    timezoneOffsetMinutes,
    timeZone,
    signingCalendarDate: new Date(params.now.getTime() - timezoneOffsetMinutes * 60_000)
      .toISOString()
      .slice(0, 10),
  };
}

export async function completeSignatureRecipient(params: {
  token: string;
  consent: boolean;
  timezoneOffsetMinutes?: number;
  timeZone?: string;
  values:
    | Record<string, SignatureFieldValue>
    | Array<{ fieldId: string; value: SignatureFieldValue; type?: string }>;
  ipAddress?: string;
  userAgent?: string;
}): Promise<{ completed: boolean; envelopeId: string; recipientId: string }> {
  if (params.consent !== true) {
    throw new SigningValidationError("Consent to electronic signing is required");
  }
  const context = await lookupSignatureRecipientByToken({ token: params.token });
  if (!context) throw new SigningNotFoundError("This signing link is invalid or expired");
  const tokenHash = hashSignatureRecipientToken(params.token);
  const result = await AppDataSource.transaction(async (manager) => {
    const recipientRepository = manager.getRepository(SignatureRecipient);
    const envelopeRepository = manager.getRepository(SignatureEnvelope);
    const fieldRepository = manager.getRepository(SignatureField);
    let recipient = await recipientRepository.findOneBy({
      id: context.recipient.id,
      tokenHash,
    });
    if (!recipient) throw new SigningConflictError("This signing link has already been used");
    const envelope = await findEnvelopeForUpdate(
      manager,
      recipient.companyId,
      recipient.envelopeId,
    );
    if (!envelope) {
      throw new SigningConflictError("This signature request is no longer active");
    }
    const currentRecipient = await recipientRepository.findOneBy({
      id: recipient.id,
      tokenHash,
    });
    if (!currentRecipient) {
      throw new SigningConflictError("This signing link has already been used");
    }
    recipient = currentRecipient;

    // Final PDF generation deliberately happens after the signer transaction:
    // it performs filesystem work and creates the archived contract. If that
    // second phase failed, the recipient and their evidence are already
    // durable. The same still-hashed receipt token may safely retry only that
    // final phase; values and recipient evidence must never be written twice.
    if (recipient.status === "completed") {
      if (envelope.status === "completed") {
        return {
          envelope,
          recipient,
          allSigned: true,
          needsFinalization: false,
          pending: [] as PendingDelivery[],
        };
      }
      if (envelope.status !== "in_progress") {
        throw new SigningConflictError("This signature request is no longer active");
      }
      if (
        !(await haveAllSignersCompleted(manager, {
          companyId: recipient.companyId,
          envelopeId: recipient.envelopeId,
        }))
      ) {
        throw new SigningConflictError("This signing link has already been used");
      }
      return {
        envelope,
        recipient,
        allSigned: true,
        needsFinalization: true,
        pending: [] as PendingDelivery[],
      };
    }
    if (
      (envelope.status !== "sent" && envelope.status !== "in_progress") ||
      (recipient.status !== "sent" && recipient.status !== "viewed")
    ) {
      throw new SigningConflictError("This signature request is no longer active");
    }
    const now = new Date();
    const timeEvidence = signingTimeEvidence({
      now,
      timezoneOffsetMinutes: params.timezoneOffsetMinutes,
      timeZone: params.timeZone,
    });
    if (envelope.expiresAt && envelope.expiresAt.getTime() <= now.getTime()) {
      throw new SigningConflictError("This signature request has expired");
    }
    const values = providedValuesToMap(params.values);
    const fields = await fieldRepository.find({
      where: {
        companyId: recipient.companyId,
        envelopeId: recipient.envelopeId,
        recipientId: recipient.id,
      },
      order: { sortOrder: "ASC" },
    });
    const normalizedValues: Array<{ field: SignatureField; valueJson: string }> = [];
    for (const field of fields) {
      const value = await normalizeCompletedFieldValue(
        field,
        recipient,
        values.get(field.id),
        timeEvidence.signingCalendarDate,
      );
      const valueJson = canonicalJson(value);
      if (Buffer.byteLength(valueJson) > MAX_FIELD_VALUE_BYTES) {
        throw new SigningValidationError(`${field.label || field.type} value is too large`);
      }
      normalizedValues.push({ field, valueJson });
    }
    const acceptedFields = normalizedValues.map(({ field, valueJson }) =>
      Object.assign(new SignatureField(), field, { valueJson }),
    );
    const originalPath = resolveSigningStoragePath(
      context.company.slug,
      envelope.originalStorageKey,
    );
    if (!originalPath || !fs.existsSync(originalPath)) {
      throw new SigningNotFoundError("The original PDF is missing");
    }
    const original = await fs.promises.readFile(originalPath);
    if (sha256Buffer(original) !== envelope.originalSha256) {
      throw new SigningConflictError("The original PDF failed its integrity check");
    }
    // Rendering is part of signer-input validation, not finalization. A value
    // that cannot be represented exactly must fail before consent, fields, or
    // recipient status are durably changed.
    await assertCompletedValuesRenderable({ original, fields: acceptedFields });
    const valueManifestSha256 = signatureFieldValueManifestSha256(acceptedFields);
    const ipAddress = cleanNetworkValue(params.ipAddress, 255);
    const userAgent = cleanNetworkValue(params.userAgent, 2048);
    recipient.consentedAt = now;
    recipient.ipAddress = ipAddress || recipient.ipAddress;
    recipient.userAgent = userAgent || recipient.userAgent;
    await appendSignatureEvent(manager, {
      companyId: recipient.companyId,
      envelopeId: recipient.envelopeId,
      recipientId: recipient.id,
      type: "recipient_consented",
      actor: { actorKind: "recipient", actorId: recipient.id },
      ipAddress: recipient.ipAddress,
      userAgent: recipient.userAgent,
      metadata: {
        consent: true,
        timezoneOffsetMinutes: timeEvidence.timezoneOffsetMinutes,
        timeZone: timeEvidence.timeZone,
        signingCalendarDate: timeEvidence.signingCalendarDate,
      },
      now,
    });
    for (const { field, valueJson } of normalizedValues) {
      field.valueJson = valueJson;
      field.completedAt = now;
    }
    if (fields.length) await fieldRepository.save(fields);
    recipient.status = "completed";
    recipient.completedAt = now;
    // Keep this link available as a read-only receipt/download capability.
    // Status makes completion single-use; reminders already rotate older links.
    await recipientRepository.save(recipient);
    envelope.status = "in_progress";
    await envelopeRepository.save(envelope);
    await appendSignatureEvent(manager, {
      companyId: recipient.companyId,
      envelopeId: recipient.envelopeId,
      recipientId: recipient.id,
      type: "recipient_completed",
      actor: { actorKind: "recipient", actorId: recipient.id },
      ipAddress: recipient.ipAddress,
      userAgent: recipient.userAgent,
      metadata: {
        completedFieldCount: fields.length,
        valueManifestSha256,
        timezoneOffsetMinutes: timeEvidence.timezoneOffsetMinutes,
        timeZone: timeEvidence.timeZone,
        signingCalendarDate: timeEvidence.signingCalendarDate,
      },
      now: new Date(now.getTime() + 1),
    });
    const incompleteSigners = await recipientRepository.countBy({
      companyId: recipient.companyId,
      envelopeId: recipient.envelopeId,
      role: "signer",
      status: In(["waiting", "sent", "viewed"]),
    });
    const allSigned = incompleteSigners === 0;
    // Selecting the next ordered group belongs to the same transaction as
    // completing this signer. There is no committed in-between state where a
    // crash can leave an active envelope with every remaining signer waiting.
    const activation = allSigned
      ? { pending: [] as PendingDelivery[] }
      : await selectNextSignerGroup(manager, {
          companyId: envelope.companyId,
          envelopeId: envelope.id,
          now,
        });
    return {
      envelope,
      recipient,
      allSigned,
      needsFinalization: allSigned,
      pending: activation.pending,
    };
  });
  const company = await requireCompany(result.envelope.companyId);
  if (result.needsFinalization) {
    await finalizeSignatureEnvelope({ company, envelopeId: result.envelope.id });
  } else if (result.pending.length) {
    await deliverPending(
      company,
      result.envelope,
      result.pending,
      { actorKind: "system", actorId: null },
      false,
    );
  }
  const finalEnvelope = await AppDataSource.getRepository(SignatureEnvelope).findOneByOrFail({
    id: result.envelope.id,
    companyId: result.envelope.companyId,
  });
  return {
    completed: finalEnvelope.status === "completed",
    envelopeId: finalEnvelope.id,
    recipientId: result.recipient.id,
  };
}

/**
 * Resume only the post-signature finalization saga for a completed recipient.
 *
 * The receipt token remains hashed on a completed recipient so it can later
 * download the finished document. That same capability may retry PDF/archive
 * creation after a process crash, but it cannot accept fields, consent, or new
 * evidence. Every signer must already be complete, and the finalizer performs
 * the frozen-definition, value-manifest, original-file, and event-chain checks.
 */
export async function retrySignatureEnvelopeFinalization(params: {
  token: string;
}): Promise<{ completed: true; envelopeId: string; recipientId: string }> {
  if (!isValidSignatureRecipientToken(params.token)) {
    throw new SigningNotFoundError("This signing link is invalid or expired");
  }
  const tokenHash = hashSignatureRecipientToken(params.token);
  const retry = await AppDataSource.transaction(async (manager) => {
    const recipient = await manager.getRepository(SignatureRecipient).findOneBy({
      tokenHash,
      role: "signer",
    });
    if (!recipient || recipient.status !== "completed") {
      throw new SigningConflictError("This signature request is not ready to be completed");
    }
    const envelope = await findEnvelopeForUpdate(
      manager,
      recipient.companyId,
      recipient.envelopeId,
    );
    if (!envelope) throw new SigningNotFoundError();
    if (envelope.status === "completed") {
      return { envelope, recipient, needsFinalization: false };
    }
    if (
      envelope.status !== "in_progress" ||
      !(await haveAllSignersCompleted(manager, {
        companyId: envelope.companyId,
        envelopeId: envelope.id,
      }))
    ) {
      throw new SigningConflictError("This signature request is not ready to be completed");
    }
    return { envelope, recipient, needsFinalization: true };
  });

  if (retry.needsFinalization) {
    const company = await requireCompany(retry.envelope.companyId);
    await finalizeSignatureEnvelope({ company, envelopeId: retry.envelope.id });
  }
  const envelope = await AppDataSource.getRepository(SignatureEnvelope).findOneBy({
    id: retry.envelope.id,
    companyId: retry.envelope.companyId,
    status: "completed",
  });
  if (!envelope) {
    throw new SigningConflictError("This signature request could not be completed");
  }
  return {
    completed: true,
    envelopeId: envelope.id,
    recipientId: retry.recipient.id,
  };
}

export async function declineSignatureRecipient(params: {
  token: string;
  reason: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<{ envelopeId: string; recipientId: string }> {
  const reason = cleanText(params.reason, "Decline reason", 2000);
  const context = await lookupSignatureRecipientByToken({ token: params.token });
  if (!context) throw new SigningNotFoundError("This signing link is invalid or expired");
  const tokenHash = hashSignatureRecipientToken(params.token);
  return AppDataSource.transaction(async (manager) => {
    const recipientRepository = manager.getRepository(SignatureRecipient);
    const envelopeRepository = manager.getRepository(SignatureEnvelope);
    let recipient = await recipientRepository.findOneBy({
      id: context.recipient.id,
      tokenHash,
    });
    if (!recipient) throw new SigningConflictError("This signing link is no longer active");
    const envelope = await findEnvelopeForUpdate(
      manager,
      recipient.companyId,
      recipient.envelopeId,
    );
    if (!envelope || (envelope.status !== "sent" && envelope.status !== "in_progress")) {
      throw new SigningConflictError("This signature request is no longer active");
    }
    const currentRecipient = await recipientRepository.findOneBy({
      id: recipient.id,
      tokenHash,
    });
    if (
      !currentRecipient ||
      (currentRecipient.status !== "sent" && currentRecipient.status !== "viewed")
    ) {
      throw new SigningConflictError("This signing link is no longer active");
    }
    recipient = currentRecipient;
    const now = new Date();
    recipient.status = "declined";
    recipient.tokenHash = null;
    recipient.declinedAt = now;
    recipient.declineReason = reason;
    recipient.ipAddress = cleanNetworkValue(params.ipAddress, 255) || recipient.ipAddress;
    recipient.userAgent = cleanNetworkValue(params.userAgent, 2048) || recipient.userAgent;
    await recipientRepository.save(recipient);
    envelope.status = "declined";
    envelope.declinedAt = now;
    envelope.declineReason = reason;
    await envelopeRepository.save(envelope);
    const recipients = await recipientRepository.findBy({
      companyId: envelope.companyId,
      envelopeId: envelope.id,
    });
    for (const row of recipients) row.tokenHash = null;
    if (recipients.length) await recipientRepository.save(recipients);
    const recipientActor: NormalizedActor = {
      actorKind: "recipient",
      actorId: recipient.id,
    };
    await appendSignatureEvent(manager, {
      companyId: envelope.companyId,
      envelopeId: envelope.id,
      recipientId: recipient.id,
      type: "recipient_declined",
      actor: recipientActor,
      ipAddress: recipient.ipAddress,
      userAgent: recipient.userAgent,
      metadata: { reason },
      now,
    });
    await appendSignatureEvent(manager, {
      companyId: envelope.companyId,
      envelopeId: envelope.id,
      recipientId: recipient.id,
      type: "envelope_declined",
      actor: recipientActor,
      ipAddress: recipient.ipAddress,
      userAgent: recipient.userAgent,
      metadata: { reason },
      now: new Date(now.getTime() + 1),
    });
    return { envelopeId: envelope.id, recipientId: recipient.id };
  });
}

function pdfSafeText(value: string): string {
  if (
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    })
  ) {
    throw new SigningValidationError("PDF field text cannot contain control characters");
  }
  return value;
}

async function pdfEvidenceText(value: string): Promise<string> {
  const assets = await signingFontAssets();
  const candidates = [assets.regular, assets.arabic, assets.cjk];
  let result = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint < 32 || codePoint === 127) {
      result += `\\u{${codePoint.toString(16).toUpperCase()}}`;
      continue;
    }
    result += candidates.some((entry) => entry.coverage.hasGlyphForCodePoint(codePoint))
      ? character
      : `\\u{${codePoint.toString(16).toUpperCase()}}`;
  }
  return result;
}

type PdfTextRun = { text: string; font: PDFFont; width: number };

function embeddedFontForCodePoint(
  fonts: EmbeddedSigningFont[],
  codePoint: number,
): EmbeddedSigningFont | null {
  return fonts.find((entry) => entry.coverage.hasGlyphForCodePoint(codePoint)) ?? null;
}

function pdfTextRuns(text: string, fonts: EmbeddedSigningFont[], size: number): PdfTextRun[] {
  const safe = pdfSafeText(text);
  const runs: PdfTextRun[] = [];
  for (const character of safe) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    const entry = embeddedFontForCodePoint(fonts, codePoint);
    if (!entry) {
      throw new SigningValidationError(
        `PDF field text contains an unsupported character (U+${codePoint
          .toString(16)
          .toUpperCase()
          .padStart(4, "0")})`,
      );
    }
    const previous = runs.at(-1);
    if (previous?.font === entry.font) {
      previous.text += character;
    } else {
      runs.push({
        text: character,
        font: entry.font,
        width: 0,
      });
    }
  }
  for (const run of runs) run.width = run.font.widthOfTextAtSize(run.text, size);
  return runs;
}

function pdfTextWidth(text: string, fonts: EmbeddedSigningFont[], size: number): number {
  return pdfTextRuns(text, fonts, size).reduce((sum, run) => sum + run.width, 0);
}

function drawPdfTextRuns(
  page: PDFPage,
  text: string,
  fonts: EmbeddedSigningFont[],
  options: {
    x: number;
    y: number;
    size: number;
    rotate?: ReturnType<typeof degrees>;
    color?: ReturnType<typeof rgb>;
  },
): void {
  let localX = 0;
  const angle = options.rotate?.angle ?? 0;
  const radians = (angle * Math.PI) / 180;
  for (const run of pdfTextRuns(text, fonts, options.size)) {
    page.drawText(run.text, {
      x: options.x + localX * Math.cos(radians),
      y: options.y + localX * Math.sin(radians),
      size: options.size,
      font: run.font,
      rotate: options.rotate,
      color: options.color,
    });
    localX += run.width;
  }
}

function wrapPdfText(
  text: string,
  fonts: EmbeddedSigningFont[],
  size: number,
  width: number,
): string[] {
  const safe = pdfSafeText(text);
  if (!safe.length) return [""];
  const lines: string[] = [];
  for (const explicitLine of safe.split("\n")) {
    if (!explicitLine.length) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const character of explicitLine) {
      const candidate = `${line}${character}`;
      if (!line || pdfTextWidth(candidate, fonts, size) <= width) {
        line = candidate;
        continue;
      }
      lines.push(line);
      line = character;
    }
    if (line) lines.push(line);
  }
  return lines;
}

function dataUrlBytes(dataUrl: string): { mime: "png" | "jpeg"; bytes: Buffer } {
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
  if (!match) throw new SigningValidationError("Signature image is invalid");
  return { mime: match[1].toLowerCase() as "png" | "jpeg", bytes: Buffer.from(match[2], "base64") };
}

async function embedFieldImage(
  pdf: PDFDocument,
  value: SignatureFieldValue,
): Promise<PDFImage | null> {
  if (!value || typeof value !== "object" || !("dataUrl" in value)) return null;
  const image = dataUrlBytes(value.dataUrl);
  return image.mime === "png"
    ? pdf.embedPng(image.bytes)
    : pdf.embedJpg(Uint8Array.from(image.bytes));
}

type PdfStampBox = {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
};

function normalizedPageRotation(page: PDFPage): PdfStampBox["rotation"] {
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  if (rotation === 0 || rotation === 90 || rotation === 180 || rotation === 270) {
    return rotation;
  }
  throw new SigningValidationError("PDF page rotation must be a multiple of 90 degrees");
}

/**
 * Convert the top-left, normalized rectangle used by PDF.js into the PDF
 * page's native coordinate system. PDF.js displays the CropBox and applies
 * the page's /Rotate value, while pdf-lib drawing coordinates are expressed
 * in unrotated page space. Keeping this conversion in one place makes the
 * editor overlay and the completed document agree for every page geometry.
 */
export function normalizedFieldBoxForPage(
  page: PDFPage,
  field: Pick<SignatureField, "x" | "y" | "width" | "height">,
): PdfStampBox {
  const crop = page.getCropBox();
  const rotation = normalizedPageRotation(page);
  const displayWidth = rotation === 90 || rotation === 270 ? crop.height : crop.width;
  const displayHeight = rotation === 90 || rotation === 270 ? crop.width : crop.height;
  const left = field.x * displayWidth;
  const top = field.y * displayHeight;
  const width = field.width * displayWidth;
  const height = field.height * displayHeight;
  const bottom = top + height;

  switch (rotation) {
    case 0:
      return {
        x: crop.x + left,
        y: crop.y + crop.height - bottom,
        width,
        height,
        rotation,
      };
    case 90:
      return {
        x: crop.x + bottom,
        y: crop.y + left,
        width,
        height,
        rotation,
      };
    case 180:
      return {
        x: crop.x + crop.width - left,
        y: crop.y + bottom,
        width,
        height,
        rotation,
      };
    case 270:
      return {
        x: crop.x + crop.width - bottom,
        y: crop.y + crop.height - left,
        width,
        height,
        rotation,
      };
  }
}

function pointInStampBox(box: PdfStampBox, x: number, y: number): { x: number; y: number } {
  const angle = (box.rotation * Math.PI) / 180;
  return {
    x: box.x + x * Math.cos(angle) - y * Math.sin(angle),
    y: box.y + x * Math.sin(angle) + y * Math.cos(angle),
  };
}

async function stampField(
  pdf: PDFDocument,
  page: PDFPage,
  field: SignatureField,
  fonts: EmbeddedSigningFonts,
): Promise<void> {
  const value = parseFieldValue(field.valueJson);
  if (value === null || value === false || value === "") return;
  const box = normalizedFieldBoxForPage(page, field);
  const rotate = degrees(box.rotation);
  page.drawRectangle({
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    rotate,
    color: rgb(1, 1, 1),
    opacity: 0.92,
    borderColor: rgb(0.15, 0.23, 0.35),
    borderWidth: 0.75,
  });
  if (field.type === "checkbox") {
    const size = Math.min(box.width, box.height) * 0.7;
    const localX = (box.width - size) / 2;
    const localY = (box.height - size) / 2;
    page.drawLine({
      start: pointInStampBox(box, localX, localY),
      end: pointInStampBox(box, localX + size, localY + size),
      thickness: 1.8,
    });
    page.drawLine({
      start: pointInStampBox(box, localX, localY + size),
      end: pointInStampBox(box, localX + size, localY),
      thickness: 1.8,
    });
    return;
  }
  const image = await embedFieldImage(pdf, value);
  if (image) {
    const scale = Math.min(box.width / image.width, box.height / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    const origin = pointInStampBox(box, (box.width - width) / 2, (box.height - height) / 2);
    page.drawImage(image, {
      ...origin,
      width,
      height,
      rotate,
    });
    return;
  }
  const text =
    typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? signatureText(value)
        : String(value);
  const selectedFonts =
    field.type === "signature" || field.type === "initials" ? fonts.signature : fonts.regular;
  const maxWidth = Math.max(1, box.width - 8);
  const maxHeight = Math.max(1, box.height - 4);
  let fontSize = Math.max(6, Math.min(18, box.height * 0.45));
  while (fontSize > 6 && pdfTextWidth(text, selectedFonts, fontSize) > maxWidth) {
    fontSize -= 0.5;
  }
  if (pdfTextWidth(text, selectedFonts, fontSize) > maxWidth || fontSize * 1.2 > maxHeight) {
    throw new SigningValidationError(
      `${field.label || field.type} does not fit in its PDF field. Shorten the value or ask the sender to enlarge the field.`,
    );
  }
  const origin = pointInStampBox(box, 4, Math.max(2, (box.height - fontSize) / 2));
  drawPdfTextRuns(page, text, selectedFonts, {
    ...origin,
    size: fontSize,
    rotate,
    color: rgb(0.06, 0.12, 0.22),
  });
}

async function assertCompletedValuesRenderable(params: {
  original: Buffer;
  fields: SignatureField[];
}): Promise<void> {
  const pdf = await PDFDocument.load(params.original, { updateMetadata: false });
  const fonts = await embedSigningFonts(pdf, signingFieldTexts(params.fields));
  const pages = pdf.getPages();
  for (const field of params.fields) {
    const page = pages[field.pageNumber - 1];
    if (!page) throw new SigningValidationError("A signing field references a missing page");
    await stampField(pdf, page, field, fonts);
  }
}

function signingFieldTexts(fields: SignatureField[]): { regular: string[]; signature: string[] } {
  const regular: string[] = [];
  const signature: string[] = [];
  for (const field of fields) {
    const value = parseFieldValue(field.valueJson);
    if (value === null || value === false || typeof value === "boolean") continue;
    if (value && typeof value === "object" && "dataUrl" in value) continue;
    const text = typeof value === "string" ? value : signatureText(value);
    if (!text) continue;
    if (field.type === "signature" || field.type === "initials") signature.push(text);
    else regular.push(text);
  }
  return { regular, signature };
}

async function buildCompletedPdf(params: {
  envelope: SignatureEnvelope;
  original: Buffer;
  recipients: SignatureRecipient[];
  fields: SignatureField[];
  auditHead: string;
  definitionManifestSha256: string;
  valueManifestSha256ByRecipient: Map<string, string>;
  recipientEvidenceByRecipient: Map<string, VerifiedRecipientEvidence>;
  completedAt: Date;
}): Promise<Buffer> {
  const pdf = await PDFDocument.load(params.original, { updateMetadata: false });
  const fieldTexts = signingFieldTexts(params.fields);
  const fonts = await embedSigningFonts(pdf, {
    regular: [
      ...fieldTexts.regular,
      params.envelope.title,
      ...params.recipients.flatMap((recipient) => {
        const evidence = params.recipientEvidenceByRecipient.get(recipient.id);
        return [
          recipient.name,
          recipient.email,
          evidence?.ipAddress ?? "",
          evidence?.userAgent ?? "",
        ];
      }),
    ],
    signature: fieldTexts.signature,
  });
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pages = pdf.getPages();
  for (const field of params.fields) {
    const page = pages[field.pageNumber - 1];
    if (!page) throw new SigningValidationError("A signing field references a missing page");
    await stampField(pdf, page, field, fonts);
  }

  const certificateWidth = 612;
  const certificateHeight = 792;
  const margin = 54;
  const contentBottom = 60;
  type CertificateCursor = { page: PDFPage; y: number };
  const addCertificatePage = (continued: boolean): CertificateCursor => {
    const page = pdf.addPage([certificateWidth, certificateHeight]);
    let cursorY = 738;
    page.drawText(
      continued
        ? "Electronic Signature Certificate (continued)"
        : "Electronic Signature Certificate",
      {
        x: margin,
        y: cursorY,
        size: continued ? 16 : 20,
        font: bold,
        color: rgb(0.06, 0.12, 0.22),
      },
    );
    cursorY -= 34;
    if (continued) {
      page.drawText("Signer evidence (continued)", {
        x: margin,
        y: cursorY,
        size: 13,
        font: bold,
      });
      cursorY -= 22;
    }
    page.drawText(
      "Generated by Genosyn. Verify the completed file against its stored SHA-256 and audit trail.",
      { x: margin, y: 36, size: 7, font: fonts.regular[0].font, color: rgb(0.3, 0.35, 0.42) },
    );
    return { page, y: cursorY };
  };

  let certificate = addCertificatePage(false);
  const rows = [
    `Document: ${params.envelope.title}`,
    `Envelope: ${params.envelope.id}`,
    `Original SHA-256: ${params.envelope.originalSha256}`,
    `Sent definition manifest SHA-256: ${params.definitionManifestSha256}`,
    `Completed: ${params.completedAt.toISOString()}`,
    `Evidence chain head before completion: ${params.auditHead || "none"}`,
  ];
  for (const row of rows) {
    for (const line of wrapPdfText(row, fonts.regular, 9, 612 - margin * 2)) {
      drawPdfTextRuns(certificate.page, line, fonts.regular, {
        x: margin,
        y: certificate.y,
        size: 9,
      });
      certificate.y -= 13;
    }
    certificate.y -= 3;
  }
  certificate.y -= 8;
  certificate.page.drawText("Signer evidence", {
    x: margin,
    y: certificate.y,
    size: 13,
    font: bold,
  });
  certificate.y -= 22;
  for (const recipient of params.recipients.filter((row) => row.role === "signer")) {
    const verifiedEvidence = params.recipientEvidenceByRecipient.get(recipient.id);
    if (!verifiedEvidence) {
      throw new SigningConflictError(`${recipient.name}'s signing evidence is incomplete`);
    }
    const completionMetadata = verifiedEvidence.metadata;
    const reportedTimeZone =
      typeof completionMetadata.timeZone === "string" && completionMetadata.timeZone
        ? completionMetadata.timeZone
        : "not reported";
    const evidence = await Promise.all(
      [
        `${recipient.name} <${recipient.email}>`,
        `Consent: ${verifiedEvidence.consentedAt.toISOString()}`,
        `Signed: ${verifiedEvidence.completedAt.toISOString()}`,
        `Signing calendar date: ${String(completionMetadata.signingCalendarDate ?? "not recorded")}`,
        `Signer timezone: ${reportedTimeZone} (UTC offset minutes: ${String(completionMetadata.timezoneOffsetMinutes ?? "not recorded")})`,
        `IP: ${verifiedEvidence.ipAddress || "not recorded"}`,
        `User agent: ${verifiedEvidence.userAgent || "not recorded"}`,
        `Accepted field values SHA-256: ${params.valueManifestSha256ByRecipient.get(recipient.id) || "not recorded"}`,
      ].map(pdfEvidenceText),
    );
    const evidenceLines = evidence.flatMap((entry) =>
      wrapPdfText(entry, fonts.regular, 8, certificateWidth - margin * 2),
    );
    const blockHeight = evidenceLines.length * 11 + 9;
    const continuationCapacity = 738 - 34 - 22 - contentBottom;
    if (blockHeight <= continuationCapacity && certificate.y - blockHeight < contentBottom) {
      certificate = addCertificatePage(true);
    }
    for (let index = 0; index < evidenceLines.length; index += 1) {
      if (certificate.y < contentBottom + 11) {
        certificate = addCertificatePage(true);
        drawPdfTextRuns(
          certificate.page,
          `${recipient.name} <${recipient.email}> (continued)`,
          fonts.regular,
          { x: margin, y: certificate.y, size: 8 },
        );
        certificate.y -= 14;
      }
      drawPdfTextRuns(certificate.page, evidenceLines[index], fonts.regular, {
        x: margin,
        y: certificate.y,
        size: 8,
      });
      certificate.y -= 11;
    }
    certificate.y -= 9;
  }
  const output = Buffer.from(await pdf.save({ useObjectStreams: false }));
  // A second parse catches corrupt image embeds or malformed output before publishing.
  await PDFDocument.load(output, { updateMetadata: false });
  return output;
}

async function sendCompletionCopies(params: {
  envelope: SignatureEnvelope;
  recipients: SignatureRecipient[];
  completed: Buffer;
}): Promise<void> {
  const recipientGroups = new Map<string, SignatureRecipient[]>();
  for (const recipient of params.recipients) {
    const key = normalizeEmail(recipient.email) ?? recipient.email.trim().toLowerCase();
    recipientGroups.set(key, [...(recipientGroups.get(key) ?? []), recipient]);
  }
  const attempts = await Promise.all(
    [...recipientGroups.values()].map(async (recipients) => {
      const result = await sendEmail({
        to: recipients[0].email,
        subject: `Completed: ${params.envelope.title}`,
        text: `The signature request “${params.envelope.title}” is complete. A copy of the signed document is attached.`,
        html: `<p>The signature request <strong>${escapeHtml(params.envelope.title)}</strong> is complete.</p><p>A copy of the signed document is attached.</p>`,
        attachments: [
          {
            filename: completedFilename(params.envelope),
            content: params.completed,
            contentType: "application/pdf",
          },
        ],
        companyId: params.envelope.companyId,
        purpose: "signature",
        triggeredByUserId: params.envelope.createdByUserId,
      });
      return { recipientIds: recipients.map((recipient) => recipient.id), result };
    }),
  );
  const attemptedAt = new Date();
  await AppDataSource.transaction(async (manager) => {
    const envelope = await findEnvelopeForUpdate(
      manager,
      params.envelope.companyId,
      params.envelope.id,
    );
    if (!envelope || envelope.status !== "completed") return;
    const recipientRepository = manager.getRepository(SignatureRecipient);
    for (const attempt of attempts) {
      const recipients = await recipientRepository.findBy({
        id: In(attempt.recipientIds),
        companyId: envelope.companyId,
        envelopeId: envelope.id,
      });
      for (const recipient of recipients) {
        recipient.lastDeliveryStatus = attempt.result.status;
        recipient.lastDeliveryError = attempt.result.errorMessage;
        recipient.lastDeliveredAt = attemptedAt;
      }
      if (recipients.length) await recipientRepository.save(recipients);
    }
  });
}

function completedFilename(envelope: SignatureEnvelope): string {
  const base = path.basename(envelope.originalFilename, path.extname(envelope.originalFilename));
  return `${base || "document"}-signed.pdf`.slice(0, 255);
}

async function finalizeSignatureEnvelope(params: {
  company: Company;
  envelopeId: string;
}): Promise<SignatureEnvelope> {
  const createdPaths: string[] = [];
  let completedBytes: Buffer | null = null;
  let completedRecipients: SignatureRecipient[] = [];
  try {
    if (signingFinalizationFailureForTests) throw signingFinalizationFailureForTests;
    const envelope = await AppDataSource.transaction(async (manager) => {
      const repository = manager.getRepository(SignatureEnvelope);
      const envelope = await findEnvelopeForUpdate(manager, params.company.id, params.envelopeId);
      if (!envelope) throw new SigningNotFoundError();
      if (envelope.status === "completed") return envelope;
      if (envelope.status !== "in_progress") {
        throw new SigningConflictError("This signature request cannot be completed");
      }
      const recipients = await manager.getRepository(SignatureRecipient).find({
        where: { companyId: envelope.companyId, envelopeId: envelope.id },
        order: { routingOrder: "ASC", createdAt: "ASC" },
      });
      const signers = recipients.filter((recipient) => recipient.role === "signer");
      if (!signers.length || signers.some((recipient) => recipient.status !== "completed")) {
        throw new SigningConflictError("Not every signer has completed their fields");
      }
      const fields = await manager.getRepository(SignatureField).find({
        where: { companyId: envelope.companyId, envelopeId: envelope.id },
        order: { pageNumber: "ASC", sortOrder: "ASC" },
      });
      const events = await manager.getRepository(SignatureEvent).find({
        where: { companyId: envelope.companyId, envelopeId: envelope.id },
        order: { createdAt: "ASC", id: "ASC" },
      });
      const originalPath = resolveSigningStoragePath(
        params.company.slug,
        envelope.originalStorageKey,
      );
      if (!originalPath || !fs.existsSync(originalPath)) {
        throw new SigningNotFoundError("The original PDF is missing");
      }
      const original = await fs.promises.readFile(originalPath);
      if (sha256Buffer(original) !== envelope.originalSha256) {
        throw new SigningConflictError("The original PDF failed its integrity check");
      }
      const chain = await verifySignatureEventChain({
        companyId: envelope.companyId,
        envelopeId: envelope.id,
      });
      if (!chain.valid)
        throw new SigningConflictError(`Audit chain verification failed: ${chain.error}`);
      const manifests = verifiedEvidenceManifests({ envelope, recipients, fields, events });
      const now = new Date();
      const completed = await buildCompletedPdf({
        envelope,
        original,
        recipients,
        fields,
        auditHead: chain.headHash,
        definitionManifestSha256: manifests.definitionManifestSha256,
        valueManifestSha256ByRecipient: manifests.valueManifestSha256ByRecipient,
        recipientEvidenceByRecipient: manifests.recipientEvidenceByRecipient,
        completedAt: now,
      });
      const completedStorageKey = `completed-${crypto.randomUUID()}.pdf`;
      const completedPath = resolveSigningStoragePath(params.company.slug, completedStorageKey);
      if (!completedPath) throw new Error("Could not create completed PDF path");
      ensureDir(signingRoot(params.company.slug));
      await fs.promises.writeFile(completedPath, completed, { flag: "wx", mode: 0o600 });
      createdPaths.push(completedPath);

      const contractStorageKey = `${crypto.randomUUID()}.pdf`;
      const contractPath = path.join(
        customerContractsRoot(params.company.slug),
        contractStorageKey,
      );
      ensureDir(customerContractsRoot(params.company.slug));
      await fs.promises.writeFile(contractPath, completed, { flag: "wx", mode: 0o600 });
      createdPaths.push(contractPath);
      const contractRepository = manager.getRepository(CustomerContract);
      const contract = await contractRepository.save(
        contractRepository.create({
          companyId: envelope.companyId,
          customerId: envelope.customerId,
          title: envelope.title,
          filename: completedFilename(envelope),
          mimeType: "application/pdf",
          sizeBytes: completed.length,
          storageKey: contractStorageKey,
          signedAt: now,
          notes: `Completed from Genosyn signature envelope ${envelope.id}.`,
          uploadedByUserId: envelope.createdByUserId,
        }),
      );
      envelope.status = "completed";
      envelope.completedAt = now;
      envelope.completedStorageKey = completedStorageKey;
      envelope.completedSizeBytes = completed.length;
      envelope.completedSha256 = sha256Buffer(completed);
      envelope.customerContractId = contract.id;
      await repository.save(envelope);
      await appendSignatureEvent(manager, {
        companyId: envelope.companyId,
        envelopeId: envelope.id,
        type: "envelope_completed",
        actor: { actorKind: "system", actorId: null },
        metadata: {
          completedSha256: envelope.completedSha256,
          completedSizeBytes: envelope.completedSizeBytes,
          customerContractId: contract.id,
        },
      });
      completedBytes = completed;
      completedRecipients = recipients;
      return envelope;
    });
    if (completedBytes) {
      try {
        await sendCompletionCopies({
          envelope,
          recipients: completedRecipients,
          completed: completedBytes,
        });
      } catch (error) {
        // The signed PDF, contract, and evidence trail are already committed.
        // EmailLog captures normal transport failures; an unexpected provider
        // or logging failure must not turn a successful signature into a 500.
        // eslint-disable-next-line no-console
        console.error(
          `[signing] completed envelope ${envelope.id}, but completion email failed:`,
          error,
        );
      }
    }
    return envelope;
  } catch (error) {
    await Promise.all(createdPaths.map((file) => fs.promises.unlink(file).catch(() => undefined)));
    throw error;
  }
}

export type ResolvedSignatureDocument = {
  envelope: SignatureEnvelope;
  path: string;
  absolutePath: string;
  filename: string;
  mimeType: "application/pdf";
  sizeBytes: number;
  sha256: string;
};

async function resolvedDocumentForEnvelope(params: {
  company: Company;
  envelope: SignatureEnvelope;
  variant: "original" | "completed";
}): Promise<ResolvedSignatureDocument> {
  const completed = params.variant === "completed";
  if (
    completed &&
    (!params.envelope.completedStorageKey || params.envelope.status !== "completed")
  ) {
    throw new SigningConflictError("The completed document is not available yet");
  }
  const storageKey = completed
    ? params.envelope.completedStorageKey
    : params.envelope.originalStorageKey;
  if (!storageKey) throw new SigningNotFoundError("Signature document is missing");
  const absolutePath = resolveSigningStoragePath(params.company.slug, storageKey);
  if (!absolutePath || !fs.existsSync(absolutePath)) {
    throw new SigningNotFoundError("Signature document is missing");
  }
  const expectedHash = completed ? params.envelope.completedSha256 : params.envelope.originalSha256;
  const expectedSize = completed
    ? Number(params.envelope.completedSizeBytes)
    : Number(params.envelope.originalSizeBytes);
  const bytes = await fs.promises.readFile(absolutePath);
  if (bytes.length !== expectedSize || sha256Buffer(bytes) !== expectedHash) {
    throw new SigningConflictError("Signature document failed its integrity check");
  }
  return {
    envelope: params.envelope,
    path: absolutePath,
    absolutePath,
    filename: completed ? completedFilename(params.envelope) : params.envelope.originalFilename,
    mimeType: "application/pdf",
    sizeBytes: bytes.length,
    sha256: expectedHash,
  };
}

export async function resolveSignatureDocument(params: {
  companyId: string;
  envelopeId: string;
  variant?: "original" | "completed";
  actor?: SigningActor;
  ipAddress?: string;
  userAgent?: string;
}): Promise<ResolvedSignatureDocument> {
  const company = await requireCompany(params.companyId);
  const envelope = await AppDataSource.getRepository(SignatureEnvelope).findOneBy({
    id: params.envelopeId,
    companyId: params.companyId,
  });
  if (!envelope) throw new SigningNotFoundError();
  const resolved = await resolvedDocumentForEnvelope({
    company,
    envelope,
    variant: params.variant ?? "original",
  });
  await AppDataSource.transaction((manager) =>
    appendSignatureEvent(manager, {
      companyId: envelope.companyId,
      envelopeId: envelope.id,
      type: "document_downloaded",
      actor: normalizeActor(params.actor),
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
      metadata: { variant: params.variant ?? "original", sha256: resolved.sha256 },
    }),
  );
  return resolved;
}

export async function resolvePublicSignatureDocument(params: {
  token: string;
  variant?: "original" | "completed";
  ipAddress?: string;
  userAgent?: string;
}): Promise<Omit<ResolvedSignatureDocument, "envelope">> {
  const context = await lookupSignatureRecipientByToken({ token: params.token });
  if (!context) throw new SigningNotFoundError("This signing link is invalid or expired");
  const variant = params.variant ?? "original";
  if (variant === "completed" && context.recipient.status !== "completed") {
    throw new SigningConflictError("Complete your signing fields before downloading the result");
  }
  const recipient = await AppDataSource.getRepository(SignatureRecipient).findOneBy({
    id: context.recipient.id,
    tokenHash: hashSignatureRecipientToken(params.token),
  });
  if (!recipient) throw new SigningNotFoundError("This signing link is no longer valid");
  const envelope = await AppDataSource.getRepository(SignatureEnvelope).findOneBy({
    id: recipient.envelopeId,
    companyId: recipient.companyId,
  });
  if (!envelope) throw new SigningNotFoundError();
  const company = await requireCompany(envelope.companyId);
  const resolved = await resolvedDocumentForEnvelope({ company, envelope, variant });
  await AppDataSource.transaction((manager) =>
    appendSignatureEvent(manager, {
      companyId: envelope.companyId,
      envelopeId: envelope.id,
      recipientId: recipient.id,
      type: "document_downloaded",
      actor: { actorKind: "recipient", actorId: recipient.id },
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
      metadata: { variant, sha256: resolved.sha256 },
    }),
  );
  const { envelope: _envelope, ...safeResolved } = resolved;
  return safeResolved;
}

export async function expireSignatureEnvelopes(
  params: {
    companyId?: string;
    now?: Date;
  } = {},
): Promise<number> {
  const now = params.now ?? new Date();
  const where: FindOptionsWhere<SignatureEnvelope> = {
    status: In(["sent", "in_progress"]),
    expiresAt: LessThanOrEqual(now),
  };
  if (params.companyId) where.companyId = params.companyId;
  const candidates = await AppDataSource.getRepository(SignatureEnvelope).findBy(where);
  let expired = 0;
  for (const candidate of candidates) {
    const didExpire = await AppDataSource.transaction(async (manager) => {
      const envelope = await findEnvelopeForUpdate(manager, candidate.companyId, candidate.id);
      if (
        !envelope ||
        (envelope.status !== "sent" && envelope.status !== "in_progress") ||
        !envelope.expiresAt ||
        envelope.expiresAt.getTime() > now.getTime()
      ) {
        return false;
      }
      // The deadline was enforced before each signer commit. If every signer
      // is already complete, this is a recoverable finalization saga rather
      // than an unsigned request: preserve its receipt token so the signed PDF
      // can be retried instead of terminally expiring committed evidence.
      if (
        envelope.status === "in_progress" &&
        (await haveAllSignersCompleted(manager, {
          companyId: envelope.companyId,
          envelopeId: envelope.id,
        }))
      ) {
        return false;
      }
      envelope.status = "expired";
      envelope.expiredAt = now;
      await manager.getRepository(SignatureEnvelope).save(envelope);
      const recipientRepository = manager.getRepository(SignatureRecipient);
      const recipients = await recipientRepository.findBy({
        companyId: envelope.companyId,
        envelopeId: envelope.id,
      });
      for (const recipient of recipients) recipient.tokenHash = null;
      if (recipients.length) await recipientRepository.save(recipients);
      await appendSignatureEvent(manager, {
        companyId: envelope.companyId,
        envelopeId: envelope.id,
        type: "envelope_expired",
        actor: { actorKind: "system", actorId: null },
        metadata: { expiredAt: now.toISOString() },
        now,
      });
      return true;
    });
    if (didExpire) expired += 1;
  }
  return expired;
}

/** Start the lightweight in-process deadline sweeper once during server boot. */
export async function bootSignatureExpirySweeper(): Promise<void> {
  await expireSignatureEnvelopes();
  if (signatureExpiryTimer) return;
  signatureExpiryTimer = setInterval(() => {
    void expireSignatureEnvelopes().catch((error: unknown) => {
      // A transient database failure must not crash the API process. The next
      // pass retries, and public token lookup also enforces the deadline.
      // eslint-disable-next-line no-console
      console.error(
        `[signing] expiration sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }, 60_000);
  signatureExpiryTimer.unref();
}

export async function listSigningGrants(params: {
  companyId: string;
}): Promise<Array<EmployeeSigningGrant & { employeeName: string }>> {
  const grants = await AppDataSource.getRepository(EmployeeSigningGrant).find({
    where: { companyId: params.companyId },
    order: { createdAt: "ASC" },
  });
  const employeeIds = grants.map((grant) => grant.employeeId);
  const employees = employeeIds.length
    ? await AppDataSource.getRepository(AIEmployee).findBy({
        companyId: params.companyId,
        id: In(employeeIds),
      })
    : [];
  const names = new Map(employees.map((employee) => [employee.id, employee.name]));
  return grants.map((grant) =>
    Object.assign(grant, { employeeName: names.get(grant.employeeId) ?? "Unknown AI Employee" }),
  );
}

export async function upsertSigningGrant(params: {
  companyId: string;
  employeeId: string;
  accessLevel: SigningAccessLevel;
}): Promise<EmployeeSigningGrant> {
  if (!SIGNING_ACCESS_LEVELS.includes(params.accessLevel)) {
    throw new SigningValidationError("Signing access must be read, draft, or send");
  }
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: params.employeeId,
    companyId: params.companyId,
  });
  if (!employee) throw new SigningNotFoundError("AI Employee not found");
  const repository = AppDataSource.getRepository(EmployeeSigningGrant);
  let grant = await repository.findOneBy({ employeeId: params.employeeId });
  if (grant && grant.companyId !== params.companyId) {
    throw new SigningConflictError("Signing grant belongs to another company");
  }
  if (!grant) {
    grant = repository.create({
      companyId: params.companyId,
      employeeId: params.employeeId,
      accessLevel: params.accessLevel,
    });
  } else {
    grant.accessLevel = params.accessLevel;
  }
  return repository.save(grant);
}

export async function deleteSigningGrant(params: {
  companyId: string;
  employeeId: string;
}): Promise<boolean> {
  const result = await AppDataSource.getRepository(EmployeeSigningGrant).delete({
    companyId: params.companyId,
    employeeId: params.employeeId,
  });
  return Boolean(result.affected);
}

export async function hasSigningAccess(params: {
  companyId: string;
  employeeId: string;
  requiredAccess: SigningAccessLevel;
}): Promise<boolean> {
  const grant = await AppDataSource.getRepository(EmployeeSigningGrant).findOneBy({
    companyId: params.companyId,
    employeeId: params.employeeId,
  });
  return Boolean(
    grant && SIGNING_ACCESS_RANK[grant.accessLevel] >= SIGNING_ACCESS_RANK[params.requiredAccess],
  );
}

export async function composeSigningContext(params: {
  companyId: string;
  employeeId: string;
}): Promise<string> {
  const grant = await AppDataSource.getRepository(EmployeeSigningGrant).findOneBy({
    companyId: params.companyId,
    employeeId: params.employeeId,
  });
  if (!grant) return "";
  const abilities =
    grant.accessLevel === "read"
      ? "inspect signature requests"
      : grant.accessLevel === "draft"
        ? "inspect requests and prepare new drafts from granted PDF Resources without contacting customers"
        : "inspect requests, prepare new drafts from granted PDF Resources, send invitations or reminders that contact customers, and void active requests";
  return [
    "## Electronic signatures",
    `You have ${grant.accessLevel} signing access. You may ${abilities}.`,
    "Only use PDF Resources you can read. Keep sent requests immutable and report delivery failures.",
    "The signing tools cannot read the source PDF attached to an envelope or edit an existing draft. Say so plainly, and ask a Member to verify document meaning and field placement.",
    ...(grant.accessLevel === "send"
      ? [
          "Sending and reminding contacts customers; voiding is irreversible. Inspect the exact request first and act only when the current instruction or Routine brief explicitly calls for it.",
        ]
      : []),
    "You must never consent, draw, type, or submit a signature for a recipient. Signing is always a human action through the recipient's private link.",
  ].join("\n");
}
