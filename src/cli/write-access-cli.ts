import type { ConnectorType } from "../connectors/interface.js";
import {
  DEFAULT_WRITE_LEASE_TTL_MS,
  MAX_WRITE_LEASE_TTL_MS,
  MIGRATION_WRITE_OPERATION,
  WRITE_OPERATIONS,
  WriteLeaseStore,
} from "../write-access/index.js";
import type { TemporaryWriteMode } from "../types/config.js";
import type { WritePermission } from "../write-access/index.js";

const WRITE_ACCESS_COMMANDS = new Set(["enable", "disable", "status"]);

/** Runtime dependencies used by the write-access command dispatcher. */
export interface WriteAccessCliDependencies {
  store: WriteLeaseStore;
  sources: ReadonlyMap<string, WriteAccessSource>;
  now: () => Date;
  writeOutput: (message: string) => void;
}

/** SQL capability facts needed to validate one configured source. */
export interface WriteAccessSource {
  type: ConnectorType | "redis";
  executeSqlEnabled: boolean;
  readonly: boolean;
  temporaryWriteMode?: TemporaryWriteMode;
}

/** Returns whether the first positional argument is a write-access command. */
export function isWriteAccessCommand(args: readonly string[]): boolean {
  const command = args[0];
  return command !== undefined && WRITE_ACCESS_COMMANDS.has(command);
}

/** Executes enable, disable, or status against the host-managed lease store. */
export async function executeWriteAccessCommand(
  args: readonly string[],
  dependencies: WriteAccessCliDependencies
): Promise<number> {
  const command = args[0];
  switch (command) {
    case "enable":
      return enableSource(args.slice(1), dependencies);
    case "disable":
      return disableSource(args.slice(1), dependencies);
    case "status":
      return showStatus(args.slice(1), dependencies);
    default:
      throw new Error(`Unsupported DBHub command '${command ?? ""}'`);
  }
}

async function enableSource(
  args: readonly string[],
  dependencies: WriteAccessCliDependencies
): Promise<number> {
  const sourceId = requireSourceId(args, "enable");
  requireLeaseManagedSource(sourceId, dependencies.sources);
  const ttlMs = parseTtlArgument(args);
  const now = dependencies.now();
  const source = dependencies.sources.get(sourceId)!;
  const permissions = getPermissions(source.temporaryWriteMode ?? "dml");
  const lease = await dependencies.store.enable(sourceId, ttlMs, now, permissions);
  const durationMinutes = ttlMs / 60_000;

  dependencies.writeOutput(
    [
      "Write access enabled",
      "",
      `Source: ${sourceId}`,
      `Operations: ${formatPermissions(lease.operations)}`,
      `Expires in: ${durationMinutes} ${durationMinutes === 1 ? "minute" : "minutes"}`,
      `Expires at: ${lease.expires_at}`,
    ].join("\n")
  );
  return 0;
}

async function disableSource(
  args: readonly string[],
  dependencies: WriteAccessCliDependencies
): Promise<number> {
  const sourceId = requireSourceId(args, "disable");
  requireLeaseManagedSource(sourceId, dependencies.sources);
  const removed = await dependencies.store.disable(sourceId);
  dependencies.writeOutput(
    removed
      ? `Write access disabled for source '${sourceId}'.`
      : `Source '${sourceId}' is already read-only.`
  );
  return 0;
}

async function showStatus(
  args: readonly string[],
  dependencies: WriteAccessCliDependencies
): Promise<number> {
  if (args.length > 0) {
    throw new Error("Usage: dbhub status");
  }

  const now = dependencies.now();
  const activeLeases = new Map(
    (await dependencies.store.listActive(now)).map((lease) => [lease.source_id, lease])
  );
  const rows = [...dependencies.sources.entries()]
    .filter(([, source]) => source.type !== "redis" && source.executeSqlEnabled)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sourceId, source]) => {
      if (!source.readonly) {
        return `${sourceId}\twritable-configured\t-`;
      }
      const lease = activeLeases.get(sourceId);
      return lease
        ? `${sourceId}\twritable:${formatPermissionMode(lease.operations)}\t${lease.expires_at}`
        : `${sourceId}\treadonly\t-`;
    });

  dependencies.writeOutput(["SOURCE\tMODE\tEXPIRES", ...rows].join("\n"));
  return 0;
}

function getPermissions(mode: TemporaryWriteMode): readonly WritePermission[] {
  return mode === "migration" ? [MIGRATION_WRITE_OPERATION] : WRITE_OPERATIONS;
}

function formatPermissions(permissions: readonly WritePermission[]): string {
  return permissions
    .map((permission) =>
      permission === MIGRATION_WRITE_OPERATION ? "MIGRATION" : permission.toUpperCase()
    )
    .join(", ");
}

function formatPermissionMode(permissions: readonly WritePermission[]): TemporaryWriteMode {
  return permissions.includes(MIGRATION_WRITE_OPERATION) ? "migration" : "dml";
}

function requireSourceId(args: readonly string[], command: "enable" | "disable"): string {
  const sourceId = args[0];
  if (!sourceId || sourceId.startsWith("--")) {
    const ttlUsage = command === "enable" ? " [--ttl <duration>]" : "";
    throw new Error(`Usage: dbhub ${command} <source>${ttlUsage}`);
  }
  return sourceId;
}

function requireLeaseManagedSource(
  sourceId: string,
  sources: ReadonlyMap<string, WriteAccessSource>
): void {
  const source = sources.get(sourceId);
  if (!source) {
    throw new Error(`Unknown source '${sourceId}'`);
  }
  if (source.type === "redis") {
    throw new Error(`Source '${sourceId}' does not support SQL write leases`);
  }
  if (!source.executeSqlEnabled) {
    throw new Error(`Source '${sourceId}' does not expose execute_sql`);
  }
  if (!source.readonly) {
    throw new Error(
      `Source '${sourceId}' is permanently writable; set readonly = true before using temporary write leases`
    );
  }
}

function parseTtlArgument(args: readonly string[]): number {
  const remainingArgs = args.slice(1);
  if (remainingArgs.length === 0) {
    return DEFAULT_WRITE_LEASE_TTL_MS;
  }

  let rawTtl: string | undefined;
  if (remainingArgs[0] === "--ttl") {
    rawTtl = remainingArgs[1];
    if (remainingArgs.length !== 2) {
      throw new Error("Usage: dbhub enable <source> [--ttl <duration>]");
    }
  } else if (remainingArgs[0]?.startsWith("--ttl=")) {
    rawTtl = remainingArgs[0].slice("--ttl=".length);
    if (remainingArgs.length !== 1) {
      throw new Error("Usage: dbhub enable <source> [--ttl <duration>]");
    }
  } else {
    throw new Error("Usage: dbhub enable <source> [--ttl <duration>]");
  }

  if (!rawTtl) {
    throw new Error("TTL is required after --ttl");
  }
  return parseTtl(rawTtl);
}

/** Parses whole-minute or whole-hour TTLs with a maximum duration of one hour. */
export function parseTtl(rawTtl: string): number {
  const match = /^(\d+)(m|h)$/.exec(rawTtl.trim().toLowerCase());
  if (!match) {
    throw new Error("TTL must use whole minutes or hours, for example 10m or 1h");
  }

  const amount = Number(match[1]);
  const ttlMs = amount * (match[2] === "h" ? 60 * 60 * 1000 : 60 * 1000);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_WRITE_LEASE_TTL_MS) {
    throw new Error("TTL must be between 1 minute and 1 hour");
  }
  return ttlMs;
}
