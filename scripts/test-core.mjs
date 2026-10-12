import { spawn } from "node:child_process";
const child = spawn(
  process.execPath,
  ["--import", "tsx", "--test", "tests/core.test.ts", "tests/pending-messages.test.ts"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        "postgres://concord:local-development-only@localhost:55432/concord_test",
    },
  },
);
child.on("exit", (code) => process.exit(code ?? 1));
