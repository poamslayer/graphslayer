import { promises as fs } from "node:fs";
import path from "node:path";
import type { SecretStore } from "./keychain.js";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * Keeps secrets in one JSON file only its owner can read, for hosts with no unlocked keychain.
 * Opt-in through GRAPHSLAYER_SECRET_STORE=file, never a fallback. ADR-0019.
 *
 * Every write goes to a temporary file that is renamed over the old one, so a crash mid-write
 * leaves the previous file whole. The mode is set on every write, not only on creation, so a
 * file someone loosened by hand is tightened again the next time a secret changes.
 */
export class FileSecretStore implements SecretStore {
  constructor(private readonly file: string) {}

  async set(account: string, secret: string): Promise<void> {
    const all = await this.read();
    all[account] = secret;
    await this.write(all);
  }

  async get(account: string): Promise<string | undefined> {
    return (await this.read())[account];
  }

  async delete(account: string): Promise<boolean> {
    const all = await this.read();
    if (!(account in all)) return false;
    delete all[account];
    await this.write(all);
    return true;
  }

  private async read(): Promise<Record<string, string>> {
    let text: string;
    try {
      text = await fs.readFile(this.file, "utf8");
    } catch (err) {
      // No file yet means nothing is stored, which is not an error.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
    return JSON.parse(text) as Record<string, string>;
  }

  private async write(all: Record<string, string>): Promise<void> {
    const dir = path.dirname(this.file);
    await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
    await fs.chmod(dir, DIR_MODE);
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(all, null, 2), { mode: FILE_MODE });
    await fs.chmod(tmp, FILE_MODE);
    await fs.rename(tmp, this.file);
  }
}
