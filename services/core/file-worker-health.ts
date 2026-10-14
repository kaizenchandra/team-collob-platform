import {readFile} from "node:fs/promises";
import {probeClamav} from "./clamav.ts";

try {
    const heartbeat = Number(await readFile("/tmp/concord-file-worker-heartbeat", "utf8"));
    const age = Date.now() - heartbeat;
    if (!Number.isFinite(heartbeat) || heartbeat <= 0 || age < -5000 || age >= 120000) throw new Error("Invalid heartbeat");
    await probeClamav(3000);
} catch {
    console.error("File worker or scanner is not ready");
    process.exitCode = 1;
}
