import type { ConnectorType } from "../connectors/interface.js";
import { isReadOnlySQL } from "./allowed-keywords.js";
import { splitSQLStatements, stripCommentsAndStrings } from "./sql-parser.js";

export type MigrationDeniedReason =
  | "cross_database_target"
  | "migration_sequence_invalid"
  | "migration_statement_not_allowed";

export type MigrationAccessDecision =
  | { kind: "migration" }
  | { kind: "denied"; reason: MigrationDeniedReason };

interface PreparedStatementState {
  variableName: string;
  hasExecuted: boolean;
}

const IDENTIFIER = "(?:`(?:``|[^`])+`|[A-Za-z_][A-Za-z0-9_$]*)";
const QUALIFIED_IDENTIFIER = `${IDENTIFIER}(?:\\s*\\.\\s*${IDENTIFIER})?`;
const CREATE_TABLE_PATTERN = new RegExp(
  `^\\s*CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${QUALIFIED_IDENTIFIER})`,
  "i"
);
const ALTER_TABLE_PATTERN = new RegExp(`^\\s*ALTER\\s+TABLE\\s+(${QUALIFIED_IDENTIFIER})`, "i");
const CREATE_INDEX_PATTERN = new RegExp(
  `^\\s*CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+${IDENTIFIER}\\s+ON\\s+(${QUALIFIED_IDENTIFIER})`,
  "i"
);
const REFERENCES_PATTERN = new RegExp(`\\bREFERENCES\\s+(${QUALIFIED_IDENTIFIER})`, "gi");
const RENAME_TARGET_PATTERN = new RegExp(`\\bRENAME\\s+(?:TO\\s+)?(${QUALIFIED_IDENTIFIER})`, "i");
const SET_IF_PATTERN = /^\s*SET\s+(@[A-Za-z_][A-Za-z0-9_$]*)\s*:=\s*IF\s*\((.*)\)\s*$/is;
const PREPARE_PATTERN = /^\s*PREPARE\s+([A-Za-z_][A-Za-z0-9_$]*)\s+FROM\s+(@[A-Za-z_][A-Za-z0-9_$]*)\s*$/i;
const EXECUTE_PATTERN = /^\s*EXECUTE\s+([A-Za-z_][A-Za-z0-9_$]*)\s*$/i;
const DEALLOCATE_PATTERN = /^\s*DEALLOCATE\s+PREPARE\s+([A-Za-z_][A-Za-z0-9_$]*)\s*$/i;
const UNSAFE_CONDITION_KEYWORDS =
  /\b(?:alter|benchmark|call|create|delete|drop|dumpfile|execute|grant|insert|into|load_file|outfile|prepare|replace|revoke|sleep|truncate|union|update|use)\b/i;
const UNSAFE_CREATE_TABLE_KEYWORDS =
  /\b(?:AS\s+SELECT|DATA\s+DIRECTORY|INDEX\s+DIRECTORY|LIKE|TABLESPACE)\b/i;
const UNSAFE_ALTER_TABLE_KEYWORDS =
  /\b(?:ALTER|CHANGE|CONVERT|DISABLE|DISCARD|DROP|ENABLE|EXCHANGE|FORCE|IMPORT|MODIFY|ORDER|RENAME)\b/i;
const SQL_STRING_LITERAL = "'(?:''|[^'])*'";
const METADATA_CONDITION_PATTERN = new RegExp(
  `^\\s*\\(\\s*SELECT\\s+COUNT\\s*\\(\\s*(?:1|\\*)\\s*\\)\\s+` +
    `FROM\\s+INFORMATION_SCHEMA\\s*\\.\\s*(COLUMNS|STATISTICS|TABLES)\\s+` +
    `WHERE\\s+TABLE_SCHEMA\\s*=\\s*DATABASE\\s*\\(\\s*\\)\\s+` +
    `AND\\s+TABLE_NAME\\s*=\\s*(${SQL_STRING_LITERAL})` +
    `(?:\\s+AND\\s+(COLUMN_NAME|INDEX_NAME)\\s*=\\s*(${SQL_STRING_LITERAL}))?` +
    `\\s*\\)\\s*=\\s*0\\s*$`,
  "i"
);

