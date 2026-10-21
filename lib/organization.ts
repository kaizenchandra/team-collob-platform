export type OrganizationPerson = {
  id: string;
  name: string;
  email: string;
  title: string;
  role: string;
  presence: string;
  department: string;
  organizationalUnit: string;
  workLocation: string;
  directReportCount: number;
  updatedAt: string | null;
  sourceAsOf: string | null;
  sourceLabel: string | null;
  revision: string | null;
  reportingStatus: "unknown" | "root" | "assigned";
};
export type OrganizationPage = {
  people: OrganizationPerson[];
  nextCursor: { name: string; id: string } | null;
};
export type OrganizationContext = {
  person: OrganizationPerson;
  manager: OrganizationPerson | null;
  managerState: "unknown" | "root" | "assigned" | "unavailable";
  chain: OrganizationPerson[];
  chainStatus: "complete" | "unknown" | "unavailable" | "cycle" | "truncated";
  loadedAt: string;
};
export type OrganizationProfile = Pick<
  OrganizationContext,
  "person" | "manager" | "managerState"
>;
export function reportingPath<T extends { id: string }>(
  selected: string,
  chain: T[],
  status: OrganizationContext["chainStatus"],
) {
  const seen = new Set([selected]);
  const safe: T[] = [];
  for (const person of chain) {
    if (seen.has(person.id)) return { chain: safe, status: "cycle" as const };
    seen.add(person.id);
    safe.push(person);
  }
  return { chain: safe, status };
}
