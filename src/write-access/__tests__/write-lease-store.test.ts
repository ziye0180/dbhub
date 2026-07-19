import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_WRITE_LEASE_TTL_MS, WriteLeaseStore } from "../write-lease-store.js";

describe("WriteLeaseStore", () => {
  let temporaryDirectory: string;
  let store: WriteLeaseStore;

  beforeEach(async () => {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dbhub-write-lease-"));
    store = new WriteLeaseStore(path.join(temporaryDirectory, "write-leases.json"));
  });

  afterEach(async () => {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("creates a ten-minute lease by default", async () => {
    const now = new Date("2026-07-13T12:00:00.000Z");

    const lease = await store.enable("awakening", undefined, now);

    expect(Date.parse(lease.expires_at) - now.getTime()).toBe(DEFAULT_WRITE_LEASE_TTL_MS);
    expect(lease.operations).toEqual(["insert", "update", "delete"]);
  });

  it("records migration capability instead of DML when explicitly requested", async () => {
    const now = new Date("2026-07-13T12:00:00.000Z");

    const lease = await store.enable(
      "awaken_pro_prod",
      DEFAULT_WRITE_LEASE_TTL_MS,
      now,
      ["migration"]
    );

    expect(lease.operations).toEqual(["migration"]);
  });

  it("keeps leases isolated by source", async () => {
    const now = new Date("2026-07-13T12:00:00.000Z");
    await store.enable("awakening", DEFAULT_WRITE_LEASE_TTL_MS, now);

    await expect(store.getActive("awakening", now)).resolves.not.toBeNull();
    await expect(store.getActive("cognitive", now)).resolves.toBeNull();
  });

  it("supports source IDs that overlap with object prototype keys", async () => {
    const now = new Date("2026-07-13T12:00:00.000Z");

    await store.enable("__proto__", DEFAULT_WRITE_LEASE_TTL_MS, now);

    await expect(store.getActive("__proto__", now)).resolves.toMatchObject({
      source_id: "__proto__",
    });
  });

  it("treats an expired lease as inactive", async () => {
    const enabledAt = new Date("2026-07-13T12:00:00.000Z");
    await store.enable("awakening", DEFAULT_WRITE_LEASE_TTL_MS, enabledAt);

    const afterExpiry = new Date(enabledAt.getTime() + DEFAULT_WRITE_LEASE_TTL_MS + 1);

    await expect(store.getActive("awakening", afterExpiry)).resolves.toBeNull();
  });

  it("treats a lease whose start time is in the future as inactive", async () => {
    const enabledAt = new Date("2026-07-13T12:10:00.000Z");
    await store.enable("awakening", DEFAULT_WRITE_LEASE_TTL_MS, enabledAt);

    await expect(
      store.getActive("awakening", new Date("2026-07-13T12:00:00.000Z"))
    ).resolves.toBeNull();
  });

  it("disables only the requested source", async () => {
    const now = new Date("2026-07-13T12:00:00.000Z");
    await store.enable("awakening", DEFAULT_WRITE_LEASE_TTL_MS, now);
    await store.enable("cognitive", DEFAULT_WRITE_LEASE_TTL_MS, now);

    const removed = await store.disable("awakening");

    expect(removed).toBe(true);
    await expect(store.getActive("awakening", now)).resolves.toBeNull();
    await expect(store.getActive("cognitive", now)).resolves.not.toBeNull();
  });

  it("fails closed when the lease file is malformed", async () => {
    await fs.writeFile(store.filePath, "not-json", "utf8");

    await expect(store.getActive("awakening", new Date())).rejects.toThrow(
      "Invalid write lease state"
    );
  });

  it("fails closed when the state contains duplicate source leases", async () => {
    const duplicateLease = {
      source_id: "awakening",
      operations: ["insert"],
      enabled_at: "2026-07-13T12:00:00.000Z",
      expires_at: "2026-07-13T12:10:00.000Z",
    };
    await fs.writeFile(
      store.filePath,
      JSON.stringify({ version: 1, leases: [duplicateLease, duplicateLease] }),
      "utf8"
    );

    await expect(store.getActive("awakening", new Date())).rejects.toThrow(
      "Invalid write lease state"
    );
  });

  it("fails closed when a lease mixes DML and migration capabilities", async () => {
    await fs.writeFile(
      store.filePath,
      JSON.stringify({
        version: 1,
        leases: [
          {
            source_id: "awakening",
            operations: ["insert", "update", "delete", "migration"],
            enabled_at: "2026-07-13T12:00:00.000Z",
            expires_at: "2026-07-13T12:10:00.000Z",
          },
        ],
      }),
      "utf8"
    );

    await expect(store.getActive("awakening", new Date())).rejects.toThrow(
      "Invalid write lease state"
    );
  });
});
