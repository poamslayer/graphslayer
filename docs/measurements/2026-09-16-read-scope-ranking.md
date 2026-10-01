# Ranking read scopes by index path coverage

Measured for #49 against the shipped v1.0 index on 2026-09-16, by `npm run rank:read-scopes`.
This ranks; it does not choose. ADR-0012 records why the shipped read list has to be a cut
rather than a confirmation, and the section on today's ten is the part that says what a
mechanical cut would cost.

## What was counted

- **Delegated GET only.** The read template is a delegated consent request. Application
  permissions are a different ceiling and a different flow, so an application surface cannot
  earn a place in a template that can never ask for it.
- **Least where marked, all where not.** A path's delegated `least` list is the documented
  minimum; where the reference marks none, `least` is absent and `all` stands in. Scoring only
  the marked paths would rank a scope by how thoroughly its resource happened to be
  documented. `Total` is that count; `Marked least` is the strict subset the reference
  actually marks.
- **`All` is reported beside it**, because a scope that is never the minimum but is always
  sufficient is a different proposition from one that is the documented minimum, and only the
  two columns together tell them apart.
- **Depth is literal segments**, so `/users` and `/users/{id}` are both depth 1. Shallow is one
  or two segments, deep is 3 or more. The join covers 62% of real GET reads at one or two
  segments and 0.7% at six, which is most of Graph and none of the traffic, so shallow
  coverage is the sort key and total coverage is only the tiebreak.
- **Read scopes only**, by `classifyScope` imported from `src/core/auth/scopes.ts`. An
  unclassified name counts as a write and is absent here.

## The population

| | |
|---|---:|
| Delegated GET paths the index carries scopes for | 2,801 |
| …of those, at one or two literal segments | 693 |
| Read scopes the index mentions | 281 |
| …of those, reaching at least one delegated GET path | 222 |
| …of those, reaching at least one shallow path | 114 |

59 read scopes reach no delegated GET path in the index at all. That is not a claim that
they grant nothing. The permissions join reaches 30% of paths and an absent entry means the
index does not know, so what this says is only that the ranking has nothing to say about them.

## The shortlist: top 60 by shallow-path coverage

