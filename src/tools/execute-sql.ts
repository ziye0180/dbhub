import { z } from "zod";
import { ConnectorManager } from "../connectors/manager.js";
import type { ExecuteOptions } from "../connectors/interface.js";
import type { TemporaryWriteMode, ToolConfig } from "../types/config.js";
import { createToolSuccessResponse, createToolErrorResponse } from "../utils/response-formatter.js";
import { getToolRegistry } from "./registry.js";
import { BUILTIN_TOOL_EXECUTE_SQL } from "./builtin-tools.js";
import { classifySqlAccess, type SqlAccessDecision } from "../utils/sql-access.js";
import {
  formatEnableWriteCommand,
  getActiveWriteLease,
  type WriteLease,
} from "../write-access/index.js";
import {
  getEffectiveSourceId,
  trackToolRequest,
  tryClassifyConnectionError,
} from "../utils/tool-handler-helpers.js";

// Schema for execute_sql tool
export const executeSqlSchema = {
  sql: z.string().describe("SQL to execute (multiple statements separated by ;)"),
};

/**
 * Create an execute_sql tool handler for a specific source
 * @param sourceId - The source ID this handler is bound to (undefined for single-source mode)
 * @returns A handler function bound to the specified source
 */
export function createExecuteSqlToolHandler(sourceId?: string) {
  return async (args: any, extra: any) => {
    const { sql } = args as { sql: string };
    const startTime = Date.now();
    const effectiveSourceId = getEffectiveSourceId(sourceId);
    let success = true;
    let errorMessage: string | undefined;
    let result: any;

    try {
      // Ensure source is connected (handles lazy connections)
      await ConnectorManager.ensureConnected(sourceId);

      // Get connector for the specified source (or default)
      const connector = ConnectorManager.getCurrentConnector(sourceId);
      const actualSourceId = connector.getId();

      // Get tool-specific configuration (tool is already registered, so it's enabled)
      const registry = getToolRegistry();
      const toolConfig = registry.getBuiltinToolConfig(BUILTIN_TOOL_EXECUTE_SQL, actualSourceId);

      const configuredReadonly = toolConfig?.readonly === true;
      const temporaryWriteMode =
        toolConfig && "temporary_write_mode" in toolConfig
          ? (toolConfig.temporary_write_mode ?? "dml")
          : "dml";
      const authorizationSourceId = sourceId ?? actualSourceId;
      const accessDecision = classifySqlAccess(sql, connector.id, temporaryWriteMode);
      const migrationDatabase =
        accessDecision.kind === "write" && accessDecision.operation === "migration"
          ? getMigrationDatabase(toolConfig, actualSourceId)
          : undefined;
      if (
        configuredReadonly &&
        accessDecision.kind === "write" &&
        accessDecision.operation === "migration" &&
        !migrationDatabase
      ) {
        errorMessage = `Migration database is not configured for source '${authorizationSourceId}'`;
        success = false;
        return createToolErrorResponse(errorMessage, "MIGRATION_DATABASE_NOT_CONFIGURED", {
          source_id: authorizationSourceId,
        });
      }
      const writeAuthorization = configuredReadonly
        ? await authorizeTemporaryWrite(
            accessDecision,
            temporaryWriteMode,
            authorizationSourceId,
            migrationDatabase
          )
        : { effectiveReadonly: toolConfig?.readonly, lease: null };

      if ("errorResponse" in writeAuthorization) {
        success = false;
        errorMessage = writeAuthorization.errorMessage;
        return writeAuthorization.errorResponse;
      }

      // Execute the SQL (single or multiple statements) if validation passed
      const executeOptions: ExecuteOptions = {
        readonly: writeAuthorization.effectiveReadonly,
        maxRows: toolConfig?.max_rows,
        ...(migrationDatabase ? { database: migrationDatabase } : {}),
      };
      result = await connector.executeSQL(sql, executeOptions);

      // Build response data
      const responseData = {
        rows: result.rows,
        count: result.rowCount,
        source_id: effectiveSourceId,
        ...(result.messages && result.messages.length > 0 ? { messages: result.messages } : {}),
        ...(writeAuthorization.lease
          ? {
              write_access: {
                expires_at: writeAuthorization.lease.expires_at,
              },
            }
          : {}),
      };

      return createToolSuccessResponse(responseData);
    } catch (error) {
      success = false;
      errorMessage = (error as Error).message;
      const classified = tryClassifyConnectionError(error, sourceId, effectiveSourceId);
      if (classified) return classified;
      return createToolErrorResponse(errorMessage, "EXECUTION_ERROR");
    } finally {
      // Track the request
      trackToolRequest(
        {
          sourceId: effectiveSourceId,
          toolName:
            effectiveSourceId === "default" ? "execute_sql" : `execute_sql_${effectiveSourceId}`,
          sql,
        },
        startTime,
        extra,
        success,
        errorMessage
      );
    }
  };
}

