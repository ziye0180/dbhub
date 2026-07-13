import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import express from "express";
import http from "http";
import path from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

import { ConnectorManager } from "./connectors/manager.js";
import { ConnectorRegistry } from "./connectors/interface.js";
import { RedisManager } from "./connectors/redis/manager.js";
import { registerRedisToolsForSource } from "./connectors/redis/tools.js";
import type { RedisSourceConfig } from "./connectors/redis/connector.js";
import { resolveTransport, resolvePort, resolveHost, resolveAllowedHosts, resolveSourceConfigs, isDemoMode } from "./config/env.js";
import { registerTools } from "./tools/index.js";
import { createAuthMiddleware, isSourceAllowed, type AuthContext } from "./middleware/auth.js";
import { listSources, getSource } from "./api/sources.js";
import { listRequests } from "./api/requests.js";
import { generateStartupTable, buildSourceDisplayInfo } from "./utils/startup-table.js";
import { getToolsForSource } from "./utils/tool-metadata.js";
import { startConfigWatcher } from "./utils/config-watcher.js";
import { validateOrigin, buildAllowedHosts, getSelfHosts, ALLOW_ANY_HOST } from "./utils/cross-origin.js";

// Create __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load package.json to get version
const packageJsonPath = path.join(__dirname, "..", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

// Server info
export const SERVER_NAME = "DBHub MCP Server";
export const SERVER_VERSION = packageJson.version;

/**
 * Generate ASCII art banner with version information
 */
export function generateBanner(version: string, modes: string[] = []): string {
  // Create a mode string that includes all active modes
  const modeText = modes.length > 0 ? ` [${modes.join(' | ')}]` : '';

  return `
 _____  ____  _   _       _     
|  __ \\|  _ \\| | | |     | |    
| |  | | |_) | |_| |_   _| |__  
| |  | |  _ <|  _  | | | | '_ \\ 
| |__| | |_) | | | | |_| | |_) |
|_____/|____/|_| |_|\\__,_|_.__/ 
                                
v${version}${modeText} - Minimal Database MCP Server
`;
}

/**
 * Initialize and start the DBHub server
 */
export async function main(): Promise<void> {
  try {
    // Resolve source configurations from TOML or fallback to single DSN
    const sourceConfigsData = await resolveSourceConfigs();

    if (!sourceConfigsData) {
      const samples = ConnectorRegistry.getAllSampleDSNs();
      const sampleFormats = Object.entries(samples)
        .map(([id, dsn]) => `  - ${id}: ${dsn}`)
        .join("\n");

      console.error(`
ERROR: Database connection configuration is required.
Please provide configuration in one of these ways (in order of priority):

1. Use demo mode: --demo (uses in-memory SQLite with sample employee database)
2. TOML config file: --config=path/to/dbhub.toml or ./dbhub.toml
3. Command line argument: --dsn="your-connection-string"
4. Environment variable: export DSN="your-connection-string"
5. .env file: DSN=your-connection-string

Example DSN formats:
${sampleFormats}

Example TOML config (dbhub.toml):
  [[sources]]
  id = "my_db"
  dsn = "postgres://user:pass@localhost:5432/dbname"

See documentation for more details on configuring database connections.
`);
      process.exit(1);
    }

    // Split SQL sources from Redis sources. Redis is handled by a parallel
    // RedisManager (see src/connectors/redis/) since the SQL Connector
    // interface is SQL-centric and doesn't fit Redis's key-value model.
    const allSources = sourceConfigsData.sources;
    const sqlSources = allSources.filter((s) => s.type !== "redis");
    const redisSources = allSources.filter((s) => s.type === "redis");

    // Create connector manager and connect to SQL database(s).
    const connectorManager = new ConnectorManager();
    const sources = sqlSources;

    console.error(`Configuration source: ${sourceConfigsData.source}`);

    if (sqlSources.length > 0) {
      // Connect to SQL database(s) - works uniformly for demo, single DSN, multi-source TOML.
      await connectorManager.connectWithSources(sqlSources);
    }

    // Register Redis sources in parallel manager (lazy connect on first use).
    if (redisSources.length > 0) {
      const redisManager = RedisManager.getInstance();
      const redisConfigs: RedisSourceConfig[] = redisSources.map((s) => ({
        id: s.id,
        description: s.description,
        host: s.host!,
        port: s.port ?? 6379,
        password: s.password,
        db: typeof s.database === "string" ? Number(s.database) : (s.database as unknown as number) ?? 0,
        max_keys: s.max_keys,
        connection_timeout: s.connection_timeout,
        command_timeout: s.command_timeout,
      }));
      console.error(`Registering ${redisSources.length} Redis source(s)...`);
      redisManager.registerSources(redisConfigs);
    }

    // Initialize tool registry for SQL sources/tools only.
    // Redis tools are registered directly in createServer() below.
    const { initializeToolRegistry } = await import("./tools/registry.js");
    initializeToolRegistry({
      sources: sqlSources,
      tools: sourceConfigsData.tools,
    });
    console.error("Tool registry initialized");

    // Start watching TOML config file for hot reload (only when using TOML config).
    // In STDIO mode, tool list is registered once — hot reload updates connections and
    // tool registry, but STDIO clients won't see added/removed tools without restart.
    // HTTP transport creates a new server per request, so tool changes apply immediately.
    const stopConfigWatcher = startConfigWatcher({
      connectorManager,
      initialTools: sourceConfigsData.tools,
    });

    // Create MCP server factory function for HTTP transport.
    // allowedSources is set per-request from the auth middleware so that
    // tools/list only returns tools the caller is permitted to use.
    // (Stateless mode: a fresh server is built per /mcp request.)
    const createServer = (allowedSources?: string[]) => {
      const server = new McpServer({
        name: SERVER_NAME,
        version: SERVER_VERSION,
      });

      // Register SQL tools (both built-in and custom) via the ToolRegistry.
      registerTools(server, allowedSources);

      // Register Redis tools (one set per allowed Redis source).
      for (const redisSource of redisSources) {
        if (allowedSources && !isSourceAllowed(redisSource.id, allowedSources)) {
          continue;
        }
        registerRedisToolsForSource(server, redisSource.id);
      }

      return server;
    };

    // Resolve transport type (for MCP server)
    const transportData = resolveTransport();

    // Resolve port and host for HTTP server (only needed for http transport)
    const port = transportData.type === "http" ? resolvePort().port : null;
    const host = transportData.type === "http" ? resolveHost().host : null;

    // DNS-rebinding allow-list for the HTTP transport: loopback is always
    // permitted; a wildcard bind also auto-allows this machine's hostname/IPs so
    // network clients work without extra config, and operators add any other
    // served hostnames via --allowed-hosts / DBHUB_ALLOWED_HOSTS ("*" disables).
    const allowedHosts =
      transportData.type === "http"
        ? buildAllowedHosts(resolveAllowedHosts().hosts, host ?? undefined, getSelfHosts())
        : new Set<string>();

    // Print ASCII art banner with version and slogan
    // Collect active modes
    const activeModes: string[] = [];
    const modeDescriptions: string[] = [];
    const isDemo = isDemoMode();

    if (isDemo) {
      activeModes.push("DEMO");
      modeDescriptions.push("using sample employee database");
    }

    // Output mode information
    if (activeModes.length > 0) {
      console.error(`Running in ${activeModes.join(' and ')} mode - ${modeDescriptions.join(', ')}`);
    }

    console.error(generateBanner(SERVER_VERSION, activeModes));

    // Print sources and tools table
    const sourceDisplayInfos = buildSourceDisplayInfo(
      sources,
      (sourceId) => getToolsForSource(sourceId).map((t) => t.readonly ? `🔒 ${t.name}` : t.name),
      isDemo
    );
    console.error(generateStartupTable(sourceDisplayInfos));

    // Clean up config watcher when the process is exiting (covers both transports)
    process.on("exit", () => { stopConfigWatcher?.(); });

    // Set up transport-specific server
    if (transportData.type === "http") {
      // HTTP transport: Start Express server with MCP endpoint and workbench
      const app = express();

      // Enable JSON parsing
      app.use(express.json());

      // DNS-rebinding guard: validate the Host header against an explicit
      // allow-list (loopback + the bind host + any --allowed-hosts) on every
      // request, and validate Origin when present. A rebound attacker hostname
      // is not on the list and is rejected even though Origin and Host agree —
      // closing GHSA-fm8p-53ww-hf6w / GHSA-fp99-xwp4-hv8q / GHSA-qvg2-3c48-77mx.
      // Non-browser MCP clients targeting an allowed host are unaffected.
      app.use((req, res, next) => {
        const origin = req.headers.origin;
        const result = validateOrigin(origin, req.headers.host, allowedHosts);
        if (!result.ok) {
          return res.status(result.status).json({
            error: result.status === 400 ? 'Bad Request' : 'Forbidden',
            message: result.message,
          });
        }

        // CORS headers — only reflect validated origins
        res.header('Access-Control-Allow-Origin', origin || 'http://localhost');
        res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id, Authorization');
        res.header('Access-Control-Allow-Credentials', 'true');

        if (req.method === 'OPTIONS') {
          return res.sendStatus(200);
        }
        next();
      });

      // Serve static frontend files
      const frontendPath = path.join(__dirname, "public");
      app.use(express.static(frontendPath));

      // Health check endpoint (public — used by uptime probes / docker healthcheck).
      app.get("/healthz", (req, res) => {
        res.status(200).send("OK");
      });

      // Phase 3 Bearer auth: applies to /mcp + /api/sources* + /api/requests.
      // Workbench static assets (/) and /healthz remain public — see
      // pm-atlas/projects/dbhub/decisions.md D-008 (Option C).
      const authMiddleware = createAuthMiddleware();

      // Data sources API endpoints (gated).
      app.get("/api/sources", authMiddleware, listSources);
      app.get("/api/sources/:sourceId", authMiddleware, getSource);
      app.get("/api/requests", authMiddleware, listRequests);

      // Main endpoint for streamable HTTP transport
      // SSE streaming (GET requests) is not supported in stateless mode
      // Return 405 Method Not Allowed for GET requests to indicate this
      app.get("/mcp", authMiddleware, (req, res) => {
        res.status(405).json({
          error: 'Method Not Allowed',
          message: 'SSE streaming is not supported in stateless mode. Use POST requests with JSON responses.'
        });
      });

      app.post("/mcp", authMiddleware, async (req, res) => {
        try {
          // In stateless mode, create a new instance of transport and server for each request
          // to ensure complete isolation. A single instance would cause request ID collisions
          // when multiple clients connect concurrently.
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined, // Disable session management for stateless mode
            enableJsonResponse: true // Use JSON responses (SSE not supported in stateless mode)
          });

          // Pull the auth context attached by the middleware. When auth is
          // disabled, the middleware sets {keyName: "(no auth)", allowedSources: ["*"]}
          // so the rest of the code path stays uniform.
          const auth = (req as typeof req & { dbhubAuth?: AuthContext }).dbhubAuth;
          const server = createServer(auth?.allowedSources);

          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
        } catch (error) {
          console.error("Error handling request:", error);
          if (!res.headersSent) {
            res.status(500).json({ error: 'Internal server error' });
          }
        }
      });

      // SPA fallback - serve index.html for all non-API routes (production only)
      // In development, the frontend is served by Vite dev server
      if (process.env.NODE_ENV !== 'development') {
        app.get("*", (req, res) => {
          res.sendFile(path.join(frontendPath, "index.html"));
        });
      }

      // Start the HTTP server. Create explicitly so the `error` listener is
      // attached before listen() — otherwise synchronous bind failures
      // (EADDRINUSE, EACCES on privileged ports) can fire before the listener
      // is registered. Matches the pattern used in utils/ssh-tunnel.ts.
      const httpServer = http.createServer(app);

      httpServer.on('error', (err) => {
        const displayHost = host!.includes(':') ? `[${host!}]` : host!;
        console.error(`Failed to bind HTTP server to ${displayHost}:${port}: ${err.message}`);
        process.exit(1);
      });

      httpServer.listen(port!, host!, () => {
        const address = httpServer.address();
        const boundHost = typeof address === 'object' && address ? address.address : host!;
        const boundPort = typeof address === 'object' && address ? address.port : port!;
        const displayHost = boundHost.includes(':') ? `[${boundHost}]` : boundHost;
        // Wildcard binds (0.0.0.0 / ::) are not routable; use localhost for user URLs.
        const userHost = (boundHost === '0.0.0.0' || boundHost === '::') ? 'localhost' : displayHost;

        console.error(`HTTP server listening on ${displayHost}:${boundPort}`);

        // Surface the DNS-rebinding allow-list so operators know which Host
        // values are accepted (and how to widen it for network deployments).
        if (allowedHosts.has(ALLOW_ANY_HOST)) {
          console.error('Allowed hosts: * (DNS-rebinding protection DISABLED — ensure DBHub is fronted by your own auth/proxy)');
        } else {
          console.error(`Allowed hosts: ${[...allowedHosts].join(', ')} (set --allowed-hosts to serve other hostnames)`);
        }

        // In development mode, suggest using the Vite dev server for hot reloading.
        // Vite serves from localhost; use the same hostname for the backend hint so
        // cross-origin calls from Vite satisfy the DNS-rebinding middleware check.
        if (process.env.NODE_ENV === 'development') {
          console.error('Development mode detected!');
          console.error('   Workbench dev server (with HMR): http://localhost:5173');
          console.error(`   Backend API: http://localhost:${boundPort}`);
          console.error('');
        } else {
          console.error(`Workbench at http://${userHost}:${boundPort}/`);
        }
        console.error(`MCP server endpoint at http://${userHost}:${boundPort}/mcp`);
      });
    } else {
      // STDIO transport: Pure MCP-over-stdio, no HTTP server
      const server = createServer();
      const transport = new StdioServerTransport();
      await server.connect(transport);
      console.error("MCP server running on stdio");

      let isShuttingDown = false;
      const shutdown = async () => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        console.error("Shutting down...");
        await transport.close();
        await connectorManager.disconnect();
        process.exit(0);
      };

      // Listen for SIGINT/SIGTERM to gracefully shut down
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      // Exit when stdin closes (parent process terminated).
      // On Windows, SIGINT/SIGTERM are not reliably sent when the parent
      // process exits — detecting stdin EOF is the portable way to handle this.
      process.stdin.on("end", shutdown);
    }
  } catch (err) {
    console.error("Fatal error:", err);
    process.exit(1);
  }
}