/**
 * Validates a forward-only MySQL/MariaDB migration batch.
 *
 * The grammar intentionally accepts only direct CREATE TABLE, ALTER TABLE ADD,
 * CREATE INDEX, read-only statements, and a closed guarded prepared-statement
 * sequence. Database-qualified write targets and destructive DDL fail closed.
 */
export function classifyMigrationSql(
  sql: string,
  connectorType: ConnectorType
): MigrationAccessDecision {
  if (connectorType !== "mysql" && connectorType !== "mariadb") {
    return denied("migration_statement_not_allowed");
  }

  const statements = splitSQLStatements(sql, connectorType);
  if (statements.length === 0) {
    return denied("migration_statement_not_allowed");
  }

  const safeVariables = new Set<string>();
  const preparedStatements = new Map<string, PreparedStatementState>();

  for (const statement of statements) {
    if (isReadOnlySQL(statement, connectorType)) {
      if (/^\s*SELECT\s+1\s*$/i.test(statement)) {
        continue;
      }
      return denied("migration_statement_not_allowed");
    }

    const directDdlDecision = classifyDirectDdl(statement, connectorType);
    if (directDdlDecision === "allowed") {
      continue;
    }
    if (directDdlDecision === "cross_database_target") {
      return denied(directDdlDecision);
    }

    const setDecision = classifyGuardedSet(statement, connectorType);
    if (setDecision.kind === "safe_set") {
      safeVariables.add(setDecision.variableName.toLowerCase());
      continue;
    }
    if (setDecision.kind === "denied") {
      return denied(setDecision.reason);
    }

    const prepareMatch = PREPARE_PATTERN.exec(statement);
    if (prepareMatch) {
      const statementName = prepareMatch[1].toLowerCase();
      const variableName = prepareMatch[2].toLowerCase();
      if (!safeVariables.delete(variableName) || preparedStatements.has(statementName)) {
        return denied("migration_sequence_invalid");
      }
      preparedStatements.set(statementName, { variableName, hasExecuted: false });
      continue;
    }

    const executeMatch = EXECUTE_PATTERN.exec(statement);
    if (executeMatch) {
      const prepared = preparedStatements.get(executeMatch[1].toLowerCase());
      if (!prepared || prepared.hasExecuted) {
        return denied("migration_sequence_invalid");
      }
      prepared.hasExecuted = true;
      continue;
    }

    const deallocateMatch = DEALLOCATE_PATTERN.exec(statement);
    if (deallocateMatch) {
      const statementName = deallocateMatch[1].toLowerCase();
      const prepared = preparedStatements.get(statementName);
      if (!prepared?.hasExecuted) {
        return denied("migration_sequence_invalid");
      }
      preparedStatements.delete(statementName);
      continue;
    }

    if (/^\s*(?:PREPARE|EXECUTE|DEALLOCATE)\b/i.test(statement)) {
      return denied("migration_sequence_invalid");
    }
    return denied("migration_statement_not_allowed");
  }

  if (safeVariables.size > 0 || preparedStatements.size > 0) {
    return denied("migration_sequence_invalid");
  }
  return { kind: "migration" };
}

type DirectDdlDecision = "allowed" | "not_ddl" | "cross_database_target";

function classifyDirectDdl(
  statement: string,
  connectorType: ConnectorType
): DirectDdlDecision {
  const createTableMatch = CREATE_TABLE_PATTERN.exec(statement);
  if (createTableMatch) {
    if (isQualified(createTableMatch[1]) || hasQualifiedReference(statement)) {
      return "cross_database_target";
    }
    const normalized = stripCommentsAndStrings(statement, connectorType);
    const normalizedTail = stripCommentsAndStrings(
      statement.slice(createTableMatch[0].length),
      connectorType
    );
    const engine = /\bENGINE\s*=\s*([A-Za-z0-9_]+)/i.exec(normalized)?.[1];
    if (
      UNSAFE_CREATE_TABLE_KEYWORDS.test(normalized) ||
      /\bSELECT\b/i.test(normalizedTail) ||
      (engine !== undefined && engine.toLowerCase() !== "innodb")
    ) {
      return "not_ddl";
    }
    return "allowed";
  }

  const alterTableMatch = ALTER_TABLE_PATTERN.exec(statement);
  if (alterTableMatch) {
    if (isQualified(alterTableMatch[1]) || hasQualifiedReference(statement)) {
      return "cross_database_target";
    }
    const alterActions = splitTopLevelArguments(statement.slice(alterTableMatch[0].length));
    const hasOnlyAddActions =
      alterActions.length > 0 &&
      alterActions.every((action) => {
        const normalizedAction = stripCommentsAndStrings(action, connectorType);
        return (
          /^\s*ADD\b/i.test(normalizedAction) &&
          !UNSAFE_ALTER_TABLE_KEYWORDS.test(normalizedAction)
        );
      });
    if (!hasOnlyAddActions) {
      const renameMatch = RENAME_TARGET_PATTERN.exec(statement);
      return renameMatch && isQualified(renameMatch[1])
        ? "cross_database_target"
        : "not_ddl";
    }
    return "allowed";
  }

  const createIndexMatch = CREATE_INDEX_PATTERN.exec(statement);
  if (createIndexMatch) {
    return isQualified(createIndexMatch[1]) ? "cross_database_target" : "allowed";
  }

  return "not_ddl";
}

