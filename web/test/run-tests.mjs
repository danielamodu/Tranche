import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");

const suites = [
  { entry: "protocol.integration.test.ts", out: "protocol.integration.test.mjs" },
  { entry: "agentApi.test.ts", out: "agentApi.test.mjs" },
];

const outFiles = [];
for (const s of suites) {
  const outFile = path.join(webRoot, "node_modules", ".tmp", s.out);
  await build({
    entryPoints: [path.join(webRoot, "test", s.entry)],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outfile: outFile,
    alias: {
      "@": path.join(webRoot, "src"),
    },
  });
  outFiles.push(outFile);
}

const result = spawnSync(process.execPath, ["--test", ...outFiles], {
  stdio: "inherit",
  cwd: webRoot,
});

process.exit(result.status ?? 1);
