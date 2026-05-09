/**
 * Bearer-token auth middleware for dbhub HTTP transport.
 *
 * Phase 3 simplified design (single founder use case):
 *   - api-keys.toml lists keys with sha256 hash + sources whitelist
 *   - if api-keys.toml is absent, auth is OFF (backwards compatible)
 *   - stdio transport bypasses auth entirely (local cc direct connect)
 *   - workbench static assets (/) and /healthz stay public
 *
 * What this file owns:
 *   - loadApiKeys(): parse api-keys.toml into an in-memory map
 *   - createAuthMiddleware(): Express middleware factory
 *   - resolveAllowedSources(): given a request, return the source whitelist
 *
 * Author: ziye
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import toml from "@iarna/toml";
import type { Request, Response, NextFunction } from "express";

// ---------- types ----------

export interface ApiKeyEntry {
  name: string;
  /** sha256:<hex> form. */
  hash: string;
  /** Source whitelist, or ["*"] for all. */
  sources: string[];
  /** Optional: ISO date for human bookkeeping. Not used for validation. */
  created_at?: string;
  /** Optional: if true, this key is disabled (kept in file for audit). */
  revoked?: boolean;
}

interface RawApiKeysToml {
  keys?: ApiKeyEntry[];
}

export interface AuthContext {
  /** The matched key's name (e.g. "ziye-master"). */
  keyName: string;
  /** The whitelist of source IDs this key can access. ["*"] = all. */
  allowedSources: string[];
}

// ---------- config loading ----------

const DEFAULT_CONFIG_PATHS = [
  // Same directory as dbhub.toml — most natural place.
  path.join(process.cwd(), "api-keys.toml"),
  // Common Linux deploy path.
  "/app/api-keys.toml",
  "/opt/dbhub/api-keys.toml",
];

/**
 * Resolve the path to api-keys.toml, in priority order:
 *   1. $DBHUB_API_KEYS env var
 *   2. ./api-keys.toml (next to dbhub.toml)
 *   3. /app/api-keys.toml (in-container default)
 *   4. /opt/dbhub/api-keys.toml (host install default)
 *
 * Returns null if nothing exists, which means auth is disabled.
 */
export function resolveApiKeysPath(): string | null {
  const envPath = process.env.DBHUB_API_KEYS;
  if (envPath) {
    return fs.existsSync(envPath) ? envPath : null;
  }
  for (const p of DEFAULT_CONFIG_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Load and parse api-keys.toml. Returns a map keyed by sha256 hash for O(1)
 * lookup. Throws on validation errors so misconfiguration fails loudly.
 */
export function loadApiKeys(configPath: string): Map<string, ApiKeyEntry> {
  const content = fs.readFileSync(configPath, "utf-8");
  const parsed = toml.parse(content) as unknown as RawApiKeysToml;

  if (!parsed.keys || !Array.isArray(parsed.keys)) {
    throw new Error(
      `Configuration file ${configPath}: must contain a [[keys]] array. ` +
        `Example:\n\n[[keys]]\nname = "ziye-master"\nhash = "sha256:..."\nsources = ["*"]`
    );
  }

  const byHash = new Map<string, ApiKeyEntry>();
  for (const entry of parsed.keys) {
    if (!entry.name || typeof entry.name !== "string") {
      throw new Error(`api-keys.toml: every [[keys]] entry must have a string 'name'`);
    }
    if (!entry.hash || typeof entry.hash !== "string") {
      throw new Error(`api-keys.toml: key '${entry.name}' missing 'hash'`);
    }
    if (!entry.hash.startsWith("sha256:")) {
      throw new Error(
        `api-keys.toml: key '${entry.name}' hash must start with 'sha256:' (got '${entry.hash.slice(0, 16)}...')`
      );
    }
    if (!Array.isArray(entry.sources) || entry.sources.length === 0) {
      throw new Error(
        `api-keys.toml: key '${entry.name}' sources must be a non-empty array (use ["*"] for all)`
      );
    }
    if (entry.revoked) {
      // Keep the entry in file but skip from runtime map.
      continue;
    }
    if (byHash.has(entry.hash)) {
      throw new Error(
        `api-keys.toml: duplicate hash for keys '${byHash.get(entry.hash)!.name}' and '${entry.name}'`
      );
    }
    byHash.set(entry.hash, entry);
  }

  return byHash;
}

// ---------- middleware ----------

const BEARER_PREFIX = "Bearer ";

function sha256(input: string): string {
  return "sha256:" + crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Constant-time comparison to mitigate timing-attack-based key recovery.
 * (Single-founder use case so the risk is small, but cheap to do right.)
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Look up a raw bearer token in the keys map. Returns null if no match.
 * Iterates the map (not a direct lookup) so that all candidate hashes are
 * compared in constant time, regardless of whether the user-supplied key
 * was correct or not.
 */
function findKeyByRawToken(
  rawToken: string,
  keys: Map<string, ApiKeyEntry>
): ApiKeyEntry | null {
  const candidate = sha256(rawToken);
  let match: ApiKeyEntry | null = null;
  for (const [hash, entry] of keys.entries()) {
    if (safeEqual(hash, candidate) && match === null) {
      match = entry;
    }
  }
  return match;
}

/**
 * Express middleware factory. If api-keys.toml exists, returns a real auth
 * gate; otherwise returns a no-op middleware (auth disabled).
 *
 * The middleware attaches `req.dbhubAuth` with the matched key context so
 * downstream handlers (tools/list, tools/call) can apply source whitelisting.
 */
export interface AuthMiddlewareOptions {
  /**
   * Override the api-keys.toml path. If undefined, uses resolveApiKeysPath().
   */
  configPath?: string;
}

export function createAuthMiddleware(options: AuthMiddlewareOptions = {}) {
  const configPath = options.configPath ?? resolveApiKeysPath();

  if (!configPath) {
    console.error("Auth: api-keys.toml not found, HTTP transport runs without auth (single-user dev mode).");
    // No-op middleware. Sets a permissive auth context so downstream code can
    // treat req.dbhubAuth uniformly.
    return (req: Request, _res: Response, next: NextFunction) => {
      (req as Request & { dbhubAuth?: AuthContext }).dbhubAuth = {
        keyName: "(no auth)",
        allowedSources: ["*"],
      };
      next();
    };
  }

  let keys: Map<string, ApiKeyEntry>;
  try {
    keys = loadApiKeys(configPath);
  } catch (err) {
    console.error(`Auth: failed to load ${configPath}, refusing to start: ${(err as Error).message}`);
    throw err;
  }
  console.error(
    `Auth: loaded ${keys.size} key(s) from ${configPath}. HTTP transport requires Bearer header.`
  );

  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith(BEARER_PREFIX)) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Missing Bearer token. Set Authorization: Bearer <api-key>.",
      });
    }
    const rawToken = header.slice(BEARER_PREFIX.length).trim();
    if (!rawToken) {
      return res.status(401).json({ error: "Unauthorized", message: "Empty Bearer token." });
    }

    const match = findKeyByRawToken(rawToken, keys);
    if (!match) {
      return res.status(401).json({ error: "Unauthorized", message: "Invalid API key." });
    }

    (req as Request & { dbhubAuth?: AuthContext }).dbhubAuth = {
      keyName: match.name,
      allowedSources: match.sources,
    };
    next();
  };
}

/**
 * Check whether a given source ID is allowed by the key's whitelist.
 * "*" in the whitelist is a wildcard meaning "all sources".
 */
export function isSourceAllowed(sourceId: string, allowedSources: string[]): boolean {
  if (allowedSources.includes("*")) return true;
  return allowedSources.includes(sourceId);
}