type GuardedSetDecision =
  | { kind: "not_set" }
  | { kind: "safe_set"; variableName: string }
  | { kind: "denied"; reason: MigrationDeniedReason };

function classifyGuardedSet(
  statement: string,
  connectorType: ConnectorType
): GuardedSetDecision {
  if (!/^\s*SET\b/i.test(statement)) {
    return { kind: "not_set" };
  }

  const match = SET_IF_PATTERN.exec(statement);
  if (!match) {
    return { kind: "denied", reason: "migration_statement_not_allowed" };
  }
  const ifArguments = splitTopLevelArguments(match[2]);
  if (ifArguments.length !== 3 || !isSafeMetadataCondition(ifArguments[0])) {
    return { kind: "denied", reason: "migration_statement_not_allowed" };
  }

  for (const branch of ifArguments.slice(1)) {
    const branchSql = parseSingleQuotedLiteral(branch);
    if (!branchSql) {
      return { kind: "denied", reason: "migration_statement_not_allowed" };
    }
    if (/^\s*SELECT\s+1\s*$/i.test(branchSql)) {
      continue;
    }
    const decision = classifyDirectDdl(branchSql, connectorType);
    if (decision !== "allowed") {
      return {
        kind: "denied",
        reason:
          decision === "cross_database_target"
            ? "cross_database_target"
            : "migration_statement_not_allowed",
      };
    }
  }

  return { kind: "safe_set", variableName: match[1] };
}

function isSafeMetadataCondition(condition: string): boolean {
  if (UNSAFE_CONDITION_KEYWORDS.test(condition)) {
    return false;
  }

  const match = METADATA_CONDITION_PATTERN.exec(condition);
  if (!match) {
    return false;
  }

  const metadataTable = match[1].toUpperCase();
  const objectField = match[3]?.toUpperCase();
  return (
    (metadataTable === "COLUMNS" && objectField === "COLUMN_NAME") ||
    (metadataTable === "STATISTICS" && objectField === "INDEX_NAME") ||
    (metadataTable === "TABLES" && objectField === undefined)
  );
}

function splitTopLevelArguments(value: string): string[] {
  const argumentsList: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;

  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (quote) {
      if (character === quote && value[index + 1] === quote) {
        index++;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") {
      depth++;
      continue;
    }
    if (character === ")") {
      depth--;
      if (depth < 0) {
        return [];
      }
      continue;
    }
    if (character === "," && depth === 0) {
      argumentsList.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }

  if (quote || depth !== 0) {
    return [];
  }
  argumentsList.push(value.slice(start).trim());
  return argumentsList;
}

function parseSingleQuotedLiteral(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed[0] !== "'" || trimmed.at(-1) !== "'") {
    return null;
  }
  const body = trimmed.slice(1, -1);
  for (let index = 0; index < body.length; index++) {
    if (body[index] !== "'") {
      continue;
    }
    if (body[index + 1] !== "'") {
      return null;
    }
    index++;
  }
  return body.replace(/''/g, "'");
}

function hasQualifiedReference(statement: string): boolean {
  REFERENCES_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REFERENCES_PATTERN.exec(statement)) !== null) {
    if (isQualified(match[1])) {
      return true;
    }
  }
  return false;
}

function isQualified(identifier: string): boolean {
  return /\./.test(identifier);
}

function denied(reason: MigrationDeniedReason): MigrationAccessDecision {
  return { kind: "denied", reason };
}
