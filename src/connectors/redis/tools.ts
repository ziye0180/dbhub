/**
 * Redis MCP tools — READ-ONLY command whitelist.
 *
 * 11 tools, one per Redis read command. We deliberately do NOT expose a
 * generic redis_execute tool; every command must be a named tool so it
 * appears in tools/list and subagent allow-lists are clear.
 *
 * Write commands (SET/DEL/FLUSHDB/HSET/EXPIRE/...) are NOT registered here
 * and there is no method on RedisConnector to call them anyway. Audit
 * surface: this file plus connector.ts.
 *
 * Each tool is wrapped with unlockTaskSupport (see ../../tools/index.ts) so
 * Claude Code subagents can call them through the MCP protocol.
 *
 * Author: ziye
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createToolSuccessResponse,
  createToolErrorResponse,
} from "../../utils/response-formatter.js";
import { RedisManager } from "./manager.js";
import { RedisConnector } from "./connector.js";

/**
 * Strip SDK-injected execution.taskSupport='forbidden' so subagents can
 * call this tool. Mirrors the helper in src/tools/index.ts (kept inline
 * to avoid circular imports between SQL and Redis tool layers).
 */
function unlockTaskSupport(tool: { execution?: unknown }): void {
  tool.execution = undefined;
}

/**
 * Resolve the Redis connector for a given source id and surface friendly
 * errors if the source does not exist.
 */
function resolveConnector(sourceId: string): { ok: true; conn: RedisConnector } | { ok: false; response: ReturnType<typeof createToolErrorResponse> } {
  if (!RedisManager.hasSource(sourceId)) {
    const available = RedisManager.getAvailableSourceIds();
    return {
      ok: false,
      response: createToolErrorResponse(
        `Redis source '${sourceId}' not found. Available: ${available.length > 0 ? available.join(", ") : "(none)"}`,
        "REDIS_SOURCE_NOT_FOUND"
      ),
    };
  }
  return { ok: true, conn: RedisManager.getConnector(sourceId) };
}

function asErrorResponse(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return createToolErrorResponse(message, "REDIS_ERROR");
}

const COMMON_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * Register all 11 redis_* tools for a single Redis source.
 */
export function registerRedisToolsForSource(server: McpServer, sourceId: string): void {
  registerRedisGet(server, sourceId);
  registerRedisMget(server, sourceId);
  registerRedisKeys(server, sourceId);
  registerRedisType(server, sourceId);
  registerRedisExists(server, sourceId);
  registerRedisTtl(server, sourceId);
  registerRedisHget(server, sourceId);
  registerRedisHgetall(server, sourceId);
  registerRedisLrange(server, sourceId);
  registerRedisSmembers(server, sourceId);
  registerRedisSismember(server, sourceId);
  registerRedisZrange(server, sourceId);
  registerRedisDbsize(server, sourceId);
}

// 13 tools registered (the 11 in the proposal + ttl + dbsize, all useful read-only).

function registerRedisGet(server: McpServer, sourceId: string): void {
  const tool = server.registerTool(
    `redis_get_${sourceId}`,
    {
      description: `GET a string value from Redis source '${sourceId}'.`,
      inputSchema: { key: z.string().describe("Redis key") },
      annotations: { title: `Redis GET on ${sourceId}`, ...COMMON_ANNOTATIONS },
    },
    async ({ key }) => {
      const r = resolveConnector(sourceId);
      if (!r.ok) return r.response;
      try {
        const value = await r.conn.get(key);
        return createToolSuccessResponse({ key, value });
      } catch (err) {
        return asErrorResponse(err);
      }
    }
  );
  unlockTaskSupport(tool);
}

function registerRedisMget(server: McpServer, sourceId: string): void {
  const tool = server.registerTool(
    `redis_mget_${sourceId}`,
    {
      description: `MGET multiple string values from Redis source '${sourceId}'.`,
      inputSchema: { keys: z.array(z.string()).min(1).max(1000).describe("Array of Redis keys") },
      annotations: { title: `Redis MGET on ${sourceId}`, ...COMMON_ANNOTATIONS },
    },
    async ({ keys }) => {
      const r = resolveConnector(sourceId);
      if (!r.ok) return r.response;
      try {
        const values = await r.conn.mget(keys);
        const result: Record<string, string | null> = {};
        keys.forEach((k, i) => (result[k] = values[i]));
        return createToolSuccessResponse({ values: result });
      } catch (err) {
        return asErrorResponse(err);
      }
    }
  );
  unlockTaskSupport(tool);
}

