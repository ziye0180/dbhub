/**
 * Redis Connector for dbhub
 *
 * Provides READ-ONLY Redis operations through dbhub.
 *
 * Architecture decision (D-005, see pm-atlas/projects/dbhub/decisions.md):
 *   Redis is implemented as a parallel subsystem to the SQL Connector
 *   interface. The existing `Connector` interface is SQL-centric (schemas /
 *   tables / executeSQL), so forcing Redis to implement it would be a hack.
 *   Instead, RedisConnector is its own class with KV-native methods.
 *
 * Author: ziye
 */

import { Redis } from "ioredis";
import type { RedisOptions } from "ioredis";

export type RedisKeyType = "string" | "list" | "set" | "zset" | "hash" | "stream" | "none";

/**
 * Configuration for a Redis connection.
 */
export interface RedisSourceConfig {
  id: string;
  description?: string;
  host: string;
  port: number;
  password?: string;
  db?: number;
  /** Maximum number of keys returned by KEYS-like operations (default: 1000). */
  max_keys?: number;
  /** Connection timeout in seconds. */
  connection_timeout?: number;
  /** Command timeout in seconds. */
  command_timeout?: number;
}

const DEFAULT_MAX_KEYS = 1000;
const DEFAULT_CONNECTION_TIMEOUT = 5;
const DEFAULT_COMMAND_TIMEOUT = 5;

/**
 * RedisConnector wraps a single ioredis client and exposes a small,
 * READ-ONLY surface for use by the redis_* MCP tools.
 *
 * All write commands (SET/DEL/FLUSH/EXPIRE/HSET/...) are intentionally
 * NOT exposed here: the only public methods are the read-only ones below.
 * Even if a tool author tried to add a write tool, there is no method on
 * RedisConnector to call.
 */
export class RedisConnector {
  readonly id: string;
  readonly description?: string;
  readonly maxKeys: number;
  private client: Redis;
  private isConnected: boolean = false;

  constructor(config: RedisSourceConfig) {
    this.id = config.id;
    this.description = config.description;
    this.maxKeys = config.max_keys ?? DEFAULT_MAX_KEYS;

    const options: RedisOptions = {
      host: config.host,
      port: config.port,
      password: config.password,
      db: config.db ?? 0,
      connectTimeout: (config.connection_timeout ?? DEFAULT_CONNECTION_TIMEOUT) * 1000,
      commandTimeout: (config.command_timeout ?? DEFAULT_COMMAND_TIMEOUT) * 1000,
      // Connect lazily so dbhub startup doesn't fail if a Redis source is down.
      lazyConnect: true,
      // Keep retry conservative; better to surface errors quickly to the MCP caller.
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    };

    this.client = new Redis(options);

    this.client.on("error", (err: Error) => {
      // Log but don't throw — individual command calls will surface errors.
      console.error(`[redis:${this.id}] connection error: ${err.message}`);
    });
  }

  /**
   * Lazily connect on first use. Subsequent calls are no-ops.
   */
  private async ensureConnected(): Promise<void> {
    if (this.isConnected) return;
    await this.client.connect();
    this.isConnected = true;
  }

  async disconnect(): Promise<void> {
    if (this.isConnected) {
      this.client.disconnect();
      this.isConnected = false;
    }
  }

  // ----- READ-ONLY commands -----

  async get(key: string): Promise<string | null> {
    await this.ensureConnected();
    return this.client.get(key);
  }

  async mget(keys: string[]): Promise<(string | null)[]> {
    await this.ensureConnected();
    if (keys.length === 0) return [];
    return this.client.mget(...keys);
  }

  /**
   * List keys matching a glob-style pattern using SCAN (safer than KEYS).
   * Caps results at this.maxKeys to protect against large keyspaces.
   */
  async keys(pattern: string, limit?: number): Promise<{ keys: string[]; truncated: boolean }> {
    await this.ensureConnected();
    const cap = Math.min(limit ?? this.maxKeys, this.maxKeys);
    const found: string[] = [];
    let cursor = "0";
    let truncated = false;

    do {
      const [next, batch] = await this.client.scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = next;
      for (const key of batch) {
        if (found.length >= cap) {
          truncated = true;
          break;
        }
        found.push(key);
      }
      if (truncated) break;
    } while (cursor !== "0");

    return { keys: found, truncated };
  }

  async type(key: string): Promise<RedisKeyType> {
    await this.ensureConnected();
    const t = await this.client.type(key);
    return t as RedisKeyType;
  }

  async exists(keys: string[]): Promise<number> {
    await this.ensureConnected();
    if (keys.length === 0) return 0;
    return this.client.exists(...keys);
  }

  async ttl(key: string): Promise<number> {
    await this.ensureConnected();
    return this.client.ttl(key);
  }

  async hget(key: string, field: string): Promise<string | null> {
    await this.ensureConnected();
    return this.client.hget(key, field);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    await this.ensureConnected();
    return this.client.hgetall(key);
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    await this.ensureConnected();
    return this.client.lrange(key, start, stop);
  }

  async smembers(key: string): Promise<string[]> {
    await this.ensureConnected();
    return this.client.smembers(key);
  }

  async sismember(key: string, member: string): Promise<boolean> {
    await this.ensureConnected();
    const result = await this.client.sismember(key, member);
    return result === 1;
  }

  async zrange(
    key: string,
    start: number,
    stop: number,
    withScores: boolean = false
  ): Promise<string[] | Array<{ member: string; score: number }>> {
    await this.ensureConnected();
    if (withScores) {
      const flat = await this.client.zrange(key, start, stop, "WITHSCORES");
      const result: Array<{ member: string; score: number }> = [];
      for (let i = 0; i < flat.length; i += 2) {
        result.push({ member: flat[i], score: Number(flat[i + 1]) });
      }
      return result;
    }
    return this.client.zrange(key, start, stop);
  }

  async dbsize(): Promise<number> {
    await this.ensureConnected();
    return this.client.dbsize();
  }
}
