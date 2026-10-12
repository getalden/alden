import type { ModelSetupState } from "@alden/schema";
import { describeCurrent, type SetupIo } from "../commands/setup.js";

/**
 * `alden` on its own, in a terminal, before any GitHub sign-in: the same three steps as the app's first run, in text.
 * Sign in, set up a model (or skip it), then the queue opens.
 */

/** What the first run does, so tests can fake GitHub, the keychain and the model setup. */
export interface FirstRunSteps {
  /** Signs in to GitHub as `alden auth login` does. Throws with what went wrong. */
  signIn(): Promise<void>;
  /** Whether a sign-in is there now (the GitHub CLI's counts). */
  signedIn(): Promise<boolean>;
  modelState(): Promise<ModelSetupState>;
  /** `alden setup`'s questions. Returns whether a model now works. */
  setUp(): Promise<boolean>;
}

/** The step line, as the app shows it: done steps ticked, the current one named. */
export function stepLine(current: 1 | 2 | 3): string {
  return (["Sign in", "Model", "Queue"] as const)
    .map((name, i) => (i + 1 < current ? `✓ ${name}` : i + 1 === current ? `[${i + 1} ${name}]` : `${i + 1} ${name}`))
    .join("   ");
}

/** What signing in gives Alden, truthfully: the scopes it asks for are repo and read:org. */
export const SIGN_IN_NOTE =
  "Alden asks GitHub for the repo and read:org scopes, to read the PRs waiting on you and post only the reviews you send. Revoke it anytime in GitHub's settings.";

/** Runs the first run. Returns whether to open the queue (false: not signed in, nothing to show). */
export async function runFirstRun(io: SetupIo, steps: FirstRunSteps): Promise<boolean> {
  io.print(`Welcome to Alden.\n\n${stepLine(1)}\n`);
  io.print("Start with the reviews waiting on you.");
  io.print("Alden reads PRs where you or your team were asked to review. Your code stays on this machine.");
  io.print(SIGN_IN_NOTE, true);
  const answer = (await io.ask("\nSign in with GitHub now? [Y/n] ")).trim();
  if (/^n(o)?$/i.test(answer)) {
    io.print("Not signed in. Run `alden auth login` when you're ready, then `alden` again.");
    return false;
  }
  try {
    await steps.signIn();
  } catch (error) {
    io.print((error as Error).message);
  }
  if (!(await steps.signedIn())) {
    io.print("Still not signed in. Run `alden auth login`, then `alden` again.");
    return false;
  }

  io.print(`\n${stepLine(2)}\n`);
  io.print("How should Alden think?");
  const state = await steps.modelState().catch(() => undefined);
  if (state?.current.available) {
    io.print(`Already set up: ${describeCurrent(state)} \`alden setup\` changes it.`);
  } else {
    const skip = (await io.ask("Set up a model now (an API key, or a local model)? [Y/n] ")).trim();
    if (/^n(o)?$/i.test(skip)) io.print("Checks only for now: ranking and checks, no model. `alden setup` adds one.");
    else await steps.setUp();
  }

  io.print(`\n${stepLine(3)}\n`);
  io.print("Opening your queue, ranked by what usually needs a reviewer first.");
  return true;
}
