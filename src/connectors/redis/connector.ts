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
/**
 * Information about a single Redis logical database parsed from
 * `INFO keyspace`. INFO returns one line per non-empty database in the form:
 *   `db0:keys=3,expires=0,avg_ttl=0`
 */
export interface KeyspaceInfo {
  keys: number;
  expires: number;
  avg_ttl: number;
}

export class RedisConnector {
  readonly id: string;
  readonly description?: string;
  readonly maxKeys: number;
  /**
   * Default-db client (configured via toml `database` field, usually 0).
   * Per-db clients are created lazily via getClient(db) when an MCP caller
   * passes an explicit db parameter (Phase: T-004 multi-db support).
   */
  private client: Redis;
  /**
   * Default db index, used when an MCP caller does NOT pass `db` to a tool.
   * Corresponds to the `db` field of RedisSourceConfig.
   */
  private readonly defaultDb: number;
  /**
   * Lazy per-db connection pool. Key is the db index (e.g. 1, 6, 8).
   * The default-db client lives in `this.client` and is also reachable via
   * getClient(defaultDb) so callers don't have to special-case.
   *
   * Why a pool instead of `client.select(db)` per call:
   *   ioredis SELECT is connection-state-mutating. Concurrent MCP calls
   *   targeting different dbs would race each other on a single shared
   *   client. A small lazy pool sidesteps that without paying for 16
   *   connections up front.
   */
  private readonly dbClients: Map<number, Redis> = new Map();
  /**
   * Cached options used to spawn per-db clients via duplicate(). Stored on
   * the instance because ioredis doesn't expose them after construction.
   */
  private readonly options: RedisOptions;
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
    this.defaultDb = config.db ?? 0;

    const options: RedisOptions = {
      host: config.host,
      port: config.port,
      password: config.password,
      db: this.defaultDb,
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
    this.options = options;

    this.client = new Redis(options);
    this.dbClients.set(this.defaultDb, this.client);

    this.attachClientListeners(this.client, this.defaultDb);
  }

  /**
   * Wire ioredis lifecycle event logging onto a client. Used both for the
   * default-db client and for lazily-spawned per-db clients.
   */
  private attachClientListeners(client: Redis, db: number): void {
    const tag = `[redis:${this.id}:db${db}]`;
    client.on("error", (err: Error) => {
      console.error(`${tag} connection error: ${err.message}`);
    });
    client.on("ready", () => {
      console.error(`${tag} ready`);
    });
    client.on("reconnecting", (delayMs: number) => {
      console.error(`${tag} reconnecting (next attempt in ${delayMs}ms)`);
    });
    client.on("end", () => {
      console.error(`${tag} connection ended`);
      if (db === this.defaultDb) {
        // Only the default-db client drives connectAttempted; per-db clients
        // manage themselves via ioredis retryStrategy.
        this.connectAttempted = false;
      }
      // Drop the per-db client so the next call recreates a fresh one.
      // Don't drop the default-db client — ensureConnected will re-attach.
      if (db !== this.defaultDb) {
        this.dbClients.delete(db);
      }
    });
  }

  /**
   * Resolve the right ioredis client for a given db index. Creates a fresh
   * connection on the first hit, caches it, and returns the same client on
   * subsequent hits. The default-db client is created in the constructor;
   * other dbs get spawned via duplicate() so they share TCP / TLS settings
   * but maintain independent SELECT state.
   */
  private async getClient(db?: number): Promise<Redis> {
    const target = db ?? this.defaultDb;

    // Validate range up front so we don't burn a connection on garbage input.
    if (!Number.isInteger(target) || target < 0 || target > 15) {
      throw new Error(
        `Invalid Redis db index: ${target}. Must be an integer between 0 and 15.`
      );
    }

    // Default-db path: ensureConnected() handles wait/reconnecting/end states.
    if (target === this.defaultDb) {
      await this.ensureConnected();
      return this.client;
    }

    // Cached per-db client — fast path.
    let client = this.dbClients.get(target);
    if (client) {
      // Same status check as ensureConnected for the default client.
      const status = client.status;
      if (status === "ready" || status === "connecting" || status === "connect" || status === "reconnecting") {
        return client;
      }
      if (status === "wait") {
        await client.connect();
        return client;
      }
      // status === "end" or unknown — drop and rebuild.
      this.dbClients.delete(target);
    }

    // Spawn a fresh client targeting the requested db. duplicate() copies
    // host / port / password / TLS but lets us override `db` and `lazyConnect`.
    client = new Redis({ ...this.options, db: target, lazyConnect: true });
    this.dbClients.set(target, client);
    this.attachClientListeners(client, target);
    await client.connect();
    return client;
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
    // Tear down all per-db clients (including the default-db one).
    const all = Array.from(this.dbClients.values());
    this.dbClients.clear();
    for (const client of all) {
      try {
        client.disconnect();
      } catch {
        // best effort
      }
    }
    this.connectAttempted = false;
  }

