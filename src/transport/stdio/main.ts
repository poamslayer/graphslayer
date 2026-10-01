import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MsalAuthImpl, makeRealPcaFactory } from "../../core/auth/msal.js";
import { resolveConfig } from "../../core/config.js";
import { ConnectionStore } from "../../core/connections/store.js";
import { GraphClient } from "../../core/graph/client.js";
import { createIndexLoader } from "../../core/index/loader.js";
import { KeyringSecretStore } from "../../core/secrets/keychain.js";
import { createServer } from "../../core/server.js";
import { MiniflareSandbox } from "./miniflare-sandbox.js";

export async function buildDeps() {
  const config = resolveConfig();
  const store = new ConnectionStore(config.connectionsFile);
  // One store for the whole process. The auth layer reads an app-only credential back out of it
  // on every token request, and the connection tools clear the entry when a connection goes.
  const secrets = new KeyringSecretStore();
  const auth = new MsalAuthImpl({
    clientId: config.clientId,
    pcaFactory: await makeRealPcaFactory(config),
    secrets,
    // A refreshed token that carries scopes granted outside the server updates the record, so
    // connections_list matches the token and the next silent request names the new scopes (#73).
    onScopesChanged: (connection, scopes) => store.upsert({ ...connection, scopes }),
  });
  // One loader for the whole server. The Graph client reads the index to decide the consistency
  // header and to answer a 404, and search reads it to build its sandbox; two loaders would
  // parse the same cloud's megabytes twice and hold both copies.
  const index = createIndexLoader();
  const client = new GraphClient(auth, { index });
  // The runtime is started on the first run, so the CLI commands never spawn workerd.
  const sandbox = new MiniflareSandbox();
  // The second sandbox, for index runs. Built without the Graph service binding, so it has no
  // network at all, and with the index as its preamble (ADR-0008). It is built on the first
  // index run and not before, so a server that only answers queries never pays for it.
  let builtIndexSandbox: MiniflareSandbox | undefined;
  const indexSandbox = ({ preamble }: { preamble: string }) =>
    (builtIndexSandbox ??= new MiniflareSandbox({ graphServiceBinding: false, preamble }));
  const dispose = async () => {
    await Promise.all([sandbox.dispose(), builtIndexSandbox?.dispose()]);
  };
  return { config, store, auth, secrets, client, index, sandbox, indexSandbox, dispose };
}

export async function startStdioServer(): Promise<void> {
  const deps = await buildDeps();
  const server = createServer(deps);
  const transport = new StdioServerTransport();

  // Called from several places that can race: two signals, or a signal arriving while stdin is
  // closing. Disposing twice is harmless but exiting twice is not, so the first caller wins.
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void deps.dispose().finally(() => process.exit(0));
  };

  transport.onclose = shutdown;
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  /**
   * The client going away without killing us.
   *
   * `StdioServerTransport.start` listens for `data` and `error` on stdin and nothing else, so
   * end of input never reaches `transport.onclose`. Without these two lines a client that simply
   * closes the pipe leaves this process running for the rest of the session, holding a `workerd`
   * child that measured at over a hundred megabytes. Verified by probing the built server: after
   * closing stdin, both the server and its runtime were still alive.
   *
   * `end` is the normal case and `close` covers a pipe that goes away without a clean EOF.
   * `shutdown` is idempotent, so hearing both costs nothing.
   */
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);

  await server.connect(transport);
  // Never write to stdout here. Stdout is the MCP channel.
  process.stderr.write(`graphslayer ready. Home: ${deps.config.homeDir}\n`);
}
