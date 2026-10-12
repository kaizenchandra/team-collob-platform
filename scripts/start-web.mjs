import { spawn } from "node:child_process";
const child = spawn(process.execPath, [".next/standalone/server.js"], {
  stdio: "inherit",
  env: {
    ...process.env,
    PORT: process.env.PORT ?? "3100",
    HOSTNAME: process.env.WEB_HOST ?? "127.0.0.1",
  },
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 1));
