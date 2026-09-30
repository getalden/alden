import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { aldenHome } from "../config.js";

type Usage = { repos: Record<string, string> };

/**
 * When Alden was first used on each repo, so `alden stats` can split before from after. Kept in ~/.alden/usage.json;
 * only the first date per repo is ever written.
 */
export class UsageLog {
  constructor(private readonly path: string = join(aldenHome(), "usage.json")) {}

  private async read(): Promise<Usage> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<Usage>;
      return { repos: parsed.repos && typeof parsed.repos === "object" ? parsed.repos : {} };
    } catch {
      return { repos: {} };
    }
  }

  /** Notes a use of `repo` ("owner/name"), keeping the earliest. */
  async markUsed(repo: string, at: Date = new Date()): Promise<void> {
    const key = repo.toLowerCase();
    const usage = await this.read();
    if (usage.repos[key]) return;
    usage.repos[key] = at.toISOString();
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(usage, null, 2)}\n`, "utf8");
  }

  async firstUse(repo: string): Promise<Date | undefined> {
    const at = (await this.read()).repos[repo.toLowerCase()];
    return at ? new Date(at) : undefined;
  }
}
