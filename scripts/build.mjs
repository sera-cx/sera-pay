import { spawn } from "node:child_process";

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: true,
      env: { ...process.env, ...env },
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

await run("vite", ["build"], {
  NODE_OPTIONS: "--max-old-space-size=4096",
  NODE_ENV: "production",
});

await run("esbuild", [
  "server/_core/index.ts",
  "--platform=node",
  "--packages=external",
  "--bundle",
  "--format=esm",
  "--outdir=dist",
], {
  NODE_ENV: "production",
});
