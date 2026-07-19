import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createExecuteSqlToolHandler } from '../execute-sql.js';
import { ConnectorManager } from '../../connectors/manager.js';
import { getToolRegistry } from '../registry.js';
import { getActiveWriteLease } from '../../write-access/index.js';
import type { Connector, ConnectorType, SQLResult } from '../../connectors/interface.js';

// Mock dependencies
vi.mock('../../connectors/manager.js');
vi.mock('../registry.js');
vi.mock('../../write-access/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../write-access/index.js')>();
  return {
    ...actual,
    getActiveWriteLease: vi.fn(),
  };
});

// Mock connector for testing
const createMockConnector = (id: ConnectorType = 'sqlite', sourceId: string = 'default'): Connector => ({
  id,
  name: 'Mock Connector',
  getId: () => sourceId,
  dsnParser: {} as any,
  connect: vi.fn(),
  disconnect: vi.fn(),
  clone: vi.fn(),
  getSchemas: vi.fn(),
  getTables: vi.fn(),
  tableExists: vi.fn(),
  getTableSchema: vi.fn(),
  getTableIndexes: vi.fn(),
  getStoredProcedures: vi.fn(),
  getStoredProcedureDetail: vi.fn(),
  executeSQL: vi.fn(),
});

// Helper function to parse tool response
const parseToolResponse = (response: any) => {
  return JSON.parse(response.content[0].text);
};

