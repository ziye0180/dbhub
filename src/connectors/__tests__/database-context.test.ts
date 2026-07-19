import { describe, expect, it, vi } from "vitest";

import { executeInDatabaseContext } from "../database-context.js";

describe("executeInDatabaseContext", () => {
  it("executes ordinary operations without changing the default database", async () => {
    const connection = {
      changeUser: vi.fn(),
      destroy: vi.fn(),
      release: vi.fn(),
    };
    const operation = vi.fn(async () => "ok");

    await expect(
      executeInDatabaseContext(connection, "awaken_payment", undefined, operation)
    ).resolves.toBe("ok");

    expect(connection.changeUser).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
    expect(connection.destroy).not.toHaveBeenCalled();
  });

  it("switches to the migration database and restores the default before release", async () => {
    const events: string[] = [];
    const connection = {
      changeUser: vi.fn(async ({ database }: { database: string }) => {
        events.push(`database:${database}`);
      }),
      destroy: vi.fn(),
      release: vi.fn(() => events.push("release")),
    };

    const result = await executeInDatabaseContext(
      connection,
      "awaken_payment",
      "awaken_pro_prod",
      async () => {
        events.push("execute");
        return "ok";
      }
    );

    expect(result).toBe("ok");
    expect(events).toEqual([
      "database:awaken_pro_prod",
      "execute",
      "database:awaken_payment",
      "release",
    ]);
    expect(connection.destroy).not.toHaveBeenCalled();
  });

  it("restores the default database when execution fails", async () => {
    const connection = {
      changeUser: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(),
      release: vi.fn(),
    };
    const executionError = new Error("migration failed");

    await expect(
      executeInDatabaseContext(
        connection,
        "awaken_payment",
        "awaken_pro_prod",
        async () => {
          throw executionError;
        }
      )
    ).rejects.toBe(executionError);

    expect(connection.changeUser).toHaveBeenNthCalledWith(2, {
      database: "awaken_payment",
    });
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it("destroys a connection that cannot restore its default database", async () => {
    const connection = {
      changeUser: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("restore failed")),
      destroy: vi.fn(),
      release: vi.fn(),
    };

    await expect(
      executeInDatabaseContext(
        connection,
        "awaken_payment",
        "awaken_pro_prod",
        async () => "ok"
      )
    ).rejects.toThrow("Failed to restore database context");

    expect(connection.destroy).toHaveBeenCalledOnce();
    expect(connection.release).not.toHaveBeenCalled();
  });

  it("destroys the connection when the initial database switch fails", async () => {
    const connection = {
      changeUser: vi.fn().mockRejectedValue(new Error("switch failed")),
      destroy: vi.fn(),
      release: vi.fn(),
    };
    const operation = vi.fn(async () => "not reached");

    await expect(
      executeInDatabaseContext(
        connection,
        "awaken_payment",
        "awaken_pro_prod",
        operation
      )
    ).rejects.toThrow("Failed to switch database context");

    expect(operation).not.toHaveBeenCalled();
    expect(connection.destroy).toHaveBeenCalledOnce();
    expect(connection.release).not.toHaveBeenCalled();
  });
});
