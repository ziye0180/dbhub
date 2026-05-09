import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createExecuteSqlToolHandler } from "./execute-sql.js";
import { createSearchDatabaseObjectsToolHandler, searchDatabaseObjectsSchema } from "./search-objects.js";
import { ConnectorManager } from "../connectors/manager.js";
import { getExecuteSqlMetadata, getSearchObjectsMetadata } from "../utils/tool-metadata.js";
import { isReadOnlySQL } from "../utils/allowed-keywords.js";
import { createCustomToolHandler, buildZodSchemaFromParameters } from "./custom-tool-handler.js";
import type { ToolConfig } from "../types/config.js";
import { getToolRegistry } from "./registry.js";
import { BUILTIN_TOOL_EXECUTE_SQL, BUILTIN_TOOL_SEARCH_OBJECTS } from "./builtin-tools.js";

/**
 * Override the SDK-injected `execution.taskSupport: 'forbidden'` default that
 * the MCP SDK hardcodes in `server.registerTool()` (see SDK
 * `dist/esm/server/mcp.js` line ~693). The 'forbidden' default makes Claude
 * Code subagents refuse to expose dbhub tools in task / subagent contexts.
 *
 * dbhub tools are read-only SQL with row caps and per-source allow-listing,
 * so they are safe to call from task / subagent contexts. We strip the
 * `execution` field after registration so the server reports no constraint.
 *
 * @param tool - Object returned by `server.registerTool(...)`
 */
function unlockTaskSupport(tool: { execution?: unknown }): void {
  // Setting to undefined causes the field to be dropped from tools/list
  // (the SDK reads `tool.execution` and includes it in the response only
  // when truthy after JSON serialization).
  tool.execution = undefined;
}

/**
 * Register all tool handlers with the MCP server
 * Iterates through all enabled tools from the registry and registers them
 * @param server - The MCP server instance
 */
export function registerTools(server: McpServer): void {
  const sourceIds = ConnectorManager.getAvailableSourceIds();

  if (sourceIds.length === 0) {
    throw new Error("No database sources configured");
  }

  const registry = getToolRegistry();

  // Register all enabled tools (both built-in and custom) for each source
  for (const sourceId of sourceIds) {
    const enabledTools = registry.getEnabledToolConfigs(sourceId);

    for (const toolConfig of enabledTools) {
      // Register based on tool name (built-in vs custom)
      if (toolConfig.name === BUILTIN_TOOL_EXECUTE_SQL) {
        registerExecuteSqlTool(server, sourceId);
      } else if (toolConfig.name === BUILTIN_TOOL_SEARCH_OBJECTS) {
        registerSearchObjectsTool(server, sourceId);
      } else {
        // Custom tool
        registerCustomTool(server, sourceId, toolConfig);
      }
    }
  }
}

/**
 * Register execute_sql tool for a source
 */
function registerExecuteSqlTool(
  server: McpServer,
  sourceId: string
): void {
  const metadata = getExecuteSqlMetadata(sourceId);
  const tool = server.registerTool(
    metadata.name,
    {
      description: metadata.description,
      inputSchema: metadata.schema,
      annotations: metadata.annotations,
    },
    createExecuteSqlToolHandler(sourceId)
  );
  unlockTaskSupport(tool);
}

/**
 * Register search_objects tool for a source
 */
function registerSearchObjectsTool(
  server: McpServer,
  sourceId: string
): void {
  const metadata = getSearchObjectsMetadata(sourceId);

  const tool = server.registerTool(
    metadata.name,
    {
      description: metadata.description,
      inputSchema: searchDatabaseObjectsSchema,
      annotations: {
        title: metadata.title,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    createSearchDatabaseObjectsToolHandler(sourceId)
  );
  unlockTaskSupport(tool);
}

/**
 * Register a custom tool
 */
function registerCustomTool(
  server: McpServer,
  sourceId: string,
  toolConfig: ToolConfig
): void {
  const sourceConfig = ConnectorManager.getSourceConfig(sourceId)!;
  const dbType = sourceConfig.type;

  const isReadOnly = isReadOnlySQL(toolConfig.statement!, dbType);
  const zodSchema = buildZodSchemaFromParameters(toolConfig.parameters);

  const tool = server.registerTool(
    toolConfig.name,
    {
      description: toolConfig.description,
      inputSchema: zodSchema,
      annotations: {
        title: `${toolConfig.name} (${dbType})`,
        readOnlyHint: isReadOnly,
        destructiveHint: !isReadOnly,
        idempotentHint: isReadOnly,
        openWorldHint: false,
      },
    },
    createCustomToolHandler(toolConfig)
  );
  unlockTaskSupport(tool);
}
