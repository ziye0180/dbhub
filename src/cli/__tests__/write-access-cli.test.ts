import { describe, expect, it, vi } from "vitest";

import { executeWriteAccessCommand } from "../write-access-cli.js";
import type { WriteLeaseStore } from "../../write-access/write-lease-store.js";

describe("write-access CLI", () => {
  it("enables a SQL source for ten minutes when ttl is omitted", async () => {
    const enable = vi.fn().mockResolvedValue({
      source_id: "awakening",
      operations: ["insert", "update", "delete"],
      enabled_at: "2026-07-13T12:00:00.000Z",
      expires_at: "2026-07-13T12:10:00.000Z",
    });
    const output: string[] = [];

    const exitCode = await executeWriteAccessCommand(["enable", "awakening"], {
      store: { enable } as unknown as WriteLeaseStore,
      sources: new Map([["awakening", { type: "mysql", executeSqlEnabled: true, readonly: true }]]),
      now: () => new Date("2026-07-13T12:00:00.000Z"),
      writeOutput: (message) => output.push(message),
    });

    expect(exitCode).toBe(0);
    expect(enable).toHaveBeenCalledWith(
      "awakening",
      600_000,
      expect.any(Date),
      ["insert", "update", "delete"]
    );
    expect(output.join("\n")).toContain("10 minutes");
  });

  it("uses the unchanged enable command to issue a migration-only lease", async () => {
    const enable = vi.fn().mockResolvedValue({
      source_id: "awaken_pro_prod",
      operations: ["migration"],
      enabled_at: "2026-07-13T12:00:00.000Z",
      expires_at: "2026-07-13T12:10:00.000Z",
    });
    const output: string[] = [];

    await executeWriteAccessCommand(["enable", "awaken_pro_prod"], {
      store: { enable } as unknown as WriteLeaseStore,
      sources: new Map([
        [
          "awaken_pro_prod",
          {
            type: "mysql",
            executeSqlEnabled: true,
            readonly: true,
            temporaryWriteMode: "migration",
          },
        ],
      ]),
      now: () => new Date("2026-07-13T12:00:00.000Z"),
      writeOutput: (message) => output.push(message),
    });

    expect(enable).toHaveBeenCalledWith(
      "awaken_pro_prod",
      600_000,
      expect.any(Date),
      ["migration"]
    );
    expect(output.join("\n")).toContain("MIGRATION");
  });

  it("uses the unchanged cognitive command to issue a hybrid lease", async () => {
    const enable = vi.fn().mockResolvedValue({
      source_id: "cognitive",
      operations: ["insert", "update", "delete", "migration"],
      enabled_at: "2026-07-13T12:00:00.000Z",
      expires_at: "2026-07-13T12:10:00.000Z",
    });
    const output: string[] = [];

    await executeWriteAccessCommand(["enable", "cognitive"], {
      store: { enable } as unknown as WriteLeaseStore,
      sources: new Map([
        [
          "cognitive",
          {
            type: "mysql",
            executeSqlEnabled: true,
            readonly: true,
            temporaryWriteMode: "dml_and_migration",
          },
        ],
      ]),
      now: () => new Date("2026-07-13T12:00:00.000Z"),
      writeOutput: (message) => output.push(message),
    });

    expect(enable).toHaveBeenCalledWith(
      "cognitive",
      600_000,
      expect.any(Date),
      ["insert", "update", "delete", "migration"]
    );
    expect(output.join("\n")).toContain("INSERT, UPDATE, DELETE, MIGRATION");
  });

  it("rejects an unknown source", async () => {
    await expect(
      executeWriteAccessCommand(["enable", "missing"], {
        store: {} as WriteLeaseStore,
        sources: new Map([
          ["awakening", { type: "mysql", executeSqlEnabled: true, readonly: true }],
        ]),
        now: () => new Date(),
        writeOutput: vi.fn(),
      })
    ).rejects.toThrow("Unknown source 'missing'");
  });

  it("rejects Redis sources", async () => {
    await expect(
      executeWriteAccessCommand(["enable", "awaken-redis"], {
        store: {} as WriteLeaseStore,
        sources: new Map([
          ["awaken-redis", { type: "redis", executeSqlEnabled: false, readonly: true }],
        ]),
        now: () => new Date(),
        writeOutput: vi.fn(),
      })
    ).rejects.toThrow("does not support SQL write leases");
  });

  it("parses an explicit ttl", async () => {
    const enable = vi.fn().mockResolvedValue({
      source_id: "awakening",
      operations: ["insert", "update", "delete"],
      enabled_at: "2026-07-13T12:00:00.000Z",
      expires_at: "2026-07-13T12:30:00.000Z",
    });

    await executeWriteAccessCommand(["enable", "awakening", "--ttl", "30m"], {
      store: { enable } as unknown as WriteLeaseStore,
      sources: new Map([["awakening", { type: "mysql", executeSqlEnabled: true, readonly: true }]]),
      now: () => new Date("2026-07-13T12:00:00.000Z"),
      writeOutput: vi.fn(),
    });

    expect(enable).toHaveBeenCalledWith(
      "awakening",
      1_800_000,
      expect.any(Date),
      ["insert", "update", "delete"]
    );
  });

  it("rejects a ttl longer than one hour", async () => {
    await expect(
      executeWriteAccessCommand(["enable", "awakening", "--ttl", "2h"], {
        store: {} as WriteLeaseStore,
        sources: new Map([
          ["awakening", { type: "mysql", executeSqlEnabled: true, readonly: true }],
        ]),
        now: () => new Date(),
        writeOutput: vi.fn(),
      })
    ).rejects.toThrow("between 1 minute and 1 hour");
  });

  it("rejects permanently writable sources", async () => {
    await expect(
      executeWriteAccessCommand(["enable", "legacy_writer"], {
        store: {} as WriteLeaseStore,
        sources: new Map([
          ["legacy_writer", { type: "mysql", executeSqlEnabled: true, readonly: false }],
        ]),
        now: () => new Date(),
        writeOutput: vi.fn(),
      })
    ).rejects.toThrow("permanently writable");
  });

  it("reports the correct usage for disable without a source", async () => {
    await expect(
      executeWriteAccessCommand(["disable"], {
        store: {} as WriteLeaseStore,
        sources: new Map(),
        now: () => new Date(),
        writeOutput: vi.fn(),
      })
    ).rejects.toThrow("Usage: dbhub disable <source>");
  });
});
