import { checkForUpdate, isStandaloneBinary, loadConfig } from "@alden/core";

/** "alden 0.3.0 is out (you have 0.2.0). …how to upgrade…", or undefined when current, off, or unknown. */
export async function updateNotice(current: string): Promise<string | undefined> {
  if (process.env.ALDEN_NO_UPDATE_CHECK) return undefined;
  const config = await loadConfig().catch(() => undefined);
  if (config && !config.updates.check) return undefined;
  const newest = await checkForUpdate(current);
  if (!newest) return undefined;
  const how = isStandaloneBinary()
    ? "Run `brew upgrade alden`, or download it from https://github.com/getalden/homebrew-tap/releases."
    : `Run \`npm install -g alden@${newest.includes("-") ? "next" : "latest"}\`.`;
  return `alden ${newest} is out (you have ${current}). ${how} Turn this off with \`alden config set updates.check false\`.`;
}
