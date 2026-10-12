// Local-only, repeatable configuration. New flow versions are built before binding.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { request } from "./local-identity-admin.mjs";
const realm = "concord-local";
const desired = JSON.parse(
  await readFile(
    new URL("../infra/keycloak/concord-local-realm.json", import.meta.url),
    "utf8",
  ),
);
const root = desired.authenticationFlows.find(
  (f) => f.alias === desired.browserFlow,
);
const configs = new Map(desired.authenticatorConfig.map((c) => [c.alias, c]));
const definitions = new Map(
  desired.authenticationFlows.map((f) => [f.alias, f]),
);
const flows = await request(`${realm}/authentication/flows`);
if (!flows.some((f) => f.alias === root.alias))
  await request(`${realm}/authentication/flows`, "POST", {
    alias: root.alias,
    providerId: "basic-flow",
    topLevel: true,
    builtIn: false,
  });
async function children(alias) {
  return (
    await request(`${realm}/authentication/flows/${alias}/executions`)
  ).filter((e) => e.level === 0);
}
async function install(alias) {
  const definition = definitions.get(alias);
  for (const step of definition.authenticationExecutions) {
    let entries = await children(alias);
    let execution = entries.find((e) =>
      step.authenticatorFlow
        ? e.displayName === step.flowAlias
        : e.providerId === step.authenticator,
    );
    if (!execution) {
      const path = `${realm}/authentication/flows/${alias}/executions`;
      if (step.authenticatorFlow)
        await request(`${path}/flow`, "POST", {
          alias: step.flowAlias,
          type: "basic-flow",
          provider: "basic-flow",
        });
      else
        await request(`${path}/execution`, "POST", {
          provider: step.authenticator,
        });
      entries = await children(alias);
      execution = entries.find((e) =>
        step.authenticatorFlow
          ? e.displayName === step.flowAlias
          : e.providerId === step.authenticator,
      );
    }
    assert.ok(execution, "Expected authenticator execution");
    await request(`${realm}/authentication/flows/${alias}/executions`, "PUT", {
      ...execution,
      requirement: step.requirement,
    });
    if (step.authenticatorConfig) {
      const config = configs.get(step.authenticatorConfig);
      if (execution.authenticationConfig)
        await request(
          `${realm}/authentication/config/${execution.authenticationConfig}`,
          "PUT",
          config,
        );
      else
        await request(
          `${realm}/authentication/executions/${execution.id}/config`,
          "POST",
          config,
        );
    }
    if (step.authenticatorFlow) await install(step.flowAlias);
  }
}
async function verify(alias) {
  const entries = await children(alias),
    steps = definitions.get(alias).authenticationExecutions;
  assert.deepEqual(
    entries.map((e) => [
      e.authenticationFlow ? e.displayName : e.providerId,
      e.requirement,
    ]),
    steps.map((e) => [
      e.authenticatorFlow ? e.flowAlias : e.authenticator,
      e.requirement,
    ]),
  );
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.authenticatorConfig) {
      const actual = await request(
        `${realm}/authentication/config/${entries[i].authenticationConfig}`,
      );
      assert.deepEqual(
        actual.config,
        configs.get(step.authenticatorConfig).config,
      );
    }
    if (step.authenticatorFlow) await verify(step.flowAlias);
  }
}
await install(root.alias);
await verify(root.alias);
const actions = await request(`${realm}/authentication/required-actions`);
const recovery = actions.find(
  (a) => a.alias === "CONFIGURE_RECOVERY_AUTHN_CODES",
);
assert.ok(recovery, "Provider recovery-code required action must exist");
await request(
  `${realm}/authentication/required-actions/${recovery.alias}`,
  "PUT",
  { ...recovery, enabled: true, defaultAction: false },
);
for (const target of desired.clients) {
  const clients = await request(`${realm}/clients?clientId=${target.clientId}`);
  if (!clients.length) await request(`${realm}/clients`, "POST", target);
  else {
    assert.equal(clients.length, 1);
    const old = clients[0];
    await request(`${realm}/clients/${old.id}`, "PUT", {
      ...old,
      attributes: { ...old.attributes, ...target.attributes },
      webOrigins: target.webOrigins,
    });
  }
}
await request(realm, "PUT", {
  browserFlow: root.alias,
  revokeRefreshToken: desired.revokeRefreshToken,
  refreshTokenMaxReuse: desired.refreshTokenMaxReuse,
});
console.log(
  "Verified and bound local password + OTP/recovery flow with mandatory enrollment fallback; users retained.",
);