| # | Scope | Shallow | Total | Deep | Marked least | All, shallow | All, total |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | `Reports.Read.All` | 102 | 106 | 4 | 106 | 102 | 106 |
| 2 | `DeviceManagementManagedDevices.Read.All` | 52 | 94 | 42 | 94 | 63 | 110 |
| 3 | `User.Read` | 38 | 120 | 82 | 120 | 44 | 129 |
| 4 | `DeviceManagementApps.Read.All` | 36 | 168 | 132 | 168 | 40 | 175 |
| 5 | `DeviceManagementServiceConfig.Read.All` | 27 | 51 | 24 | 51 | 32 | 56 |
| 6 | `Application.Read.All` | 21 | 62 | 41 | 62 | 26 | 75 |
| 7 | `Directory.Read.All` | 21 | 28 | 7 | 25 | 129 | 345 |
| 8 | `DeviceManagementConfiguration.Read.All` | 20 | 66 | 46 | 66 | 108 | 266 |
| 9 | `Policy.Read.All` | 19 | 51 | 32 | 45 | 28 | 81 |
| 10 | `Sites.Read.All` | 16 | 72 | 56 | 72 | 28 | 111 |
| 11 | `Calendars.ReadBasic` | 13 | 59 | 46 | 59 | 14 | 73 |
| 12 | `Files.Read` | 12 | 47 | 35 | 47 | 12 | 47 |
| 13 | `RoleManagement.Read.Directory` | 9 | 33 | 24 | 33 | 14 | 64 |
| 14 | `Device.Read.All` | 9 | 27 | 18 | 27 | 9 | 27 |
| 15 | `Chat.ReadBasic` | 9 | 12 | 3 | 12 | 9 | 15 |
| 16 | `Tasks.Read` | 8 | 65 | 57 | 65 | 8 | 66 |
| 17 | `Contacts.Read` | 8 | 37 | 29 | 37 | 8 | 37 |
| 18 | `OrgContact.Read.All` | 8 | 17 | 9 | 17 | 8 | 17 |
| 19 | `Domain.Read.All` | 8 | 12 | 4 | 12 | 9 | 13 |
| 20 | `IdentityProvider.Read.All` | 8 | 11 | 3 | 11 | 8 | 11 |
| 21 | `GroupSettings.Read.All` | 8 | 9 | 1 | 9 | 8 | 9 |
| 22 | `Place.Read.All` | 8 | 8 | 0 | 8 | 8 | 8 |
| 23 | `EduRoster.ReadBasic` | 6 | 38 | 32 | 38 | 6 | 38 |
| 24 | `Mail.ReadBasic` | 6 | 22 | 16 | 22 | 8 | 30 |
| 25 | `Group.Read.All` | 6 | 21 | 15 | 21 | 51 | 211 |
| 26 | `DeviceManagementRBAC.Read.All` | 6 | 13 | 7 | 13 | 8 | 15 |
| 27 | `Team.ReadBasic.All` | 6 | 11 | 5 | 11 | 6 | 11 |
| 28 | `SearchConfiguration.Read.All` | 6 | 9 | 3 | 9 | 6 | 9 |
| 29 | `SecurityEvents.Read.All` | 6 | 9 | 3 | 9 | 6 | 9 |
| 30 | `OnlineMeetings.Read` | 5 | 8 | 3 | 8 | 5 | 10 |
| 31 | `Channel.ReadBasic.All` | 5 | 8 | 3 | 8 | 5 | 8 |
| 32 | `CloudPC.Read.All` | 4 | 33 | 29 | 33 | 4 | 33 |
| 33 | `GroupMember.ReadBasic.All` | 4 | 25 | 21 | 25 | 8 | 45 |
| 34 | `Bookings.Read.All` | 4 | 23 | 19 | 23 | 4 | 23 |
| 35 | `IdentityUserFlow.Read.All` | 4 | 21 | 17 | 21 | 4 | 21 |
| 36 | `Group-Conversation.Read.All` | 4 | 19 | 15 | 19 | 4 | 19 |
| 37 | `DelegatedAdminRelationship.Read.All` | 4 | 17 | 13 | 17 | 4 | 17 |
| 38 | `ShortNotes.Read` | 4 | 14 | 10 | 14 | 4 | 14 |
| 39 | `SubjectRightsRequest.Read.All` | 4 | 12 | 8 | 12 | 4 | 12 |
| 40 | `AuditLog.Read.All` | 4 | 11 | 7 | 11 | 5 | 13 |
| 41 | `RoleManagementPolicy.Read.Directory` | 4 | 11 | 7 | 11 | 4 | 11 |
| 42 | `EventListener.Read.All` | 4 | 10 | 6 | 10 | 4 | 10 |
| 43 | `CustomSecAttributeDefinition.Read.All` | 4 | 9 | 5 | 9 | 4 | 9 |
| 44 | `User.Read.All` | 4 | 7 | 3 | 7 | 35 | 100 |
| 45 | `IdentityRiskEvent.Read.All` | 4 | 6 | 2 | 6 | 4 | 6 |
| 46 | `LicenseAssignment.Read.All` | 4 | 6 | 2 | 6 | 4 | 6 |
| 47 | `Community.Read.All` | 4 | 4 | 0 | 4 | 4 | 4 |
| 48 | `Chat.Read` | 3 | 19 | 16 | 19 | 12 | 34 |
| 49 | `Policy.Read.AuthenticationMethod` | 3 | 12 | 9 | 12 | 3 | 12 |
| 50 | `ProfilePhoto.Read.All` | 3 | 5 | 2 | 5 | 9 | 15 |
| 51 | `Presence.Read` | 3 | 4 | 1 | 4 | 3 | 4 |
| 52 | `Group.ReadBasic.All` | 3 | 3 | 0 | 3 | 12 | 49 |
| 53 | `User.ReadBasic.All` | 3 | 3 | 0 | 3 | 10 | 20 |
| 54 | `Mail.Read` | 2 | 21 | 19 | 21 | 8 | 43 |
| 55 | `AdministrativeUnit.Read.All` | 2 | 18 | 16 | 18 | 2 | 18 |
| 56 | `PrintJob.ReadBasic` | 2 | 12 | 10 | 12 | 2 | 12 |
| 57 | `GroupMember.Read.All` | 2 | 11 | 9 | 11 | 14 | 60 |
| 58 | `MailboxSettings.Read` | 2 | 10 | 8 | 10 | 2 | 10 |
| 59 | `Printer.Read.All` | 2 | 7 | 5 | 7 | 4 | 13 |
| 60 | `Policy.Read.PermissionGrant` | 2 | 7 | 5 | 7 | 2 | 7 |

## Today's ten shipped read scopes

