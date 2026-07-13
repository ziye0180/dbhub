import path from "node:path";

import { resolveTomlConfigPath } from "../config/toml-loader.js";
import { WriteLeaseStore, type WriteLease } from "./write-lease-store.js";

export const WRITE_LEASE_FILE_NAME = "write-leases.json";

/** Formats the user-facing enable command without exposing shell metacharacters. */
export function formatEnableWriteCommand(sourceId: string): string {
  const shellArgument = /^[a-zA-Z0-9._-]+$/.test(sourceId)
    ? sourceId
    : `'${sourceId.replaceAll("'", `'\\''`)}'`;
  return `dbhub enable ${shellArgument}`;
}

/** Resolves the lease file beside the active dbhub.toml under a private .dbhub directory. */
export function resolveWriteLeaseFilePath(): string {
  const configuredStateDirectory = process.env.DBHUB_STATE_DIR?.trim();
  if (configuredStateDirectory) {
    return path.join(configuredStateDirectory, WRITE_LEASE_FILE_NAME);
  }

  const configPath = resolveTomlConfigPath();
  const baseDirectory = configPath ? path.dirname(configPath) : process.cwd();
  return path.join(baseDirectory, ".dbhub", WRITE_LEASE_FILE_NAME);
}

/** Reads the current host-issued write lease for a source. */
export async function getActiveWriteLease(
  sourceId: string,
  now: Date = new Date()
): Promise<WriteLease | null> {
  const store = new WriteLeaseStore(resolveWriteLeaseFilePath());
  return store.getActive(sourceId, now);
}
