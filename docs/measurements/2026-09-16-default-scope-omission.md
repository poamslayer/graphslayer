# What `.default` leaves out of a delegated token

Measurement, 2026-09-16. Answers #42: a scope consented through `connection_add` was reported
as present by `connections_list` and Graph kept answering 403 for it. Probed against a live
tenant (`bddd94e7-…`, delegated, the shared Microsoft Graph Command Line Tools app of ADR-0003)
with the real MSAL and the real stored connection.

## What the tokens actually carried

Two connections, the same signed-in account, the same tenant. Both records listed
`DeviceManagementConfiguration.Read.All` in `connection.scopes`, consented interactively the
same day.

| request `getGraphToken` makes | scopes in the token's `scp` claim | `DeviceManagementConfiguration.Read.All` present |
|---|---|---|
| `https://graph.microsoft.com/.default`, which is what the code did | 22 | **no** |
| the connection's own stored scopes, by name | 23 | **yes** |
| the connection's own scopes with `forceRefresh` | 23 | yes |

Every other scope was identical across all three. The one scope that was missing is the one
that had just been consented, and asking for it by name is what put it in the token.
`forceRefresh` changed nothing beyond the scoped request, so it is not part of the fix: it
would cost a network round trip on every call and buy nothing.

## Why, and why not for the reason the issue guessed

#42 suspected MSAL's scope-keyed access-token cache was returning a token minted before the
consent. That is not the mechanism.

`@azure/msal-common`'s `CacheManager.matchTarget` matches a cached access token when the
entity's `target` — the scope list the **server returned** — contains the requested scope set.
A `.default` request looks for a cached target containing the literal string
`https://graph.microsoft.com/.default`, and Entra never returns that string as a granted scope.
So a `.default` request misses the cache every time and always goes to the refresh token. The
token was not stale.

What `.default` means is the application's **statically configured** permissions. ADR-0003 has
us on Microsoft's shared Graph Command Line Tools registration precisely because it is already
consented in most tenants, and a permission a user consents to dynamically is not in that
registration's static list. So `.default` asks for the registration's set and gets it, and the
dynamically consented scope is simply not in the answer.

This is worth writing down because the wrong explanation is the plausible one. "MSAL cached it"
predicts that waiting for the token to expire fixes it. It does not, and someone will
eventually wait.

## What changed

`getGraphToken` asks for the connection's own scopes, dropping the OIDC reserved names
(`openid`, `profile`, `email`, `offline_access`) which are not Graph resource scopes, and falls
back to `.default` only when a connection records no scopes at all. `signInDelegated` records
the `scp` claim of the token it actually received rather than the scope list the consent
reported, so `connections_list` cannot claim a scope the token does not carry.

App-only connections are untouched and must stay untouched: the client credentials flow has no
legal request but `.default`.
