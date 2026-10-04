import { stripControl } from "./render/style.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface Progress {
  /** Says what it's doing now, keeping the clock running. */
  update(label: string): void;
  stop(): void;
}

/**
 * A one-line spinner with elapsed seconds on stderr, so stdout stays clean for pipes and --json. Does nothing unless
 * stderr is a terminal.
 */
export function startProgress(label: string, stream: NodeJS.WriteStream = process.stderr): Progress {
  if (!stream.isTTY) return { update() {}, stop() {} };
  const started = Date.now();
  let frame = 0;
  // Labels can name repos, which come from GitHub.
  let current = stripControl(label);
  let stopped = false;
  const draw = () => {
    if (stopped) return;
    const seconds = ` ${Math.floor((Date.now() - started) / 1000)}s`;
    // A line that wraps can't be redrawn in place, so a long label is cut to fit, keeping the clock.
    const room = Math.max(10, (stream.columns ?? 80) - 3 - seconds.length);
    const text = current.length > room ? `${current.slice(0, room - 1)}…` : current;
    stream.write(`\r${FRAMES[frame++ % FRAMES.length]} ${text}${seconds}\u001b[K`);
  };
  draw();
  const timer = setInterval(draw, 100);
  return {
    update(next: string) {
      current = stripControl(next);
      draw();
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      stream.write("\r\u001b[2K");
    },
  };
}
