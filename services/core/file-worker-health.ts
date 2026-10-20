import {assertWorkerHeartbeat} from "./worker-heartbeat.ts";
import {probeClamav} from "./clamav.ts";

try {
    await assertWorkerHeartbeat("/tmp/concord-file-worker-heartbeat", 120000);
    await probeClamav(3000);
} catch {
    console.error("File worker or scanner is not ready");
    process.exitCode = 1;
}
