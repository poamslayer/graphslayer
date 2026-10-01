/**
 * Reading a credential from the terminal, which is the only way one enters this server.
 *
 * ADR-0007 says no tool argument ever carries a secret, so there is no flag for the credential
 * either: a flag would put it in the shell history and in the process list, which is the same
 * mistake one layer down.
 */

export interface PromptIo {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/** A readable that is also a terminal. Narrowed by hand so a fake stream can stand in for one. */
type MaybeTty = NodeJS.ReadableStream & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  setEncoding?: (encoding: BufferEncoding) => unknown;
};

/**
 * Prompts on stderr and returns what was typed, with nothing echoed.
 *
 * The prompt goes to stderr because stdout is reserved: the same binary speaks MCP over stdout,
 * and anything piping this command would read the prompt as protocol. See the comment at the end
 * of `src/transport/stdio/main.ts`.
 */
export async function promptSecret(prompt: string, io: PromptIo = {}): Promise<string> {
  const input = (io.input ?? process.stdin) as MaybeTty;
  const output = io.output ?? process.stderr;

  output.write(prompt);

  // Echo is suppressed by raw mode, which only exists on a terminal. When this is not a terminal
  // the caller has deliberately piped the credential in and there is nothing to echo anyway.
  const raw = input.isTTY === true && typeof input.setRawMode === "function";
  const wasRaw = input.isRaw === true;
  if (raw) input.setRawMode?.(true);
  try {
    const secret = await readUntilNewline(input, raw);
    if (!secret) throw new Error("No credential was entered.");
    return secret;
  } finally {
    // Restoring here rather than after a successful read, because a command that throws and
    // leaves the terminal with echo off is a bug people remember long after the error scrolls away.
    if (raw) input.setRawMode?.(wasRaw);
    // The newline the terminal did not echo, so the next line does not start beside the prompt.
    output.write("\n");
  }
}

/**
 * Collects characters up to the first newline.
 *
 * Only the trailing newline is removed. A credential may legitimately contain spaces, so
 * trimming the value would corrupt secrets that happen to start or end with one.
 */
function readUntilNewline(input: MaybeTty, raw: boolean): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buffer = "";
    input.setEncoding?.("utf8");

    const cleanup = () => {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      input.pause?.();
    };
    const onData = (chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const ch of text) {
        // A terminal in raw mode ends a line with a carriage return; a pipe ends it with \n.
        if (ch === "\r" || ch === "\n") {
          cleanup();
          resolve(buffer);
          return;
        }
        if (raw) {
          // Raw mode turns off the line editing the terminal would otherwise do for us, so the
          // two keys a person reaches for while typing a long secret have to be handled here.
          if (ch === "") {
            cleanup();
            reject(new Error("Cancelled."));
            return;
          }
          if (ch === "" || ch === "\b") {
            buffer = buffer.slice(0, -1);
            continue;
          }
        }
        buffer += ch;
      }
    };
    const onEnd = () => {
      cleanup();
      resolve(buffer);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
    input.resume?.();
  });
}
