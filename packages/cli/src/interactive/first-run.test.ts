import type { ModelSetupState } from "@alden/schema";
import { describe, expect, it } from "vitest";
import type { SetupIo } from "../commands/setup.js";
import { type FirstRunSteps, runFirstRun, stepLine } from "./first-run.js";

function script(answers: string[]) {
  const out: string[] = [];
  const io: SetupIo = {
    print: (text) => out.push(text),
    ask: async (question) => {
      out.push(question);
      return answers.shift() ?? "";
    },
    secret: async () => "",
    progress: () => {},
  };
  return { io, text: () => out.join("\n") };
}

const modelState = (available: boolean) =>
  ({
    current: { provider: "openai", model: "gpt-6.1-sol", available, reason: null },
    key: null,
    openaiKey: { source: "alden", where: "the OpenAI key you stored" },
  }) as unknown as ModelSetupState;

function steps(over: Partial<FirstRunSteps> & { signedInAfter?: boolean; available?: boolean } = {}) {
  const calls: string[] = [];
  let signed = false;
  const all: FirstRunSteps = {
    signIn: async () => {
      calls.push("signIn");
      signed = over.signedInAfter ?? true;
    },
    signedIn: async () => signed,
    modelState: async () => modelState(over.available ?? false),
    setUp: async () => {
      calls.push("setUp");
      return true;
    },
    ...over,
  };
  return { steps: all, calls };
}

describe("the terminal's first run", () => {
  it("signs in, sets up a model, then opens the queue, in the app's order", async () => {
    const { io, text } = script(["", ""]);
    const { steps: s, calls } = steps();
    expect(await runFirstRun(io, s)).toBe(true);
    expect(calls).toEqual(["signIn", "setUp"]);
    const out = text();
    const at = ["[1 Sign in]", "[2 Model]", "[3 Queue]"].map((t) => out.indexOf(t));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(out).toContain("repo and read:org");
    expect(out).toContain("How should Alden think?");
  });

  it("skips the model step when one works already, or when you say no", async () => {
    const ready = script([""]);
    const done = steps({ available: true });
    expect(await runFirstRun(ready.io, done.steps)).toBe(true);
    expect(done.calls).toEqual(["signIn"]);
    expect(ready.text()).toContain("Already set up: gpt-6.1-sol via OpenAI");

    const no = script(["y", "n"]);
    const skipped = steps();
    expect(await runFirstRun(no.io, skipped.steps)).toBe(true);
    expect(skipped.calls).toEqual(["signIn"]);
    expect(no.text()).toContain("Checks only for now");
  });

  it("stops before the queue when you don't sign in, or signing in fails", async () => {
    const later = script(["n"]);
    const none = steps();
    expect(await runFirstRun(later.io, none.steps)).toBe(false);
    expect(none.calls).toEqual([]);
    expect(later.text()).toContain("alden auth login");

    const failing = script([""]);
    const broken = steps({
      signIn: async () => {
        throw new Error("The code expired.");
      },
    });
    expect(await runFirstRun(failing.io, broken.steps)).toBe(false);
    expect(failing.text()).toContain("The code expired.");
  });

  it("ticks the steps that are done", () => {
    expect(stepLine(1)).toBe("[1 Sign in]   2 Model   3 Queue");
    expect(stepLine(3)).toBe("✓ Sign in   ✓ Model   [3 Queue]");
  });
});
