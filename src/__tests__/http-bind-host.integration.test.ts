import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('HTTP bind host integration', () => {
  let serverProcess: ChildProcess | null = null;
  let testDbPath: string;
  let testConfigPath: string;
  const testPort = 3002;
  const testHost = '127.0.0.1';
  const startupLogs: string[] = [];

  beforeAll(async () => {
    const testId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    testDbPath = path.join(os.tmpdir(), `bind_host_test_${testId}.db`);
    testConfigPath = path.join(os.tmpdir(), `bind_host_test_${testId}.toml`);
    fs.writeFileSync(
      testConfigPath,
      `[[sources]]\n` +
        `id = "default"\n` +
        `dsn = ${JSON.stringify(`sqlite://${testDbPath}`)}\n`
    );

    // Invoke tsx directly via node to avoid pnpm.cmd resolution issues on Windows.
    const tsxCli = path.resolve(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const entry = path.resolve(process.cwd(), 'src', 'index.ts');

    serverProcess = spawn(process.execPath, [
      tsxCli,
      entry,
      `--config=${testConfigPath}`,
      '--transport=http',
      `--port=${testPort}`,
      `--host=${testHost}`,
    ], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
      },
      stdio: 'pipe',
    });

    serverProcess.stdout?.on('data', (data) => {
      startupLogs.push(data.toString());
    });
    serverProcess.stderr?.on('data', (data) => {
      startupLogs.push(data.toString());
    });

    // Wait for /healthz to respond on the configured host
    let ready = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      try {
        const res = await fetch(`http://${testHost}:${testPort}/healthz`);
        if (res.status === 200) {
          ready = true;
          break;
        }
      } catch {
        // not ready yet
      }
    }

    if (!ready) {
      throw new Error(`Server did not bind to ${testHost}:${testPort} within timeout. Logs:\n${startupLogs.join('')}`);
    }
  }, 45000);

  afterAll(async () => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        if (!serverProcess) return resolve();
        // Without clearing this on normal exit, the pending timer keeps
        // the Vitest process alive until the 5s tail elapses.
        const killTimeout = setTimeout(() => {
          if (serverProcess && !serverProcess.killed) serverProcess.kill('SIGKILL');
          resolve();
        }, 5000);
        serverProcess.on('exit', () => {
          clearTimeout(killTimeout);
          resolve();
        });
      });
    }
    if (testDbPath && fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    if (testConfigPath && fs.existsSync(testConfigPath)) {
      fs.unlinkSync(testConfigPath);
    }
  });

  it('responds on the configured host', async () => {
    const res = await fetch(`http://${testHost}:${testPort}/healthz`);
    expect(res.status).toBe(200);
  });

  it('logs the actual bound address at startup', () => {
    const allLogs = startupLogs.join('');
    expect(allLogs).toContain(`${testHost}:${testPort}`);
  });
});
