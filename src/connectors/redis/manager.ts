/**
 * RedisManager — singleton registry for RedisConnector instances.
 *
 * Parallel to ConnectorManager (which handles SQL connectors). Keeping them
 * separate lets us add Redis support without touching the SQL Connector
 * interface. See pm-atlas/projects/dbhub/decisions.md D-005.
 *
 * Author: ziye
 */

import { RedisConnector, RedisSourceConfig } from "./connector.js";

let managerInstance: RedisManager | null = null;

export class RedisManager {
  private connectors: Map<string, RedisConnector> = new Map();

  constructor() {
    if (!managerInstance) {
      managerInstance = this;
    }
  }

  /**
   * Register all configured Redis sources. Connections are lazy by default
   * (handled inside RedisConnector via lazyConnect: true).
   */
  registerSources(configs: RedisSourceConfig[]): void {
    for (const cfg of configs) {
      if (this.connectors.has(cfg.id)) {
        throw new Error(`Redis source '${cfg.id}' already registered.`);
      }
      this.connectors.set(cfg.id, new RedisConnector(cfg));
      console.error(
        `  - ${cfg.id}: redis://${cfg.password ? "***@" : ""}${cfg.host}:${cfg.port}/${cfg.db ?? 0} (lazy)`
      );
    }
  }

  getConnector(sourceId: string): RedisConnector {
    const conn = this.connectors.get(sourceId);
    if (!conn) {
      const available = Array.from(this.connectors.keys());
      throw new Error(
        `Redis source '${sourceId}' not found. Available: ${available.length > 0 ? available.join(", ") : "(none)"}`
      );
    }
    return conn;
  }

  getAvailableSourceIds(): string[] {
    return Array.from(this.connectors.keys());
  }

  hasSource(sourceId: string): boolean {
    return this.connectors.has(sourceId);
  }

  async disconnectAll(): Promise<void> {
    for (const conn of this.connectors.values()) {
      try {
        await conn.disconnect();
      } catch {
        // best effort
      }
    }
    this.connectors.clear();
  }

  // ----- static helpers -----

  static getInstance(): RedisManager {
    if (!managerInstance) {
      managerInstance = new RedisManager();
    }
    return managerInstance;
  }

  static getConnector(sourceId: string): RedisConnector {
    return RedisManager.getInstance().getConnector(sourceId);
  }

  static getAvailableSourceIds(): string[] {
    return RedisManager.getInstance().getAvailableSourceIds();
  }

  static hasSource(sourceId: string): boolean {
    return RedisManager.getInstance().hasSource(sourceId);
  }
}
