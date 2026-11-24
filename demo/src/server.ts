import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  TrancheDemoSession,
  formatTrancheError,
  type Step1Options,
  type Step5Options,
} from "./engine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../public");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function jsonStringifySafe(value: unknown): string {
  return JSON.stringify(value, (_key, val) => (typeof val === "bigint" ? val.toString() : val));
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = jsonStringifySafe(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

async function readJsonBody<T extends object>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {} as T;
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object.");
  }
  return parsed as T;
}

async function serveStatic(res: ServerResponse, requestPath: string): Promise<void> {
  const rel = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  const resolved = path.resolve(PUBLIC_DIR, rel);
  if (!resolved.startsWith(PUBLIC_DIR + path.sep) && resolved !== path.join(PUBLIC_DIR, "index.html")) {
    sendJson(res, 403, { ok: false, error: "Forbidden" });
    return;
  }

  try {
    const content = await readFile(resolved);
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME_TYPES[ext] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { ok: false, error: `Not found: ${requestPath}` });
  }
}

export interface StartedDemoServer {
  server: Server;
  session: TrancheDemoSession;
  port: number;
  baseUrl: string;
  close: () => Promise<void>;
}

export async function startDemoServer(options?: {
  port?: number;
  host?: string;
  session?: TrancheDemoSession;
}): Promise<StartedDemoServer> {
  const host = options?.host ?? "127.0.0.1";
  const requestedPort = options?.port ?? Number(process.env.PORT ?? 3177);
  const session = options?.session ?? new TrancheDemoSession();

  await session.init();

  const server = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const pathname = url.pathname;

    try {
      if (method === "GET" && pathname === "/api/state") {
        const state = await session.getState();
        sendJson(res, 200, { ok: true, state });
        return;
      }

      if (method === "POST" && pathname === "/api/reset") {
        const state = await session.reset();
        sendJson(res, 200, { ok: true, state });
        return;
      }

      if (method === "POST" && pathname === "/api/run-all") {
        const body = await readJsonBody<Step1Options & Step5Options>(req);
        const result = await session.runAllSteps(body);
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (method === "POST" && pathname === "/api/step/1") {
        const body = await readJsonBody<Step1Options>(req);
        const result = await session.step1(body);
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (method === "POST" && pathname === "/api/step/2") {
        const result = await session.step2();
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (method === "POST" && pathname === "/api/step/3") {
        const result = await session.step3();
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (method === "POST" && pathname === "/api/step/4") {
        const result = await session.step4();
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (method === "POST" && pathname === "/api/step/5") {
        const body = await readJsonBody<Step5Options>(req);
        const result = await session.step5(body);
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (method === "POST" && pathname === "/api/step/6") {
        const result = await session.step6();
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (method === "GET" && !pathname.startsWith("/api/")) {
        await serveStatic(res, pathname);
        return;
      }

      sendJson(res, 404, { ok: false, error: `Unknown endpoint: ${method} ${pathname}` });
    } catch (err) {
      const formatted = formatTrancheError(err);
      sendJson(res, formatted.statusCode, { ok: false, error: formatted.message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Failed to bind demo HTTP server.");
  }

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await session.shutdown();
  };

  return {
    server,
    session,
    port: addr.port,
    baseUrl: `http://${host}:${addr.port}`,
    close,
  };
}

const isMainModule =
  process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMainModule) {
  let started: StartedDemoServer | undefined;
  let shuttingDown = false;

  const handleSignal = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[Tranche Demo] Received ${signal}; shutting down server and local Anvil...`);
    if (started) {
      await started.close();
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void handleSignal("SIGINT"));
  process.on("SIGTERM", () => void handleSignal("SIGTERM"));

  startDemoServer()
    .then((s) => {
      started = s;
      console.log(`[Tranche Demo] Dashboard running at ${s.baseUrl}`);
      console.log(`[Tranche Demo] Mode: LOCAL_EIP712_COMPLIANCE on local Anvil (Zero Mainnet Spend)`);
    })
    .catch(async (err) => {
      console.error("[Tranche Demo] Fatal startup error:", err);
      if (started) {
        await started.close();
      }
      process.exit(1);
    });
}
