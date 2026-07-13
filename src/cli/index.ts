import { loadTomlConfig } from "../config/toml-loader.js";
import { resolveWriteLeaseFilePath, WriteLeaseStore } from "../write-access/index.js";
import {
  executeWriteAccessCommand,
  isWriteAccessCommand,
  type WriteAccessSource,
} from "./write-access-cli.js";
import type { TomlConfig } from "../types/config.js";

/** Handles DBHub administration subcommands before database connectors are loaded. */
export async function tryRunCliCommand(args: readonly string[]): Promise<boolean> {
  const commandArgs = removeConfigOption(args);
  if (!isWriteAccessCommand(commandArgs)) {
    return false;
  }

  const config = loadTomlConfig();
  if (!config) {
    throw new Error("dbhub.toml is required for write-access commands");
  }

  const sources = buildWriteAccessSources(config);
  const store = new WriteLeaseStore(resolveWriteLeaseFilePath());
  await executeWriteAccessCommand(commandArgs, {
    store,
    sources,
    now: () => new Date(),
    writeOutput: (message) => process.stdout.write(`${message}\n`),
  });
  return true;
}

function buildWriteAccessSources(config: TomlConfig): Map<string, WriteAccessSource> {
  const toolsBySource = new Map<string, TomlConfig["tools"]>();
  for (const tool of config.tools ?? []) {
    const tools = toolsBySource.get(tool.source) ?? [];
    tools.push(tool);
    toolsBySource.set(tool.source, tools);
  }

  return new Map(
    config.sources.map((source) => {
      const configuredTools = toolsBySource.get(source.id);
      const executeSqlTool = configuredTools
        ? configuredTools.find((tool) => tool.name === "execute_sql")
        : undefined;
      return [
        source.id,
        {
          type: source.type,
          executeSqlEnabled: configuredTools === undefined || executeSqlTool !== undefined,
          readonly: executeSqlTool?.readonly === true,
        },
      ];
    })
  );
}

function removeConfigOption(args: readonly string[]): string[] {
  const commandArgs: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--config") {
      index++;
      continue;
    }
    if (argument.startsWith("--config=")) {
      continue;
    }
    commandArgs.push(argument);
  }
  return commandArgs;
}
