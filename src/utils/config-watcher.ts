import fs from "fs";
import { loadTomlConfig, resolveTomlConfigPath } from "../config/toml-loader.js";
import { ConnectorManager } from "../connectors/manager.js";
import { RedisManager } from "../connectors/redis/manager.js";
import type { RedisSourceConfig } from "../connectors/redis/connector.js";
import { initializeToolRegistry } from "../tools/registry.js";
import type { SourceConfig, ToolConfig } from "../types/config.js";

/**
 * Map a TOML SourceConfig of type=redis to a RedisSourceConfig.
 * Mirrors the same mapping done at startup in src/server.ts so the two
 * code paths stay in sync.
 */
function toRedisSourceConfig(s: SourceConfig): RedisSourceConfig {
  return {
    id: s.id,
    description: s.description,
    host: s.host!,
    port: s.port ?? 6379,
    password: s.password,
    db:
      typeof s.database === "string"
        ? Number(s.database)
        : ((s.database as unknown as number) ?? 0),
    max_keys: s.max_keys,
    connection_timeout: s.connection_timeout,
    command_timeout: s.command_timeout,
  };
}

const DEBOUNCE_MS = 500;

interface ConfigWatcherOptions {
  connectorManager: ConnectorManager;
  initialTools?: ToolConfig[];
}

/**
 * Watch the TOML configuration file for changes and reload sources automatically.
 * Only applicable when using TOML-based configuration.
 *
 * NOTE: In STDIO transport mode, the MCP server's tool list is registered once at
 * startup. Hot reload updates the underlying database connections and tool registry,
 * but STDIO clients won't see added/removed tools until a full server restart.
 * HTTP transport creates a fresh server per request, so tool changes take effect immediately.
 */
export function startConfigWatcher(options: ConfigWatcherOptions): (() => void) | null {
  const { connectorManager, initialTools } = options;
  const configPath = resolveTomlConfigPath();
  if (!configPath) {
    return null;
  }

  let debounceTimer: NodeJS.Timeout | null = null;
  let isReloading = false;
  let reloadPending = false;

  // Track last known-good config for rollback (sources + tools)
  let lastGoodSources: SourceConfig[] = connectorManager.getAllSourceConfigs();
  let lastGoodTools: ToolConfig[] | undefined = initialTools;

  const scheduleReload = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(reload, DEBOUNCE_MS);
  };

  const reload = async () => {
    if (isReloading) {
      reloadPending = true;
      return;
    }
    isReloading = true;
    reloadPending = false;

    try {
      console.error(`\nDetected change in ${configPath}, reloading configuration...`);

      // Parse and validate new config — if this throws, keep existing connections
      const newConfig = loadTomlConfig();
      if (!newConfig) {
        console.error("Config reload: failed to load TOML config, keeping existing connections.");
        return;
      }

      // Save current config for rollback
      const oldSources = lastGoodSources;
      const oldTools = lastGoodTools;

      // Split sources by type (Nova FB-02): Redis sources live in RedisManager,
      // not ConnectorManager. Passing redis sources to ConnectorManager.connectWithSources
      // makes it try to build a SQL DSN like `redis://...` and fail validation, which
      // then triggers a rollback that takes ALL SQL sources down. Filter early.
      const newSqlSources = newConfig.sources.filter((s) => s.type !== "redis");
      const newRedisSources = newConfig.sources.filter((s) => s.type === "redis");

      // Disconnect all existing connections (both SQL and Redis).
      await connectorManager.disconnect();
      await RedisManager.getInstance().disconnectAll();

      try {
        // Reconnect SQL sources (no-op if there are none).
        if (newSqlSources.length > 0) {
          await connectorManager.connectWithSources(newSqlSources);
        }

        // Re-register Redis sources (lazy connect on first use).
        if (newRedisSources.length > 0) {
          RedisManager.getInstance().registerSources(newRedisSources.map(toRedisSourceConfig));
        }

        // Re-initialize tool registry with SQL config only — Redis tools are
        // registered per-server in createServer() via registerRedisToolsForSource.
        initializeToolRegistry({
          sources: newSqlSources,
          tools: newConfig.tools,
        });

        // Update last known-good config (full source list, type-tagged).
        lastGoodSources = newConfig.sources;
        lastGoodTools = newConfig.tools;

        console.error(
          `Configuration reloaded successfully (sql: ${newSqlSources.length}, redis: ${newRedisSources.length}).`
        );
      } catch (connectError) {
        console.error("Failed to connect with new config, rolling back:", connectError);
        // Clean up any partial connections before rollback (both managers).
        try { await connectorManager.disconnect(); } catch { /* best effort */ }
        try { await RedisManager.getInstance().disconnectAll(); } catch { /* best effort */ }
        try {
          const oldSqlSources = oldSources.filter((s) => s.type !== "redis");
          const oldRedisSources = oldSources.filter((s) => s.type === "redis");
          if (oldSqlSources.length > 0) {
            await connectorManager.connectWithSources(oldSqlSources);
          }
          if (oldRedisSources.length > 0) {
            RedisManager.getInstance().registerSources(oldRedisSources.map(toRedisSourceConfig));
          }
          initializeToolRegistry({ sources: oldSqlSources, tools: oldTools });
          console.error("Rolled back to previous configuration.");
        } catch (rollbackError) {
          console.error("Rollback also failed, server has no active connections:", rollbackError);
        }
      }
    } catch (error) {
      console.error("Config reload failed, keeping existing connections:", error);
    } finally {
      isReloading = false;
      if (reloadPending) {
        reloadPending = false;
        scheduleReload();
      }
    }
  };

  const watcher = fs.watch(configPath, (eventType) => {
    if (eventType === "change") {
      scheduleReload();
    }
  });
  watcher.unref?.();
  watcher.on("error", (err) => {
    console.error("Config file watcher error:", err);
  });

  console.error(`Watching ${configPath} for changes (hot reload enabled)`);

  // Return cleanup function
  return () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    watcher.close();
  };
}
