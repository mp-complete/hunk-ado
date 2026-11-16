import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { join } from "node:path";

/** Own only directories we created; keep patches until Hunk has finished reviewing. */
export class TemporaryPatchStore {
  readonly root: string;
  readonly directories = new Set<string>();
  constructor(root: string) { this.root = root; }

  async create(): Promise<string> {
    const directory = await mkdtemp(join(this.root, "hunk-ado-"));
    this.directories.add(directory);
    try {
      await chmod(directory, 0o700);
      await mkdir(join(directory, "empty-hooks"), { mode: 0o700 });
      return directory;
    } catch (error) { await this.remove(directory); throw error; }
  }

  async write(directory: string, patch: Uint8Array): Promise<string> {
    if (!this.directories.has(directory)) throw new Error("Unowned temporary directory.");
    const path = join(directory, "review.diff");
    await writeFile(path, patch, { flag: "wx", mode: 0o600 });
    return path;
  }

  async remove(directory: string): Promise<void> {
    if (!this.directories.has(directory)) return;
    await rm(directory, { recursive: true, force: true });
    this.directories.delete(directory);
  }

  cleanup(): void {
    for (const directory of this.directories) {
      try {
        rmSync(directory, { recursive: true, force: true });
        this.directories.delete(directory);
      } catch { /* Best effort; never prevent remaining directories from being cleaned. */ }
    }
  }
}
