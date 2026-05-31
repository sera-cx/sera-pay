import { spawn } from "node:child_process";

process.env.NODE_ENV = "development";

const child = spawn("tsx", ["watch", "server/_core/index.ts"], {
  stdio: "inherit",
  shell: true,
  env: process.env,
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