interface AuthorizedWriteAccess {
  effectiveReadonly: boolean | undefined;
  lease: WriteLease | null;
}

interface DeniedWriteAccess {
  errorMessage: string;
  errorResponse: ReturnType<typeof createToolErrorResponse>;
}

async function authorizeTemporaryWrite(
  decision: SqlAccessDecision,
  temporaryWriteMode: TemporaryWriteMode,
  sourceId: string,
  migrationDatabase?: string
): Promise<AuthorizedWriteAccess | DeniedWriteAccess> {
  if (decision.kind === "read") {
    return { effectiveReadonly: true, lease: null };
  }

  if (decision.kind === "denied") {
    const errorMessage = describeDeniedWrite(decision.reason);
    return {
      errorMessage,
      errorResponse: createToolErrorResponse(errorMessage, "WRITE_OPERATION_NOT_ALLOWED", {
        source_id: sourceId,
        reason: decision.reason,
      }),
    };
  }

  let lease: WriteLease | null;
  try {
    lease = await getActiveWriteLease(sourceId);
  } catch (error) {
    const errorMessage = `Write access state is invalid for source '${sourceId}': ${(error as Error).message}`;
    return {
      errorMessage,
      errorResponse: createToolErrorResponse(errorMessage, "WRITE_ACCESS_STATE_INVALID", {
        source_id: sourceId,
      }),
    };
  }

  if (!lease) {
    const command = formatEnableWriteCommand(sourceId);
    const errorMessage = [
      `Source '${sourceId}' is read-only by default.`,
      "The write operation was not executed.",
      "Ask the user to run this command on the DBHub host:",
      command,
      "Default duration: 10 minutes.",
      "Do not run this authorization command on the user's behalf.",
    ].join("\n");
    return {
      errorMessage,
      errorResponse: createToolErrorResponse(errorMessage, "WRITE_ACCESS_REQUIRED", {
        source_id: sourceId,
        operation: decision.operation,
        temporary_write_mode: temporaryWriteMode,
        ...(migrationDatabase ? { migration_database: migrationDatabase } : {}),
        command,
        default_ttl: "10m",
      }),
    };
  }

  if (!lease.operations.includes(decision.operation)) {
    const errorMessage = `The active write lease for source '${sourceId}' does not allow ${decision.operation.toUpperCase()}`;
    return {
      errorMessage,
      errorResponse: createToolErrorResponse(errorMessage, "WRITE_OPERATION_NOT_ALLOWED", {
        source_id: sourceId,
        operation: decision.operation,
      }),
    };
  }

  return { effectiveReadonly: false, lease };
}

function getMigrationDatabase(
  toolConfig: ToolConfig | undefined,
  sourceId: string
): string | undefined {
  if (toolConfig && "temporary_migration_database" in toolConfig) {
    return toolConfig.temporary_migration_database;
  }
  return ConnectorManager.getSourceConfig(sourceId)?.database;
}

function describeDeniedWrite(
  reason: Extract<SqlAccessDecision, { kind: "denied" }>["reason"]
): string {
  switch (reason) {
    case "empty_sql":
      return "SQL must contain at least one executable statement";
    case "multiple_write_statements":
      return "Temporary write access allows exactly one write statement per request";
    case "where_required":
      return "Temporary write access requires UPDATE and DELETE statements to include a top-level WHERE clause";
    case "operation_not_allowed":
      return "Temporary write access allows only INSERT, UPDATE, and DELETE; DDL and administrative operations remain blocked";
    case "cross_database_target":
      return "Temporary migration access requires every write target to use the source's default database without database qualification";
    case "migration_sequence_invalid":
      return "Temporary migration access requires each prepared statement to be created from a validated local variable, executed once, and deallocated in the same request";
    case "migration_statement_not_allowed":
      return "Temporary migration access allows only guarded forward CREATE TABLE, ALTER TABLE ADD, and CREATE INDEX operations";
  }
}
