import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { registerAuthCommand } from "./commands/auth.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerOpenCommand } from "./commands/open.js";
import { registerQueueCommand } from "./commands/queue.js";
import { registerReviewCommand } from "./commands/review.js";
import { registerSpendCommand } from "./commands/spend.js";

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

await program.parseAsync();
