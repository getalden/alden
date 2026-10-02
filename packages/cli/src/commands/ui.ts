import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configureTelemetry, embeddedFilesUnder, flushTelemetry, track } from "@alden/core";
import type { Command } from "commander";
import { createUiApi } from "../ui/api.js";
import { startUiServer } from "../ui/server.js";
import { openInBrowser } from "./open.js";

interface UiOptions {
  port?: string;
  /** Commander sets this to false for --no-open. */
  open: boolean;
  json?: boolean;
}

export function registerUiCommand(program: Command, version: string): void {
  program
    .command("ui")
    .description("Open the queue and briefings in your browser. Serves on 127.0.0.1 only, until you stop it.")
    .option("--port <n>", "port to serve on (default: a free one)")
    .option("--no-open", "print the link instead of opening a browser")
    .option("--json", "print one JSON line with the link and port, and don't open a browser (for the desktop app)")
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

      // Started by the desktop app (--json), events say so; either way they go out every minute while it runs.
      configureTelemetry({ version, surface: options.json ? "desktop" : "ui" });
      await track("command_run", { command: "ui", ok: true, duration_ms: 0 });
      const sender = setInterval(() => void flushTelemetry(), 60_000);
      sender.unref();
      void flushTelemetry();
      if (options.json) {
        console.log(JSON.stringify({ url: ui.url, port: new URL(ui.url).port }));
      } else {
        console.log(`Alden is running at ${ui.url}`);
        console.log("The link carries a session key; don't share it. Press Ctrl+C to stop.");
        if (options.open) openInBrowser(ui.url, "Couldn't open a browser. Open the link above.");
      }

      const stop = () => {
        clearInterval(sender);
        void Promise.race([flushTelemetry({ timeoutMs: 800 }), new Promise((r) => setTimeout(r, 900))])
          .then(() => ui.close())
          .then(() => process.exit(0));
        // Streaming reviews keep connections open; don't wait on them forever.
        setTimeout(() => process.exit(0), 1_000).unref();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      // Started by the desktop app: stop when it goes away (its end of stdin closes), even if it crashed.
      if (options.json) {
        process.stdin.on("end", stop);
        process.stdin.resume();
      }
    });
}
