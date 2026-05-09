/**
 * Mini keygen helper for dbhub api-keys.toml.
 *
 * Run: node dist/keygen.js [name]
 *
 * Prints a freshly generated raw key (give to the client) and its sha256 hash
 * (paste into api-keys.toml). The raw key is shown ONCE — re-run if you lose it.
 *
 * Author: ziye
 */

import crypto from "crypto";

function generateRawKey(): string {
  // 32 bytes of randomness, base64url encoded → 43 chars, URL-safe.
  return "dbhub_sk_" + crypto.randomBytes(32).toString("base64url");
}

function sha256(input: string): string {
  return "sha256:" + crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function main(): void {
  const name = process.argv[2] || "unnamed";
  const rawKey = generateRawKey();
  const hash = sha256(rawKey);

  // Stderr: instructions; Stdout: machine-friendly key=value lines so it can be piped.
  process.stderr.write(
    `\nGenerated key for "${name}". Show the RAW key to the client ONCE; store the HASH in api-keys.toml.\n\n`
  );
  process.stdout.write(`raw_key=${rawKey}\n`);
  process.stdout.write(`hash=${hash}\n`);
  process.stderr.write(
    `\nadd to api-keys.toml:\n\n` +
      `[[keys]]\n` +
      `name = "${name}"\n` +
      `hash = "${hash}"\n` +
      `sources = ["*"]                # or ["awakening", "cognitive"] to restrict\n` +
      `created_at = "${new Date().toISOString().slice(0, 10)}"\n\n`
  );
}

main();
