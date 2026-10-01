import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { embeddedFilesUnder } from "@alden/core";
import type { Command } from "commander";
import { createUiApi } from "../ui/api.js";
import { startUiServer } from "../ui/server.js";
import { openInBrowser } from "./open.js";

interface UiOptions {
  port?: string;
  /** Commander sets this to false for --no-open. */
  open: boolean;
}

export function registerUiCommand(program: Command, version: string): void {
  program
    .command("ui")
    .description("Open the queue and briefings in your browser. Serves on 127.0.0.1 only, until you stop it.")
    .option("--port <n>", "port to serve on (default: a free one)")
    .option("--no-open", "print the link instead of opening a browser")
    .action(async (options: UiOptions) => {
      const port = options.port === undefined ? 0 : Number.parseInt(options.port, 10);
      if (!Number.isInteger(port) || port < 0 || port > 65_535) program.error("--port must be a port number.");

      // The bundled CLI sits in dist/, with the built UI beside it in dist/ui.
      const staticDir = join(dirname(fileURLToPath(import.meta.url)), "ui");
      let ui: Awaited<ReturnType<typeof startUiServer>>;
      try {
        // A standalone binary carries the UI inside it.
        const embedded = embeddedFilesUnder("ui/");
        ui = await startUiServer({
          api: createUiApi({ version, cwd: process.cwd() }),
          ...(embedded.size > 0 ? { files: embedded } : { staticDir }),
          port,
        });
      } catch (error) {
        const code = (error as { code?: string }).code;
        program.error(
          code === "EADDRINUSE" ? `Port ${port} is in use. Try another, or leave out --port.` : String(error),
        );
      }

      console.log(`Alden is running at ${ui.url}`);
      console.log("The link carries a session key; don't share it. Press Ctrl+C to stop.");
      if (options.open) openInBrowser(ui.url, "Couldn't open a browser. Open the link above.");

      const stop = () => {
        void ui.close().then(() => process.exit(0));
        // Streaming reviews keep connections open; don't wait on them forever.
        setTimeout(() => process.exit(0), 1_000).unref();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
}