  // ----- READ-ONLY commands -----
  // All methods accept an optional `db` parameter (Phase: T-004). When `db`
  // is omitted the call goes to the source's configured default-db client.
  // When `db` is provided and != defaultDb, getClient(db) returns a cached
  // (or freshly spawned) connection scoped to that db, leaving the default
  // client untouched. Concurrent calls on different dbs do not race.

  async get(key: string, db?: number): Promise<string | null> {
    const client = await this.getClient(db);
    return client.get(key);
  }

  async mget(keys: string[], db?: number): Promise<(string | null)[]> {
    if (keys.length === 0) return [];
    const client = await this.getClient(db);
    return client.mget(...keys);
  }

  /**
   * List keys matching a glob-style pattern using SCAN (safer than KEYS).
   * Caps results at this.maxKeys to protect against large keyspaces.
   */
  async keys(
    pattern: string,
    limit?: number,
    db?: number
  ): Promise<{ keys: string[]; truncated: boolean }> {
    const client = await this.getClient(db);
    const cap = Math.min(limit ?? this.maxKeys, this.maxKeys);
    const found: string[] = [];
    let cursor = "0";
    let truncated = false;

    do {
      const [next, batch] = await client.scan(cursor, "MATCH", pattern, "COUNT", 100);
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

  async type(key: string, db?: number): Promise<RedisKeyType> {
    const client = await this.getClient(db);
    const t = await client.type(key);
    return t as RedisKeyType;
  }

  async exists(keys: string[], db?: number): Promise<number> {
    if (keys.length === 0) return 0;
    const client = await this.getClient(db);
    return client.exists(...keys);
  }

  async ttl(key: string, db?: number): Promise<number> {
    const client = await this.getClient(db);
    return client.ttl(key);
  }

  async hget(key: string, field: string, db?: number): Promise<string | null> {
    const client = await this.getClient(db);
    return client.hget(key, field);
  }

  async hgetall(key: string, db?: number): Promise<Record<string, string>> {
    const client = await this.getClient(db);
    return client.hgetall(key);
  }

  async lrange(key: string, start: number, stop: number, db?: number): Promise<string[]> {
    const client = await this.getClient(db);
    return client.lrange(key, start, stop);
  }

  async smembers(key: string, db?: number): Promise<string[]> {
    const client = await this.getClient(db);
    return client.smembers(key);
  }

  async sismember(key: string, member: string, db?: number): Promise<boolean> {
    const client = await this.getClient(db);
    const result = await client.sismember(key, member);
    return result === 1;
  }

  async zrange(
    key: string,
    start: number,
    stop: number,
    withScores: boolean = false,
    db?: number
  ): Promise<string[] | Array<{ member: string; score: number }>> {
    const client = await this.getClient(db);
    if (withScores) {
      const flat = await client.zrange(key, start, stop, "WITHSCORES");
      const result: Array<{ member: string; score: number }> = [];
      for (let i = 0; i < flat.length; i += 2) {
        result.push({ member: flat[i], score: Number(flat[i + 1]) });
      }
      return result;
    }
    return client.zrange(key, start, stop);
  }

  async dbsize(db?: number): Promise<number> {
    const client = await this.getClient(db);
    return client.dbsize();
  }

  /**
   * Parse `INFO keyspace` output into a per-db summary. Returns one entry
   * per non-empty database. Empty databases are NOT in the response (Redis
   * itself omits them). T-004 new tool: redis_info_keyspace.
   *
   * Sample raw INFO output:
   *   # Keyspace
   *   db0:keys=3,expires=0,avg_ttl=0
   *   db1:keys=28365,expires=5000,avg_ttl=1800
   */
  async infoKeyspace(): Promise<Record<string, KeyspaceInfo>> {
    // INFO works against any client; reuse the default-db one.
    const client = await this.getClient(this.defaultDb);
    const raw = await client.info("keyspace");
    const result: Record<string, KeyspaceInfo> = {};
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      // Format: dbN:keys=K,expires=E,avg_ttl=T
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx === -1) continue;
      const dbName = trimmed.slice(0, colonIdx);
      const fields = trimmed.slice(colonIdx + 1).split(",");
      const parsed: Partial<KeyspaceInfo> = {};
      for (const field of fields) {
        const eqIdx = field.indexOf("=");
        if (eqIdx === -1) continue;
        const k = field.slice(0, eqIdx);
        const v = Number(field.slice(eqIdx + 1));
        if (k === "keys") parsed.keys = v;
        else if (k === "expires") parsed.expires = v;
        else if (k === "avg_ttl") parsed.avg_ttl = v;
      }
      result[dbName] = {
        keys: parsed.keys ?? 0,
        expires: parsed.expires ?? 0,
        avg_ttl: parsed.avg_ttl ?? 0,
      };
    }
    return result;
  }
}
