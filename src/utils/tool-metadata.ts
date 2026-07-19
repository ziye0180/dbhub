import { z } from "zod";
import { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { ConnectorManager } from "../connectors/manager.js";
import { normalizeSourceId } from "./normalize-id.js";
import { executeSqlSchema } from "../tools/execute-sql.js";
import { getToolRegistry } from "../tools/registry.js";
import { BUILTIN_TOOL_EXECUTE_SQL } from "../tools/builtin-tools.js";
import type { ParameterConfig, TemporaryWriteMode, ToolConfig } from "../types/config.js";
import { formatEnableWriteCommand } from "../write-access/index.js";

/**
 * Tool parameter definition for API responses
 */
export interface ToolParameter {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

/**
 * Tool metadata for API responses
 */
export interface Tool {
  name: string;
  description: string;
  parameters: ToolParameter[];
  statement?: string;
  readonly?: boolean;
  max_rows?: number;
  temporary_write_mode?: TemporaryWriteMode;
  temporary_migration_database?: string;
}

/**
 * Tool metadata with Zod schema (used internally for registration)
 */
export interface ToolMetadata {
  name: string;
  description: string;
  schema: Record<string, z.ZodType<any>>;
  annotations: ToolAnnotations;
}

/**
 * Build a prefix string for prepending a source's user-provided `description`
 * onto a generated tool description. Returns "" when no description is set
 * (undefined, empty, or whitespace-only). Normalizes surrounding whitespace
 * with `trim()` and skips adding a period when the description already ends
 * with one of "." / "!" / "?" / ":" — the colon is included because a
 * trailing colon naturally introduces what follows (the generic tool
 * template) and appending "." after it would produce artifacts like
 * "Details below:. Execute SQL...".
 *
 * Examples:
 *   undefined            -> ""
 *   "  "                 -> ""
 *   "Prod DB"            -> "Prod DB. "
 *   "Prod DB."           -> "Prod DB. "      (no double period)
 *   "  Prod DB!  "       -> "Prod DB! "      (trimmed, no added period)
 *   "Query me?"          -> "Query me? "
 *   "Details below:"     -> "Details below: " (colon introduces what follows)
 *   "Clause 1; clause 2" -> "Clause 1; clause 2. " (semicolon is mid-sentence)
 *   "(read-only)"        -> "(read-only). "  (closing paren is mid-sentence)
 */
export function buildSourceDescriptionPrefix(description: string | undefined): string {
  const trimmed = description?.trim() ?? "";
  if (!trimmed) return "";
  return /[.!?:]$/.test(trimmed) ? `${trimmed} ` : `${trimmed}. `;
}

/**
 * Convert a Zod schema object to simplified parameter list
 * @param schema - Zod schema object (e.g., { sql: z.string().describe("...") })
 * @returns Array of tool parameters
 */
export function zodToParameters(schema: Record<string, z.ZodType<any>>): ToolParameter[] {
  const parameters: ToolParameter[] = [];

  for (const [key, zodType] of Object.entries(schema)) {
    // Extract description from Zod schema
    const description = zodType.description || "";

    // Determine if required (Zod types are required by default unless optional)
    const required = !(zodType instanceof z.ZodOptional);

    // Determine type from Zod type
    let type = "string"; // default
    if (zodType instanceof z.ZodString) {
      type = "string";
    } else if (zodType instanceof z.ZodNumber) {
      type = "number";
    } else if (zodType instanceof z.ZodBoolean) {
      type = "boolean";
    } else if (zodType instanceof z.ZodArray) {
      type = "array";
    } else if (zodType instanceof z.ZodObject) {
      type = "object";
    }

    parameters.push({
      name: key,
      type,
      required,
      description,
    });
  }

  return parameters;
}

/**
 * Get execute_sql tool metadata for a specific source
 * @param sourceId - The source ID to get tool metadata for
 * @returns Tool metadata with name, description, and Zod schema
 */
export function getExecuteSqlMetadata(sourceId: string): ToolMetadata {
  const sourceIds = ConnectorManager.getAvailableSourceIds();
  const sourceConfig = ConnectorManager.getSourceConfig(sourceId)!;
  const dbType = sourceConfig.type;
  const isSingleSource = sourceIds.length === 1;

  // Get tool configuration from registry to extract readonly/max_rows
  const registry = getToolRegistry();
  const toolConfig = registry.getBuiltinToolConfig(BUILTIN_TOOL_EXECUTE_SQL, sourceId);
  const executeOptions = {
    readonly: toolConfig?.readonly,
    maxRows: toolConfig?.max_rows,
    temporaryWriteMode:
      toolConfig && "temporary_write_mode" in toolConfig
        ? (toolConfig.temporary_write_mode ?? "dml")
        : "dml",
    temporaryMigrationDatabase:
      toolConfig && "temporary_migration_database" in toolConfig
        ? toolConfig.temporary_migration_database
        : undefined,
  };

  // Determine tool name based on single vs multi-source configuration
  const toolName = isSingleSource ? "execute_sql" : `execute_sql_${normalizeSourceId(sourceId)}`;

  // Determine title (human-readable display name)
  const title = isSingleSource
    ? `Execute SQL (${dbType})`
    : `Execute SQL on ${sourceId} (${dbType})`;

  // Determine description with more context.
  // Prepend the user-provided `description` from the source config (if set)
  // so AI clients reading the MCP tool list see the source's purpose first.
  const userDescPrefix = buildSourceDescriptionPrefix(sourceConfig.description);
  const readonlyNote = executeOptions.readonly ? " [READ-ONLY BY DEFAULT]" : "";
  const maxRowsNote = executeOptions.maxRows ? ` (limited to ${executeOptions.maxRows} rows)` : "";
  const defaultDatabaseNote = sourceConfig.database
    ? executeOptions.temporaryWriteMode === "migration"
      ? ` Default database: '${sourceConfig.database}'. Temporary migration writes are restricted to unqualified targets in this database.`
      : executeOptions.temporaryWriteMode === "dml_and_migration"
        ? ` Default database: '${sourceConfig.database}'. Temporary DML remains in this database; validated migration writes run in '${executeOptions.temporaryMigrationDatabase}'.`
        : ` Default database: '${sourceConfig.database}'. Other accessible databases may exist; use search_objects with object_type='schema' to discover them and qualify cross-database SQL as database.table.`
    : "";
  const temporaryWriteNote = executeOptions.readonly
    ? ` Temporary ${executeOptions.temporaryWriteMode} access requires the user to run this command on the DBHub host: ${formatEnableWriteCommand(sourceId)}; never run that authorization command on the user's behalf.`
    : "";
  const description = isSingleSource
    ? `${userDescPrefix}Execute SQL queries on the ${dbType} database.${defaultDatabaseNote}${temporaryWriteNote}${readonlyNote}${maxRowsNote}`
    : `${userDescPrefix}Execute SQL queries on the '${sourceId}' ${dbType} source.${defaultDatabaseNote}${temporaryWriteNote}${readonlyNote}${maxRowsNote}`;

  // Build annotations object with all standard MCP hints
  const annotations = {
    title,
    // Static MCP annotations must describe every state the tool can enter.
    // A lease-managed tool is read-only by default but can execute configured writes later.
    readOnlyHint: false,
    destructiveHint: true,
    // Both permanently writable and lease-managed execution can be non-idempotent.
    idempotentHint: false,
    // Database operations are always against internal/closed systems, not open-world
    openWorldHint: false,
  };

  return {
    name: toolName,
    description,
    schema: executeSqlSchema,
    annotations,
  };
}

/**
 * Get search_objects tool metadata for a specific source
 * @param sourceId - The source ID to get tool metadata for
 * @returns Tool name, description, and annotations
 */
export function getSearchObjectsMetadata(sourceId: string): {
  name: string;
  description: string;
  title: string;
} {
  const sourceIds = ConnectorManager.getAvailableSourceIds();
  const sourceConfig = ConnectorManager.getSourceConfig(sourceId)!;
  const dbType = sourceConfig.type;
  const isSingleSource = sourceIds.length === 1;

  const toolName = isSingleSource
    ? "search_objects"
    : `search_objects_${normalizeSourceId(sourceId)}`;
  const title = isSingleSource
    ? `Search Database Objects (${dbType})`
    : `Search Database Objects on ${sourceId} (${dbType})`;
  // Prepend the user-provided `description` from the source config (if set)
  // so AI clients reading the MCP tool list see the source's purpose first.
  const userDescPrefix = buildSourceDescriptionPrefix(sourceConfig.description);
  const defaultDatabaseNote = sourceConfig.database
    ? ` Default database: '${sourceConfig.database}'. object_type='schema' lists every accessible non-system database; other object types default to this database unless schema is provided.`
    : "";
  const description = isSingleSource
    ? `${userDescPrefix}Search and list database objects on the ${dbType} database.${defaultDatabaseNote}`
    : `${userDescPrefix}Search and list database objects on the '${sourceId}' ${dbType} source.${defaultDatabaseNote}`;

  return {
    name: toolName,
    description,
    title,
  };
}

/**
 * Convert custom tool parameter configs to Tool parameter format
 * @param params - Parameter configurations from custom tool
 * @returns Array of tool parameters
 */
function customParamsToToolParams(params: ParameterConfig[] | undefined): ToolParameter[] {
  if (!params || params.length === 0) {
    return [];
  }

  return params.map((param) => ({
    name: param.name,
    type: param.type,
    required: param.required !== false && param.default === undefined,
    description: param.description,
  }));
}

/**
 * Build execute_sql tool metadata for API response
 */
function buildExecuteSqlTool(sourceId: string, toolConfig?: ToolConfig): Tool {
  const executeSqlMetadata = getExecuteSqlMetadata(sourceId);
  const executeSqlParameters = zodToParameters(executeSqlMetadata.schema);

  // Extract readonly and max_rows from toolConfig
  // ToolConfig is a union type, but ExecuteSqlToolConfig and CustomToolConfig both have these fields
  const readonly = toolConfig && "readonly" in toolConfig ? toolConfig.readonly : undefined;
  const max_rows = toolConfig && "max_rows" in toolConfig ? toolConfig.max_rows : undefined;
  const temporary_write_mode =
    toolConfig && "temporary_write_mode" in toolConfig
      ? toolConfig.temporary_write_mode
      : undefined;
  const temporary_migration_database =
    toolConfig && "temporary_migration_database" in toolConfig
      ? toolConfig.temporary_migration_database
      : undefined;

  return {
    name: executeSqlMetadata.name,
    description: executeSqlMetadata.description,
    parameters: executeSqlParameters,
    readonly,
    max_rows,
    temporary_write_mode,
    temporary_migration_database,
  };
}

/**
 * Build search_objects tool metadata for API response
 */
function buildSearchObjectsTool(sourceId: string): Tool {
  const searchMetadata = getSearchObjectsMetadata(sourceId);

  return {
    name: searchMetadata.name,
    description: searchMetadata.description,
    parameters: [
      {
        name: "object_type",
        type: "string",
        required: true,
        description:
          "Object type to search: schema, table, view, column, procedure, function, index",
      },
      {
        name: "pattern",
        type: "string",
        required: false,
        description: "LIKE pattern (% = any chars, _ = one char). Default: %",
      },
      {
        name: "schema",
        type: "string",
        required: false,
        description: "Filter to schema",
      },
      {
        name: "table",
        type: "string",
        required: false,
        description: "Filter to table (requires schema; column/index only)",
      },
      {
        name: "detail_level",
        type: "string",
        required: false,
        description: "Detail: names (minimal), summary (metadata), full (all)",
      },
      {
        name: "limit",
        type: "integer",
        required: false,
        description: "Max results (default: 100, max: 1000)",
      },
    ],
    readonly: true, // search_objects is always readonly
  };
}

/**
 * Build custom tool metadata for API response
 */
function buildCustomTool(toolConfig: ToolConfig): Tool {
  return {
    name: toolConfig.name,
    description: toolConfig.description!,
    parameters: customParamsToToolParams(toolConfig.parameters),
    statement: toolConfig.statement,
    readonly: toolConfig.readonly,
    max_rows: toolConfig.max_rows,
  };
}

/**
 * Get tools for a specific source (API response format)
 * Only includes tools that are actually enabled in the ToolRegistry
 * @param sourceId - The source ID to get tools for
 * @returns Array of enabled tools with simplified parameters
 */
export function getToolsForSource(sourceId: string): Tool[] {
  // Get enabled tools from registry
  const registry = getToolRegistry();
  const enabledToolConfigs = registry.getEnabledToolConfigs(sourceId);

  // Uniform iteration: map each enabled tool config to its API representation
  return enabledToolConfigs.map((toolConfig) => {
    // Dispatch based on tool name
    if (toolConfig.name === "execute_sql") {
      return buildExecuteSqlTool(sourceId, toolConfig);
    } else if (toolConfig.name === "search_objects") {
      return buildSearchObjectsTool(sourceId);
    } else {
      // Custom tool
      return buildCustomTool(toolConfig);
    }
  });
}
