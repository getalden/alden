import type { Briefing } from "@alden/schema";
import type { Finding } from "./commands/doctor.js";
import { paint, type RenderOptions, wrap } from "./render/style.js";

/** A command to run next, and what it does. */
export interface NextStep {
  command: string;
  why: string;
}

/**
 * A blank line and a dim "Next: …" suggesting what to run after a command, or "" when there's nothing to suggest. Commands print it
 * only to a terminal: never with --json or into a pipe, where a script reads the output.
 */
export function nextLine(steps: NextStep[], { width, color }: RenderOptions): string {
  if (steps.length === 0) return "";
  const text = `Next: ${steps.map((s) => `${s.command} (${s.why})`).join(" · ")}`;
  const [first = "", ...rest] = wrap(text, width);
  return `\n${[first, ...rest.map((l) => `      ${l}`)].map((l) => paint(l, "dim", color)).join("\n")}\n`;
}

/** Whether to print a "Next:" line: stdout is a terminal and the output isn't JSON. */
export function wantsNext(json: boolean | undefined, stream: NodeJS.WriteStream = process.stdout): boolean {
  return stream.isTTY === true && !json;
}

/** After `alden queue`: brief or open the top PR. */
export function queueNext(rows: number): NextStep[] {
  if (rows === 0) return [];
  return [
    { command: "alden review 1", why: "brief the top PR" },
    { command: "alden open 1", why: "open it on GitHub" },
  ];
}

/** After `alden review`: react to its flags, open the PR, tell Alden what matters here. `rank` is the queue's #. */
export function reviewNext(briefing: Briefing, rank: number | undefined): NextStep[] {
  if (briefing.files.length === 0) return [];
  const steps: NextStep[] = [];
  if (briefing.target.kind === "pr" && rank !== undefined) {
    steps.push({ command: `alden open ${rank}`, why: "open it on GitHub" });
  }
  if (briefing.target.kind === "pr" && briefing.needsYourEyes.length > 0) {
    steps.push({ command: "alden ui", why: "mark each flag useful or not, so Alden learns" });
  }
  steps.push({ command: 'alden memory add "…"', why: "tell Alden what you look for here" });
  return steps;
}

/** After `alden doctor`: the command its first problem's fix names, failures first, or the queue when all is well. */
export function doctorNext(findings: Finding[]): NextStep[] {
  const problems = [...findings.filter((f) => f.status === "fail"), ...findings.filter((f) => f.status === "warn")];
  if (problems.length === 0) return [{ command: "alden queue", why: "see what's waiting on you" }];
  for (const problem of problems) {
    // Only a whole command to copy: not a template like `alden config set budget.dailyUsd …`.
    const command = [...(problem.fix ?? "").matchAll(/`([^`]+)`/g)]
      .map((m) => m[1] as string)
      .find((c) => !c.includes("…"));
    if (command) return [{ command, why: `the fix for ${problem.area}` }];
  }
  return [];
}
