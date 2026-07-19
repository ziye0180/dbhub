import type { SourceConfig, ToolConfig } from "../types/config.js";

/** Validates an explicitly configured temporary write capability. */
export function validateTemporaryWriteConfig(
  tool: ToolConfig,
  sources: SourceConfig[],
  configPath: string
): void {
  const mode = "temporary_write_mode" in tool ? tool.temporary_write_mode : undefined;
  if (mode !== "dml" && mode !== "migration") {
    throw new Error(
      `Configuration file ${configPath}: tool '${tool.name}' has invalid temporary_write_mode. ` +
        `Must be 'dml' or 'migration'.`
    );
  }
  if (!("readonly" in tool) || tool.readonly !== true) {
    throw new Error(
      `Configuration file ${configPath}: temporary_write_mode requires readonly = true for source '${tool.source}'.`
    );
  }
  if (mode === "dml") {
    return;
  }

  const source = sources.find((candidate) => candidate.id === tool.source);
  if (!source) {
    throw new Error(
      `Configuration file ${configPath}: tool '${tool.name}' references unknown source '${tool.source}'`
    );
  }
  if (source.type !== "mysql" && source.type !== "mariadb") {
    throw new Error(
      `Configuration file ${configPath}: temporary_write_mode = 'migration' supports only MySQL and MariaDB sources.`
    );
  }
  if (!source.database?.trim()) {
    throw new Error(
      `Configuration file ${configPath}: temporary_write_mode = 'migration' requires the source to define a default database.`
    );
  }
}
