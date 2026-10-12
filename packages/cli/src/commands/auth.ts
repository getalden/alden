import { createInterface } from "node:readline";
import {
  createGitHubClient,
  credentialsFilePath,
  DefaultCredentialStore,
  detectKeyKind,
  FileCredentialStore,
  getViewer,
  ghCliToken,
  githubClientId,
  type KeyProvider,
  loadConfig,
  modelKeyStore,
  pollForToken,
  requestDeviceCode,
  resolveModelKey,
  resolveOpenAIKey,
  resolveToken,
  selectProvider,
  type TokenSource,
  useAnthropic,
  useOpenAI,
  type Viewer,
  whyNoToken,
} from "@alden/core";

const KEY_LABEL: Record<KeyProvider, string> = { anthropic: "Anthropic", openai: "OpenAI" };

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

/**
 * Reads a line without echoing it, for secrets: the terminal in raw mode, so nothing typed or pasted shows (not even
 * as dots). Not a terminal (a pipe): reads it as it comes. Ctrl+C cancels.
 */
export function readSecret(
  prompt: string,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): Promise<string> {
  return new Promise((resolve, reject) => {
    output.write(prompt);
    const raw = input.isTTY === true;
    if (raw) input.setRawMode(true);
    input.setEncoding("utf8");
    let value = "";
    const finish = (error?: Error) => {
      input.off("data", onData);
      if (raw) input.setRawMode(false);
      input.pause();
      output.write("\n");
      if (error) reject(error);
      else resolve(value.trim());
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return finish();
        if (ch === "\u0003") return finish(new Error("Cancelled."));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    input.on("data", onData);
    input.resume();
  });
}

/** Where the model key comes from, for `alden auth status`. Never the key itself. */
async function modelKeyLine(): Promise<string> {
  const config = await loadConfig().catch(() => undefined);
  const provider = config?.model.provider ?? "anthropic";
  if (provider === "openai") {
    const key = await resolveOpenAIKey();
    return key
      ? `OpenAI API key: from ${key.where}.`
      : "OpenAI API key: none, so reviews run the checks only. Run `alden auth model` to add one.";
  }
  if (provider !== "anthropic") return `Model: ${provider}, with its own credentials (see \`alden doctor\`).`;
  const key = await resolveModelKey();
  return key
    ? `Anthropic API key: from ${key.where}.`
    : "Anthropic API key: none, so reviews run the checks only. Run `alden auth model` to add one.";
}

function scopeWarning(viewer: Viewer): string | undefined {
  if (viewer.missingScopes.length === 0) return undefined;
  return `Warning: this token is missing ${viewer.missingScopes.join(", ")}. Alden may not see private repos or team review requests.`;
}

/**
 * Signs in to GitHub, as `alden auth login` does: the GitHub CLI's sign-in when there is one (unless `device`), else
 * the device flow, with Enter opening GitHub's page in a terminal. Throws with what went wrong. The interactive first
 * run (`alden` on its own, signed out) uses it too.
 */
export async function signInToGitHub(options: { device: boolean }): Promise<void> {
  const store = new DefaultCredentialStore();
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
  const clientId = githubClientId();
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
  const token = await pollForToken(clientId, code).finally(() => prompt?.close());
  const viewer = await getViewer(createGitHubClient(token));
  await store.set(token);
  console.log(`Signed in to github.com as @${viewer.login}.`);
}

export function registerAuthCommand(program: Command): void {
  const auth = program.command("auth").description("Sign in to GitHub, and store your Anthropic or OpenAI API key.");

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

      try {
        await signInToGitHub({ device: options.device === true });
      } catch (error) {
        program.error((error as Error).message);
      }
    });

  auth
    .command("status")
    .description("Show which GitHub account Alden is using, and where the GitHub token and the model key come from.")
    .action(async () => {
      const resolved = await resolveToken();
      if (!resolved) {
        const problem = await whyNoToken();
        console.log(await modelKeyLine());
        program.error(
          problem.kind === "keychain"
            ? `Not signed in: the keychain refused to answer (${problem.detail}). Run \`alden auth login\`, and allow Alden when macOS asks.`
            : "Not signed in. Run `alden auth login`.",
        );
      }
      try {
        const viewer = await getViewer(createGitHubClient(resolved.token));
        console.log(`Signed in to github.com as @${viewer.login}, using ${SOURCE_LABEL[resolved.source]}.`);
        if (viewer.scopes.length > 0) console.log(`Token scopes: ${viewer.scopes.join(", ")}`);
        const warning = scopeWarning(viewer);
        if (warning) console.warn(warning);
      } catch {
        const fix = resolved.source === "env" ? "Fix or unset ALDEN_GITHUB_TOKEN." : "Run `alden auth login`.";
        console.log(await modelKeyLine());
        program.error(`The token from ${SOURCE_LABEL[resolved.source]} was rejected by GitHub. ${fix}`);
      }
      console.log(await modelKeyLine());
    });

  auth
    .command("model")
    .description(
      "Store your Anthropic or OpenAI API key in the keychain (Alden tells them apart), for the CLI, alden ui, alden mcp and the desktop app. Asks for it without showing it, or reads it from standard input.",
    )
    .option("--remove", "remove the keys Alden stored (both, unless --provider says which)")
    .option("--provider <provider>", "with --remove: anthropic or openai")
    .action(async (options: { remove?: boolean; provider?: string }) => {
      if (options.remove) {
        if (options.provider !== undefined && options.provider !== "anthropic" && options.provider !== "openai") {
          program.error("--provider is anthropic or openai.");
        }
        const which: KeyProvider[] = options.provider ? [options.provider as KeyProvider] : ["anthropic", "openai"];
        for (const provider of which) {
          await modelKeyStore(provider).delete();
          console.log(`Removed the ${KEY_LABEL[provider]} API key Alden stored.`);
          const remaining = provider === "openai" ? await resolveOpenAIKey() : await resolveModelKey();
          if (remaining) console.log(`Alden will still use ${remaining.where}.`);
        }
        return;
      }
      let key: string;
      try {
        key = process.stdin.isTTY
          ? await readSecret("Anthropic or OpenAI API key (it won't show as you paste): ")
          : await readStdin();
      } catch (error) {
        program.error((error as Error).message);
      }
      if (!key) program.error("No key given.");
      const detected = detectKeyKind(key);
      if (!detected.ok) program.error(detected.message);
      const provider = detected.provider;
      await modelKeyStore(provider).set(key.trim());
      const inFile = (await new FileCredentialStore(provider).get().catch(() => undefined)) !== undefined;
      console.log(
        inFile
          ? `Stored your ${KEY_LABEL[provider]} API key in ${credentialsFilePath()} (owner-only), since there's no keychain here.`
          : `Stored your ${KEY_LABEL[provider]} API key in the keychain.`,
      );
      const first = provider === "openai" ? await resolveOpenAIKey() : await resolveModelKey();
      if (first && first.source === "env") {
        console.log(`${first.where} is set here and comes first; Alden uses the stored key where it isn't set.`);
      }
      // A key for another provider than the one set up: switch when the current one has no model, else say how.
      const config = await loadConfig().catch(() => undefined);
      if (config && config.model.provider !== provider) {
        const current = await selectProvider(config);
        if (!current.ok) {
          if (provider === "openai") await useOpenAI();
          else await useAnthropic();
          console.log(`Reviews now use ${KEY_LABEL[provider]}'s models. \`alden setup\` or the model picker switches.`);
        } else {
          console.log(
            `Reviews still use ${config.model.provider}. To use ${KEY_LABEL[provider]}: alden config set model.provider ${provider}`,
          );
        }
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
