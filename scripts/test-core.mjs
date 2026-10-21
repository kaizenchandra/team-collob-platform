import { spawn } from "node:child_process";
const child = spawn(
  process.execPath,
  ["--import", "tsx", "--test", "tests/core.test.ts", "tests/db-timeouts.test.ts", "tests/media-config.test.ts", "tests/camera-background.test.ts", "tests/meeting-layout.test.ts", "tests/organization.test.ts", "tests/pending-call-chat.test.ts", "tests/meeting-time.test.ts", "tests/calendar.test.ts", "tests/calendar-media.test.ts", "tests/message-link.test.ts", "tests/message-sequence.test.ts", "tests/file-link.test.ts", "tests/clamav.test.ts", "tests/worker-heartbeat.test.ts", "tests/pending-messages.test.ts", "tests/draft-attachments.test.ts", "tests/draft-replies.test.ts", "tests/backup.test.mjs", "tests/backup-preflight.test.mjs", "tests/recovery-kit.test.mjs", "tests/restore-transfer.test.mjs", "tests/release-health.test.mjs"],
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
