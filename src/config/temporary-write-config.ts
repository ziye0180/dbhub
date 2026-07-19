import type { SourceConfig, ToolConfig } from "../types/config.js";

/** Validates an explicitly configured temporary write capability. */
export function validateTemporaryWriteConfig(
  tool: ToolConfig,
  sources: SourceConfig[],
  configPath: string
): void {
  const mode = "temporary_write_mode" in tool ? tool.temporary_write_mode : undefined;
  const migrationDatabase =
    "temporary_migration_database" in tool ? tool.temporary_migration_database : undefined;
  if (mode !== "dml" && mode !== "migration" && mode !== "dml_and_migration") {
    throw new Error(
      `Configuration file ${configPath}: tool '${tool.name}' has invalid temporary_write_mode. ` +
        `Must be 'dml', 'migration', or 'dml_and_migration'.`
    );
  }
  if (!("readonly" in tool) || tool.readonly !== true) {
    throw new Error(
      `Configuration file ${configPath}: temporary_write_mode requires readonly = true for source '${tool.source}'.`
    );
  }
  if (mode === "dml") {
    if (migrationDatabase !== undefined) {
      throw new Error(
        `Configuration file ${configPath}: temporary_migration_database requires migration capability.`
      );
    }
    return;
  }
  if (mode === "migration" && migrationDatabase !== undefined) {
    throw new Error(
      `Configuration file ${configPath}: temporary_migration_database is only valid for dml_and_migration mode.`
    );
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
  if (mode === "dml_and_migration" && !migrationDatabase) {
    throw new Error(
      `Configuration file ${configPath}: temporary_write_mode = 'dml_and_migration' requires temporary_migration_database.`
    );
  }
  if (
    migrationDatabase !== undefined &&
    (typeof migrationDatabase !== "string" || !/^[A-Za-z0-9_$-]{1,64}$/.test(migrationDatabase))
  ) {
    throw new Error(`Configuration file ${configPath}: invalid temporary_migration_database.`);
  }
}
