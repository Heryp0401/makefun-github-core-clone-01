import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const forge = join(dir, "forge");
if (!existsSync(forge)) {
  console.error("[launcher] forge binary not found:", forge);
  process.exit(1);
}
const child = spawn(forge, [], { stdio: "inherit", env: process.env });
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
child.on("error", (err) => {
  console.error("[launcher] failed to spawn forge:", err);
  process.exit(1);
});
