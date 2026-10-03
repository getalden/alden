import { createInterface } from "node:readline";
import {
  createGitHubClient,
  DefaultCredentialStore,
  getViewer,
  ghCliToken,
  githubClientId,
  pollForToken,
  requestDeviceCode,
  resolveToken,
  type TokenSource,
  type Viewer,
} from "@alden/core";
import type { Command } from "commander";
import { openInBrowser } from "./open.js";

const SOURCE_LABEL: Record<TokenSource, string> = {
  env: "ALDEN_GITHUB_TOKEN",
  alden: "Alden's own sign-in",
  gh: "your GitHub CLI sign-in",
};

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

function scopeWarning(viewer: Viewer): string | undefined {
  if (viewer.missingScopes.length === 0) return undefined;
  return `Warning: this token is missing ${viewer.missingScopes.join(", ")}. Alden may not see private repos or team review requests.`;
}

export function registerAuthCommand(program: Command): void {
  const auth = program.command("auth").description("Sign in to GitHub.");

  auth
    .command("login")
    .description("Sign in to GitHub. Reuses the GitHub CLI's sign-in if there is one.")
    .option("--device", "sign in with a code in your browser, even if the GitHub CLI is signed in")
    .option("--with-token", "read a token from standard input")
    .action(async (options: { device?: boolean; withToken?: boolean }) => {
      const store = new DefaultCredentialStore();

      if (options.withToken) {
        const token = await readStdin();
        if (!token) program.error("No token on standard input.");
        const viewer = await getViewer(createGitHubClient(token)).catch(() =>
          program.error("GitHub rejected that token."),
        );
        await store.set(token);
        console.log(`Signed in to github.com as @${viewer.login}.`);
        const warning = scopeWarning(viewer);
        if (warning) console.warn(warning);
        return;
      }

      if (!options.device) {
        const token = await ghCliToken();
        if (token) {
          const viewer = await getViewer(createGitHubClient(token));
          console.log(`Using your GitHub CLI sign-in as @${viewer.login}. Nothing new was stored.`);
          console.log("To sign in to Alden separately, run `alden auth login --device`.");
          const warning = scopeWarning(viewer);
          if (warning) console.warn(`${warning} Fix it with \`gh auth refresh -s read:org\`.`);
          return;
        }
      }

      let clientId: string;
      try {
        clientId = githubClientId();
      } catch (error) {
        program.error((error as Error).message);
      }
      const code = await requestDeviceCode(clientId);
      console.log(`Your one-time code: ${code.userCode}`);
      // In a terminal, Enter opens the page while Alden keeps waiting for the approval, as `gh auth login` does.
      const interactive = process.stdin.isTTY && process.stdout.isTTY;
      const prompt = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
      if (prompt) {
        console.log(`Press Enter to open ${code.verificationUri} in your browser, then enter the code there.`);
        prompt.once("line", () => {
          openInBrowser(code.verificationUri, `Couldn't open a browser. Go to ${code.verificationUri}.`);
          console.log("Waiting for you to approve it in the browser…");
        });
      } else {
        console.log(`Open ${code.verificationUri} and enter the code.`);
        console.log("Waiting for you to approve it in the browser…");
      }
      try {
        const token = await pollForToken(clientId, code).finally(() => prompt?.close());
        const viewer = await getViewer(createGitHubClient(token));
        await store.set(token);
        console.log(`Signed in to github.com as @${viewer.login}.`);
      } catch (error) {
        program.error((error as Error).message);
      }
    });

  auth
    .command("status")
    .description("Show which GitHub account Alden is using and where the token comes from.")
    .action(async () => {
      const resolved = await resolveToken();
      if (!resolved) {
        program.error("Not signed in. Run `alden auth login`.");
      }
      try {
        const viewer = await getViewer(createGitHubClient(resolved.token));
        console.log(`Signed in to github.com as @${viewer.login}, using ${SOURCE_LABEL[resolved.source]}.`);
        if (viewer.scopes.length > 0) console.log(`Token scopes: ${viewer.scopes.join(", ")}`);
        const warning = scopeWarning(viewer);
        if (warning) console.warn(warning);
      } catch {
        const fix = resolved.source === "env" ? "Fix or unset ALDEN_GITHUB_TOKEN." : "Run `alden auth login`.";
        program.error(`The token from ${SOURCE_LABEL[resolved.source]} was rejected by GitHub. ${fix}`);
      }
    });

  auth
    .command("logout")
    .description("Remove the token Alden stored. Doesn't touch the GitHub CLI's sign-in.")
    .action(async () => {
      await new DefaultCredentialStore().delete();
      console.log("Removed Alden's stored GitHub token.");
      const remaining = await resolveToken();
      if (remaining) {
        console.log(`Alden will still use ${SOURCE_LABEL[remaining.source]}.`);
      }
    });
}
