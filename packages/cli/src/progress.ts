const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * A one-line spinner with elapsed seconds on stderr, so stdout stays clean for pipes and --json. Does nothing unless
 * stderr is a terminal.
 */
export function startProgress(label: string, stream: NodeJS.WriteStream = process.stderr): { stop(): void } {
  if (!stream.isTTY) return { stop() {} };
  const started = Date.now();
  let frame = 0;
  const draw = () => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    stream.write(`\r${FRAMES[frame++ % FRAMES.length]} ${label} ${seconds}s`);
  };
  draw();
  const timer = setInterval(draw, 100);
  return {
    stop() {
      clearInterval(timer);
      stream.write("\r\u001b[2K");
    },
  };
}