| Scope | Placement | Shallow | Total | Marked least | All, shallow | All, total |
|---|---:|---:|---:|---:|---:|---:|
| `User.Read` | 3 of 222 | 38 | 120 | 120 | 44 | 129 |
| `User.Read.All` | 44 of 222 | 4 | 7 | 7 | 35 | 100 |
| `Group.Read.All` | 25 of 222 | 6 | 21 | 21 | 51 | 211 |
| `GroupSettings.Read.All` | 21 of 222 | 8 | 9 | 9 | 8 | 9 |
| `Directory.Read.All` | 7 of 222 | 21 | 28 | 25 | 129 | 345 |
| `AdministrativeUnit.Read.All` | 55 of 222 | 2 | 18 | 18 | 2 | 18 |
| `Organization.Read.All` | 70 of 222 | 2 | 3 | 3 | 7 | 11 |
| `Domain.Read.All` | 19 of 222 | 8 | 12 | 12 | 9 | 13 |
| `Application.Read.All` | 6 of 222 | 21 | 62 | 62 | 26 | 75 |
| `Policy.Read.All` | 9 of 222 | 19 | 51 | 45 | 28 | 81 |
| `RoleManagement.Read.Directory` | 13 of 222 | 9 | 33 | 33 | 14 | 64 |
| `RoleManagementPolicy.Read.Directory` | 41 of 222 | 4 | 11 | 11 | 4 | 11 |
| `UserAuthenticationMethod.Read.All` | 141 of 222 | 0 | 4 | 4 | 0 | 59 |
| `IdentityProvider.Read.All` | 20 of 222 | 8 | 11 | 11 | 8 | 11 |
| `IdentityRiskEvent.Read.All` | 45 of 222 | 4 | 6 | 6 | 4 | 6 |
| `IdentityRiskyUser.Read.All` | 63 of 222 | 2 | 6 | 6 | 2 | 6 |
| `AuditLog.Read.All` | 40 of 222 | 4 | 11 | 11 | 5 | 13 |
| `Reports.Read.All` | 1 of 222 | 102 | 106 | 106 | 102 | 106 |
| `SecurityEvents.Read.All` | 29 of 222 | 6 | 9 | 9 | 6 | 9 |
| `DelegatedAdminRelationship.Read.All` | 37 of 222 | 4 | 17 | 17 | 4 | 17 |
| `Device.Read.All` | 14 of 222 | 9 | 27 | 27 | 9 | 27 |
| `DeviceManagementManagedDevices.Read.All` | 2 of 222 | 52 | 94 | 94 | 63 | 110 |
| `DeviceManagementConfiguration.Read.All` | 8 of 222 | 20 | 66 | 66 | 108 | 266 |
| `DeviceManagementApps.Read.All` | 4 of 222 | 36 | 168 | 168 | 40 | 175 |
| `DeviceManagementServiceConfig.Read.All` | 5 of 222 | 27 | 51 | 51 | 32 | 56 |
| `DeviceManagementRBAC.Read.All` | 26 of 222 | 6 | 13 | 13 | 8 | 15 |
| `SharePointTenantSettings.Read.All` | 183 of 222 | 0 | 1 | 1 | 0 | 1 |

**The ranking would drop 4 of the ten we ship today**: `Organization.Read.All`, `UserAuthenticationMethod.Read.All`, `IdentityRiskyUser.Read.All`, `SharePointTenantSettings.Read.All`.
This is exactly the failure #49 names — ranking alone drops scopes used weekly. A scope
earns its place by what an assessment reads, and the index can only score what Microsoft's
reference documented.

## Sufficient everywhere, the documented minimum nowhere

These read scopes unlock nothing under the sort key, because every shallow path that names
them also names something narrower as its minimum. They score zero and sort last, and a
ranking read without this section would look like it had dismissed them.

| Scope | All, shallow | All, total |
|---|---:|---:|
| `ChannelSettings.Read.All` | 5 | 8 |
| `TeamSettings.Read.All` | 5 | 9 |
| `RoleManagement.Read.All` | 4 | 42 |
| `Presence.Read.All` | 3 | 4 |
| `AgreementAcceptance.Read.All` | 2 | 6 |
| `Calendars.Read.Shared` | 2 | 8 |
| `ExternalConnection.Read.All` | 2 | 5 |
| `People.Read.All` | 2 | 4 |
| `PrintAlertSettings.Read.All` | 2 | 6 |
| `PrintJob.Read.All` | 2 | 14 |
| `PrintJob.ReadBasic.All` | 2 | 12 |
| `PrintSettings.Read.All` | 2 | 6 |
| `Group-XTenantIdentitySync.Read.All` | 1 | 1 |
| `LearningSelfInitiatedCourse.Read` | 1 | 4 |
| `OrganizationalBranding.Read.All` | 1 | 4 |

## The ceiling arithmetic

Entra caps a delegated consent request at about 155 permissions (ADR-0012).

| | Scopes | Against the ceiling |
|---|---:|---|
| The shortlist, as a read template | 60 | 95 names of headroom |
| The shortlist doubled, worst-case read-write | 120 | 35 names of headroom |
| The shortlist plus only the counterparts the index holds today | 114 | 41 names of headroom |
| Today's shipped read template | 27 | 128 names of headroom |

The doubled figure is the worst case on purpose. It assumes every shortlisted read scope has
a `ReadWrite` counterpart worth asking for, which is not true today: `AuditLog` has none
because Graph consumers cannot write append-only records, and `scopes.ts` already filters the
derivation against the index, which holds 54 of the 60. A list that fits only while that
derivation stays partial is a list that breaks the first time Microsoft publishes a
counterpart, so the worst case is the number a pick has to clear.

