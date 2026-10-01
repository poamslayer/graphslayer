# Renamed graphslayer, and published from a fresh public repo

The project is now **graphslayer**: the npm package, the command, the GitHub repo
`poamslayer/graphslayer`, the User-Agent (`graphslayer/<version>`), the home folder
(`~/.graphslayer`), the environment variables (`GRAPHSLAYER_HOME`, `GRAPHSLAYER_CLIENT_ID`,
`GRAPHSLAYER_NO_TOKEN_CACHE`) and the keychain service (`graphslayer`). Arnold chose the name on
2026-10-01. It belongs to the POAMSlayer brand and names what the server is about, which sets it
apart from Lokka, the Graph MCP server it is most often compared with.

Nothing had ever been published, and Arnold was the only one with an install, so there is no
migration code. His connections and keychain entries were moved by hand.

## Why a fresh repo

The package is public on npm, so the source should be public too. It is also needed for npm
provenance, and for the links on the npm page to open. The original repo, `poamslayer/ms-graph-mcp`,
could not simply be made public. A personal email address is on 25 of its commits, and GitHub
keeps every pull request's original commits after `main` is rewritten. The commits in 42 of its
pull requests carry that address. So the public repo starts from one snapshot commit made with
the GitHub noreply address. The private repo keeps the full history, pull requests and issues,
which the ADRs before this one refer to by number.

## Consequences

- Issue and pull request numbers in ADR-0001 to ADR-0017 refer to the private repo.
- Releases publish from GitHub Actions over npm trusted publishing (`.github/workflows/publish.yml`),
  with provenance, once the first version is on npm. The first version is published by hand.
- ADRs and notes written before this keep the old name, as they were written.
