import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import type { TrancheDeployment } from "@tranche/sdk";

export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close(() => reject(new Error("Failed to allocate free port")));
        return;
      }
      const { port } = addr;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

export function resolveAnvilBinary(): string {
  const windowsPath = "C:\\Users\\USER\\.foundry\\bin\\anvil.exe";
  if (existsSync(windowsPath)) return windowsPath;
  return "anvil";
}

export async function startTempAnvil(): Promise<{ rpcUrl: string; port: number; proc: ChildProcess }> {
  const port = await getFreePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const proc = spawn(resolveAnvilBinary(), ["--host", "127.0.0.1", "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Drain stdio pipes so the child buffer never stalls on long runs.
  proc.stdout?.resume();
  proc.stderr?.resume();

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`Anvil exited prematurely with code ${proc.exitCode}`);
    }
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) {
        return { rpcUrl, port, proc };
      }
    } catch {
      // Wait for Anvil RPC readiness.
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  await stopTempAnvil(proc);
  throw new Error("Timed out waiting for temporary anvil node.");
}

export async function stopTempAnvil(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Ignore if already exited.
      }
      resolve();
    }, 2_000);

    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });

    try {
      proc.kill();
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

export async function warpTime(deployment: TrancheDeployment, seconds: number): Promise<number> {
  await deployment.publicClient.request({
    method: "evm_increaseTime" as never,
    params: [seconds] as never,
  });
  await deployment.publicClient.request({
    method: "evm_mine" as never,
    params: [] as never,
  });
  const block = await deployment.publicClient.getBlock({ blockTag: "latest" });
  return Number(block.timestamp);
}
