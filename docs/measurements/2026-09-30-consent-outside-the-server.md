# A scope granted outside the server waits for the cached token to expire

Measurement, 2026-09-30. Answers #73, which suspected a regression of #42 because a newly added
scope did not take effect. It was not a regression. Probed against the live tenant (`bddd94e7-…`,
delegated, the shared Microsoft Graph Command Line Tools app of ADR-0003) on `main` at `cf3ae63`,
with a fresh build.

## How it was measured

- A new connection, `probe73`, was added with `connection_add` and the explicit scope `User.Read`.
- Scope B was `Agreement.Read.All`, which this app had not been granted in this tenant.
- The test path was `GET /identityGovernance/termsOfUse/agreements`, which needs B.
- A probe script used the server's own code. It built the PCA with `makeRealPcaFactory`, asked
  `acquireTokenSilent` for `graphScopesForConnection(connection.scopes)`, decoded the `scp` claim,
  and called the path. Each run was a new process, so each run also stands in for a restart.
- B was granted through a plain `/authorize` consent prompt for the same client id, opened in the
  browser. The server's token cache took no part in the grant.

`/sites/root` was tried first and dropped, because it answered 200 without `Sites.Read.All`.

## What the tokens carried

| When | `fromCache` | token expiry (UTC) | B in `scp` | status |
|---|---|---|---|---|
| Before consent | true | 01:08:55 | no | 403, names `Agreement.Read.All` |
| Right after consent | true | 01:08:55 | no | 403 |
| New process (restart) | true | 01:08:55 | no | 403 |
| `forceRefresh`, same stored scopes | false | 01:41:47 | yes | 200 |
| Next normal call | true | 01:41:47 | yes | 200 |

## Why

`@azure/msal-common` 16.14.1 looks up a cached access token in `CacheManager.getAccessToken`, and
`matchTarget` accepts a cached token whose scopes contain every scope asked for. The server asks
for the connection's stored scopes. B is not stored, so the token cached before the consent still
contains everything asked for, and MSAL returns it until it expires. That can be 60 to 90
minutes. The cache is persisted in the keychain, so a restart returns the same token.

When the server does get a token from Entra, Entra puts every scope granted to the app in it,
including B, although B was not asked for by name. So the grant takes effect once the old token
expires. That is why the problem appeared and then went away before anyone could record it.

This is the stale cache that #42 suspected and ruled out for its own case. In #42 the token was
never stale. `.default` missed the cache on every call, and Entra left the dynamically consented
scope out of the answer. Here the scope is named nowhere in the request, so the cache answers.

## Paths through `connection_add`

A new sign-in through `connection_add`, for the same alias or a new one, was not tested live.
Reading the same package, `accessTokenKeyMatchesFilter` with `keyMustContainAllScopes` set to false
removes every cached access token for the account that shares any scope with the token being
saved. So a new sign-in replaces the old token, and the next call uses the new one.

## What changed

- `MsalAuthImpl.refreshGraphToken` asks for a token with `forceRefresh` and returns it only when it
  carries scopes the connection did not record. It asks at most once per connection per minute,
  so a script that hits many genuine 403s costs one round trip to Entra.
- `GraphClient` calls it once after a 403 on a delegated connection, and retries the request with
  the new token when one comes back. A `$batch` whose entries include a 403 is sent once more on
  the same rule. Graph refused the request, so a retry cannot repeat a write.
- When the token gained scopes, the stored connection's `scopes` are updated from its `scp`, so
  `connections_list` lists them and the next silent request names them.

App-only connections are untouched. Client credentials have no consent step, and `.default`
already returns every role the app holds.

## Verified live after the fix

Same tenant, rebuilt server, MCP reconnected, 2026-10-01 00:25 to 00:28 UTC.

- Outside the server. Scope C was `EntitlementManagement.Read.All` on
  `/identityGovernance/entitlementManagement/accessPackages`. Before consent, `graph_run` got 403.
  The first `graph_run` after consent got 200, and the stored record for `probe73` listed C. The
  baseline 403 also added `Agreement.Read.All` to the record, because the refresh it triggered
  returned a token carrying that scope from the first measurement.
- Through `connection_add`. Scope D was `LifecycleWorkflows.Read.All`, added on a new alias,
  `probe73b`. The token for `probe73b` carried D. The cached token for the old alias `probe73`
  also carried D with no refresh, which confirms the reading of `accessTokenKeyMatchesFilter`
  above. The path itself still answered 403, now "Insufficient license" instead of "Insufficient
  privileges", because the tenant has no Entra ID Governance license.

One gap remains. In the second case the record for `probe73` did not list D, because no refresh
ran for it. The record lists fewer scopes than the token, which is the safe direction, and it
catches up on the next refresh that gains a scope.

## Other findings

- The tenant has a Conditional Access sign-in frequency policy that limits refresh tokens to 7
  days (AADSTS70043). Connections older than that fail with "Token refresh failed" until someone
  runs `connection_add` again.
- The stale local `dist/` named in #73 was not the cause. The #42 fix was in the running build.
