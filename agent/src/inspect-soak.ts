import path from "node:path";
import { findLatestSoakSessionDir, inspectSoakSession } from "./soak-evidence.js";

function main() {
  const logDir = path.resolve(process.env.AGENT_SOAK_LOG_DIR ?? "soak-evidence");
  const explicitDir = process.argv[2];
  const targetDir = explicitDir ? path.resolve(explicitDir) : findLatestSoakSessionDir(logDir);

  if (!targetDir) {
    console.log(`No soak sessions found in ${logDir}`);
    process.exit(0);
  }

  const report = inspectSoakSession(targetDir);
  console.log(JSON.stringify(report, null, 2));
}

main();
