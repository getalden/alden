import { getConfigValue, loadConfig, setConfigValue, userConfigPath } from "@alden/core";
import type { Command } from "commander";

export function registerConfigCommand(program: Command): void {
  const config = program.command("config").description("Read and change Alden's settings.");

  config
    .command("get")
    .description("Print a setting, e.g. `alden config get model.name`.")
    .argument("<key>", "dotted key")
    .action(async (key: string) => {
      const value = getConfigValue(await loadConfig(), key);
      if (value === undefined) {
        program.error(`Unknown config key: ${key}`);
      }
      console.log(typeof value === "object" ? JSON.stringify(value, null, 2) : String(value));
    });

  config
    .command("set")
    .description("Change a setting in your user config, e.g. `alden config set budget.dailyUsd 20`.")
    .argument("<key>", "dotted key")
    .argument("<value>", "new value")
    .action(async (key: string, value: string) => {
      try {
        await setConfigValue(key, value);
      } catch (error) {
        program.error((error as Error).message);
      }
    });

  config
    .command("list")
    .description("Print every setting after merging defaults, user and repo config.")
    .action(async () => {
      console.log(JSON.stringify(await loadConfig(), null, 2));
    });

  config
    .command("path")
    .description("Print the path of your user config file.")
    .action(() => {
      console.log(userConfigPath());
    });
}
