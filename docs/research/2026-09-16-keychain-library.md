# Picking a keychain library for the app-only secret

Research note, 2026-09-16. Answers the spec's open item "Pick the keychain library. The original `keytar` package is no longer maintained." App-only connections store a client secret or certificate password, and the model is never in that loop, so the store has to be the OS keychain rather than a file we manage. Version numbers and publish dates below were read from the npm registry and the GitHub API on 2026-09-16 and go stale quickly.

## The finding that reframes the question

**`keytar` is already in this repo's dependency tree and cannot be removed.** `@azure/msal-node-extensions@5.5.1` declares `keytar: "^7.8.0"` as a mandatory, non-optional dependency, and `npm ls` confirms `keytar@7.9.0` installed today. Its GitHub repository has been archived since 2022.

So the decision is not "avoid keytar". It is "what does our own code call", with keytar present either way. Only Microsoft can take it out of the tree.

`@azure/msal-node-extensions` does export enough to store an arbitrary secret: `KeychainPersistence`, `LibSecretPersistence`, `FilePersistenceWithDataProtection`, `PersistenceCreator`, and an `IPersistence` interface that is `save(contents: string)` / `load(): Promise<string | null>`, not MSAL-cache-shaped. But its macOS and Linux classes are thin wrappers that call `keytar.setPassword` directly; only the Windows path avoids it, through Microsoft's own DPAPI binary. Using them would mean building a new feature on the archived package rather than merely tolerating it.

## Candidates

| Package | Version | Last activity | Install cost | Linux backend |
|---|---|---|---|---|
| `@napi-rs/keyring` | 2.1.0 | published 2026-09-13 | prebuilt binaries as per-platform `optionalDependencies`, 12 targets, no compile | Secret Service over D-Bus implemented in Rust, no `libsecret` needed, falls back to kernel `keyutils` |
| `@github/keytar` | 7.10.6 | repo pushed 2026-09-10 | prebuilds bundled inside the tarball, no network fetch | same `libsecret` linkage as keytar |
| `keytar` | 7.9.0 | repo archived 2022 | prebuilds fetched by `prebuild-install` | `libsecret` |
| msal-node-extensions' own classes | 5.5.1 | — | no new dependency | keytar underneath |
| `cross-keychain` | 1.1.0 | 2025-10-07, single maintainer | no native code at all | shells out to `secret-tool`, which must already be on the host |

Ruled out: `keyv` has no OS-keychain adapter in any `@keyv/*` package; the `secret-service` name now belongs to an unrelated package; `keychain` is macOS-only.

## Recommendation

`@napi-rs/keyring`, called directly from our own code, with `@azure/msal-node-extensions` left doing only what it is for, the MSAL token cache.

- It is the only candidate with activity inside the last week, against keytar's upstream being archived for four years.
- No compile step on any common platform, which keeps the one-line `npx` install working on a machine with no build tools. Each platform binary is hundreds of KB against the 109 MB `workerd` binary miniflare already ships, so the footprint argument is noise here.
- On Linux it needs no `libsecret` at runtime and degrades to kernel `keyutils` on a headless box instead of hard-failing, which matters because assessments get run from CI and containers.

`cross-keychain` is the only genuinely native-code-free option, but its Linux path depends on `secret-tool` being installed on the host, which a bare `npx` invocation cannot guarantee.