describe('execute-sql tool', () => {
  let mockConnector: Connector;
  const mockGetCurrentConnector = vi.mocked(ConnectorManager.getCurrentConnector);
  const mockGetToolRegistry = vi.mocked(getToolRegistry);
  const mockGetActiveWriteLease = vi.mocked(getActiveWriteLease);

  beforeEach(() => {
    mockConnector = createMockConnector('sqlite');
    mockGetCurrentConnector.mockReturnValue(mockConnector);
    mockGetActiveWriteLease.mockResolvedValue(null);

    // Mock tool registry to return empty config (no readonly, no max_rows)
    mockGetToolRegistry.mockReturnValue({
      getBuiltinToolConfig: vi.fn().mockReturnValue({}),
    } as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('basic execution', () => {
    it('should execute SELECT and return rows', async () => {
      const mockResult: SQLResult = { rows: [{ id: 1, name: 'test' }], rowCount: 1 };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql: 'SELECT * FROM users' }, null);
      const parsedResult = parseToolResponse(result);

      expect(parsedResult.success).toBe(true);
      expect(parsedResult.data.rows).toEqual([{ id: 1, name: 'test' }]);
      expect(parsedResult.data.count).toBe(1);
      expect(mockConnector.executeSQL).toHaveBeenCalledWith('SELECT * FROM users', { readonly: undefined, maxRows: undefined });
    });

    it('should pass multi-statement SQL directly to connector', async () => {
      const mockResult: SQLResult = { rows: [{ id: 1 }], rowCount: 1 };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const sql = 'SELECT * FROM users; SELECT * FROM roles;';
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql }, null);
      const parsedResult = parseToolResponse(result);

      expect(parsedResult.success).toBe(true);
      expect(mockConnector.executeSQL).toHaveBeenCalledWith(sql, { readonly: undefined, maxRows: undefined });
    });

    it('should handle execution errors', async () => {
      vi.mocked(mockConnector.executeSQL).mockRejectedValue(new Error('Database error'));

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql: 'SELECT * FROM invalid_table' }, null);

      expect(result.isError).toBe(true);
      const parsedResult = parseToolResponse(result);
      expect(parsedResult.success).toBe(false);
      expect(parsedResult.error).toBe('Database error');
      expect(parsedResult.code).toBe('EXECUTION_ERROR');
    });

    it('returns SOURCE_UNREACHABLE when the connector throws a network error', async () => {
      const econn: any = new Error('connect ECONNREFUSED 127.0.0.1:5432');
      econn.code = 'ECONNREFUSED';
      mockGetCurrentConnector.mockReturnValue({
        id: 'postgres',
        getId: () => 'prod',
        executeSQL: vi.fn().mockRejectedValue(econn),
      } as any);
      vi.mocked(ConnectorManager.getSourceConfig).mockReturnValue({ id: 'prod', type: 'postgres' } as any);
      vi.mocked(ConnectorManager.ensureConnected).mockResolvedValue(undefined as any);

      const handler = createExecuteSqlToolHandler('prod');
      const res: any = await handler({ sql: 'SELECT 1' }, {});
      const payload = JSON.parse(res.content[0].text);

      expect(res.isError).toBe(true);
      expect(payload.code).toBe('SOURCE_UNREACHABLE');
      expect(payload.details.source_id).toBe('prod');
    });

    it('falls through to EXECUTION_ERROR when the source config is null', async () => {
      const econn: any = new Error('connect ECONNREFUSED 127.0.0.1:5432');
      econn.code = 'ECONNREFUSED';
      mockGetCurrentConnector.mockReturnValue({
        id: 'postgres',
        getId: () => 'prod',
        executeSQL: vi.fn().mockRejectedValue(econn),
      } as any);
      vi.mocked(ConnectorManager.getSourceConfig).mockReturnValue(null as any);
      vi.mocked(ConnectorManager.ensureConnected).mockResolvedValue(undefined as any);

      const handler = createExecuteSqlToolHandler('prod');
      const res: any = await handler({ sql: 'SELECT 1' }, {});
      const payload = JSON.parse(res.content[0].text);

      expect(res.isError).toBe(true);
      expect(payload.code).toBe('EXECUTION_ERROR');
    });

    it('uses the display source id "default" in single-source mode', async () => {
      const econn: any = new Error('connect ECONNREFUSED 127.0.0.1:5432');
      econn.code = 'ECONNREFUSED';
      mockGetCurrentConnector.mockReturnValue({
        id: 'postgres',
        getId: () => 'default',
        executeSQL: vi.fn().mockRejectedValue(econn),
      } as any);
      vi.mocked(ConnectorManager.getSourceConfig).mockReturnValue({ type: 'postgres' } as any);
      vi.mocked(ConnectorManager.ensureConnected).mockResolvedValue(undefined as any);

      const handler = createExecuteSqlToolHandler();
      const res: any = await handler({ sql: 'SELECT 1' }, {});
      const payload = JSON.parse(res.content[0].text);

      expect(res.isError).toBe(true);
      expect(payload.code).toBe('SOURCE_UNREACHABLE');
      expect(payload.details.source_id).toBe('default');
    });
  });

  describe('read-only mode enforcement', () => {
    beforeEach(() => {
      // Set per-source readonly mode via tool registry (simulates TOML config)
      mockGetToolRegistry.mockReturnValue({
        getBuiltinToolConfig: vi.fn().mockReturnValue({ readonly: true }),
      } as any);
    });

    it('should allow SELECT statements', async () => {
      const mockResult: SQLResult = { rows: [{ id: 1 }], rowCount: 1 };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql: 'SELECT * FROM users' }, null);
      const parsedResult = parseToolResponse(result);

      expect(parsedResult.success).toBe(true);
      expect(mockConnector.executeSQL).toHaveBeenCalledWith('SELECT * FROM users', { readonly: true, maxRows: undefined });
    });

    it('should allow multiple read-only statements', async () => {
      const mockResult: SQLResult = { rows: [], rowCount: 0 };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const sql = 'SELECT * FROM users; SELECT * FROM roles;';
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql }, null);

      expect(parseToolResponse(result).success).toBe(true);
    });

    it.each([
      ['INSERT', "INSERT INTO users (name) VALUES ('test')"],
      ['UPDATE', "UPDATE users SET name = 'x' WHERE id = 1"],
      ['DELETE', "DELETE FROM users WHERE id = 1"],
    ])('asks the user to enable write access for %s', async (_, sql) => {
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql }, null);

      expect(result.isError).toBe(true);
      const parsedResult = parseToolResponse(result);
      expect(parsedResult.code).toBe('WRITE_ACCESS_REQUIRED');
      expect(parsedResult.error).toContain('dbhub enable test_source');
      expect(parsedResult.error).toContain(
        "Do not run this authorization command on the user's behalf"
      );
      expect(parsedResult.details).toMatchObject({
        source_id: 'test_source',
        default_ttl: '10m',
      });
      expect(mockConnector.executeSQL).not.toHaveBeenCalled();
    });

    it('fails closed when the write lease state is invalid', async () => {
      mockGetActiveWriteLease.mockRejectedValue(new Error('Invalid write lease state'));

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler(
        { sql: "INSERT INTO users (name) VALUES ('test')" },
        null,
      );

      expect(parseToolResponse(result).code).toBe('WRITE_ACCESS_STATE_INVALID');
      expect(mockConnector.executeSQL).not.toHaveBeenCalled();
    });

    it.each([
      ['DROP', "DROP TABLE users"],
      ['CREATE', "CREATE TABLE test (id INT)"],
      ['ALTER', "ALTER TABLE users ADD COLUMN email VARCHAR(255)"],
      ['TRUNCATE', "TRUNCATE TABLE users"],
    ])('rejects %s even when a lease exists', async (_, sql) => {
      mockGetActiveWriteLease.mockResolvedValue({
        source_id: 'test_source',
        operations: ['insert', 'update', 'delete'],
        enabled_at: '2026-07-13T12:00:00.000Z',
        expires_at: '2026-07-13T12:10:00.000Z',
      });

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql }, null);

      expect(parseToolResponse(result).code).toBe('WRITE_OPERATION_NOT_ALLOWED');
      expect(mockConnector.executeSQL).not.toHaveBeenCalled();
    });

    it.each([
      ['UPDATE', "UPDATE users SET name = 'x'"],
      ['DELETE', "DELETE FROM users"],
    ])('rejects %s without WHERE even when a lease exists', async (_, sql) => {
      mockGetActiveWriteLease.mockResolvedValue({
        source_id: 'test_source',
        operations: ['insert', 'update', 'delete'],
        enabled_at: '2026-07-13T12:00:00.000Z',
        expires_at: '2026-07-13T12:10:00.000Z',
      });

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql }, null);

      expect(parseToolResponse(result).code).toBe('WRITE_OPERATION_NOT_ALLOWED');
      expect(mockConnector.executeSQL).not.toHaveBeenCalled();
    });

    it.each([
      ['INSERT', "INSERT INTO users (name) VALUES ('test')"],
      ['UPDATE', "UPDATE users SET name = 'x' WHERE id = 1"],
      ['DELETE', "DELETE FROM users WHERE id = 1"],
    ])('allows %s with an active lease', async (_, sql) => {
      const lease = {
        source_id: 'test_source',
        operations: ['insert', 'update', 'delete'] as const,
        enabled_at: '2026-07-13T12:00:00.000Z',
        expires_at: '2026-07-13T12:10:00.000Z',
      };
      mockGetActiveWriteLease.mockResolvedValue(lease);
      vi.mocked(mockConnector.executeSQL).mockResolvedValue({ rows: [], rowCount: 1 });

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql }, null);
      const parsedResult = parseToolResponse(result);

      expect(parsedResult.success).toBe(true);
      expect(parsedResult.data.write_access.expires_at).toBe(lease.expires_at);
      expect(mockConnector.executeSQL).toHaveBeenCalledWith(sql, {
        readonly: false,
        maxRows: undefined,
      });
    });

    it('should reject multi-statement with any write operation', async () => {
      const sql = "SELECT * FROM users; INSERT INTO users (name) VALUES ('test');";
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql }, null);

      expect(result.isError).toBe(true);
      expect(parseToolResponse(result).code).toBe('WRITE_OPERATION_NOT_ALLOWED');
    });

  });

  describe('readonly per-source isolation', () => {
    // Verifies readonly is enforced per-source from tool registry, not globally

    it.each([
      ['readonly: false', { readonly: false }],
      ['readonly: undefined', {}],
    ])('should allow writes when %s', async (_, toolConfig) => {
      mockGetToolRegistry.mockReturnValue({
        getBuiltinToolConfig: vi.fn().mockReturnValue(toolConfig),
      } as any);
      const mockResult: SQLResult = { rows: [], rowCount: 0 };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const handler = createExecuteSqlToolHandler('writable_source');
      const result = await handler({ sql: "INSERT INTO users (name) VALUES ('test')" }, null);

      expect(parseToolResponse(result).success).toBe(true);
      expect(mockConnector.executeSQL).toHaveBeenCalled();
    });

    it('should enforce readonly even with other options set', async () => {
      mockGetToolRegistry.mockReturnValue({
        getBuiltinToolConfig: vi.fn().mockReturnValue({ readonly: true, max_rows: 100 }),
      } as any);

      const handler = createExecuteSqlToolHandler('limited_source');
      const result = await handler({ sql: "DELETE FROM users" }, null);

      expect(parseToolResponse(result).code).toBe('WRITE_OPERATION_NOT_ALLOWED');
    });
  });

  describe('temporary migration mode', () => {
    const migrationSql = `
CREATE TABLE IF NOT EXISTS \`pro_user_account\` (\`id\` bigint NOT NULL);
SET @sql := IF((SELECT COUNT(1) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pro_upload_intent' AND COLUMN_NAME = 'intent_no') = 0, 'ALTER TABLE \`pro_upload_intent\` ADD COLUMN \`intent_no\` varchar(64) NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
`;

    beforeEach(() => {
      mockConnector = createMockConnector('mysql', 'awaken_pro_prod');
      mockConnector.getDefaultSchema = vi.fn().mockResolvedValue('awaken_pro_prod');
      mockGetCurrentConnector.mockReturnValue(mockConnector);
      vi.mocked(ConnectorManager.getSourceConfig).mockReturnValue({
        id: 'awaken_pro_prod',
        type: 'mysql',
        database: 'awaken_pro_prod',
      } as any);
      mockGetToolRegistry.mockReturnValue({
        getBuiltinToolConfig: vi.fn().mockReturnValue({
          readonly: true,
          temporary_write_mode: 'migration',
        }),
      } as any);
    });

    it('asks for the same host enable command when no migration lease exists', async () => {
      const handler = createExecuteSqlToolHandler('awaken_pro_prod');
      const result = await handler({ sql: migrationSql }, null);
      const parsedResult = parseToolResponse(result);

      expect(parsedResult.code).toBe('WRITE_ACCESS_REQUIRED');
      expect(parsedResult.details.command).toBe('dbhub enable awaken_pro_prod');
      expect(mockConnector.executeSQL).not.toHaveBeenCalled();
    });

    it('keeps read queries available without a migration lease', async () => {
      vi.mocked(mockConnector.executeSQL).mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 });

      const handler = createExecuteSqlToolHandler('awaken_pro_prod');
      const result = await handler({ sql: 'SELECT * FROM users' }, null);

      expect(parseToolResponse(result).success).toBe(true);
      expect(mockGetActiveWriteLease).not.toHaveBeenCalled();
      expect(mockConnector.executeSQL).toHaveBeenCalledWith('SELECT * FROM users', {
        readonly: true,
        maxRows: undefined,
      });
    });

    it('rejects a DML lease for migration SQL', async () => {
      mockGetActiveWriteLease.mockResolvedValue({
        source_id: 'awaken_pro_prod',
        operations: ['insert', 'update', 'delete'],
        enabled_at: '2026-07-13T12:00:00.000Z',
        expires_at: '2026-07-13T12:10:00.000Z',
      });

      const handler = createExecuteSqlToolHandler('awaken_pro_prod');
      const result = await handler({ sql: migrationSql }, null);

      expect(parseToolResponse(result).code).toBe('WRITE_OPERATION_NOT_ALLOWED');
      expect(mockConnector.executeSQL).not.toHaveBeenCalled();
    });

    it('executes forward DDL unchanged with a matching migration lease', async () => {
      const lease = {
        source_id: 'awaken_pro_prod',
        operations: ['migration'] as const,
        enabled_at: '2026-07-13T12:00:00.000Z',
        expires_at: '2026-07-13T12:10:00.000Z',
      };
      mockGetActiveWriteLease.mockResolvedValue(lease);
      vi.mocked(mockConnector.executeSQL).mockResolvedValue({ rows: [], rowCount: 0 });

      const handler = createExecuteSqlToolHandler('awaken_pro_prod');
      const result = await handler({ sql: migrationSql }, null);

      expect(parseToolResponse(result).success).toBe(true);
      expect(mockConnector.executeSQL).toHaveBeenCalledWith(migrationSql, {
        readonly: false,
        maxRows: undefined,
      });
    });

    it('does not let a migration lease authorize ordinary DML', async () => {
      mockGetActiveWriteLease.mockResolvedValue({
        source_id: 'awaken_pro_prod',
        operations: ['migration'],
        enabled_at: '2026-07-13T12:00:00.000Z',
        expires_at: '2026-07-13T12:10:00.000Z',
      });

      const handler = createExecuteSqlToolHandler('awaken_pro_prod');
      const result = await handler({ sql: 'INSERT INTO users (id) VALUES (1)' }, null);

      expect(parseToolResponse(result).code).toBe('WRITE_OPERATION_NOT_ALLOWED');
      expect(mockConnector.executeSQL).not.toHaveBeenCalled();
    });

    it('fails closed when the runtime default database differs from configuration', async () => {
      vi.mocked(mockConnector.getDefaultSchema!).mockResolvedValue('awaken_payment');
      mockGetActiveWriteLease.mockResolvedValue({
        source_id: 'awaken_pro_prod',
        operations: ['migration'],
        enabled_at: '2026-07-13T12:00:00.000Z',
        expires_at: '2026-07-13T12:10:00.000Z',
      });

      const handler = createExecuteSqlToolHandler('awaken_pro_prod');
      const result = await handler({ sql: migrationSql }, null);
      const parsedResult = parseToolResponse(result);

      expect(parsedResult.code).toBe('MIGRATION_DATABASE_MISMATCH');
      expect(parsedResult.details).toMatchObject({
        source_id: 'awaken_pro_prod',
        configured_database: 'awaken_pro_prod',
        runtime_database: 'awaken_payment',
      });
      expect(mockConnector.executeSQL).not.toHaveBeenCalled();
    });
  });

  describe('SQL comments handling in readonly mode', () => {
    beforeEach(() => {
      mockGetToolRegistry.mockReturnValue({
        getBuiltinToolConfig: vi.fn().mockReturnValue({ readonly: true }),
      } as any);
    });

    it.each([
      ['single-line comment', '-- Fetch users\nSELECT * FROM users'],
      ['multi-line comment', '/* Fetch all */\nSELECT * FROM products'],
      ['inline comments', 'SELECT id, -- user id\n       name FROM users'],
    ])('should allow SELECT with %s', async (_, sql) => {
      const mockResult: SQLResult = { rows: [], rowCount: 0 };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql }, null);

      expect(parseToolResponse(result).success).toBe(true);
    });

    it('should reject comment-only SQL in readonly mode', async () => {
      const sql = '-- Just a comment\n/* Another */';
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql }, null);

      expect(parseToolResponse(result).code).toBe('WRITE_OPERATION_NOT_ALLOWED');
    });

    it('should reject MySQL conditional comment bypass with mysql connector', async () => {
      const mysqlConnector = createMockConnector('mysql', 'mysql_source');
      mockGetCurrentConnector.mockReturnValue(mysqlConnector);

      const sql = 'SELECT 1; /*!50000 DROP TABLE users */';
      const handler = createExecuteSqlToolHandler('mysql_source');
      const result = await handler({ sql }, null);

      expect(parseToolResponse(result).code).toBe('WRITE_OPERATION_NOT_ALLOWED');
    });

    it('should reject MariaDB M-bang comment bypass with mariadb connector', async () => {
      const mariadbConnector = createMockConnector('mariadb', 'mariadb_source');
      mockGetCurrentConnector.mockReturnValue(mariadbConnector);

      const sql = 'SELECT 1; /*M! DELETE FROM users */';
      const handler = createExecuteSqlToolHandler('mariadb_source');
      const result = await handler({ sql }, null);

      expect(parseToolResponse(result).code).toBe('WRITE_OPERATION_NOT_ALLOWED');
    });

    it('should reject write statement hidden after comment', async () => {
      const sql = '-- Insert new user\nINSERT INTO users (name) VALUES (\'test\')';
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql }, null);

      expect(parseToolResponse(result).code).toBe('WRITE_ACCESS_REQUIRED');
    });
  });

  describe('edge cases', () => {
    it.each([
      ['empty string', ''],
      ['only semicolons and whitespace', '   ;  ;  ; '],
    ])('should handle %s', async (_, sql) => {
      const mockResult: SQLResult = { rows: [], rowCount: 0 };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql }, null);

      expect(parseToolResponse(result).success).toBe(true);
    });
  });
});
