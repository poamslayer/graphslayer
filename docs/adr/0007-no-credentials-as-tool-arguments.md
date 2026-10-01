# No tool accepts a token, secret, or certificate password

There is no tool that takes a bearer token or a client secret as an argument, and there never will be. Anything the model writes into a tool argument passes through the conversation and the client, which the MCP specification says credentials must never do. Delegated sign-in happens in the browser, and app-only credentials are entered through a terminal command a person runs, then stored in the operating system keychain. Lokka ships a `set-access-token` tool; we deliberately do not.

## Consequences

Adding an app-only connection cannot be done from inside a chat. That is the point.
