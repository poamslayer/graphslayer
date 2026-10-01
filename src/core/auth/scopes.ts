import type { Connection, ConnectionMode } from "../types.js";

export type ScopeTemplate = "read" | "read-write";
export type ScopeClass = "read" | "write";

/**
 * Entra's documented approximate cap on the permissions one delegated consent request may
 * carry, taken from ADR-0012.
 *
 * "Approximate" is Microsoft's own word and it is why `scope-ceiling.test.ts` asserts a margin
 * below this rather than equality to it: a template sitting on the number is not known to fit,
 * only untested, and the place that discovers it does not fit is a customer's consent screen.
 */
export const DELEGATED_CONSENT_CEILING = 155;

const WRITE_ACTION_MARKERS = [
  "Write",
  "Create",
  "Delete",
  "Remove",
  "Send",
  "Manage",
  "Update",
  "Submit",
  "Invite",
  "Revoke",
  "Export",
  "Import",
];

/** What a name says on its own, before the rule that an unclassified scope counts as a write. */
export type ScopeReading = "read" | "write" | "unclassified";

/**
 * A Graph scope is `Resource.Action` or `Resource.Action.Qualifier`, and the action token is
 * what says whether it reads.
 *
 * Only `Read` and `ReadBasic` count as read, and nothing that merely starts with "Read" does.
 * `TeamsAppInstallation.ReadForChat` and `ResourceSpecificPermissionGrant.ReadForTeam` are
 * their own grants rather than narrower spellings of `Read`, and Microsoft's reference never
 * makes them equivalent, so reading the prefix instead of the token would quietly widen the
 * read template by twelve names.
 *
 * The three-way answer exists so the names that say neither are visible. Collapsing them into
 * "write" at this point would be correct and untestable: a marker that silently swallowed one
 * would look exactly like a name that was never ambiguous.
 */
export function readScopeName(name: string): ScopeReading {
  const action = name.split(".")[1];
  if (action === "Read" || action === "ReadBasic") return "read";
  if (action && WRITE_ACTION_MARKERS.some((marker) => action.includes(marker))) return "write";
  return "unclassified";
}

/**
 * An unclassified name counts as a write, so a misreading keeps a scope out of the read
 * template rather than smuggling one in. Against the shipped index that is 36 names,
 * `Directory.AccessAsUser.All` among them.
 */
export function classifyScope(name: string): ScopeClass {
  return readScopeName(name) === "read" ? "read" : "write";
}

/**
 * The scopes a read connection asks for.
 *
 * Chosen by hand from the shortlist `scripts/rank-read-scopes.ts` produces, which ranks every
 * read scope by how many shallow index paths it unlocks. The ranking is in
 * `docs/measurements/2026-09-16-read-scope-ranking.md` and it is a shortlist rather than an
 * answer, for two reasons the numbers make plain.
 *
 * It drops things that are needed. `UserAuthenticationMethod.Read.All` ranks 141st of 222 with
 * **zero** shallow paths, and it is how you find out whether anyone has registered MFA —
 * `/reports/authenticationMethods/userRegistrationDetails` is three literal segments deep, so a
 * depth-weighted ranking cannot see it. It is in this list anyway.
 *
 * It promotes things that are not. `Calendars.ReadBasic`, `Files.Read`, `Tasks.Read`,
 * `Contacts.Read`, `Mail.ReadBasic` and `Sites.Read.All` all rank in the top 25 and none of them
 * are here. They are mailbox, file and collaboration content, not the security posture of a
 * directory, and asking a customer to consent to reading everyone's mail in order to audit their
 * conditional access policies is the ask that gets a tool refused outright.
 *
 * What this list covers, deliberately: identity and its groups, the directory and its
 * administrative units, the tenant and its domains, applications, policy, roles and PIM,
 * authentication methods and identity providers, risk, audit and reporting, partner delegated
 * admin relationships, devices and Intune, and SharePoint's tenant-level settings — which is the
 * sharing posture, not site content.
 *
 * Keep it sorted by subject rather than by rank. The rank is in the measurement; what a reader
 * needs here is to see at a glance whether a subject is covered.
 */
export const READ_TEMPLATE_SCOPES: string[] = [
  // People and groups
  "User.Read",
  "User.Read.All",
  "Group.Read.All",
  "GroupSettings.Read.All",
  // The directory itself
  "Directory.Read.All",
  "AdministrativeUnit.Read.All",
  "Organization.Read.All",
  "Domain.Read.All",
  // Applications and what they are allowed to do
  "Application.Read.All",
  "Policy.Read.All",
  // Privilege
  "RoleManagement.Read.Directory",
  "RoleManagementPolicy.Read.Directory",
  // How people prove who they are, and when that goes wrong
  "UserAuthenticationMethod.Read.All",
  "IdentityProvider.Read.All",
  "IdentityRiskEvent.Read.All",
  "IdentityRiskyUser.Read.All",
  // What already happened
  "AuditLog.Read.All",
  "Reports.Read.All",
  "SecurityEvents.Read.All",
  // Who else administers this tenant
  "DelegatedAdminRelationship.Read.All",
  // Endpoints
  "Device.Read.All",
  "DeviceManagementManagedDevices.Read.All",
  "DeviceManagementConfiguration.Read.All",
  "DeviceManagementApps.Read.All",
  "DeviceManagementServiceConfig.Read.All",
  "DeviceManagementRBAC.Read.All",
  // Sharing posture, at the tenant level only
  "SharePointTenantSettings.Read.All",
];

