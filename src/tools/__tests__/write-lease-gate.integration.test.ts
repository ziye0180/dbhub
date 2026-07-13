import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectorManager } from "../../connectors/manager.js";
import type { Connector } from "../../connectors/interface.js";
import { getToolRegistry, type ToolRegistry } from "../registry.js";
import { createExecuteSqlToolHandler } from "../execute-sql.js";
import { WRITE_LEASE_FILE_NAME, WriteLeaseStore } from "../../write-access/index.js";

vi.mock("../../connectors/manager.js");
vi.mock("../registry.js");

describe("write lease file to execute_sql integration", () => {
  let stateDirectory: string;
  let originalStateDirectory: string | undefined;
  const executeSQL = vi.fn();

  beforeAll(async () => {
    stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dbhub-write-gate-"));
    originalStateDirectory = process.env.DBHUB_STATE_DIR;
    process.env.DBHUB_STATE_DIR = stateDirectory;
  });

  afterAll(async () => {
    if (originalStateDirectory === undefined) {
      delete process.env.DBHUB_STATE_DIR;
    } else {
      process.env.DBHUB_STATE_DIR = originalStateDirectory;
    }
    await fs.rm(stateDirectory, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ConnectorManager.ensureConnected).mockResolvedValue(undefined);
    vi.mocked(ConnectorManager.getCurrentConnector).mockReturnValue({
      id: "sqlite",
      getId: () => "leased",
      executeSQL,
    } as unknown as Connector);
    vi.mocked(getToolRegistry).mockReturnValue({
      getBuiltinToolConfig: () => ({ name: "execute_sql", source: "leased", readonly: true }),
    } as unknown as ToolRegistry);
    executeSQL.mockResolvedValue({ rows: [], rowCount: 1 });
  });

  it("moves from read-only to writable after the host creates a lease", async () => {
    const handler = createExecuteSqlToolHandler("leased");
    const sql = "INSERT INTO users (name) VALUES ('test')";

    const denied = await handler({ sql }, null);
    expect(JSON.parse(denied.content[0].text).code).toBe("WRITE_ACCESS_REQUIRED");
    expect(executeSQL).not.toHaveBeenCalled();

    const store = new WriteLeaseStore(path.join(stateDirectory, WRITE_LEASE_FILE_NAME));
    await store.enable("leased", undefined, new Date(Date.now() - 11 * 60 * 1000));

    const expired = await handler({ sql }, null);
    expect(JSON.parse(expired.content[0].text).code).toBe("WRITE_ACCESS_REQUIRED");
    expect(executeSQL).not.toHaveBeenCalled();

    await store.enable("leased");

    const allowed = await handler({ sql }, null);
    expect(JSON.parse(allowed.content[0].text).success).toBe(true);
    expect(executeSQL).toHaveBeenCalledWith(sql, { readonly: false, maxRows: undefined });
  });
});
