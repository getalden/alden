import type { Engine } from "./engine.js";
import { parseKeys } from "./keys.js";
import { ENTER, frame, LEAVE } from "./screen.js";
import { type Effect, type Event, initialState, type State, update } from "./state.js";
import { view } from "./view.js";

/**
 * Runs the interactive view on a terminal: raw keys in, whole frames out, on the alternate screen so your scrollback
 * is as it was when you quit. Whatever happens (q, Ctrl-C, a crash, a kill), the terminal is put back.
 */

export interface TerminalInput {
  isTTY?: boolean;
  setRawMode?(on: boolean): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: "data", listener: (chunk: string | Buffer) => void): unknown;
  off(event: "data", listener: (chunk: string | Buffer) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

export interface TerminalOutput {
  columns?: number;
  rows?: number;
  write(text: string): unknown;
  on(event: "resize", listener: () => void): unknown;
  off(event: "resize", listener: () => void): unknown;
}

export interface RunOptions {
  engine: Engine;
  input: TerminalInput;
  output: TerminalOutput;
  color: boolean;
  now?: () => number;
  /** The spinner's clock, every 100ms. Tests leave it off and draw ticks themselves. */
  animate?: boolean;
  /** Put the terminal back if the process crashes or is killed. Tests leave the process alone. */
  guardProcess?: boolean;
}

export interface Session {
  /** Settles when you quit. */
  done: Promise<void>;
  /** Settles once nothing asked of Alden is still under way: for tests. */
  settled(): Promise<void>;
  /** The state now: for tests. */
  state(): State;
}

/** Whether `alden` with no command opens the interactive view: a terminal both ways, not CI, not a dumb terminal. */
export function wantsInteractive(
  stdin: { isTTY?: boolean },
  stdout: { isTTY?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (stdin.isTTY !== true || stdout.isTTY !== true) return false;
  if (env.CI && env.CI !== "false" && env.CI !== "0") return false;
  return env.TERM !== "dumb";
}

const SIGNALS = { SIGTERM: 15, SIGHUP: 1, SIGINT: 2 } as const;

export function startInteractive(options: RunOptions): Session {
  const { engine, input, output, color } = options;
  const now = options.now ?? Date.now;
  // A terminal that won't say its size (0 by 0, as under `script`) is taken as 80 by 24.
  const size = () => ({ width: output.columns || 80, height: output.rows || 24 });
  let [state, initial] = initialState(size().width, size().height, now());
  let drawn = "";
  let pending = 0;
  let waiters: (() => void)[] = [];
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const draw = () => {
    const next = frame(view(state, { color, now: now() }), state.width);
    if (next !== drawn) output.write(next);
    drawn = next;
  };

  let closed = false;
  const restore = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    input.off("data", onData);
    output.off("resize", onResize);
    try {
      input.setRawMode?.(false);
    } catch {
      // the terminal has already gone
    }
    input.pause();
    output.write(LEAVE);
    if (options.guardProcess) {
      process.off("exit", restore);
      process.off("uncaughtException", crash);
      process.off("unhandledRejection", crash);
      for (const signal of Object.keys(SIGNALS)) process.off(signal, killed);
    }
  };

  const dispatch = (event: Event) => {
    if (closed) return;
    const [next, effects] = update(state, event, now());
    state = next;
    if (state.quit) {
      restore();
      finish();
      return;
    }
    draw();
    for (const effect of effects) run(effect);
  };

  /** Asks Alden for something, and turns the answer (or the error) into an event. */
  function ask<T>(work: () => Promise<T>, ok: (value: T) => Event, failed: (error: string) => Event) {
    pending++;
    void (async () => {
      let event: Event;
      try {
        event = ok(await work());
      } catch (error) {
        event = failed((error as Error).message);
      }
      dispatch(event);
      pending--;
      if (pending === 0) {
        const ready = waiters;
        waiters = [];
        for (const wake of ready) wake();
      }
    })();
  }

  function run(effect: Effect) {
    switch (effect.type) {
      case "load-queue":
        return ask(
          () => engine.queue(effect.refresh, (label) => dispatch({ type: "queue-progress", label })),
          (queue) => ({ type: "queue-loaded", queue }),
          (error) => ({ type: "queue-failed", error }),
        );
      case "brief":
        return ask(
          () =>
            engine.brief(effect.pr, effect.llm, (label) =>
              dispatch({ type: "briefing-progress", id: effect.id, label }),
            ),
          (briefing) => ({ type: "briefing-loaded", id: effect.id, briefing }),
          (error) => ({ type: "briefing-failed", id: effect.id, error }),
        );
      case "check-model":
        return ask(
          () => engine.model(),
          (choice) => ({ type: "model-checked", choice }),
          (error) => ({ type: "model-checked", choice: { available: false, reason: error } }),
        );
      case "feedback":
        return ask(
          () => engine.feedback(effect.input),
          (saved) => ({
            type: "feedback-saved",
            place: effect.place,
            verdict: effect.verdict,
            ...(saved.progress ? { progress: saved.progress } : {}),
          }),
          (error) => ({ type: "feedback-failed", error }),
        );
      case "comment":
        return ask(
          () => engine.comment(effect.input),
          (draft) => ({ type: "comment-saved", pr: effect.input.pr, draft }),
          (error) => ({ type: "comment-failed", error }),
        );
      case "load-pending":
        return ask(
          () => engine.pending(effect.pr),
          (pending) => ({ type: "pending-loaded", pr: effect.pr, pending }),
          (error) => ({ type: "pending-failed", pr: effect.pr, error }),
        );
      case "send":
        return ask(
          () => engine.send(effect.pr, effect.event),
          (result) => ({ type: "sent", result }),
          (error) => ({ type: "send-failed", error }),
        );
      case "open":
        try {
          engine.open(effect.url);
        } catch {
          // the message already says where the PR is
        }
        return;
    }
  }

  const onData = (chunk: string | Buffer) => {
    for (const key of parseKeys(chunk.toString())) dispatch({ type: "key", key });
  };
  const onResize = () => {
    drawn = "";
    dispatch({ type: "resize", ...size() });
  };
  const busy = () => Boolean(state.queue.busy || state.briefing?.busy || state.send?.busy);
  const timer = setInterval(() => {
    if (options.animate && busy()) dispatch({ type: "tick" });
  }, 100);
  if (!options.animate) clearInterval(timer);

  function crash(error: unknown) {
    restore();
    process.stderr.write(`alden: ${(error as Error)?.stack ?? String(error)}\n`);
    process.exit(1);
  }
  function killed(signal: NodeJS.Signals) {
    restore();
    process.exit(128 + (SIGNALS[signal as keyof typeof SIGNALS] ?? 0));
  }
  if (options.guardProcess) {
    process.on("exit", restore);
    process.on("uncaughtException", crash);
    process.on("unhandledRejection", crash);
    for (const signal of Object.keys(SIGNALS)) process.on(signal, killed);
  }

  output.write(ENTER);
  input.setRawMode?.(true);
  input.setEncoding("utf8");
  input.on("data", onData);
  input.resume();
  output.on("resize", onResize);
  draw();
  for (const effect of initial) run(effect);
  initial = [];

  return {
    done,
    settled: () => (pending === 0 ? Promise.resolve() : new Promise<void>((wake) => waiters.push(wake))),
    state: () => state,
  };
}