/**
 * The write counterparts the shipped index actually holds, mirrored here so building a template
 * never parses four megabytes at import. `scopes.test.ts` asserts this mirror against the index,
 * which is where drift would show up.
 */
const READ_WRITE_COUNTERPARTS_IN_INDEX = new Set([
  "User.ReadWrite",
  "User.ReadWrite.All",
  "Group.ReadWrite.All",
  "GroupSettings.ReadWrite.All",
  "Directory.ReadWrite.All",
  "AdministrativeUnit.ReadWrite.All",
  "Organization.ReadWrite.All",
  "Domain.ReadWrite.All",
  "Application.ReadWrite.All",
  "RoleManagement.ReadWrite.Directory",
  "RoleManagementPolicy.ReadWrite.Directory",
  "UserAuthenticationMethod.ReadWrite.All",
  "IdentityProvider.ReadWrite.All",
  "IdentityRiskEvent.ReadWrite.All",
  "IdentityRiskyUser.ReadWrite.All",
  "SecurityEvents.ReadWrite.All",
  "DelegatedAdminRelationship.ReadWrite.All",
  "Device.ReadWrite.All",
  "DeviceManagementManagedDevices.ReadWrite.All",
  "DeviceManagementConfiguration.ReadWrite.All",
  "DeviceManagementApps.ReadWrite.All",
  "DeviceManagementServiceConfig.ReadWrite.All",
  "DeviceManagementRBAC.ReadWrite.All",
  "SharePointTenantSettings.ReadWrite.All",
]);

// Three of the read scopes derive nothing, and each absence is a fact rather than a gap.
// `AuditLog` and `Reports` have no write counterpart at all, because audit logs and usage
// reports are not writable by a Graph consumer. `Policy` has nineteen in the beta index and
// none with an `.All` qualifier, so there is nothing to derive and the four below are chosen.
const DERIVED_WRITE_SCOPES = READ_TEMPLATE_SCOPES
  .map((scope) => {
    const segments = scope.split(".");
    segments[1] = "ReadWrite";
    return segments.join(".");
  })
  .filter((scope) => READ_WRITE_COUNTERPARTS_IN_INDEX.has(scope));

// SecurityDefaults is deliberately omitted: enabling it disables every conditional access
// policy in one call. The other Policy.ReadWrite scopes cover B2B, cross-tenant, trust framework,
// mobility management, device configuration, external identities, access review, consent request,
// hybrid and on-premises authentication, application configuration, or federated token validation
// surfaces outside an Entra assessment; asking for them would broaden consent without helping one.
const POLICY_WRITE_SCOPES = [
  "Policy.ReadWrite.ConditionalAccess",
  "Policy.ReadWrite.AuthenticationMethod",
  "Policy.ReadWrite.Authorization",
  "Policy.ReadWrite.PermissionGrant",
];

export const READ_WRITE_TEMPLATE_SCOPES: string[] = [
  ...READ_TEMPLATE_SCOPES,
  ...DERIVED_WRITE_SCOPES,
  ...POLICY_WRITE_SCOPES,
];

export function scopesForTemplate(template: ScopeTemplate): string[] {
  return [...(template === "read-write" ? READ_WRITE_TEMPLATE_SCOPES : READ_TEMPLATE_SCOPES)];
}

export function modeForTemplate(template: ScopeTemplate): ConnectionMode {
  return template === "read-write" ? "write" : "read";
}


/** Graph permission names look like Resource.Action or Resource.Action.Scope, e.g. User.Read.All. */
export const SCOPE_NAME_RE = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9-]*){1,3}$/;

/** The sign-in scopes MSAL adds to every interactive sign-in, so they are never evidence of earlier consent. */
export const SIGN_IN_SCOPES = new Set(["openid", "profile", "email", "offline_access"]);

/**
 * Granted scopes the sign-in did not request: consent the client id already held in the tenant.
 * Compared without case, because the scp claim does not promise the casing a request used. #66.
 */
export function inheritedScopes(granted: string[], requested: string[]): string[] {
  const requestedSet = new Set(requested.map((s) => s.toLowerCase()));
  return granted.filter((s) => !SIGN_IN_SCOPES.has(s.toLowerCase()) && !requestedSet.has(s.toLowerCase()));
}

export interface InheritedScopesReport {
  requestedScopes: string[];
  inheritedScopes: string[];
  /** Present only when the token is wider than the request. */
  inheritedScopesNote?: string;
}

/**
 * Sets a connection's requested scopes beside what its token inherited. A token wider than its
 * request reads as a failed consent unless the result says why: the shared client id carries
 * whatever consent other tools collected in the tenant. ADR-0003, #66. Undefined for a connection
 * with no requested scopes, which is app-only or was stored before they were kept.
 */
export function inheritedScopesReport(connection: Pick<Connection, "scopes" | "requestedScopes">): InheritedScopesReport | undefined {
  const requested = connection.requestedScopes;
  if (!requested) return undefined;
  const inherited = inheritedScopes(connection.scopes, requested);
  if (!inherited.length) return { requestedScopes: requested, inheritedScopes: inherited };
  return {
    requestedScopes: requested,
    inheritedScopes: inherited,
    inheritedScopesNote: `The token carries ${inherited.length} scopes this sign-in did not request: ${inherited.join(", ")}. The application already holds consent for them in this tenant, granted earlier by an admin or by another tool that uses the same client id. This sign-in requested exactly ${requested.join(", ")}.`,
  };
}
