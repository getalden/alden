import { configureTelemetry, noteClone } from "@alden/core";
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { registerAuthCommand } from "./commands/auth.js";
import { registerCompletionCommand } from "./commands/completion.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerFeedbackCommand } from "./commands/feedback.js";
import { registerMcpCommand } from "./commands/mcp.js";
import { registerMemoryCommand } from "./commands/memory.js";
import { registerOpenCommand } from "./commands/open.js";
import { registerQueueCommand } from "./commands/queue.js";
import { registerReviewCommand } from "./commands/review.js";
import { registerSpendCommand } from "./commands/spend.js";
import { registerStatsCommand } from "./commands/stats.js";
import { registerUiCommand } from "./commands/ui.js";
import { instrument, registerTelemetryCommand } from "./telemetry.js";
import { updateNotice } from "./version.js";

const program = new Command()
  .name("alden")
  .description("A code review companion: triages your PR queue and briefs you on what needs your eyes.")
  .version(pkg.version);

registerAuthCommand(program);
registerConfigCommand(program);
registerQueueCommand(program);
registerOpenCommand(program);
registerReviewCommand(program);
registerSpendCommand(program);
registerFeedbackCommand(program);
registerMemoryCommand(program);
registerStatsCommand(program);
registerDoctorCommand(program, pkg.version);
registerUiCommand(program, pkg.version);
registerMcpCommand(program, pkg.version);
registerTelemetryCommand(program);
registerCompletionCommand(program);

configureTelemetry({ version: pkg.version, surface: "cli" });
// Remember the clone Alden runs in (repo → folder), so briefings on that repo's PRs find callers from anywhere.
program.hook("preAction", async () => {
  await noteClone(process.cwd());
});
instrument(program);

// `alden --version` also says when a newer Alden exists (on stderr, so scripts reading the version aren't affected).
const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === "--version" || args[0] === "-V")) {
  console.log(pkg.version);
  const notice = await updateNotice(pkg.version);
  if (notice) console.error(notice);
  process.exit(0);
}

await program.parseAsync();
