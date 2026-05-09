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
  /**
   * Tracks whether we've ever attempted to bring the client up (i.e. called
   * `client.connect()`). Once true, we let ioredis manage reconnection via
   * its retryStrategy. Status of the live connection is read from
   * `client.status`, NOT from a stale boolean (Nova FB-01).
   */
  private connectAttempted: boolean = false;

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
      // Allow per-command retries during transient disconnects. ioredis defaults to 20;
      // keep it modest so MCP callers see errors quickly when the server is genuinely down.
      maxRetriesPerRequest: 3,
      // Exponential backoff for reconnection (Nova FB-01). Without this ioredis
      // gives up on disconnect and the client stays dead forever, which is what
      // happened with the old `retryStrategy: () => null`.
      retryStrategy: (times: number) => {
        // 100ms, 200ms, 500ms, 1000ms, 2000ms, then cap at 2000ms thereafter.
        const schedule = [100, 200, 500, 1000, 2000];
        const delay = schedule[Math.min(times - 1, schedule.length - 1)];
        if (times === 1) {
          console.error(`[redis:${this.id}] connection lost, reconnecting in ${delay}ms`);
        }
        return delay;
      },
      // ioredis built-in: queue commands while connection is reconnecting so
      // a brief redis blip doesn't surface as errors to MCP callers.
      enableOfflineQueue: true,
      // Don't auto-resubscribe (we don't use pub/sub anyway).
      autoResubscribe: false,
    };

    this.client = new Redis(options);

    this.client.on("error", (err: Error) => {
      // Log but don't throw — individual command calls will surface errors via
      // the await chain. Hot stack of repeated errors during reconnect is
      // expected; ioredis emits one "error" per retry attempt.
      console.error(`[redis:${this.id}] connection error: ${err.message}`);
    });
    this.client.on("ready", () => {
      console.error(`[redis:${this.id}] ready`);
    });
    this.client.on("reconnecting", (delayMs: number) => {
      console.error(`[redis:${this.id}] reconnecting (next attempt in ${delayMs}ms)`);
    });
    this.client.on("end", () => {
      // Connection closed and ioredis stopped retrying. The next ensureConnected()
      // call will trigger a fresh connect() instead of trusting a stale flag.
      console.error(`[redis:${this.id}] connection ended`);
      this.connectAttempted = false;
    });
  }

  /**
   * Ensure the client has been started. Reads live status from ioredis instead
   * of trusting a cached boolean (Nova FB-01: ensureConnected used to check a
   * stale `isConnected` flag, which stayed true across actual disconnects).
   *
   * Status values from ioredis:
   *   wait        — initial state under lazyConnect, before connect() is called
   *   connecting  — TCP / TLS handshake in progress
   *   connect     — TCP up, AUTH not yet done
   *   ready       — fully usable
   *   reconnecting — backoff between reconnect attempts
   *   end         — closed and not retrying
   */
  private async ensureConnected(): Promise<void> {
    const status = this.client.status;

    if (status === "ready") {
      // Already fully connected — fast path.
      return;
    }

    if (status === "connecting" || status === "connect" || status === "reconnecting") {
      // ioredis is in flight; offlineQueue will buffer the next command for us,
      // so we can fall through. The actual command call will resolve once status
      // reaches "ready" or fail with an error after retries.
      this.connectAttempted = true;
      return;
    }

    if (status === "wait") {
      // Lazy connect: call connect() exactly once. Subsequent reconnects are
      // handled by retryStrategy.
      this.connectAttempted = true;
      await this.client.connect();
      return;
    }

    if (status === "end") {
      // ioredis closed the connection and stopped retrying. Re-enter via connect().
      this.connectAttempted = true;
      await this.client.connect();
      return;
    }

    // Unknown status — try a connect for safety.
    this.connectAttempted = true;
    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    if (this.connectAttempted) {
      this.client.disconnect();
      this.connectAttempted = false;
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
