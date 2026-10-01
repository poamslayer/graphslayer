import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveCloud, type Cloud } from "../config.js";
import type { Connection, ConnectionMode } from "../types.js";

interface FileShape {
  version: 1;
  connections: Connection[];
}

/**
 * The one place that decides what an absent mode means, so no caller ever reads
 * `connection.mode` and picks its own answer.
 *
 * Absence means read, and it has to. Every connection stored before modes existed has no such
 * field, and a default of write would hand each of them the power to change a directory they
 * were never added to change. The safe direction is the one where a record we cannot interpret
 * does less rather than more. ADR-0012.
 */
export function modeOf(connection: Pick<Connection, "mode">): ConnectionMode {
  return connection.mode ?? "read";
}

/**
 * The matching compatibility rule for the cloud field. A legacy record can only have been used
 * with the commercial endpoints, so absence preserves its old meaning without rewriting the
 * person's connections file. ADR-0013.
 */
export function cloudOf(connection: Pick<Connection, "cloud">): Cloud {
  return resolveCloud(connection.cloud);
}

export class ConnectionStore {
  constructor(private readonly file: string) {}

  async list(): Promise<Connection[]> {
    return (await this.read()).connections;
  }

  /** Accepts an alias or a tenant id. */
  async resolve(key: string): Promise<Connection | undefined> {
    const all = await this.list();
    return all.find((c) => c.alias === key) ?? all.find((c) => c.tenantId === key);
  }

  async upsert(connection: Connection): Promise<void> {
    const data = await this.read();
    const rest = data.connections.filter((c) => c.alias !== connection.alias);
    await this.write({ version: 1, connections: [...rest, connection] });
  }

  async remove(alias: string): Promise<boolean> {
    const data = await this.read();
    const rest = data.connections.filter((c) => c.alias !== alias);
    if (rest.length === data.connections.length) return false;
    await this.write({ version: 1, connections: rest });
    return true;
  }

  private async read(): Promise<FileShape> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<FileShape>;
      return { version: 1, connections: Array.isArray(parsed.connections) ? parsed.connections : [] };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, connections: [] };
      throw err;
    }
  }

  private async write(data: FileShape): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.file, JSON.stringify(data, null, 2), { mode: 0o600 });
  }
}
