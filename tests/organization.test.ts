import { test } from "node:test";
import assert from "node:assert/strict";
import { reportingPath } from "../lib/organization.ts";
test("reporting path stops at a repeated employee and never repairs the source", () => {
  const chain = [
    { id: "root", name: "Leader" },
    { id: "manager", name: "Manager" },
    { id: "root", name: "Leader" },
  ];
  const saved = structuredClone(chain);
  assert.deepEqual(reportingPath("selected", chain, "complete"), {
    chain: chain.slice(0, 2),
    status: "cycle",
  });
  assert.deepEqual(chain, saved);
  assert.equal(
    reportingPath("selected", [{ id: "selected" }], "complete").chain.length,
    0,
  );
});
test("people with the same display name remain distinct identities in reporting paths", () => {
  const chain = [
    { id: "first", name: "Morgan Lee" },
    { id: "second", name: "Morgan Lee" },
  ];
  assert.deepEqual(reportingPath("third", chain, "complete"), {
    chain,
    status: "complete",
  });
});
test("unknown, restricted and truncated paths retain their explicit source status", () => {
  for (const status of ["unknown", "unavailable", "truncated"] as const)
    assert.deepEqual(reportingPath("employee", [], status), {
      chain: [],
      status,
    });
  assert.equal(reportingPath("root", [], "complete").status, "complete");
});
