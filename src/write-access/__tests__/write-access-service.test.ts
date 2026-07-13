import { describe, expect, it } from "vitest";

import { formatEnableWriteCommand } from "../write-access-service.js";

describe("formatEnableWriteCommand", () => {
  it("keeps ordinary source IDs easy to copy", () => {
    expect(formatEnableWriteCommand("awakening-prod_1")).toBe("dbhub enable awakening-prod_1");
  });

  it("shell-quotes source IDs containing metacharacters", () => {
    expect(formatEnableWriteCommand("prod; echo unsafe")).toBe("dbhub enable 'prod; echo unsafe'");
    expect(formatEnableWriteCommand("prod'west")).toBe("dbhub enable 'prod'\\''west'");
  });
});
