import { describe, it, expect, vi } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { promptSecret } from "../../src/cli/prompt.js";

function sink() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  return { stream, text: () => chunks.join("") };
}

/** A readable that can claim to be a terminal, so raw mode can be exercised off a real TTY. */
function fakeInput(opts: { tty?: boolean } = {}) {
  const stream = new PassThrough() as PassThrough & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (m: boolean) => void };
  const setRawMode = vi.fn((mode: boolean) => {
    stream.isRaw = mode;
  });
  if (opts.tty) {
    stream.isTTY = true;
    stream.isRaw = false;
    stream.setRawMode = setRawMode;
  }
  return { stream, setRawMode };
}

describe("promptSecret", () => {
  it("writes the prompt to the output stream and nothing to stdout", async () => {
    const input = fakeInput();
    const output = sink();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const promise = promptSecret("Client secret: ", { input: input.stream, output: output.stream });
    input.stream.write("hunter2\n");

    await expect(promise).resolves.toBe("hunter2");
    expect(output.text()).toContain("Client secret: ");
    expect(stdout).not.toHaveBeenCalled();
    stdout.mockRestore();
  });

  it("returns the secret without its newline and without touching inner spaces", async () => {
    const input = fakeInput();
    const output = sink();

    const promise = promptSecret("Secret: ", { input: input.stream, output: output.stream });
    input.stream.write("  a b  c \n");

    await expect(promise).resolves.toBe("  a b  c ");
  });

  it("rejects an empty secret", async () => {
    const input = fakeInput();
    const output = sink();

    const promise = promptSecret("Secret: ", { input: input.stream, output: output.stream });
    input.stream.write("\n");

    await expect(promise).rejects.toThrow("No credential was entered.");
  });

  it("suppresses echo on a terminal and restores the mode afterwards", async () => {
    const input = fakeInput({ tty: true });
    const output = sink();

    const promise = promptSecret("Secret: ", { input: input.stream, output: output.stream });
    // A terminal in raw mode ends the line with a carriage return, not a newline.
    input.stream.write("s3cret\r");

    await expect(promise).resolves.toBe("s3cret");
    expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(output.text()).not.toContain("s3cret");
  });

  it("restores raw mode even when the read throws", async () => {
    const input = fakeInput({ tty: true });
    const output = sink();

    const promise = promptSecret("Secret: ", { input: input.stream, output: output.stream });
    input.stream.emit("error", new Error("stdin exploded"));

    await expect(promise).rejects.toThrow("stdin exploded");
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it("leaves echo alone when the input is not a terminal", async () => {
    const input = fakeInput();
    const output = sink();

    const promise = promptSecret("Secret: ", { input: input.stream, output: output.stream });
    input.stream.write("piped\n");

    await expect(promise).resolves.toBe("piped");
    expect(input.setRawMode).not.toHaveBeenCalled();
  });
});
