import { spawn } from "node:child_process";
const child = spawn(
  process.execPath,
  ["--import", "tsx", "--test", "tests/core.test.ts", "tests/meeting-time.test.ts", "tests/clamav.test.ts", "tests/pending-messages.test.ts", "tests/backup.test.mjs", "tests/release-health.test.mjs"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      FILE_ROOT: process.env.TEST_FILE_ROOT ?? ".data/test-files",
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        "postgres://concord:local-development-only@localhost:55432/concord_test",
    },
  },
);
child.on("exit", (code) => process.exit(code ?? 1));
