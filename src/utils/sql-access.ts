import type { ConnectorType } from "../connectors/interface.js";
import type { TemporaryWriteMode } from "../types/config.js";
import { isReadOnlySQL } from "./allowed-keywords.js";
import { classifyMigrationSql, type MigrationDeniedReason } from "./migration-sql-access.js";
import { splitSQLStatements, stripCommentsAndStrings } from "./sql-parser.js";
import type { WriteOperation } from "../write-access/index.js";

export type SqlAccessDecision =
  | { kind: "read" }
  | { kind: "write"; operation: WriteOperation | "migration" }
  | {
      kind: "denied";
      reason:
        | "empty_sql"
        | "multiple_write_statements"
        | "operation_not_allowed"
        | "where_required"
        | MigrationDeniedReason;
    };

interface TopLevelWord {
  value: string;
  offset: number;
}

const ALLOWED_WRITE_OPERATIONS = new Set<WriteOperation>(["insert", "update", "delete"]);
const WRITE_OR_ADMIN_KEYWORDS = new Set([
  ...ALLOWED_WRITE_OPERATIONS,
  "alter",
  "call",
  "create",
  "drop",
  "exec",
  "execute",
  "grant",
  "merge",
  "rename",
  "replace",
  "revoke",
  "truncate",
]);

/**
 * Classifies SQL for the temporary-write policy.
 *
 * Read-only statements remain unrestricted. A lease may unlock exactly one
 * INSERT, UPDATE, or DELETE statement; DDL, routines, administrative commands,
 * multi-statement writes, and unbounded UPDATE/DELETE remain blocked.
 */
export function classifySqlAccess(
  sql: string,
  connectorType: ConnectorType,
  temporaryWriteMode: TemporaryWriteMode = "dml"
): SqlAccessDecision {
  const statements = splitSQLStatements(sql, connectorType);
  if (statements.length === 0) {
    return { kind: "denied", reason: "empty_sql" };
  }
  if (statements.every((statement) => isReadOnlySQL(statement, connectorType))) {
    return { kind: "read" };
  }

  if (temporaryWriteMode === "migration") {
    const migrationDecision = classifyMigrationSql(sql, connectorType);
    return migrationDecision.kind === "migration"
      ? { kind: "write", operation: "migration" }
      : migrationDecision;
  }

  if (temporaryWriteMode === "dml_and_migration") {
    const dmlDecision = classifyDmlAccess(statements, connectorType);
    if (
      dmlDecision.kind === "write" ||
      (dmlDecision.kind === "denied" && dmlDecision.reason === "where_required")
    ) {
      return dmlDecision;
    }
    const migrationDecision = classifyMigrationSql(sql, connectorType);
    return migrationDecision.kind === "migration"
      ? { kind: "write", operation: "migration" }
      : migrationDecision;
  }

  return classifyDmlAccess(statements, connectorType);
}

function classifyDmlAccess(statements: string[], connectorType: ConnectorType): SqlAccessDecision {
  if (statements.length !== 1) {
    return { kind: "denied", reason: "multiple_write_statements" };
  }

  const cleanedSql = stripCommentsAndStrings(statements[0], connectorType).toLowerCase();
  const words = extractTopLevelWords(cleanedSql);
  const firstWord = words[0]?.value;
  if (
    !firstWord ||
    (firstWord !== "with" && !ALLOWED_WRITE_OPERATIONS.has(firstWord as WriteOperation))
  ) {
    return { kind: "denied", reason: "operation_not_allowed" };
  }

  const operationWord = words.find((word) => WRITE_OR_ADMIN_KEYWORDS.has(word.value));
  if (!operationWord || !ALLOWED_WRITE_OPERATIONS.has(operationWord.value as WriteOperation)) {
    return { kind: "denied", reason: "operation_not_allowed" };
  }

  const operation = operationWord.value as WriteOperation;
  if (operation === "update" || operation === "delete") {
    const hasWhereAfterOperation = words.some(
      (word) => word.value === "where" && word.offset > operationWord.offset
    );
    if (!hasWhereAfterOperation) {
      return { kind: "denied", reason: "where_required" };
    }
  }
  return { kind: "write", operation };
}

function extractTopLevelWords(sql: string): TopLevelWord[] {
  const words: TopLevelWord[] = [];
  let parenthesisDepth = 0;
  let index = 0;

  while (index < sql.length) {
    const character = sql[index];
    if (character === "(") {
      parenthesisDepth++;
      index++;
      continue;
    }
    if (character === ")") {
      parenthesisDepth = Math.max(0, parenthesisDepth - 1);
      index++;
      continue;
    }
    if (parenthesisDepth === 0 && isWordStart(character)) {
      const start = index;
      index++;
      while (index < sql.length && isWordPart(sql[index])) {
        index++;
      }
      words.push({ value: sql.slice(start, index), offset: start });
      continue;
    }
    index++;
  }

  return words;
}

function isWordStart(character: string | undefined): boolean {
  return character !== undefined && /[a-z_]/.test(character);
}

function isWordPart(character: string | undefined): boolean {
  return character !== undefined && /[a-z0-9_$]/.test(character);
}
