import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { registerAuthCommand } from "./commands/auth.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerFeedbackCommand } from "./commands/feedback.js";
import { registerOpenCommand } from "./commands/open.js";
import { registerQueueCommand } from "./commands/queue.js";
import { registerReviewCommand } from "./commands/review.js";
import { registerSpendCommand } from "./commands/spend.js";
import { registerStatsCommand } from "./commands/stats.js";
import { registerUiCommand } from "./commands/ui.js";
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
registerStatsCommand(program);
registerDoctorCommand(program, pkg.version);
registerUiCommand(program, pkg.version);

// `alden --version` also says when a newer Alden exists (on stderr, so scripts reading the version aren't affected).
const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === "--version" || args[0] === "-V")) {
  console.log(pkg.version);
  const notice = await updateNotice(pkg.version);
  if (notice) console.error(notice);
  process.exit(0);
}

await program.parseAsync();
