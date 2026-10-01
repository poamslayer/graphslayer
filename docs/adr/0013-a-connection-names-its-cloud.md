# A connection names its cloud

Three constants in `src/core/config.ts` pinned the server to the commercial cloud: `GRAPH_ORIGIN`, `GRAPH_SCOPE_DEFAULT` and `LOGIN_AUTHORITY_BASE`. A tenant in GCC High could not be reached at all, and two guards would have refused it even with a valid token — `buildRequestUrl` rejects any origin that is not `graph.microsoft.com`, and `decodeCursor` rejects any cursor that does not point at it. We are adding GCC High, and the cloud is a field on the connection rather than a setting on the process.

Microsoft documents four deployments; two of them matter here and the third is a trap:

| Cloud | Graph | Authority |
|---|---|---|
| Commercial | `graph.microsoft.com` | `login.microsoftonline.com` |
| GCC Moderate | `graph.microsoft.com` | `login.microsoftonline.com` |
| GCC High | `graph.microsoft.us` | `login.microsoftonline.us` |
| DoD | `dod-graph.microsoft.us` | `login.microsoftonline.us` |

GCC Moderate runs on the commercial endpoints and therefore already worked. It is deliberately **not** a selectable value: an option that changes nothing except to break the tenant that picks it is worse than no option. GCC High ships. DoD is one more entry in the table when someone wants it.

## Considered options

**A field on the connection.** Chosen. `CONTEXT.md` promises reads and writes "across one or more Microsoft 365 tenants", and the dual-tenant defence contractor — commercial for the corporate directory, GCC High for CUI — is the ordinary shape of this customer, not an edge case. Only a per-connection field lets one server answer a question that spans both.

**An environment variable on the process.** Rejected. It makes that customer two installations with two connection stores, and no single agent session can see both. It also contradicts ADR-0004: the tenant is already a required argument on every call precisely so that one server can serve several, and moving the cloud to the process would put half of the tenant's identity somewhere the call cannot name.

**Derived from the tenant id.** Rejected. A tenant id alone does not say which cloud it lives in; discovering it means asking a cloud-specific endpoint and inferring from the failures, so every connect becomes a probe of several clouds and a guess. Explicit at connect time costs one optional argument and removes the whole class of mystery.

Three facts were verified rather than assumed, because the docs do not settle them:

- **`@azure/msal-node` needs only the authority.** Building a `PublicClientApplication` against `https://login.microsoftonline.us/organizations` resolves to `https://login.microsoftonline.us/organizations/oauth2/v2.0/authorize` with no `knownAuthorities`, no `azureCloudOptions` and no instance-discovery bypass. Microsoft's national-cloud MSAL article has no Node tab, so this was measured.
- **The shared app works there.** `login.microsoftonline.us` issues a device code for `14d82eec-204b-4c2f-b7e8-296a70dab67e` against `https://graph.microsoft.us/.default`, so ADR-0003's choice of Microsoft's Graph Command Line Tools application carries into GCC High and no separate registration is required.
- **The Gov path surface is a strict subset, and the schema is public.** `graph.microsoft.us` serves `$metadata` unauthenticated for both versions, and the GCC High and DoD v1.0 documents are byte identical (MD5 `12e88144e5aacc1ac7e7666d457a5933`), so one schema variant covers both `.us` clouds. Against our shipped index, at least 1,595 of 11,546 v1.0 paths (13.8%) and 2,996 of 18,583 beta paths (16.1%) do not exist there — a floor, because the check catches a missing root entity set or entity type rather than a path that dies partway along a navigation property.

  The *schema as a whole* is not a subset, and an earlier draft of this ADR said it was. GCC High declares four definitions commercial does not: the complex types `blockAccessAction`, `deviceRestrictionAction` and `notifyUserAction`, and the enum `restrictionTrigger`. What makes subtraction sound anyway is that the extras are confined to those two kinds: entity sets, singletons, entity types, actions and functions — the five kinds that produce paths — have no Gov-only members at all. Paths can therefore be removed and never added. The four Gov-only definitions are a gap in the type dictionary, recorded in ADR-0014.

## Consequences

- **Existing connections need no migration.** A record written before this field reads back as `undefined`, and `undefined` means commercial, because commercial was the only thing there was. One `?? "commercial"` is the entire upgrade path; no script runs over `connections.json`.
- **Both guards get stronger, not weaker.** They stop asking "is this the commercial host" and start asking "is this *this connection's* host". Today a GCC High cursor and a commercial cursor are indistinguishable once decoded; afterwards a cursor from the wrong cloud is refused.
- **`graph_describe` stays accurate per cloud by subtraction, not duplication.** A removal list of the paths absent from GCC High ships at roughly 430 KB, against roughly 8 MB for a second pair of index files. It is applied inside `src/core/index/loader.ts`, keyed by cloud, so what the loader returns is already correct for that connection and nothing downstream can forget to filter. `describe.ts` and `search.ts` are untouched. What that subtraction can and cannot make true is ADR-0014: the shape is cloud correct, the scopes and the consistency header are not.
- **The audit event records the cloud.** Proving that a read happened inside the GCC High boundary is evidence a CMMC assessor asks for, and reconstructing it later from a tenant id means keeping a mapping nobody wrote down.
- **The read template is not narrowed for GCC High, and may fail there.** Entra documents `AADSTS70011 invalid_scope` but never says what happens when one scope of many is unknown in a cloud, and the template carries about 150. Guessing a subtraction blind would silently narrow what the tool can read, which is worse than a loud failure, so the template is unchanged and the error surfaces the scope list instead. `signInDelegated` already accepts explicit `scopes`, so the escape hatch exists.
- **One latent bug is fixed here rather than found later.** `src/core/graph/client.ts` builds each `$batch` sub-request by trimming `"https://graph.microsoft.com/v1.0".length` characters from the front of a URL. `graph.microsoft.us` is shorter, so the slice would not throw — it would send quietly malformed paths.

> Superseded in part by ADR-0016 (2026-10-01): the server keeps no local audit log, so where this record mentions audit lines, Microsoft's own logs are the record now.

> Tool names changed in ADR-0017 (2026-10-01): `graph_describe` is now `search`, and `graph_run` and `graph_write` are now `execute`.
