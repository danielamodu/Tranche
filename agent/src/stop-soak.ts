import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";

function main() {
  const logDir = path.resolve(process.env.AGENT_SOAK_LOG_DIR ?? "soak-evidence");
  const pidFile = path.join(logDir, "soak.pid");
  if (!existsSync(pidFile)) {
    console.log(`No active soak PID file found at ${pidFile}`);
    process.exit(0);
  }

  const parsed = JSON.parse(readFileSync(pidFile, "utf8")) as {
    pid: number;
    sessionId?: string;
  };
  const pid = parsed.pid;
  try {
    process.kill(pid, "SIGTERM");
    console.log(`Sent SIGTERM to soak runner (pid=${pid}, session=${parsed.sessionId ?? "unknown"}).`);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ESRCH") {
      console.log(`Process ${pid} is not running; removing stale PID file ${pidFile}.`);
      try {
        unlinkSync(pidFile);
      } catch {
        // ignore
      }
      process.exit(0);
    }
    throw err;
  }
}

main();