function registerRedisKeys(server: McpServer, sourceId: string): void {
  const tool = server.registerTool(
    `redis_keys_${sourceId}`,
    {
      description: `Find keys matching a glob pattern on Redis source '${sourceId}' (uses SCAN, not KEYS, capped at max_keys).`,
      inputSchema: {
        pattern: z.string().default("*").describe("Glob pattern (e.g. 'user:*'). Default: '*'"),
        limit: z.number().int().positive().max(10000).optional().describe("Max keys to return"),
      },
      annotations: { title: `Redis SCAN on ${sourceId}`, ...COMMON_ANNOTATIONS },
    },
    async ({ pattern, limit }) => {
      const r = resolveConnector(sourceId);
      if (!r.ok) return r.response;
      try {
        const { keys, truncated } = await r.conn.keys(pattern, limit);
        return createToolSuccessResponse({ keys, count: keys.length, truncated });
      } catch (err) {
        return asErrorResponse(err);
      }
    }
  );
  unlockTaskSupport(tool);
}

function registerRedisType(server: McpServer, sourceId: string): void {
  const tool = server.registerTool(
    `redis_type_${sourceId}`,
    {
      description: `TYPE of a key on Redis source '${sourceId}' (returns string/list/set/zset/hash/stream/none).`,
      inputSchema: { key: z.string().describe("Redis key") },
      annotations: { title: `Redis TYPE on ${sourceId}`, ...COMMON_ANNOTATIONS },
    },
    async ({ key }) => {
      const r = resolveConnector(sourceId);
      if (!r.ok) return r.response;
      try {
        const type = await r.conn.type(key);
        return createToolSuccessResponse({ key, type });
      } catch (err) {
        return asErrorResponse(err);
      }
    }
  );
  unlockTaskSupport(tool);
}

function registerRedisExists(server: McpServer, sourceId: string): void {
  const tool = server.registerTool(
    `redis_exists_${sourceId}`,
    {
      description: `EXISTS — count how many of the given keys exist on Redis source '${sourceId}'.`,
      inputSchema: { keys: z.array(z.string()).min(1).max(1000).describe("Array of Redis keys") },
      annotations: { title: `Redis EXISTS on ${sourceId}`, ...COMMON_ANNOTATIONS },
    },
    async ({ keys }) => {
      const r = resolveConnector(sourceId);
      if (!r.ok) return r.response;
      try {
        const count = await r.conn.exists(keys);
        return createToolSuccessResponse({ keys, count });
      } catch (err) {
        return asErrorResponse(err);
      }
    }
  );
  unlockTaskSupport(tool);
}

function registerRedisTtl(server: McpServer, sourceId: string): void {
  const tool = server.registerTool(
    `redis_ttl_${sourceId}`,
    {
      description: `TTL of a key on Redis source '${sourceId}' in seconds. -1 = no expiry, -2 = key does not exist.`,
      inputSchema: { key: z.string().describe("Redis key") },
      annotations: { title: `Redis TTL on ${sourceId}`, ...COMMON_ANNOTATIONS },
    },
    async ({ key }) => {
      const r = resolveConnector(sourceId);
      if (!r.ok) return r.response;
      try {
        const ttl = await r.conn.ttl(key);
        return createToolSuccessResponse({ key, ttl });
      } catch (err) {
        return asErrorResponse(err);
      }
    }
  );
  unlockTaskSupport(tool);
}

function registerRedisHget(server: McpServer, sourceId: string): void {
  const tool = server.registerTool(
    `redis_hget_${sourceId}`,
    {
      description: `HGET a single hash field from Redis source '${sourceId}'.`,
      inputSchema: {
        key: z.string().describe("Redis hash key"),
        field: z.string().describe("Hash field name"),
      },
      annotations: { title: `Redis HGET on ${sourceId}`, ...COMMON_ANNOTATIONS },
    },
    async ({ key, field }) => {
      const r = resolveConnector(sourceId);
      if (!r.ok) return r.response;
      try {
        const value = await r.conn.hget(key, field);
        return createToolSuccessResponse({ key, field, value });
      } catch (err) {
        return asErrorResponse(err);
      }
    }
  );
  unlockTaskSupport(tool);
}

function registerRedisHgetall(server: McpServer, sourceId: string): void {
  const tool = server.registerTool(
    `redis_hgetall_${sourceId}`,
    {
      description: `HGETALL — all fields of a hash on Redis source '${sourceId}'.`,
      inputSchema: { key: z.string().describe("Redis hash key") },
      annotations: { title: `Redis HGETALL on ${sourceId}`, ...COMMON_ANNOTATIONS },
    },
    async ({ key }) => {
      const r = resolveConnector(sourceId);
      if (!r.ok) return r.response;
      try {
        const fields = await r.conn.hgetall(key);
        return createToolSuccessResponse({ key, fields });
      } catch (err) {
        return asErrorResponse(err);
      }
    }
  );
  unlockTaskSupport(tool);
}

