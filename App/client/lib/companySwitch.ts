import type { Company } from "./api";

type CreateCompanyAndSwitchOptions = {
  createCompany: () => Promise<Company>;
  refreshCompanies: () => Promise<void>;
  navigate: (destination: string) => void | Promise<void>;
  suffix?: string;
};

/**
 * Creates a company and makes it routable before opening it.
 *
 * Company routes resolve slugs from App's in-memory company list. Navigating
 * before that list is refreshed makes a newly created slug look invalid and
 * sends the Member back to their previous company.
 */
export async function createCompanyAndSwitch({
  createCompany,
  refreshCompanies,
  navigate,
  suffix = "",
}: CreateCompanyAndSwitchOptions): Promise<Company> {
  const company = await createCompany();
  await refreshCompanies();
  await navigate(`/c/${company.slug}${suffix}`);
  return company;
}
