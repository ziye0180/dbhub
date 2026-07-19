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

  describe("migration mode", () => {
    it("keeps pure reads available without treating them as migration writes", () => {
      expect(classifySqlAccess("SELECT * FROM users", "mysql", "migration")).toEqual({
        kind: "read",
      });
    });

    it("accepts a forward DDL batch with a closed prepared-statement sequence", () => {
      const sql = `
CREATE TABLE IF NOT EXISTS \`pro_user_account\` (\`id\` bigint NOT NULL);
SET @sql := IF(
  (SELECT COUNT(1) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pro_upload_intent' AND COLUMN_NAME = 'intent_no') = 0,
  'ALTER TABLE \`pro_upload_intent\` ADD COLUMN \`intent_no\` varchar(64) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
CREATE UNIQUE INDEX \`uk_pro_upload_intent_env_no\` ON \`pro_upload_intent\` (\`env_code\`, \`intent_no\`);
`;

      expect(classifySqlAccess(sql, "mysql", "migration")).toEqual({
        kind: "write",
        operation: "migration",
      });
    });

    it.each([
      ["USE awaken_payment", "migration_statement_not_allowed"],
      ["CREATE TABLE awaken_payment.users (id bigint)", "cross_database_target"],
      ["ALTER TABLE `awaken_payment`.`users` ADD COLUMN name varchar(64)", "cross_database_target"],
      ["DROP TABLE users", "migration_statement_not_allowed"],
      ["TRUNCATE TABLE users", "migration_statement_not_allowed"],
      ["INSERT INTO users (id) VALUES (1)", "migration_statement_not_allowed"],
      ["CREATE TABLE copied AS SELECT * FROM users", "migration_statement_not_allowed"],
      ["CREATE TABLE copied SELECT * FROM users", "migration_statement_not_allowed"],
      ["CREATE TABLE copied LIKE awaken_payment.users", "migration_statement_not_allowed"],
      [
        "CREATE TABLE users (id bigint) ENGINE=FEDERATED CONNECTION='mysql://example.invalid/db/users'",
        "migration_statement_not_allowed",
      ],
      [
        "ALTER TABLE users ADD CONSTRAINT fk_user FOREIGN KEY (id) REFERENCES awaken_payment.users(id)",
        "cross_database_target",
      ],
      ["ALTER TABLE users MODIFY COLUMN id bigint", "migration_statement_not_allowed"],
      [
        "ALTER TABLE users ADD COLUMN email varchar(255), DISABLE KEYS",
        "migration_statement_not_allowed",
      ],
      ["SELECT * FROM users; CREATE TABLE copied (id bigint)", "migration_statement_not_allowed"],
      ["PREPARE stmt FROM @sql; EXECUTE stmt", "migration_sequence_invalid"],
      [
        "SET @sql := 'DROP TABLE users'; PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt",
        "migration_statement_not_allowed",
      ],
      [
        "SET @sql := IF((SELECT COUNT(1) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() UNION SELECT SLEEP(10)), 'CREATE TABLE users (id bigint)', 'SELECT 1'); PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt",
        "migration_statement_not_allowed",
      ],
      [
        "SET @sql := IF((SELECT COUNT(1) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'email' AND mutate_users() = 1) = 0, 'ALTER TABLE users ADD COLUMN email varchar(255)', 'SELECT 1'); PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt",
        "migration_statement_not_allowed",
      ],
      [
        "SET @sql := IF((SELECT COUNT(1) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'idx_users_email') = 0, 'CREATE INDEX idx_users_email ON users (email)', 'SELECT 1'); PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt",
        "migration_statement_not_allowed",
      ],
      [
        "SET @sql := IF((SELECT COUNT(1) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE()), 'CREATE TABLE users (id bigint)', 'SELECT mutate_users()'); PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt",
        "migration_statement_not_allowed",
      ],
    ] as const)("rejects unsafe migration SQL: %s", (sql, reason) => {
      expect(classifySqlAccess(sql, "mysql", "migration")).toEqual({
        kind: "denied",
        reason,
      });
    });

    it("keeps DDL denied when migration mode is not configured", () => {
      expect(classifySqlAccess("CREATE TABLE users (id bigint)", "mysql")).toEqual({
        kind: "denied",
        reason: "operation_not_allowed",
      });
    });
  });

  describe("hybrid DML and migration mode", () => {
    it("classifies ordinary DML without weakening its guards", () => {
      expect(
        classifySqlAccess("UPDATE users SET name = 'x' WHERE id = 1", "mysql", "dml_and_migration")
      ).toEqual({ kind: "write", operation: "update" });
      expect(
        classifySqlAccess("DELETE FROM users", "mysql", "dml_and_migration")
      ).toEqual({ kind: "denied", reason: "where_required" });
    });

    it("classifies approved forward DDL as migration", () => {
      expect(
        classifySqlAccess("CREATE TABLE users (id bigint) ENGINE=InnoDB", "mysql", "dml_and_migration")
      ).toEqual({ kind: "write", operation: "migration" });
    });
  });
});
