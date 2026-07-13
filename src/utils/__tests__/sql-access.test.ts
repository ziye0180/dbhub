import { describe, expect, it } from "vitest";

import { classifySqlAccess } from "../sql-access.js";

describe("classifySqlAccess", () => {
  it.each(["SELECT * FROM users", "SHOW TABLES", "SELECT 1; SELECT 2;"])(
    "classifies read-only SQL: %s",
    (sql) => {
      expect(classifySqlAccess(sql, "mysql")).toEqual({ kind: "read" });
    }
  );

  it.each([
    ["insert", "INSERT INTO users (id) VALUES (1)"],
    ["update", "UPDATE users SET name = 'x' WHERE id = 1"],
    ["delete", "DELETE FROM users WHERE id = 1"],
    [
      "update",
      "WITH target AS (SELECT id FROM users) UPDATE users SET name = 'x' WHERE id IN (SELECT id FROM target)",
    ],
  ] as const)("classifies %s SQL", (operation, sql) => {
    expect(classifySqlAccess(sql, "mysql")).toEqual({ kind: "write", operation });
  });

  it.each([
    ["UPDATE users SET active = 0", "where_required"],
    ["DELETE FROM users", "where_required"],
    ["UPDATE users SET active = (SELECT active FROM defaults WHERE id = 1)", "where_required"],
    ["DROP TABLE users", "operation_not_allowed"],
    ["TRUNCATE TABLE users", "operation_not_allowed"],
    ["CALL mutate_users()", "operation_not_allowed"],
    [
      "INSERT INTO users (id) VALUES (1); DELETE FROM users WHERE id = 2",
      "multiple_write_statements",
    ],
  ] as const)("rejects unsafe SQL with reason %s", (sql, reason) => {
    expect(classifySqlAccess(sql, "mysql")).toEqual({ kind: "denied", reason });
  });
});
