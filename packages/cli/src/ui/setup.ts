import { execFile } from "node:child_process";
import { lstatSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";
import {
  createGitHubClient,
  DefaultCredentialStore,
  type DeviceCode,
  getViewer,
  ghCliToken,
  githubClientId,
  isStandaloneBinary,
  pollForToken,
  requestDeviceCode,
  resolveToken,
} from "@alden/core";
import { openInBrowser } from "../commands/open.js";

/**
 * Setting Alden up from the UI rather than a terminal, which the desktop app needs: GitHub sign-in with the device
 * flow (the same as `alden auth login --device`), switching to the GitHub CLI's sign-in, and installing the `alden`
 * command from the app.
 */

export type SignInState =
  | { state: "idle" }
  | { state: "waiting"; userCode: string; verificationUri: string; expiresAt: string }
  | { state: "done"; login: string }
  | { state: "failed"; message: string };

export interface SignIn {
  start(): Promise<SignInState>;
  status(): SignInState;
  /** Opens GitHub's page for the code in the default browser, from the server: the desktop window can't open tabs. */
  open(): void;
  /** Drops Alden's stored token, so it uses the GitHub CLI's sign-in. */
  useGitHubCli(): Promise<{ login: string } | { error: string }>;
}

export function createSignIn(): SignIn {
  let current: SignInState = { state: "idle" };
  let pending: DeviceCode | undefined;

  return {
    async start() {
      const clientId = githubClientId();
      const code = await requestDeviceCode(clientId);
      pending = code;
      current = {
        state: "waiting",
        userCode: code.userCode,
        verificationUri: code.verificationUri,
        expiresAt: new Date(Date.now() + code.expiresIn * 1000).toISOString(),
      };
      // Approval happens in the browser, minutes later; the UI asks for the status meanwhile.
      void pollForToken(clientId, code)
        .then(async (token) => {
          const viewer = await getViewer(createGitHubClient(token));
          await new DefaultCredentialStore().set(token);
          if (pending === code) current = { state: "done", login: viewer.login };
        })
        .catch((error: Error) => {
          if (pending === code) current = { state: "failed", message: error.message };
        });
      return current;
    },
    status: () => current,
    open() {
      if (current.state === "waiting") openInBrowser(current.verificationUri, "Couldn't open a browser.");
    },
    async useGitHubCli() {
      if (!(await ghCliToken())) {
        return { error: "The GitHub CLI isn't signed in here. Sign in with GitHub instead, or run `gh auth login`." };
      }
      await new DefaultCredentialStore().delete();
      const resolved = await resolveToken();
      if (!resolved) return { error: "No sign-in found after switching." };
      try {
        return { login: (await getViewer(createGitHubClient(resolved.token))).login };
      } catch {
        return { error: "GitHub rejected the GitHub CLI's sign-in too. Run `gh auth login`, or sign in with GitHub." };
      }
    },
  };
}

/** Whether the GitHub CLI is signed in on this machine, for offering its sign-in. */
export async function gitHubCliSignedIn(): Promise<boolean> {
  return (await ghCliToken().catch(() => undefined)) !== undefined;
}

// ─── The `alden` command, from the desktop app ───

/** Where the command goes, as Docker Desktop and VS Code do it: on every Mac's PATH, outside Homebrew's folder. */
export const CLI_LINK = "/usr/local/bin/alden";
const OTHER_INSTALLS = [CLI_LINK, "/opt/homebrew/bin/alden"];

export type CliStatus =
  | { state: "unavailable" }
  | { state: "installed"; path: string; ours: boolean }
  | { state: "missing"; bundled: string };

/** The desktop app's bundled `alden` (this process), and whether an `alden` command is installed. */
export function cliStatus(): CliStatus {
  const bundled = process.execPath;
  if (process.platform !== "darwin" || !isStandaloneBinary() || basename(bundled) !== "alden")
    return { state: "unavailable" };
  for (const path of OTHER_INSTALLS) {
    try {
      const stat = lstatSync(path);
      const ours = stat.isSymbolicLink() && readlinkSync(path) === bundled;
      return { state: "installed", path, ours };
    } catch {
      // not there
    }
  }
  return { state: "missing", bundled };
}

export type CliInstall =
  | { state: "installed"; path: string }
  | { state: "exists"; path: string }
  | { state: "cancelled" }
  | { state: "failed"; message: string };

/**
 * Links the bundled `alden` into /usr/local/bin: directly when that folder is writable (as it often is with Homebrew on
 * Intel Macs), otherwise after macOS asks for an administrator's password.
 */
export async function installCli(): Promise<CliInstall> {
  const status = cliStatus();
  if (status.state === "unavailable")
    return { state: "failed", message: "Only the desktop app on macOS installs the command." };
  if (status.state === "installed") return { state: "exists", path: status.path };
  try {
    mkdirSync(dirname(CLI_LINK), { recursive: true });
    symlinkSync(status.bundled, CLI_LINK);
    return { state: "installed", path: CLI_LINK };
  } catch {
    // Not writable without an administrator: ask macOS.
  }
  const path = status.bundled.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script =
    `do shell script "mkdir -p /usr/local/bin && ln -sf " & quoted form of "${path}" & " ${CLI_LINK}" ` +
    `with prompt "Alden wants to install the alden command in /usr/local/bin." with administrator privileges`;
  try {
    await promisify(execFile)("osascript", ["-e", script]);
    return { state: "installed", path: CLI_LINK };
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? "");
    if (stderr.includes("-128")) return { state: "cancelled" };
    return { state: "failed", message: stderr.trim() || (error as Error).message };
  }
}