function registerRedisLrange(server: McpServer, sourceId: string): void {
  const tool = server.registerTool(
    `redis_lrange_${sourceId}`,
    {
      description: `LRANGE — list elements within range on Redis source '${sourceId}'. Use 0,-1 for all.`,
      inputSchema: {
        key: z.string().describe("Redis list key"),
        start: z.number().int().default(0).describe("Start index (inclusive). Default 0."),
        stop: z.number().int().default(-1).describe("Stop index (inclusive, negative from end). Default -1 (all)."),
      },
      annotations: { title: `Redis LRANGE on ${sourceId}`, ...COMMON_ANNOTATIONS },
    },
    async ({ key, start, stop }) => {
      const r = resolveConnector(sourceId);
      if (!r.ok) return r.response;
      try {
        const elements = await r.conn.lrange(key, start, stop);
        return createToolSuccessResponse({ key, elements, count: elements.length });
      } catch (err) {
        return asErrorResponse(err);
      }
    }
  );
  unlockTaskSupport(tool);
}

function registerRedisSmembers(server: McpServer, sourceId: string): void {
  const tool = server.registerTool(
    `redis_smembers_${sourceId}`,
    {
      description: `SMEMBERS — all members of a set on Redis source '${sourceId}'.`,
      inputSchema: { key: z.string().describe("Redis set key") },
      annotations: { title: `Redis SMEMBERS on ${sourceId}`, ...COMMON_ANNOTATIONS },
    },
    async ({ key }) => {
      const r = resolveConnector(sourceId);
      if (!r.ok) return r.response;
      try {
        const members = await r.conn.smembers(key);
        return createToolSuccessResponse({ key, members, count: members.length });
      } catch (err) {
        return asErrorResponse(err);
      }
    }
  );
  unlockTaskSupport(tool);
}

function registerRedisSismember(server: McpServer, sourceId: string): void {
  const tool = server.registerTool(
    `redis_sismember_${sourceId}`,
    {
      description: `SISMEMBER — check if a value is a member of a set on Redis source '${sourceId}'.`,
      inputSchema: {
        key: z.string().describe("Redis set key"),
        member: z.string().describe("Member to check"),
      },
      annotations: { title: `Redis SISMEMBER on ${sourceId}`, ...COMMON_ANNOTATIONS },
    },
    async ({ key, member }) => {
      const r = resolveConnector(sourceId);
      if (!r.ok) return r.response;
      try {
        const isMember = await r.conn.sismember(key, member);
        return createToolSuccessResponse({ key, member, isMember });
      } catch (err) {
        return asErrorResponse(err);
      }
    }
  );
  unlockTaskSupport(tool);
}

function registerRedisZrange(server: McpServer, sourceId: string): void {
  const tool = server.registerTool(
    `redis_zrange_${sourceId}`,
    {
      description: `ZRANGE — sorted set range on Redis source '${sourceId}'. Use withScores=true to include scores.`,
      inputSchema: {
        key: z.string().describe("Redis sorted set key"),
        start: z.number().int().default(0).describe("Start index (inclusive)."),
        stop: z.number().int().default(-1).describe("Stop index (inclusive, negative from end)."),
        withScores: z.boolean().default(false).describe("Include scores in result"),
      },
      annotations: { title: `Redis ZRANGE on ${sourceId}`, ...COMMON_ANNOTATIONS },
    },
    async ({ key, start, stop, withScores }) => {
      const r = resolveConnector(sourceId);
      if (!r.ok) return r.response;
      try {
        const elements = await r.conn.zrange(key, start, stop, withScores);
        return createToolSuccessResponse({ key, elements, count: Array.isArray(elements) ? elements.length : 0 });
      } catch (err) {
        return asErrorResponse(err);
      }
    }
  );
  unlockTaskSupport(tool);
}

function registerRedisDbsize(server: McpServer, sourceId: string): void {
  const tool = server.registerTool(
    `redis_dbsize_${sourceId}`,
    {
      description: `DBSIZE — total number of keys in the current database on Redis source '${sourceId}'.`,
      inputSchema: {},
      annotations: { title: `Redis DBSIZE on ${sourceId}`, ...COMMON_ANNOTATIONS },
    },
    async () => {
      const r = resolveConnector(sourceId);
      if (!r.ok) return r.response;
      try {
        const size = await r.conn.dbsize();
        return createToolSuccessResponse({ size });
      } catch (err) {
        return asErrorResponse(err);
      }
    }
  );
  unlockTaskSupport(tool);
}
