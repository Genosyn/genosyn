import { AppDataSource } from "../db/datasource.js";
import { Subsidiary, type SubsidiaryIssuerSnapshot } from "../db/entities/Subsidiary.js";

export type SubsidiaryInput = Pick<SubsidiaryIssuerSnapshot, "name"> &
  Partial<Omit<SubsidiaryIssuerSnapshot, "name">>;

export function listSubsidiaries(companyId: string): Promise<Subsidiary[]> {
  return AppDataSource.getRepository(Subsidiary).find({
    where: { companyId },
    order: { archived: "ASC", name: "ASC", id: "ASC" },
  });
}

export async function createSubsidiary(companyId: string, input: SubsidiaryInput): Promise<Subsidiary> {
  const repo = AppDataSource.getRepository(Subsidiary);
  return repo.save(repo.create({ ...input, companyId, archived: false }));
}

export async function updateSubsidiary(
  companyId: string,
  id: string,
  input: Partial<SubsidiaryIssuerSnapshot> & { archived?: boolean },
): Promise<Subsidiary | null> {
  const repo = AppDataSource.getRepository(Subsidiary);
  const subsidiary = await repo.findOneBy({ id, companyId });
  if (!subsidiary) return null;
  Object.assign(subsidiary, input);
  return repo.save(subsidiary);
}

export type DocumentIssuer = {
  subsidiaryId: string | null;
  issuerSnapshot: SubsidiaryIssuerSnapshot | null;
};

/** Select a live issuer only within the current company, before writing a draft. */
export async function resolveDocumentIssuer(
  companyId: string,
  subsidiaryId?: string | null,
): Promise<DocumentIssuer> {
  if (!subsidiaryId) return { subsidiaryId: null, issuerSnapshot: null };
  const subsidiary = await AppDataSource.getRepository(Subsidiary).findOneBy({
    id: subsidiaryId,
    companyId,
  });
  if (!subsidiary) throw new Error("Invalid subsidiary");
  if (subsidiary.archived) throw new Error("Archived subsidiaries cannot issue new documents");
  const { name, address, country, taxNumber, registrationNumber, email, phone, website, footer } = subsidiary;
  return {
    subsidiaryId: subsidiary.id,
    issuerSnapshot: { name, address, country, taxNumber, registrationNumber, email, phone, website, footer },
  };
}

type IssuerDisplayFields = {
  companyName?: string;
  defaultFromBlock?: string;
  defaultFooter?: string;
};

/** Every document renderer uses the same frozen issuer, including email bodies. */
export function documentIssuerFields(
  document: { issuerSnapshot?: SubsidiaryIssuerSnapshot | null },
  fallback: IssuerDisplayFields,
): IssuerDisplayFields {
  const issuer = document.issuerSnapshot;
  if (!issuer) return fallback;
  return {
    companyName: issuer.name,
    defaultFromBlock: [
      issuer.name,
      issuer.address,
      issuer.country,
      issuer.taxNumber ? `Tax #: ${issuer.taxNumber}` : "",
      issuer.registrationNumber ? `Registration #: ${issuer.registrationNumber}` : "",
      issuer.email,
      issuer.phone,
      issuer.website,
    ].filter(Boolean).join("\n"),
    // A blank subsidiary footer must not inherit another legal entity's bank details.
    defaultFooter: issuer.footer,
  };
}
