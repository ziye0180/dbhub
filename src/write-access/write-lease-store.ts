import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

/** Default duration granted when `--ttl` is omitted. */
export const DEFAULT_WRITE_LEASE_TTL_MS = 10 * 60 * 1000;
/** Shortest accepted write lease. */
export const MIN_WRITE_LEASE_TTL_MS = 60 * 1000;
/** Longest accepted write lease. */
export const MAX_WRITE_LEASE_TTL_MS = 60 * 60 * 1000;

/** DML operations authorized by the default temporary lease mode. */
export const WRITE_OPERATIONS = ["insert", "update", "delete"] as const;
/** Forward-migration capability authorized only for configured sources. */
export const MIGRATION_WRITE_OPERATION = "migration" as const;
/** Complete set of capabilities accepted in the persisted lease contract. */
export const WRITE_PERMISSIONS = [...WRITE_OPERATIONS, MIGRATION_WRITE_OPERATION] as const;
/** DML operation classified by the default write policy. */
export type WriteOperation = (typeof WRITE_OPERATIONS)[number];
/** Capability persisted in a source-scoped temporary lease. */
export type WritePermission = (typeof WRITE_PERMISSIONS)[number];

/** Persisted, source-scoped temporary write authorization. */
export interface WriteLease {
  source_id: string;
  operations: readonly WritePermission[];
  enabled_at: string;
  expires_at: string;
}

interface WriteLeaseState {
  version: 1;
  leases: WriteLease[];
}

const writeLeaseSchema = z
  .object({
    source_id: z.string().min(1),
    operations: z.array(z.enum(WRITE_PERMISSIONS)).min(1),
    enabled_at: z.string().datetime(),
    expires_at: z.string().datetime(),
  })
  .strict()
  .superRefine((lease, context) => {
    const enabledAt = Date.parse(lease.enabled_at);
    const expiresAt = Date.parse(lease.expires_at);
    const ttlMs = expiresAt - enabledAt;
    if (ttlMs < MIN_WRITE_LEASE_TTL_MS || ttlMs > MAX_WRITE_LEASE_TTL_MS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Write lease duration must be between 1 minute and 1 hour",
        path: ["expires_at"],
      });
    }
    const isMigrationOnly =
      lease.operations.length === 1 && lease.operations[0] === MIGRATION_WRITE_OPERATION;
    const isCompleteDml =
      lease.operations.length === WRITE_OPERATIONS.length &&
      WRITE_OPERATIONS.every((operation) => lease.operations.includes(operation));
    const isCompleteHybrid =
      lease.operations.length === WRITE_PERMISSIONS.length &&
      WRITE_PERMISSIONS.every((operation) => lease.operations.includes(operation));
    if (!isMigrationOnly && !isCompleteDml && !isCompleteHybrid) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Write lease must contain the complete DML profile, migration only, or the complete hybrid profile",
        path: ["operations"],
      });
    }
  });

const writeLeaseStateSchema = z
  .object({
    version: z.literal(1),
    leases: z.array(writeLeaseSchema),
  })
  .strict()
  .superRefine((state, context) => {
    const sourceIds = new Set<string>();
    for (const [index, lease] of state.leases.entries()) {
      if (sourceIds.has(lease.source_id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate write lease for source '${lease.source_id}'`,
          path: ["leases", index, "source_id"],
        });
      }
      sourceIds.add(lease.source_id);
    }
  });

/**
 * Repository for the host-managed write lease state file.
 *
 * The DBHub server only reads this file. The host CLI writes it atomically so
 * the server never observes partial JSON while deciding whether to allow writes.
 */
export class WriteLeaseStore {
  public constructor(public readonly filePath: string) {}

  /** Enables the supplied configured capability for one source until expiry. */
  public async enable(
    sourceId: string,
    ttlMs: number = DEFAULT_WRITE_LEASE_TTL_MS,
    now: Date = new Date(),
    permissions: readonly WritePermission[] = WRITE_OPERATIONS
  ): Promise<WriteLease> {
    this.validateTtl(ttlMs);
    const state = await this.readState();
    const lease = writeLeaseSchema.parse({
      source_id: sourceId,
      operations: [...permissions],
      enabled_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ttlMs).toISOString(),
    });

    const existingLeaseIndex = state.leases.findIndex(
      (existingLease) => existingLease.source_id === sourceId
    );
    if (existingLeaseIndex === -1) {
      state.leases.push(lease);
    } else {
      state.leases[existingLeaseIndex] = lease;
    }
    await this.writeState(state);
    return lease;
  }

  /** Removes the lease for one source and returns whether a lease existed. */
  public async disable(sourceId: string): Promise<boolean> {
    const state = await this.readState();
    const leaseIndex = state.leases.findIndex((lease) => lease.source_id === sourceId);
    if (leaseIndex === -1) {
      return false;
    }

    state.leases.splice(leaseIndex, 1);
    await this.writeState(state);
    return true;
  }

  /** Returns an unexpired lease for the source, or null when write access is closed. */
  public async getActive(sourceId: string, now: Date = new Date()): Promise<WriteLease | null> {
    const state = await this.readState();
    const lease = state.leases.find((candidate) => candidate.source_id === sourceId);
    if (
      !lease ||
      Date.parse(lease.enabled_at) > now.getTime() ||
      Date.parse(lease.expires_at) <= now.getTime()
    ) {
      return null;
    }
    return lease;
  }

  /** Lists only leases that are active at the supplied time. */
  public async listActive(now: Date = new Date()): Promise<WriteLease[]> {
    const state = await this.readState();
    return state.leases
      .filter(
        (lease) =>
          Date.parse(lease.enabled_at) <= now.getTime() &&
          Date.parse(lease.expires_at) > now.getTime()
      )
      .sort((left, right) => left.source_id.localeCompare(right.source_id));
  }

  private validateTtl(ttlMs: number): void {
    if (
      !Number.isSafeInteger(ttlMs) ||
      ttlMs < MIN_WRITE_LEASE_TTL_MS ||
      ttlMs > MAX_WRITE_LEASE_TTL_MS
    ) {
      throw new Error("Write lease TTL must be between 1 minute and 60 minutes");
    }
  }

  private async readState(): Promise<WriteLeaseState> {
    let rawState: string;
    try {
      rawState = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { version: 1, leases: [] };
      }
      throw new Error(`Failed to read write lease state '${this.filePath}'`, { cause: error });
    }

    try {
      return writeLeaseStateSchema.parse(JSON.parse(rawState));
    } catch (error) {
      throw new Error(`Invalid write lease state '${this.filePath}'`, { cause: error });
    }
  }

  private async writeState(state: WriteLeaseState): Promise<void> {
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);

    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporaryPath, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    } catch (error) {
      const cleanupFailures: string[] = [];
      if (handle) {
        try {
          await handle.close();
        } catch (cleanupError) {
          cleanupFailures.push(`close: ${describeError(cleanupError)}`);
        }
      }
      try {
        await fs.rm(temporaryPath, { force: true });
      } catch (cleanupError) {
        cleanupFailures.push(`remove temporary file: ${describeError(cleanupError)}`);
      }

      const cleanupContext =
        cleanupFailures.length > 0 ? `; cleanup failures: ${cleanupFailures.join("; ")}` : "";
      throw new Error(`Failed to write write lease state '${this.filePath}'${cleanupContext}`, {
        cause: error,
      });
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
