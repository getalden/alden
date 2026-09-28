import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { registerConfigCommand } from "./commands/config.js";

const program = new Command()
  .name("alden")
  .description("A code review companion: triages your PR queue and briefs you on what needs your eyes.")
  .version(pkg.version);

registerConfigCommand(program);

await program.parseAsync();
