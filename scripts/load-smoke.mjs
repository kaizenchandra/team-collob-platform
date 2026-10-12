import { writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
const base = process.env.API_URL ?? "http://localhost:4100";
const response = await fetch(`${base}/v1/session`, {
  method: "POST",
  headers: {
    origin: "http://localhost:3100",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    email: "alice@acme.test",
    password: "Development123!",
  }),
});
if (!response.ok) throw new Error("Development login required");
const cookie = response.headers.get("set-cookie").split(";")[0];
const headers = {
  cookie,
  origin: "http://localhost:3100",
  "Content-Type": "application/json",
};
const org = "11111111-1111-4111-8111-111111111111",
  channel = "44444444-4444-4444-8444-444444444444";
async function measure(count, concurrency, fn) {
  let index = 0;
  const timings = [];
  let errors = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (index++ < count) {
        const start = performance.now();
        try {
          const r = await fn();
          await r.arrayBuffer();
          if (!r.ok) errors++;
        } catch {
          errors++;
        }
        timings.push(performance.now() - start);
      }
    }),
  );
  timings.sort((a, b) => a - b);
  return {
    count,
    concurrency,
    errors,
    p50Ms: +timings[Math.floor(timings.length * 0.5)].toFixed(2),
    p95Ms: +timings[Math.floor(timings.length * 0.95)].toFixed(2),
    maxMs: +timings.at(-1).toFixed(2),
  };
}
const reads = await measure(100, 5, () =>
  fetch(`${base}/v1/channels/${channel}/messages`, { headers }),
);
const search = await measure(50, 5, () =>
  fetch(`${base}/v1/organizations/${org}/search?q=welcome`, { headers }),
);
const bootstrap = await (
  await fetch(`${base}/v1/organizations/${org}/bootstrap`, { headers })
).json();
const current = bootstrap.channels.find((c) => c.id === channel);
// Reapply current preferences; never alter the operator's preferences or generate content.
const writes = await measure(50, 5, () =>
  fetch(`${base}/v1/channels/${channel}/preferences`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      pinned: current.pinned,
      muted: current.muted,
      hidden: current.hidden,
    }),
  }),
);
const result = {
  at: new Date().toISOString(),
  host: {
    platform: os.platform(),
    arch: os.arch(),
    cpus: os.cpus().length,
    memoryGiB: Math.round(os.totalmem() / 1024 ** 3),
    node: process.version,
  },
  boundary:
    "Local HTTP roundtrip including body transfer; warm services; concurrency 5; small development dataset; no external dependencies. Not target-scale evidence.",
  reads,
  search,
  writes,
};
await mkdir("docs/evidence", { recursive: true });
await writeFile(
  "docs/evidence/load-smoke.json",
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result, null, 2));
