/**
 * The default field selection, curated by hand for the nine types where a page costs the most.
 *
 * Microsoft publishes nothing that says which properties matter. There is no such field in the
 * OpenAPI, the CSDL, or the permissions reference, so unlike the consistency header and the
 * enum members there is nothing here to derive. That leaves two honest options: curate a short
 * list, or ship no default at all. ADR-0011 records why deriving one mechanically was measured
 * and rejected — `microsoft.graph.user` has 81 scalar properties against the 11 Graph itself
 * returns, so "every scalar property" makes a response 7.4 times wider rather than narrower,
 * and it pulls in `signInActivity`, which fails the whole call without `AuditLog.Read.All`.
 *
 * Keyed by entity type rather than by path. A type is where the knowledge actually lives, it
 * covers `/users` and `/users/{id}` from one entry, and it is right by construction for
 * `/groups/{id}/members`, which returns `microsoft.graph.directoryObject` and so correctly gets
 * no user fields.
 *
 * Every name here is checked against the CSDL at build time. A curated property that is not a
 * real property of its type fails the build. That check is the whole reason a hand-kept list is
 * defensible here: the list cannot rot quietly, because the build stops when it does.
 */
export const CURATED_DEFAULT_SELECT: Record<string, string[]> = {
  "microsoft.graph.user": [
    "id", "displayName", "userPrincipalName", "mail", "jobTitle", "department", "accountEnabled", "createdDateTime",
  ],
  "microsoft.graph.group": [
    "id", "displayName", "description", "mail", "mailEnabled", "securityEnabled", "groupTypes", "visibility", "createdDateTime",
  ],
  "microsoft.graph.device": [
    "id", "deviceId", "displayName", "operatingSystem", "operatingSystemVersion", "accountEnabled", "isCompliant",
    "isManaged", "trustType", "approximateLastSignInDateTime",
  ],
  "microsoft.graph.application": [
    "id", "appId", "displayName", "signInAudience", "publisherDomain", "createdDateTime",
  ],
  "microsoft.graph.servicePrincipal": [
    "id", "appId", "displayName", "servicePrincipalType", "accountEnabled", "appOwnerOrganizationId", "signInAudience",
  ],
  "microsoft.graph.directoryRole": ["id", "displayName", "description", "roleTemplateId"],
  "microsoft.graph.subscribedSku": ["id", "skuId", "skuPartNumber", "consumedUnits", "appliesTo"],
  "microsoft.graph.organization": ["id", "displayName", "tenantType", "createdDateTime"],
  "microsoft.graph.domain": ["id", "isVerified", "isDefault", "authenticationType"],
};

export interface CuratedProblem {
  type: string;
  /** Property names curated for the type that the CSDL does not give it. */
  missing: string[];
}

/**
 * Checks the curated list against the types the build actually read.
 *
 * A type the index does not hold is reported with every one of its properties missing, because
 * a curated entry for a type that no longer exists is the same kind of rot as a curated property
 * that no longer exists, and silently skipping it would hide a Graph rename.
 */
export function curatedProblems(
  types: Record<string, { properties: Record<string, string> }>,
  curated: Record<string, string[]> = CURATED_DEFAULT_SELECT,
): CuratedProblem[] {
  const problems: CuratedProblem[] = [];
  for (const [type, properties] of Object.entries(curated)) {
    const known = types[type]?.properties;
    const missing = known === undefined ? [...properties] : properties.filter((name) => known[name] === undefined);
    if (missing.length > 0) problems.push({ type, missing });
  }
  return problems;
}
