import {execFile} from "node:child_process";
import {promisify} from "node:util";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApp } from "../services/core/server.ts";
import { pool, migrate } from "../services/core/db.ts";
import { seed, ids } from "../services/core/seed.ts";
process.env.DEV_AUTH = "true";
process.env.LOG_LEVEL = "silent";
let app: Awaited<ReturnType<typeof createApp>>;
const cookies: Record<string, string> = {};
const origin = "http://localhost:3100";
async function request(
  user: string,
  method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT",
  url: string,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    headers: { origin, cookie: cookies[user] },
    payload: payload as Record<string, unknown>,
  });
}
before(async () => {
  await migrate();
  await seed();
  app = await createApp();
  for (const [name, email] of [
    ["alice", "alice@acme.test"],
    ["bob", "bob@acme.test"],
    ["eve", "eve@northstar.test"],
    ["guest", "guest@partner.test"],
  ]) {
    const r = await app.inject({
      method: "POST",
      url: "/v1/session",
      headers: { origin },
      payload: { email, password: "Development123!" },
    });
    assert.equal(r.statusCode, 200, r.body);
    cookies[name] = String(r.headers["set-cookie"]).split(";")[0];
  }
});
after(async () => {
  await app.close();
  await pool.end();
});
test("anonymous and cross-origin requests are rejected", async () => {
  assert.equal((await app.inject({ url: "/v1/session" })).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/session",
        headers: { origin: "https://evil.test" },
        payload: {},
      })
    ).statusCode,
    403,
  );
});
test("tenant isolation across bootstrap, history, search, work, activity and audit", async () => {
  for (const route of [
    `/organizations/${ids.org}/bootstrap`,
    `/channels/${ids.channel}/messages`,
    `/organizations/${ids.org}/search?q=welcome`,
    `/channels/${ids.private}/tasks`,
    `/channels/${ids.private}/forms`,
    `/organizations/${ids.org}/activity`,
    `/organizations/${ids.org}/audit`,
    `/channels/${ids.channel}/files`,
  ])
    assert.equal(
      (await request("eve", "GET", "/v1" + route)).statusCode,
      404,
      route,
    );
  assert.equal(
    (await request("bob", "GET", `/v1/organizations/${ids.org}/audit`))
      .statusCode,
    403,
  );
});
test("private-channel visibility excludes a team guest", async () => {
  const r = await request(
    "guest",
    "GET",
    `/v1/organizations/${ids.org}/bootstrap`,
  );
  assert.equal(r.statusCode, 200);
  assert(!r.json().channels.some((x: { id: string }) => x.id === ids.private));
  assert.equal(
    (await request("guest", "GET", `/v1/channels/${ids.private}/messages`))
      .statusCode,
    404,
  );
});
test("concurrent retried writes commit one message and one ordered event", async () => {
  const clientId = randomUUID(),
    body = "concurrent-" + clientId;
  const responses = await Promise.all(
    Array.from({ length: 12 }, () =>
      request("alice", "POST", `/v1/channels/${ids.channel}/messages`, {
        clientId,
        body,
      }),
    ),
  );
  responses.forEach((r) => assert.equal(r.statusCode, 201, r.body));
  assert.equal(new Set(responses.map((r) => r.json().id)).size, 1);
  const rows = await pool.query("SELECT * FROM messages WHERE client_id=$1", [
    clientId,
  ]);
  assert.equal(rows.rowCount, 1);
  const events = await pool.query(
    "SELECT * FROM outbox WHERE payload->>'id'=$1",
    [rows.rows[0].id],
  );
  assert.equal(events.rowCount, 1);
  assert.equal(
    (
      await request("alice", "POST", `/v1/channels/${ids.channel}/messages`, {
        clientId,
        body: "changed payload",
      })
    ).statusCode,
    409,
  );
  const other = await request(
    "bob",
    "GET",
    `/v1/channels/${ids.channel}/messages`,
  );
  assert(
    other.json().messages.some((m: { id: string }) => m.id === rows.rows[0].id),
  );
});
test("message edit ownership, threads, reactions and monotonic read position", async () => {
  const m = (
    await request("alice", "POST", `/v1/channels/${ids.channel}/messages`, {
      clientId: randomUUID(),
      body: "Editable message",
    })
  ).json();
  assert.equal(
    (
      await request(
        "bob",
        "PATCH",
        `/v1/channels/${ids.channel}/messages/${m.id}`,
        { body: "forged" },
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await request(
        "alice",
        "PATCH",
        `/v1/channels/${ids.channel}/messages/${m.id}`,
        { body: "Updated message" },
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await request("bob", "POST", `/v1/channels/${ids.channel}/messages`, {
        clientId: randomUUID(),
        body: "Thread response",
        parentId: m.id,
      })
    ).statusCode,
    201,
  );
  assert.equal(
    (
      await request(
        "bob",
        "POST",
        `/v1/channels/${ids.channel}/messages/${m.id}/reactions`,
        { emoji: "👍", active: true },
      )
    ).statusCode,
    200,
  );
  await request("bob", "POST", `/v1/channels/${ids.channel}/read`, {
    seq: Number(m.seq),
  });
  await request("bob", "POST", `/v1/channels/${ids.channel}/read`, { seq: 0 });
  const read = await pool.query(
    "SELECT seq FROM read_positions WHERE channel_id=$1 AND user_id=$2",
    [ids.channel, ids.bob],
  );
  assert.equal(read.rows[0].seq, m.seq);
  assert.equal(
    (
      await request("bob", "POST", `/v1/channels/${ids.channel}/read`, {
        seq: 99999999,
      })
    ).statusCode,
    400,
  );
});
test("search and draft persistence survive a fresh application instance", async () => {
  const term = "persistence" + randomUUID().replaceAll("-", "");
  await request("alice", "POST", `/v1/channels/${ids.channel}/messages`, {
    clientId: randomUUID(),
    body: term,
  });
  await request("bob", "PUT", `/v1/channels/${ids.channel}/draft`, {
    body: term,
  });
  const fresh = await createApp();
  const r = await fresh.inject({
    url: `/v1/organizations/${ids.org}/search?q=${term}`,
    headers: { cookie: cookies.bob },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().results[0].body, term);
  const d = await fresh.inject({
    url: `/v1/channels/${ids.channel}/draft`,
    headers: { cookie: cookies.bob },
  });
  assert.equal(d.json().body, term);
  await fresh.close();
});
test("private tasks and forms enforce assignment and response permissions", async () => {
  const task = await request(
    "alice",
    "POST",
    `/v1/channels/${ids.private}/tasks`,
    {
      title: "Test task",
      assigneeId: ids.bob,
      priority: "high",
      dueDate: "2026-12-01",
    },
  );
  assert.equal(task.statusCode, 200, task.body);
  assert.equal(
    (
      await request("alice", "POST", `/v1/channels/${ids.private}/tasks`, {
        title: "Leak",
        assigneeId: ids.eve,
        priority: "normal",
        dueDate: null,
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await request(
        "bob",
        "PATCH",
        `/v1/channels/${ids.private}/tasks/${task.json().id}`,
        { status: "done" },
      )
    ).statusCode,
    200,
  );
  const f = (
    await request("alice", "POST", `/v1/channels/${ids.private}/forms`, {
      title: "Feedback",
      questions: ["What worked?"],
    })
  ).json();
  assert.equal(
    (
      await request(
        "bob",
        "POST",
        `/v1/channels/${ids.private}/forms/${f.id}/responses`,
        { answers: ["Everything"] },
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await request(
        "bob",
        "GET",
        `/v1/channels/${ids.private}/forms/${f.id}/responses`,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await request(
        "alice",
        "GET",
        `/v1/channels/${ids.private}/forms/${f.id}/responses`,
      )
    ).json().responses.length,
    1,
  );
});
test("atomic channel conversion previews and applies explicit historical access changes", async () => {
  const created = (
    await request("alice", "POST", `/v1/organizations/${ids.org}/channels`, {
      name: "Migration test",
      kind: "standard",
      teamId: ids.team,
      members: [],
    })
  ).json();
  const before = await request(
    "guest",
    "GET",
    `/v1/channels/${created.id}/messages`,
  );
  assert.equal(before.statusCode, 200);
  const payload = { kind: "private", teamId: ids.team, members: [ids.bob] };
  const p = (
    await request(
      "alice",
      "POST",
      `/v1/channels/${created.id}/migration-preview`,
      payload,
    )
  ).json();
  assert(p.revoked.includes(ids.guest));
  assert.equal(
    (
      await request(
        "bob",
        "POST",
        `/v1/channels/${created.id}/migration-preview`,
        payload,
      )
    ).statusCode,
    403,
  );
  const key = randomUUID();
  const migrated = await request(
    "alice",
    "POST",
    `/v1/channels/${created.id}/migrate`,
    { ...payload, preview: p, clientId: key },
  );
  assert.equal(migrated.statusCode, 200, migrated.body);
  assert.equal(
    (await request("guest", "GET", `/v1/channels/${created.id}/messages`))
      .statusCode,
    404,
  );
  assert.equal(
    (
      await request("alice", "POST", `/v1/channels/${created.id}/migrate`, {
        ...payload,
        preview: p,
        clientId: key,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await request("alice", "POST", `/v1/channels/${created.id}/migrate`, {
        ...payload,
        preview: p,
        clientId: randomUUID(),
      })
    ).statusCode,
    409,
  );
});
test("meeting attendees must be tenant members; only organizer cancels", async () => {
  const b = {
    title: "Planning",
    startsAt: "2026-12-01T10:00:00Z",
    endsAt: "2026-12-01T10:30:00Z",
    timezone: "Asia/Kolkata",
    attendees: [ids.bob],
  };
  const m = await request(
    "alice",
    "POST",
    `/v1/organizations/${ids.org}/meetings`,
    b,
  );
  assert.equal(m.statusCode, 200, m.body);
  assert.equal(
    (
      await request("alice", "POST", `/v1/organizations/${ids.org}/meetings`, {
        ...b,
        attendees: [ids.eve],
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await request(
        "bob",
        "PATCH",
        `/v1/organizations/${ids.org}/meetings/${m.json().id}`,
        { cancelled: true },
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await request(
        "bob",
        "PATCH",
        `/v1/organizations/${ids.org}/meetings/${m.json().id}`,
        { response: "accepted" },
      )
    ).statusCode,
    200,
  );
});
test("files remain quarantined and cannot be discovered cross-tenant", async () => {
  const f = await request(
    "guest",
    "POST",
    `/v1/channels/${ids.channel}/files`,
    {
      name: "notes.txt",
      mime: "text/plain",
      content: Buffer.from("test document").toString("base64"),
    },
  );
  assert.equal(f.statusCode, 200, f.body);
  assert.equal(f.json().state, "quarantined");
  assert.equal(
    (
      await request(
        "alice",
        "GET",
        `/v1/channels/${ids.channel}/files/${f.json().id}/download`,
      )
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await request(
        "eve",
        "GET",
        `/v1/channels/${ids.channel}/files/${f.json().id}/download`,
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await request(
        "guest",
        "DELETE",
        `/v1/channels/${ids.channel}/files/${f.json().id}`,
      )
    ).statusCode,
    200,
  );
});
test("32-person receipts include every opted-in authorized recipient", async () => {
  const people = Array.from({ length: 32 }, () => randomUUID());
  for (const [i, user] of people.entries()) {
    await pool.query("INSERT INTO users(id,email,name) VALUES($1,$2,$3)", [
      user,
      `${user}@receipts.test`,
      `Receipt ${i}`,
    ]);
    await pool.query("INSERT INTO memberships VALUES($1,$2,'member',true)", [
      ids.org,
      user,
    ]);
  }
  const created = (
    await request("alice", "POST", `/v1/organizations/${ids.org}/channels`, {
      name: "Large receipt group",
      kind: "group",
      teamId: null,
      members: people,
    })
  ).json();
  const m = (
    await request("alice", "POST", `/v1/channels/${created.id}/messages`, {
      clientId: randomUUID(),
      body: "32-person receipt test",
    })
  ).json();
  for (const user of people) {
    const token = randomUUID();
    const { hash } = await import("../services/core/security.ts");
    await pool.query(
      "INSERT INTO sessions VALUES($1,$2,now()+interval '1 hour',now())",
      [hash(token), user],
    );
    const r = await app.inject({
      method: "POST",
      url: `/v1/channels/${created.id}/read`,
      headers: { origin, cookie: `concord_session=${token}` },
      payload: { seq: Number(m.seq) },
    });
    assert.equal(r.statusCode, 200, r.body);
  }
  const r = await request(
    "alice",
    "GET",
    `/v1/channels/${created.id}/receipts`,
  );
  assert.equal(r.json().receipts.length, 32);
  await pool.query(
    "UPDATE users SET preferences='{\"readReceipts\":false}' WHERE id=$1",
    [people[0]],
  );
  assert.equal(
    (
      await request("alice", "GET", `/v1/channels/${created.id}/receipts`)
    ).json().receipts.length,
    31,
  );
});
test("live event replay and membership revocation close an active subscription", async () => {
  const live = await createApp();
  const address = await live.listen({ port: 0, host: "127.0.0.1" });
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 10000);
  try {
    const c = (
      await request("alice", "POST", `/v1/organizations/${ids.org}/channels`, {
        name: "Revocation test",
        kind: "private",
        teamId: ids.team,
        members: [ids.bob],
      })
    ).json();
    const m = (
      await request("alice", "POST", `/v1/channels/${c.id}/messages`, {
        clientId: randomUUID(),
        body: "Replay event",
      })
    ).json();
    const response = await fetch(`${address}/v1/channels/${c.id}/events`, {
      headers: { cookie: cookies.bob, origin },
      signal: abort.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    let received = "";
    while (!received.includes("message.created")) {
      const value = await reader.read();
      assert(!value.done);
      received += new TextDecoder().decode(value.value);
    }
    assert(received.includes("message.created"));
    const eventId = received.match(/id: (\d+)/)![1];
    await pool.query(
      "DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2",
      [c.id, ids.bob],
    );
    while (!received.includes("event: revoked")) {
      const value = await reader.read();
      if (value.done) break;
      received += new TextDecoder().decode(value.value);
    }
    assert(received.includes("event: revoked"));
    assert.equal(
      (await request("bob", "GET", `/v1/channels/${c.id}/messages`)).statusCode,
      404,
    );
    await pool.query("INSERT INTO channel_members VALUES($1,$2,$3)", [
      ids.org,
      c.id,
      ids.bob,
    ]);
    await request("alice", "POST", `/v1/channels/${c.id}/messages`, {
      clientId: randomUUID(),
      body: "After reconnect",
    });
    const replay = await fetch(`${address}/v1/channels/${c.id}/events`, {
      headers: { cookie: cookies.bob, origin, "Last-Event-ID": eventId },
      signal: abort.signal,
    });
    const next = await replay.body!.getReader().read();
    const chunk = new TextDecoder().decode(next.value);
    assert(chunk.includes("message.created"));
    assert(!chunk.includes(`id: ${eventId}\n`));
    assert(m.id);
  } finally {
    clearTimeout(timeout);
    abort.abort();
    await live.close();
  }
});
test("invitations are identity-bound, expirable, single-use and revocable; last owner protected", async () => {
  const org = randomUUID();
  await pool.query("INSERT INTO organizations(id,name) VALUES($1,$2)", [
    org,
    "Invitation test",
  ]);
  await pool.query("INSERT INTO memberships VALUES($1,$2,'owner',true)", [
    org,
    ids.alice,
  ]);
  const invite = (
    await request("alice", "POST", `/v1/organizations/${org}/invitations`, {
      email: "eve@northstar.test",
      role: "guest",
    })
  ).json();
  assert.equal(
    (
      await request("bob", "POST", "/v1/invitations/accept", {
        token: invite.token,
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await request("eve", "POST", "/v1/invitations/accept", {
        token: invite.token,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await request("eve", "POST", "/v1/invitations/accept", {
        token: invite.token,
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await request(
        "eve",
        "PATCH",
        `/v1/organizations/${org}/members/${ids.eve}`,
        { role: "owner", active: true },
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await request(
        "alice",
        "PATCH",
        `/v1/organizations/${org}/members/${ids.alice}`,
        { role: "member", active: true },
      )
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await request(
        "alice",
        "PATCH",
        `/v1/organizations/${org}/members/${ids.eve}`,
        { role: "guest", active: false },
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (await request("eve", "GET", `/v1/organizations/${org}/bootstrap`))
      .statusCode,
    404,
  );
  assert.equal(
    (
      await request(
        "alice",
        "PATCH",
        `/v1/organizations/${org}/members/${ids.eve}`,
        { role: "guest", active: true },
      )
    ).statusCode,
    200,
  );
  const expired = (
    await request("alice", "POST", `/v1/organizations/${org}/invitations`, {
      email: "bob@acme.test",
      role: "member",
    })
  ).json();
  await pool.query(
    "UPDATE invitations SET expires_at=now()-interval '1 minute' WHERE id=$1",
    [expired.id],
  );
  assert.equal(
    (
      await request("bob", "POST", "/v1/invitations/accept", {
        token: expired.token,
      })
    ).statusCode,
    404,
  );
  const revoked = (
    await request("alice", "POST", `/v1/organizations/${org}/invitations`, {
      email: "bob@acme.test",
      role: "member",
    })
  ).json();
  await request(
    "alice",
    "DELETE",
    `/v1/organizations/${org}/invitations/${revoked.id}`,
  );
  assert.equal(
    (
      await request("bob", "POST", "/v1/invitations/accept", {
        token: revoked.token,
      })
    ).statusCode,
    404,
  );
});
test("receipt privacy opt-out and session logout enforced", async () => {
  await pool.query(
    `UPDATE users SET preferences=jsonb_set(preferences,'{readReceipts}','false') WHERE id=$1`,
    [ids.bob],
  );
  const r = await request(
    "alice",
    "GET",
    `/v1/channels/${ids.channel}/receipts`,
  );
  assert(
    !r.json().receipts.some((x: { user_id: string }) => x.user_id === ids.bob),
  );
  await pool.query(
    `UPDATE users SET preferences=jsonb_set(preferences,'{readReceipts}','true') WHERE id=$1`,
    [ids.bob],
  );
  assert.equal((await request("bob", "DELETE", "/v1/session")).statusCode, 200);
  assert.equal((await request("bob", "GET", "/v1/session")).statusCode, 401);
});

test("production rejects development authentication, development seed, and missing identity configuration",async()=>{
 const run=promisify(execFile);
 const env:NodeJS.ProcessEnv={...process.env,NODE_ENV:'production',DEV_AUTH:'true'};
 await assert.rejects(run(process.execPath,['--import','tsx','--input-type=module','-e',"const {createApp}=await import('./services/core/server.ts');await createApp();"],{env}),/Development authentication forbidden/);
 await assert.rejects(run(process.execPath,['--import','tsx','--input-type=module','-e',"const {seed}=await import('./services/core/seed.ts');await seed();"],{env}),/Seed requires/);
 await assert.rejects(run(process.execPath,['--import','tsx','--input-type=module','-e',"const {createApp}=await import('./services/core/server.ts');await createApp();"],{env:{...env,DEV_AUTH:'false',OIDC_ISSUER:''}}),/OIDC configuration required/);
});

test("OIDC state survives app recreation, rejects wrong browsers and permits only one concurrent consumption", async () => {
  const { saveLogin, consumeLogin } = await import("../services/core/oidc-state.ts");
  const { hash } = await import("../services/core/security.ts");
  const state = randomUUID();
  await saveLogin(state, "server-only-verifier", "nonce", "issuer-client-callback");
  await assert.rejects(consumeLogin(state, "wrong-cookie", "issuer-client-callback"), /state mismatch/);
  await assert.rejects(consumeLogin(state, state, "other-client"), /state mismatch/);
  const freshApp = await createApp();
  await freshApp.close();
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => consumeLogin(state, state, "issuer-client-callback")));
  assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
  const success = results.find(x => x.status === "fulfilled");
  assert.deepEqual(success?.value, { verifier: "server-only-verifier", nonce: "nonce" });
  await assert.rejects(consumeLogin(state, state, "issuer-client-callback"), /state mismatch/);
  const expired = randomUUID();
  await saveLogin(expired, "expired-secret", "nonce", "binding");
  await pool.query("UPDATE oidc_transactions SET expires_at=now()-interval '1 second' WHERE state_hash=$1", [hash(expired)]);
  await assert.rejects(consumeLogin(expired, expired, "binding"), /state mismatch/);
  const cleanup = randomUUID();
  await saveLogin(cleanup, "secret", "nonce", "binding");
  assert.equal((await pool.query("SELECT 1 FROM oidc_transactions WHERE state_hash=$1", [hash(expired)])).rowCount, 0);
  await consumeLogin(cleanup, cleanup, "binding");
});

test("production configuration requires explicit storage, HTTPS identity and assurance policy", async () => {
  const { validateConfiguration } = await import("../services/core/config.ts");
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "production", DATABASE_URL: "postgres://db.example/concord",
    WEB_ORIGIN: "https://app.example", OIDC_ISSUER: "https://id.example/realm",
    OIDC_CLIENT_ID: "concord", OIDC_CLIENT_SECRET: "test-only",
    OIDC_REDIRECT_URI: "https://api.example/v1/auth/callback", OIDC_REQUIRED_ACR: "urn:example:mfa",
    OIDC_RECONCILE:"true", OIDC_TOKEN_KEY_FILE:"/run/secrets/test-keyring",
  };
  assert.doesNotThrow(() => validateConfiguration(env));
  for (const key of ["DATABASE_URL", "WEB_ORIGIN", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_REDIRECT_URI", "OIDC_REQUIRED_ACR", "OIDC_TOKEN_KEY_FILE", "OIDC_RECONCILE"]) {
    assert.throws(() => validateConfiguration({ ...env, [key]: undefined }), /configured/);
  }
  assert.throws(() => validateConfiguration({ ...env, OIDC_LOCAL_HTTP: "true" }), /forbidden/);
  assert.throws(() => validateConfiguration({ ...env, OIDC_INTERNAL_ORIGIN: "http://keycloak:8080" }), /forbidden/);
  assert.throws(() => validateConfiguration({ ...env, OIDC_REDIRECT_URI: "http://api.example/callback" }), /HTTPS/);
  assert.throws(() => validateConfiguration({ ...env, WEB_ORIGIN: "https://app.example,http://other.example" }), /HTTPS/);
});

test("authentication throttling does not consume the session-status and logout budget", async () => {
  const isolated = await createApp();
  try {
    for (let i = 0; i < 60; i++) {
      const response = await isolated.inject({ method: "POST", url: "/v1/session", headers: { origin }, payload: {} });
      assert.equal(response.statusCode, 400);
    }
    assert.equal((await isolated.inject({ method: "POST", url: "/v1/session", headers: { origin }, payload: {} })).statusCode, 429);
    assert.equal((await isolated.inject({ url: "/v1/session" })).statusCode, 401);
    assert.equal((await isolated.inject({method:"POST",url:"/v1/auth/backchannel-logout",headers:{"content-type":"application/x-www-form-urlencoded"},payload:"logout_token=x&logout_token=y"})).statusCode,400);
    assert.equal((await isolated.inject({ method: "DELETE", url: "/v1/session", headers: { origin } })).statusCode, 401);
  } finally { await isolated.close(); }
});

test("logout JWT validation rejects wrong signatures, claims, audience, issuer and stale tokens", async () => {
  const { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } = await import("jose");
  const { verifyLogout } = await import("../services/core/provider-sessions.ts");
  const key = await generateKeyPair("RS256");
  const keys = createLocalJWKSet({ keys: [await exportJWK(key.publicKey)] });
  const claims = { iss: "https://provider.test", aud: "concord", iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+60, jti: randomUUID(), sid: "provider-session", events: { "http://schemas.openid.net/event/backchannel-logout": {} } };
  const sign = (body: Record<string, unknown>) => new SignJWT(body).setProtectedHeader({alg: "RS256", typ: "JWT"}).sign(key.privateKey);
  assert.equal((await verifyLogout(await sign(claims), claims.iss, "concord", keys)).sid, claims.sid);
  await assert.rejects(verifyLogout(await sign(claims), claims.iss, "concord", async () => { throw new TypeError("fetch failed"); }), (error: unknown) => (error as {statusCode:number}).statusCode === 503);
  for (const change of [{iss:"https://other.test"}, {aud:"other-client"}, {iat:claims.iat-600}, {iat:claims.iat+60}, {exp:undefined}, {exp:claims.iat-30}, {events:{}}, {events:{"http://schemas.openid.net/event/backchannel-logout":[]}}, {nonce:"nonce"}, {sid:undefined}, {jti:undefined}]) {
    await assert.rejects(verifyLogout(await sign({...claims,...change}), claims.iss, "concord", keys), /Invalid logout/);
  }
  const other = await generateKeyPair("RS256");
  const forgery = await new SignJWT(claims).setProtectedHeader({alg:"RS256"}).sign(other.privateKey);
  await assert.rejects(verifyLogout(forgery, claims.iss, "concord", keys), /Invalid logout/);
});

test("provider logout is scoped, idempotent, audited and prevents an in-flight callback restoring access", async () => {
  const { createProviderSession, revokeProviderSessions } = await import("../services/core/provider-sessions.ts");
  const issuer = `https://${randomUUID()}.test`, client = "concord", sub = "alice", now = Math.floor(Date.now()/1000);
  const tokens = Array.from({length: 5}, () => randomUUID());
  await createProviderSession(tokens[0], ids.alice, issuer, client, sub, "sid-a", now);
  await createProviderSession(tokens[1], ids.alice, issuer, client, sub, "sid-b", now);
  await createProviderSession(tokens[2], ids.alice, issuer, "other-client", sub, "sid-a", now);
  await createProviderSession(tokens[3], ids.alice, issuer + "/other", client, sub, "sid-a", now);
  const logout = {iss:issuer, iat:now, jti:randomUUID(), sub, sid:"sid-a", events:{"http://schemas.openid.net/event/backchannel-logout":{}}};
  await Promise.all(Array.from({length: 5}, () => revokeProviderSessions(logout, client)));
  assert.equal((await pool.query("SELECT 1 FROM sessions WHERE token_hash=$1",[tokens[0]])).rowCount, 0);
  for (const token of tokens.slice(1,4)) assert.equal((await pool.query("SELECT 1 FROM sessions WHERE token_hash=$1",[token])).rowCount, 1);
  assert.equal((await pool.query("SELECT 1 FROM audit WHERE action='identity.provider_logout' AND target=$1",[issuer])).rowCount, 1);
  await assert.rejects(createProviderSession(tokens[4], ids.alice, issuer, client, sub, "sid-a", now+1), /Provider session ended/);
  await revokeProviderSessions({...logout, jti:randomUUID(), sid:undefined}, client);
  assert.equal((await pool.query("SELECT 1 FROM sessions WHERE token_hash=$1",[tokens[1]])).rowCount, 0);
  await assert.rejects(createProviderSession(tokens[4], ids.alice, issuer, client, sub, "sid-c", now), /Provider session ended/);
  await createProviderSession(tokens[4], ids.alice, issuer, client, sub, "sid-c", now+1);
  await pool.query("DELETE FROM sessions WHERE token_hash=ANY($1::text[])", [tokens]);
});

test("signed logout endpoint has a narrow Origin exception and rejects malformed/oversized forms", async () => {
  const path = "/v1/auth/backchannel-logout";
  assert.equal((await app.inject({method:"POST",url:path,headers:{"content-type":"application/x-www-form-urlencoded"},payload:"logout_token=x&logout_token=y"})).statusCode,400);
  assert.equal((await app.inject({method:"POST",url:path,headers:{"content-type":"application/x-www-form-urlencoded"},payload:"logout_token="+"x".repeat(17000)})).statusCode,413);
  assert.equal((await app.inject({method:"POST",url:path,payload:{logout_token:"x"}})).statusCode,400);
  assert.equal((await app.inject({method:"POST",url:"/v1/session",payload:{}})).statusCode,403);
});

test('session assurance policy rejects legacy, weaker, foreign-client and disabled-user sessions', async () => {
  const { sessionReader } = await import('../services/core/session-policy.ts');
  const { createProviderSession } = await import('../services/core/provider-sessions.ts');
  const issuer = 'https://assurance.example.test';
  const tokens = Array.from({length:5}, () => randomUUID());
  const read = sessionReader({OIDC_ISSUER:issuer,OIDC_CLIENT_ID:'application',OIDC_REQUIRED_ACR:'mfa'});
  for (let i=0; i<4; i++) await createProviderSession(tokens[i], ids.alice, issuer, i===3?'foreign':'application', 'alice', undefined, Math.floor(Date.now()/1000), [undefined,'password','mfa','mfa'][i]);
  await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[tokens[4],ids.alice]);
  try {
    for (const index of [0,1,3,4]) assert.equal((await read(tokens[index])).rowCount,0);
    assert.equal((await read(tokens[2])).rowCount,1);
    assert.equal((await sessionReader({DEV_AUTH:'true'})(tokens[4])).rowCount,1);
    assert.equal((await sessionReader({DEV_AUTH:'true',NODE_ENV:'production'})(tokens[4])).rowCount,0);
    await pool.query('UPDATE users SET disabled=true WHERE id=$1',[ids.alice]);
    assert.equal((await read(tokens[2])).rowCount,0);
  } finally {
    await pool.query('UPDATE users SET disabled=false WHERE id=$1',[ids.alice]);
    await pool.query('DELETE FROM sessions WHERE token_hash=ANY($1::text[])',[tokens]);
  }
});

test('identity actions allow only configured provider recovery without arbitrary actions or redirects', async () => {
  const {identityAction} = await import('../services/core/identity-actions.ts');
  assert.deepEqual(identityAction({},undefined),{});
  assert.deepEqual(identityAction({action:'recovery-codes'},'keycloak'),{kc_action:'CONFIGURE_RECOVERY_AUTHN_CODES'});
  assert.throws(()=>identityAction({action:'recovery-codes'},undefined),/not configured/);
  assert.throws(()=>identityAction({action:'delete-account'},'keycloak'));
  assert.throws(()=>identityAction({action:['recovery-codes','delete-account']},'keycloak'));
  assert.throws(()=>identityAction({action:'recovery-codes',redirect_uri:'https://attacker.invalid'},'keycloak'));
  assert.equal((await app.inject({url:'/v1/auth/login?action=recovery-codes'})).statusCode,503);
  assert.equal((await app.inject({url:'/v1/auth/login?action=delete-account'})).statusCode,400);
});

test('provider credential encryption authenticates binding, detects tampering and supports explicit key rotation', async()=>{
 const {tokenVault}=await import('../services/core/token-vault.ts');
 const a=Buffer.alloc(32,1).toString('base64url'),b=Buffer.alloc(32,2).toString('base64url');
 const old=tokenVault({active:'a',keys:{a}}),both=tokenVault({active:'b',keys:{a,b}}),current=tokenVault({active:'b',keys:{b}});
 const encrypted=await old.seal('synthetic-refresh-secret','session-a');
 assert.ok(!encrypted.includes('synthetic-refresh-secret'));
 assert.equal(await both.open(encrypted,'session-a'),'synthetic-refresh-secret');
 await assert.rejects(both.open(encrypted,'session-b'));
 const pieces=encrypted.split('.');pieces[3]=(pieces[3][0]==='A'?'B':'A')+pieces[3].slice(1);
 await assert.rejects(both.open(pieces.join('.'),'session-a'));
 await assert.rejects(current.open(encrypted,'session-a'));
 const rotated=await both.seal(await both.open(encrypted,'session-a'),'session-a');
 assert.equal(await current.open(rotated,'session-a'),'synthetic-refresh-secret');
 assert.throws(()=>tokenVault({active:'missing',keys:{a}}));
 assert.throws(()=>tokenVault({active:'a',keys:{a:'short'}}));
});

test('provider checks coalesce, rotate encrypted credentials and fail closed on provider outages', async()=>{
 const {providerReconciler}=await import('../services/core/provider-reconciliation.ts');
 const {tokenVault,credentialBinding}=await import('../services/core/token-vault.ts');
 const {createProviderSession}=await import('../services/core/provider-sessions.ts');
 const vault=tokenVault({active:'test',keys:{test:Buffer.alloc(32,3).toString('base64url')}});
 const key=randomUUID(),issuer='https://reconciliation.example.test',client='application',sub='alice';
 const binding=credentialBinding(key,issuer,client,sub);
 await createProviderSession(key,ids.alice,issuer,client,sub,undefined,Math.floor(Date.now()/1000),'mfa',await vault.seal('original',binding));
 let calls=0;
 const check=providerReconciler(issuer,client,vault,async(token)=>{calls++;assert.equal(token,'original');return {active:true,refreshToken:'rotated'};});
 try {
  await check(key);assert.equal(calls,0);
  await pool.query("UPDATE oidc_sessions SET verified_until=now()-interval '1 second' WHERE token_hash=$1",[key]);
  await Promise.all(Array.from({length:12},()=>check(key)));assert.equal(calls,1);
  const stored=(await pool.query('SELECT credential_jwe,verified_until>now() AS fresh FROM oidc_sessions WHERE token_hash=$1',[key])).rows[0];
  assert.equal(stored.fresh,true);assert.equal(await vault.open(stored.credential_jwe,binding),'rotated');
  await pool.query("UPDATE oidc_sessions SET verified_until=now()-interval '1 second' WHERE token_hash=$1",[key]);
  const outage=providerReconciler(issuer,client,vault,async()=>{throw new Error('secret provider diagnostic');});
  await assert.rejects(outage(key),e=>(e as {statusCode:number}).statusCode===503 && !(e as Error).message.includes('secret'));
  assert.equal((await pool.query('SELECT verified_until>now() AS fresh FROM oidc_sessions WHERE token_hash=$1',[key])).rows[0].fresh,false);
  await assert.rejects(check(key),e=>(e as {statusCode:number}).statusCode===503);
  assert.equal(calls,1);
 }finally{await pool.query('DELETE FROM sessions WHERE token_hash=$1',[key]);}
});

test('provider leases survive process peers, expire, and cannot restore a session deleted during refresh', async()=>{
 const {providerReconciler}=await import('../services/core/provider-reconciliation.ts');
 const {tokenVault,credentialBinding}=await import('../services/core/token-vault.ts');
 const {createProviderSession}=await import('../services/core/provider-sessions.ts');
 const vault=tokenVault({active:'test',keys:{test:Buffer.alloc(32,4).toString('base64url')}});
 const key=randomUUID(),issuer='https://lease.example.test',client='app',sub='alice';
 await createProviderSession(key,ids.alice,issuer,client,sub,undefined,Math.floor(Date.now()/1000),'mfa',await vault.seal('original',credentialBinding(key,issuer,client,sub)));
 try{
  await pool.query("UPDATE oidc_sessions SET verified_until=now()-interval '1 second',check_lease_id=$2,check_lease_until=now()+interval '20 seconds' WHERE token_hash=$1",[key,randomUUID()]);
  let calls=0;
  const checker=providerReconciler(issuer,client,vault,async()=>{calls++;await pool.query('DELETE FROM sessions WHERE token_hash=$1',[key]);return {active:true,refreshToken:'late'};});
  await assert.rejects(checker(key),e=>(e as {statusCode:number}).statusCode===503);assert.equal(calls,0);
  await pool.query("UPDATE oidc_sessions SET check_lease_until=now()-interval '1 second' WHERE token_hash=$1",[key]);
  await assert.rejects(checker(key),e=>(e as {statusCode:number}).statusCode===503);
  assert.equal(calls,1);assert.equal((await pool.query('SELECT 1 FROM sessions WHERE token_hash=$1',[key])).rowCount,0);
 }finally{await pool.query('DELETE FROM sessions WHERE token_hash=$1',[key]);}
});

test('inactive provider sessions are removed with one audit effect while unknown legacy credentials require reauthentication', async()=>{
 const {providerReconciler}=await import('../services/core/provider-reconciliation.ts');
 const {tokenVault,credentialBinding}=await import('../services/core/token-vault.ts');
 const {createProviderSession}=await import('../services/core/provider-sessions.ts');
 const vault=tokenVault({active:'test',keys:{test:Buffer.alloc(32,5).toString('base64url')}});
 const issuer='https://inactive.example.test',client='app',sub='alice',keys=[randomUUID(),randomUUID()];
 await createProviderSession(keys[0],ids.alice,issuer,client,sub,undefined,Math.floor(Date.now()/1000),'mfa',await vault.seal('inactive',credentialBinding(keys[0],issuer,client,sub)));
 await createProviderSession(keys[1],ids.alice,issuer,client,sub,undefined,Math.floor(Date.now()/1000),'mfa');
 const check=providerReconciler(issuer,client,vault,async()=>({active:false}));
 const before=(await pool.query("SELECT count(*)::int AS n FROM audit WHERE action='identity.session_reconciled' AND org_id IS NULL")).rows[0].n;
 try{
  await pool.query("UPDATE oidc_sessions SET verified_until=now()-interval '1 second' WHERE token_hash=$1",[keys[0]]);
  await assert.rejects(check(keys[0]),e=>(e as {statusCode:number}).statusCode===401);
  await check(keys[0]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit WHERE action='identity.session_reconciled' AND org_id IS NULL")).rows[0].n,before+1);
  await assert.rejects(check(keys[1]),e=>(e as {statusCode:number}).statusCode===401);
 }finally{await pool.query('DELETE FROM sessions WHERE token_hash=ANY($1::text[])',[keys]);}
});


test("authentication failures retain bounded global evidence without trusting identity or tenant input", async () => {
  const secret = "do-not-retain-password-or-provider-data";
  const attempts = [
    await app.inject({method: "POST", url: "/v1/session", headers: {origin, "x-request-id": secret}, payload: {email: "alice@acme.test", password: secret, org_id: ids.org, actor_id: ids.alice}}),
    await app.inject({method: "GET", url: `/v1/auth/callback?code=${secret}&state=${secret}&org_id=${ids.org}`}),
    await app.inject({method: "POST", url: "/v1/auth/backchannel-logout", headers: {"content-type": "application/x-www-form-urlencoded"}, payload: `logout_token=${secret}&logout_token=duplicate`}),
  ];
  for (const response of attempts) {
    assert.ok(response.statusCode >= 400);
    const correlationId = response.json().correlationId;
    assert.match(correlationId, /^[0-9a-f-]{36}$/);
    assert.equal(response.headers["x-request-id"], correlationId);
    const rows = (await pool.query("SELECT * FROM audit WHERE action='identity.authentication_failed' AND metadata->>'correlationId'=$1", [correlationId])).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].org_id, null);
    assert.equal(rows[0].actor_id, null);
    assert.equal(rows[0].target, "authentication");
    assert.deepEqual(Object.keys(rows[0].metadata).sort(), ["correlationId", "route", "status"]);
    assert.equal(rows[0].metadata.status, response.statusCode);
    assert.ok(!JSON.stringify(rows).includes(secret));
    assert.ok(!JSON.stringify(rows).includes("alice@acme.test"));
    assert.ok(!response.body.includes(secret));
  }
});

test("successful login/logout audit is scoped to active memberships and excluded from foreign/member views", async () => {
  const before = (await pool.query("SELECT coalesce(max(id),0)::text AS id FROM audit")).rows[0].id;
  const signedIn = await app.inject({method: "POST", url: "/v1/session", headers: {origin}, payload: {email: "bob@acme.test", password: "Development123!"}});
  assert.equal(signedIn.statusCode, 200);
  const cookie = String(signedIn.headers["set-cookie"]).split(";")[0];
  const memberView = await app.inject({method:"GET",url:`/v1/organizations/${ids.org}/audit`,headers:{origin,cookie}});
  assert.equal(memberView.statusCode,403);
  const signedOut = await app.inject({method:"DELETE",url:"/v1/session",headers:{origin,cookie}});
  assert.equal(signedOut.statusCode,200);
  const active = (await pool.query("SELECT org_id FROM memberships WHERE user_id=$1 AND active ORDER BY org_id", [ids.bob])).rows.map(r=>r.org_id);
  for (const action of ["identity.signed_in", "identity.signed_out"]) {
    const rows = (await pool.query("SELECT * FROM audit WHERE id>$1 AND actor_id=$2 AND action=$3 ORDER BY org_id NULLS FIRST", [before,ids.bob,action])).rows;
    assert.deepEqual(rows.map(r=>r.org_id), [null,...active]);
    assert.ok(rows.every(r=>r.target===ids.bob));
  }
  const admin = await request("alice", "GET", `/v1/organizations/${ids.org}/audit`);
  assert.equal(admin.statusCode,200);
  assert.ok(admin.json().items.some((r:{action:string;actor_id:string})=>r.action==="identity.signed_out" && r.actor_id===ids.bob));
  assert.ok(admin.json().items.every((r:{org_id:string})=>r.org_id===ids.org));
  assert.equal((await request("eve","GET",`/v1/organizations/${ids.org}/audit`)).statusCode,404);
});

test("identity audit scope excludes inactive memberships and rolls back with the surrounding mutation", async () => {
  const {identityAudit} = await import("../services/core/identity-audit.ts");
  const {transaction} = await import("../services/core/db.ts");
  const before = (await pool.query("SELECT count(*)::int AS n FROM audit")).rows[0].n;
  await assert.rejects(transaction(async db=>{
    await db.query("UPDATE memberships SET active=false WHERE user_id=$1",[ids.bob]);
    await identityAudit(db,ids.bob,"identity.signed_out");
    const scoped = await db.query("SELECT 1 FROM audit WHERE actor_id=$1 AND action='identity.signed_out' AND org_id IS NOT NULL AND created_at>=transaction_timestamp()",[ids.bob]);
    assert.equal(scoped.rowCount,0);
    throw new Error("rollback audit and membership change");
  }), /rollback audit/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit")).rows[0].n,before);
  assert.ok((await pool.query("SELECT 1 FROM memberships WHERE user_id=$1 AND active",[ids.bob])).rowCount);
});

test("audit storage failure rolls back sign-in and returns a generic unavailable response", async () => {
  const db = await pool.connect();
  const before = (await pool.query("SELECT count(*)::int AS n FROM sessions")).rows[0].n;
  try {
    await db.query(`CREATE FUNCTION pg_temp.reject_identity_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit storage failure' USING ERRCODE='42501'; END $$`);
    await db.query(`CREATE TRIGGER test_reject_identity_audit BEFORE INSERT ON audit FOR EACH ROW WHEN (NEW.action IN ('identity.signed_in','identity.authentication_failed')) EXECUTE FUNCTION pg_temp.reject_identity_audit()`);
    const result = await app.inject({method:"POST",url:"/v1/session",headers:{origin},payload:{email:"bob@acme.test",password:"Development123!"}});
    assert.equal(result.statusCode,503);
    assert.equal(result.headers["set-cookie"],undefined);
    assert.equal(result.json().error,"Service temporarily unavailable. Retry shortly.");
    assert.ok(!result.body.includes("synthetic"));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM sessions")).rows[0].n,before);
  } finally {
    await db.query("DROP TRIGGER IF EXISTS test_reject_identity_audit ON audit");
    await db.query("DROP FUNCTION IF EXISTS pg_temp.reject_identity_audit()");
    db.release();
  }
});

test("message format persists, validates and participates in retry deduplication without reinterpreting legacy text", async () => {
  const url = `/v1/channels/${ids.channel}/messages`;
  const clientId = randomUUID(), body = "**Formatted** [link](https://example.com)";
  const responses = await Promise.all(Array.from({length: 6},()=>request("alice","POST",url,{clientId,body,format:"markdown-v1"})));
  responses.forEach(r=>assert.equal(r.statusCode,201,r.body));
  assert.equal(new Set(responses.map(r=>r.json().id)).size,1);
  const m = responses[0].json();
  assert.equal(m.format,"markdown-v1");
  assert.equal((await request("alice","POST",url,{clientId,body,format:"plain"})).statusCode,409);
  assert.equal((await request("alice","POST",url,{clientId:randomUUID(),body,format:"html"})).statusCode,400);
  const legacy = await request("alice","POST",url,{clientId:randomUUID(),body});
  assert.equal(legacy.json().format,"plain");
  assert.equal((await request("alice","PATCH",`${url}/${m.id}`,{body:"**Edited**"})).statusCode,200);
  assert.equal((await pool.query("SELECT format FROM messages WHERE id=$1",[m.id])).rows[0].format,"markdown-v1");
  assert.equal((await request("alice","PATCH",`${url}/${m.id}`,{body:"**Edited**",format:"html"})).statusCode,400);
  assert.equal((await request("alice","PATCH",`${url}/${m.id}`,{body:"**Literal**",format:"plain"})).statusCode,200);
  const history = (await request("alice","GET",url)).json().messages;
  assert.equal(history.find((r:{id:string})=>r.id===m.id).format,"plain");
  const {historySchema} = await import("../lib/contracts.ts");
  assert.equal(historySchema.safeParse((await request("alice","GET",url)).json()).success,true);
});

test("mention parsing recognizes only explicit Markdown links and bounds unique recipients", async()=>{
  const {mentionRecipients}=await import("../services/core/mentions.ts");
  const token=`[@Bob](concord-mention:${ids.bob})`;
  assert.deepEqual(mentionRecipients(`${token} ${token}`,"markdown-v1"),[ids.bob]);
  assert.deepEqual(mentionRecipients(token,"plain"),[]);
  assert.deepEqual(mentionRecipients(`\`${token}\`\n\n\`\`\`\n${token}\n\`\`\`\n\n!${token}\n\n[Bob][ref]\n\n[ref]: concord-mention:${ids.bob}`,"markdown-v1"),[]);
  assert.throws(()=>mentionRecipients("[x](concord-mention:not-a-user)","markdown-v1"),/Invalid mention/);
  assert.throws(()=>mentionRecipients(Array.from({length:21},()=>`[x](concord-mention:${randomUUID()})`).join(" "),"markdown-v1"),/at most 20/);
});

test("mentions persist once, reject inaccessible recipients, and disappear on edit, deletion and access revocation", async()=>{
  const id=randomUUID();
  await pool.query("INSERT INTO channels(id,org_id,team_id,name,kind) VALUES($1,$2,$3,'Mention security test','private')",[id,ids.org,ids.team]);
  await pool.query("INSERT INTO channel_members(org_id,channel_id,user_id) VALUES($1,$2,$3),($1,$2,$4)",[ids.org,id,ids.alice,ids.bob]);
  const login=await app.inject({method:"POST",url:"/v1/session",headers:{origin},payload:{email:"bob@acme.test",password:"Development123!"}});
  cookies.bob=String(login.headers["set-cookie"]).split(";")[0];
  const url=`/v1/channels/${id}/messages`, body=`Mention test [@forged label](concord-mention:${ids.bob})`, payload={clientId:randomUUID(),body,format:"markdown-v1"};
  const accepted=await Promise.all(Array.from({length:6},()=>request("alice","POST",url,payload)));
  accepted.forEach(r=>assert.equal(r.statusCode,201,r.body));
  const mid=accepted[0].json().id;
  assert.equal((await pool.query("SELECT 1 FROM message_mentions WHERE message_id=$1",[mid])).rowCount,1);
  const history=(await request("alice","GET",url)).json().messages;
  assert.deepEqual(history.find((m:{id:string})=>m.id===mid).mentions,[{id:ids.bob,name:"Bob Chen"}]);
  for (const user of [ids.eve,ids.guest,randomUUID()]) {
    const denied=await request("alice","POST",url,{...payload,clientId:randomUUID(),body:`[x](concord-mention:${user})`});
    assert.equal(denied.statusCode,400);
  }
  assert.equal((await pool.query("SELECT 1 FROM messages WHERE channel_id=$1",[id])).rowCount,1);
  assert.equal((await pool.query("SELECT 1 FROM outbox WHERE channel_id=$1 AND type='message.created'",[id])).rowCount,1);
  try {
    await pool.query("UPDATE users SET disabled=true WHERE id=$1",[ids.bob]);
    const members=(await request("alice","GET",`/v1/channels/${id}/members`)).json().members;
    assert.ok(!members.some((m:{id:string})=>m.id===ids.bob));
    assert.equal((await request("alice","POST",url,{...payload,clientId:randomUUID()})).statusCode,400);
  } finally { await pool.query("UPDATE users SET disabled=false WHERE id=$1",[ids.bob]); }

  const activity=`/v1/organizations/${ids.org}/activity?filter=mentions`;
  assert.ok((await request("bob","GET",activity)).json().items.some((m:{id:string})=>m.id===mid));
  assert.equal((await request("bob","POST",`/v1/channels/${id}/read`,{seq:1})).statusCode,200);
  assert.ok((await request("bob","GET",activity)).json().items.some((m:{id:string})=>m.id===mid));
  await pool.query("DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2",[id,ids.bob]);
  assert.ok(!(await request("bob","GET",activity)).json().items.some((m:{id:string})=>m.id===mid));
  assert.equal((await request("alice","POST",url,payload)).json().id,mid);
  assert.equal((await request("alice","PATCH",`${url}/${mid}`,{body:body+" changed"})).statusCode,400);
  assert.equal((await pool.query("SELECT body FROM messages WHERE id=$1",[mid])).rows[0].body,body);
  assert.equal((await request("alice","PATCH",`${url}/${mid}`,{body:"Mention removed"})).statusCode,200);
  assert.equal((await pool.query("SELECT 1 FROM message_mentions WHERE message_id=$1",[mid])).rowCount,0);
  await pool.query("INSERT INTO channel_members VALUES($1,$2,$3)",[ids.org,id,ids.bob]);
  assert.equal((await request("alice","PATCH",`${url}/${mid}`,{body})).statusCode,200);
  assert.ok((await request("bob","GET",activity)).json().items.some((m:{id:string})=>m.id===mid));
  assert.equal((await request("alice","DELETE",`${url}/${mid}`)).statusCode,200);
  assert.equal((await pool.query("SELECT 1 FROM message_mentions WHERE message_id=$1",[mid])).rowCount,0);
  assert.ok(!(await request("bob","GET",activity)).json().items.some((m:{id:string})=>m.id===mid));
  assert.equal((await request("eve","GET",activity)).statusCode,404);
});

test("durable scan jobs retry, reject, recover leases and never resurrect deleted files",async()=>{
  const {runFileJob}=await import("../services/core/file-jobs.ts");
  const {writeFile}=await import("node:fs/promises");
  const {fileRoot}=await import("../services/core/file-content.ts");
  const path=await import("node:path");
  // Isolate worker fixtures from earlier retained test uploads.
  await pool.query("UPDATE file_scan_jobs SET status='cancelled',lease_id=NULL,lease_until=NULL WHERE status IN ('queued','running')");
  const root=`/v1/channels/${ids.channel}/files`;
  const upload=async()=>{
    const r=await request("alice","POST",root,{name:"scan.txt",mime:"text/plain",content:Buffer.from("safe test text").toString("base64")});
    assert.equal(r.statusCode,200,r.body);return r.json().id as string;
  };
  const id=await upload();
  await runFileJob(async()=>{throw new Error("test dependency outage");});
  let job=(await pool.query("SELECT * FROM file_scan_jobs WHERE file_id=$1",[id])).rows[0];
  assert.equal(job.status,"queued");assert.equal(job.attempts,1);assert.equal(job.last_error,"scan_unavailable");
  assert.equal((await request("alice","GET",`${root}/${id}/download`)).statusCode,409);
  await pool.query("UPDATE file_scan_jobs SET available_at=now(),attempts=4 WHERE file_id=$1",[id]);
  await runFileJob(async()=>{throw new Error("still unavailable");});
  assert.equal((await pool.query("SELECT status FROM file_scan_jobs WHERE file_id=$1",[id])).rows[0].status,"dead");
  assert.equal((await request("guest","POST",`${root}/${id}/retry`,{})).statusCode,404);
  assert.equal((await request("alice","POST",`${root}/${id}/retry`,{})).statusCode,200);
  await Promise.all([runFileJob(async()=>({state:"ready",version:"test-only scanner"})),runFileJob(async()=>({state:"ready",version:"test-only scanner"}))]);
  const download=await request("alice","GET",`${root}/${id}/download`);
  assert.equal(download.statusCode,200);assert.equal(download.body,"safe test text");
  assert.equal(download.headers["content-type"],"application/octet-stream");assert.match(String(download.headers["content-disposition"]),/^attachment;/);
  assert.equal((await request("eve","GET",`${root}/${id}/download`)).statusCode,404);
  await writeFile(path.join(fileRoot(),id),"tampered");
  assert.equal((await request("alice","GET",`${root}/${id}/download`)).statusCode,503);
  const infected=await upload();await runFileJob(async()=>({state:"rejected",version:"test-only scanner"}));
  assert.equal((await request("alice","GET",`${root}/${infected}/download`)).statusCode,409);
  const deleted=await upload();
  await runFileJob(async()=>{assert.equal((await request("alice","DELETE",`${root}/${deleted}`)).statusCode,200);return {state:"ready",version:"test-only scanner"};});
  assert.equal((await pool.query("SELECT state FROM files WHERE id=$1",[deleted])).rows[0].state,"deleted");
  const expired=await upload();
  await pool.query("UPDATE file_scan_jobs SET status='running',lease_id=$2,lease_until=now()-interval '1 second' WHERE file_id=$1",[expired,randomUUID()]);
  await runFileJob(async()=>({state:"ready",version:"test-only scanner"}));
  job=(await pool.query("SELECT * FROM file_scan_jobs WHERE file_id=$1",[expired])).rows[0];assert.equal(job.status,"done");
  assert.equal((await request("alice","POST",root,{name:"fake.png",mime:"image/png",content:Buffer.from("not a PNG").toString("base64")})).statusCode,400);
});

test("attachments enforce scanned same-channel access, immutable retries and current history visibility",async()=>{
  const url=`/v1/channels/${ids.channel}/messages`,files=`/v1/channels/${ids.channel}/files`;
  const upload=await request("alice","POST",files,{name:"attachment.txt",mime:"text/plain",content:Buffer.from("Attachment fixture").toString("base64")});
  assert.equal(upload.statusCode,200,upload.body);const file=upload.json().id;
  const payload={clientId:randomUUID(),body:"Shared attachment",attachmentIds:[file]};
  assert.equal((await request("alice","POST",url,payload)).statusCode,400);
  await pool.query("UPDATE files SET state='rejected' WHERE id=$1",[file]);
  assert.equal((await request("alice","POST",url,payload)).statusCode,400);
  // Isolate reference authorization from provider scanning, which has a separate live browser check.
  await pool.query("UPDATE files SET state='ready' WHERE id=$1",[file]);
  assert.equal((await request("alice","POST",`/v1/channels/${ids.private}/messages`,payload)).statusCode,400);
  assert.equal((await request("eve","POST",url,payload)).statusCode,404);
  assert.equal((await request("alice","POST",url,{...payload,attachmentIds:[randomUUID()]})).statusCode,400);
  assert.equal((await request("alice","POST",url,{...payload,attachmentIds:[file,file]})).statusCode,400);
  assert.equal((await request("alice","POST",url,{...payload,attachmentIds:Array.from({length:11},()=>randomUUID())})).statusCode,400);
  const accepted=await Promise.all(Array.from({length:6},()=>request("alice","POST",url,payload)));
  accepted.forEach(r=>assert.equal(r.statusCode,201,r.body));const mid=accepted[0].json().id;
  assert.equal(new Set(accepted.map(r=>r.json().id)).size,1);
  assert.equal((await pool.query("SELECT 1 FROM message_attachments WHERE message_id=$1",[mid])).rowCount,1);
  assert.equal((await pool.query("SELECT 1 FROM outbox WHERE payload->>'id'=$1 AND type='message.created'",[mid])).rowCount,1);
  assert.equal((await request("alice","POST",url,{...payload,attachmentIds:[]})).statusCode,409);
  const history=async()=> (await request("guest","GET",url)).json().messages.find((m:{id:string})=>m.id===mid);
  assert.deepEqual((await history()).attachments,[{id:file,name:"attachment.txt",state:"ready"}]);
  const shared=await request("guest","POST",url,{...payload,clientId:randomUUID()});assert.equal(shared.statusCode,201,shared.body);
  assert.equal((await request("alice","DELETE",`${files}/${file}`)).statusCode,200);
  assert.equal((await request("alice","POST",url,payload)).json().id,mid);
  assert.equal((await request("guest","POST",url,{...payload,clientId:randomUUID()})).statusCode,400);
  assert.deepEqual((await history()).attachments,[{id:file,name:null,state:"unavailable"}]);
  assert.equal((await request("alice","PATCH",`${url}/${mid}`,{body:"Updated caption"})).statusCode,200);
  assert.deepEqual((await history()).attachments,[{id:file,name:null,state:"unavailable"}]);
  assert.equal((await request("alice","DELETE",`${url}/${mid}`)).statusCode,200);
  assert.deepEqual((await history()).attachments,[]);
});

test("upload client IDs deduplicate concurrent acceptance, conflict on payload changes and retain deletion identity",async()=>{
  const url=`/v1/channels/${ids.channel}/files`,payload={clientId:randomUUID(),name:"upload-id.txt",mime:"text/plain",content:Buffer.from("Retry upload").toString("base64")};
  const count=Number((await pool.query("SELECT count(*) FROM outbox WHERE channel_id=$1 AND type='file.uploaded'",[ids.channel])).rows[0].count);
  const accepted=await Promise.all(Array.from({length:8},()=>request("alice","POST",url,payload)));
  accepted.forEach(r=>assert.equal(r.statusCode,200,r.body));const file=accepted[0].json().id;
  assert.equal(new Set(accepted.map(r=>r.json().id)).size,1);
  assert.equal((await pool.query("SELECT 1 FROM file_scan_jobs WHERE file_id=$1",[file])).rowCount,1);
  assert.equal(Number((await pool.query("SELECT count(*) FROM outbox WHERE channel_id=$1 AND type='file.uploaded'",[ids.channel])).rows[0].count),count+1);
  for(const changed of [{name:"changed.txt"},{content:Buffer.from("Different").toString("base64")}])assert.equal((await request("alice","POST",url,{...payload,...changed})).statusCode,409);
  assert.equal((await request("eve","POST",url,payload)).statusCode,404);
  const guest=await request("guest","POST",url,payload);assert.equal(guest.statusCode,200);assert.notEqual(guest.json().id,file);
  assert.equal((await request("alice","DELETE",`${url}/${file}`)).statusCode,200);
  assert.deepEqual((await request("alice","POST",url,payload)).json(),{id:file,state:"deleted"});
});

test("orphan reconciliation preserves referenced, young, unknown and symlink bytes and excludes active uploads",async()=>{
  const {reconcileFiles}=await import("../services/core/file-reconciliation.ts");
  const {fileRoot}=await import("../services/core/file-content.ts");
  const {writeFile,utimes,symlink,lstat,unlink}=await import("node:fs/promises");
  const path=await import("node:path");
  const root=fileRoot(),orphan=randomUUID(),young=randomUUID(),link=randomUUID(),unknown=`unknown-${randomUUID()}`;
  const old=new Date(Date.now()-7200000);
  for(const name of [orphan,young,unknown])await writeFile(path.join(root,name),"orphan fixture");
  for(const name of [orphan,unknown])await utimes(path.join(root,name),old,old);
  await symlink(path.join(root,unknown),path.join(root,link));
  const referenced=(await pool.query("SELECT storage_key FROM files ORDER BY created_at DESC LIMIT 1")).rows[0].storage_key;
  await utimes(path.join(root,referenced),old,old);
  const lock=await pool.connect();
  try{
    await lock.query("BEGIN");await lock.query("SELECT pg_advisory_xact_lock_shared(712341)");
    const skipped=await reconcileFiles();assert.ok(skipped.skippedBatches>0);assert.ok(await lstat(path.join(root,orphan)));
    await lock.query("ROLLBACK");
    const completed=await reconcileFiles();assert.ok(completed.removed>=1);
    await assert.rejects(lstat(path.join(root,orphan)),{code:"ENOENT"});
    for(const name of [young,unknown,link,referenced])assert.ok(await lstat(path.join(root,name)));
  }finally{
    await lock.query("ROLLBACK");lock.release();
    for(const name of [orphan,young,unknown,link])await unlink(path.join(root,name)).catch(()=>{});
  }
});

test("failed upload metadata leaves recoverable bytes instead of eagerly unlinking them",async()=>{
  const {readdir,utimes,lstat}=await import("node:fs/promises");
  const {fileRoot}=await import("../services/core/file-content.ts");
  const {reconcileFiles}=await import("../services/core/file-reconciliation.ts");
  const path=await import("node:path");
  const before=new Set(await readdir(fileRoot()));
  await pool.query("CREATE FUNCTION reject_test_upload() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name='rollback-fixture.txt' THEN RAISE EXCEPTION 'test rollback'; END IF; RETURN NEW; END $$");
  await pool.query("CREATE TRIGGER reject_test_upload BEFORE INSERT ON files FOR EACH ROW EXECUTE FUNCTION reject_test_upload()");
  try {
    const r=await request("alice","POST",`/v1/channels/${ids.channel}/files`,{clientId:randomUUID(),name:"rollback-fixture.txt",mime:"text/plain",content:Buffer.from("rollback bytes").toString("base64")});
    assert.equal(r.statusCode,500);
    const added=(await readdir(fileRoot())).filter(name=>!before.has(name));assert.equal(added.length,1);
    assert.equal((await pool.query("SELECT 1 FROM files WHERE storage_key=$1",[added[0]])).rowCount,0);
    await reconcileFiles();assert.ok(await lstat(path.join(fileRoot(),added[0])));
    const old=new Date(Date.now()-7200000);await utimes(path.join(fileRoot(),added[0]),old,old);
    await reconcileFiles();await assert.rejects(lstat(path.join(fileRoot(),added[0])),{code:"ENOENT"});
  }finally{
    await pool.query("DROP TRIGGER reject_test_upload ON files");await pool.query("DROP FUNCTION reject_test_upload()");
  }
});

test("object keys bind tenant, file and checksum; incomplete and insecure configuration fail closed",async()=>{
  const {objectKey,objectStorageConfigured,readObject}=await import("../services/core/object-storage.ts");
  const file={id:randomUUID(),org_id:ids.org,sha256:"a".repeat(64),bytes:4};
  assert.equal(objectKey(file),`${ids.org}/${file.id}/${file.sha256}`);
  assert.throws(()=>objectKey({...file,org_id:"../other"}));
  assert.throws(()=>objectKey({...file,sha256:"bad"}));
  const keys=["S3_ENDPOINT","S3_BUCKET","S3_ACCESS_KEY_ID","S3_SECRET_ACCESS_KEY","S3_ALLOW_INSECURE_LOCAL","NODE_ENV"];
  const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  try{
    for(const k of keys)delete process.env[k];assert.equal(objectStorageConfigured(),false);
    process.env.S3_BUCKET="concord-files";assert.throws(()=>objectStorageConfigured(),/incomplete/);
    process.env.S3_ENDPOINT="http://invalid.test";process.env.S3_ACCESS_KEY_ID="local-reader";process.env.S3_SECRET_ACCESS_KEY="local-secret";
    assert.throws(()=>objectStorageConfigured(),/HTTPS/);
    process.env.S3_ALLOW_INSECURE_LOCAL="true";assert.equal(objectStorageConfigured(),true);
    await assert.rejects(readObject({...file,object_key:"wrong",object_bucket:"concord-files"}),/pointer/);
    process.env["NODE_"+"ENV"]="production";assert.throws(()=>objectStorageConfigured(),/HTTPS/);
    process.env.S3_ENDPOINT="https://invalid.test";assert.throws(()=>objectStorageConfigured(),/Development/);
  }finally{for(const k of keys){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}}
});

test("source previews enforce scan/ACL/integrity and bound literal Unicode text",async()=>{
  const {writeFile}=await import("node:fs/promises");
  const {fileRoot}=await import("../services/core/file-content.ts");
  const root=`/v1/channels/${ids.channel}/files`;
  const upload=async(name:string,mime:string,source:string)=>{
    const r=await request("alice","POST",root,{name,mime,content:Buffer.from(source).toString("base64")});
    assert.equal(r.statusCode,200,r.body);return r.json().id as string;
  };
  const source='<script>alert("preview")</script>\n[link](https://example.invalid)\n=SUM(A1)';
  const file=await upload("preview.md","text/markdown",source),url=`${root}/${file}/preview`;
  assert.equal((await request("alice","GET",url)).statusCode,409);
  await pool.query("UPDATE files SET state='rejected' WHERE id=$1",[file]);
  assert.equal((await request("alice","GET",url)).statusCode,409);
  // Scan state is a fixture here. The browser suite verifies actual ClamAV/S3 publication.
  await pool.query("UPDATE files SET state='ready' WHERE id=$1",[file]);
  const r=await request("bob","GET",url);
  assert.equal(r.statusCode,200,r.body);
  assert.deepEqual(r.json(),{text:source,truncated:false,bytes:Buffer.byteLength(source),limit:32768});
  assert.match(String(r.headers["cache-control"]),/no-store/);
  assert.equal(r.headers["x-content-type-options"],"nosniff");
  assert.equal((await request("eve","GET",url)).statusCode,404);
  assert.equal((await request("alice","GET",`/v1/channels/${ids.private}/files/${file}/preview`)).statusCode,404);
  await pool.query("UPDATE memberships SET active=false WHERE user_id=$1 AND org_id=$2",[ids.bob,ids.org]);
  try {assert.equal((await request("bob","GET",url)).statusCode,404);} finally {await pool.query("UPDATE memberships SET active=true WHERE user_id=$1 AND org_id=$2",[ids.bob,ids.org]);}
  await writeFile(`${fileRoot()}/${file}`,"x".repeat(Buffer.byteLength(source)));
  assert.equal((await request("alice","GET",url)).statusCode,503);
  const long=await upload("long.txt","text/plain","x".repeat(32767)+"😀end");
  const empty=await upload("empty.csv","text/csv","");
  const pdf=await upload("unsupported.pdf","application/pdf","%PDF-1.7\nfixture");
  await pool.query("UPDATE files SET state='ready' WHERE id=ANY($1::uuid[])",[[long,empty,pdf]]);
  const bounded=(await request("alice","GET",`${root}/${long}/preview`)).json();
  assert.equal(bounded.text,"x".repeat(32767));assert.equal(bounded.truncated,true);
  assert.equal((await request("alice","GET",`${root}/${empty}/preview`)).json().text,"");
  assert.equal((await request("alice","GET",`${root}/${pdf}/preview`)).statusCode,415);
  assert.equal((await request("alice","DELETE",`${root}/${long}`)).statusCode,200);
  assert.equal((await request("alice","GET",`${root}/${long}/preview`)).statusCode,404);
});

test("file revisions serialize numbering, preserve retry identity and withdraw the whole lineage",async()=>{
  const root=`/v1/channels/${ids.channel}/files`;
  const body={name:'versioned.txt',mime:'text/plain',content:Buffer.from('original bytes').toString('base64')};
  const initial=await request('alice','POST',root,body);assert.equal(initial.statusCode,200,initial.body);const original=initial.json().id;
  const revision={...body,versionOf:original,content:Buffer.from('new bytes').toString('base64'),clientId:randomUUID()};
  assert.equal((await request('alice','POST',root,revision)).statusCode,404);
  await pool.query("UPDATE files SET state='ready' WHERE id=$1",[original]);
  assert.equal((await request('bob','POST',root,revision)).statusCode,404);
  assert.equal((await request('eve','POST',root,revision)).statusCode,404);
  assert.equal((await request('alice','POST',`/v1/channels/${ids.private}/files`,revision)).statusCode,404);
  assert.equal((await request('alice','POST',root,{...revision,name:'renamed.txt'})).statusCode,400);
  const accepted=await Promise.all(Array.from({length:5},()=>request('alice','POST',root,revision)));
  accepted.forEach(r=>assert.equal(r.statusCode,200,r.body));const second=accepted[0].json().id;assert.equal(new Set(accepted.map(r=>r.json().id)).size,1);
  assert.equal((await request('alice','POST',root,{...revision,versionOf:undefined})).statusCode,409);
  assert.equal((await request('alice','POST',root,{...revision,content:body.content})).statusCode,409);
  assert.equal((await request('alice','GET',`${root}/${second}/download`)).statusCode,409);
  const next=await Promise.all(Array.from({length:4},()=>request('alice','POST',root,{...revision,clientId:randomUUID()})));
  next.forEach(r=>assert.equal(r.statusCode,200,r.body));
  const history=(await request('bob','GET',`${root}/${original}/versions`)).json();assert.equal(history.canUpload,false);
  assert.deepEqual(history.versions.map((v:{revision_number:number})=>v.revision_number),[6,5,4,3,2,1]);
  assert.equal((await request('eve','GET',`${root}/${original}/versions`)).statusCode,404);
  assert.equal((await request('alice','GET',`${root}/${second}/versions`)).statusCode,404);
  assert.equal((await request('alice','POST',root,{...revision,versionOf:second,clientId:randomUUID()})).statusCode,404);
  assert.equal((await request('alice','GET',`${root}/${original}/download`)).body,'original bytes');
  await pool.query("UPDATE files SET state='ready' WHERE id=$1",[second]);
  assert.equal((await request('bob','GET',`${root}/${second}/download`)).body,'new bytes');
  const sent=await request('alice','POST',`/v1/channels/${ids.channel}/messages`,{clientId:randomUUID(),body:'Version attachment',attachmentIds:[second]});assert.equal(sent.statusCode,201,sent.body);
  // Deleted ordinals are not reused and the original stays available.
  assert.equal((await request('alice','DELETE',`${root}/${next[0].json().id}`)).statusCode,200);
  assert.equal((await request('alice','GET',`${root}/${original}/download`)).statusCode,200);
  assert.equal((await request('alice','POST',root,{...revision,clientId:randomUUID()})).statusCode,200);
  assert.equal((await request('alice','GET',`${root}/${original}/versions`)).json().versions[0].revision_number,7);
  await pool.query("UPDATE files SET revision_number=100 WHERE revision_root=$1 AND revision_number=7",[original]);
  assert.equal((await request('alice','POST',root,{...revision,clientId:randomUUID()})).statusCode,409);
  assert.equal((await request('alice','DELETE',`${root}/${original}`)).statusCode,200);
  assert.equal((await request('bob','GET',`${root}/${second}/download`)).statusCode,404);
  assert.equal((await request('alice','GET',`${root}/${original}/versions`)).statusCode,404);
  assert.equal((await request('alice','POST',root,revision)).json().state,'deleted');
  assert.equal((await request('alice','POST',root,{...revision,clientId:randomUUID()})).statusCode,404);
  const rows=await pool.query("SELECT f.state,j.status FROM files f JOIN file_scan_jobs j ON j.file_id=f.id WHERE f.id=$1 OR f.revision_root=$1",[original]);
  assert.equal(rows.rowCount,7);rows.rows.forEach(r=>{assert.equal(r.state,'deleted');assert.equal(r.status,'cancelled');});
  const messages=(await request('bob','GET',`/v1/channels/${ids.channel}/messages`)).json().messages;
  assert.equal(messages.find((m:{id:string})=>m.id===sent.json().id).attachments[0].state,'unavailable');
});

test('quiet hours evaluate overnight, equal endpoints and timezone DST boundaries',async()=>{
  const {isQuietHours}=await import('../services/core/notifications.ts');
  assert.equal(isQuietHours('UTC','22:00','08:00',new Date('2026-01-01T23:00:00Z')),true);
  assert.equal(isQuietHours('UTC','22:00','08:00',new Date('2026-01-01T08:00:00Z')),false);
  assert.equal(isQuietHours('Asia/Kolkata','09:00','10:00',new Date('2026-01-01T03:30:00Z')),true);
  assert.equal(isQuietHours('UTC','00:00','00:00'),true);
  assert.equal(isQuietHours('America/New_York','01:00','03:00',new Date('2026-03-08T06:59:00Z')),true);
  assert.equal(isQuietHours('America/New_York','01:00','03:00',new Date('2026-03-08T07:00:00Z')),false);
});
test('notification claims enforce quiet hours, current access, unread/mute and persistent cross-tab dedup',async()=>{
  const claim=`/v1/organizations/${ids.org}/notification-claims`,messages=`/v1/channels/${ids.channel}/messages`;
  const setting={browser_enabled:true,quiet_enabled:true,quiet_start:'00:00',quiet_end:'00:00'};
  const mention=async()=>{const r=await request('alice','POST',messages,{clientId:randomUUID(),format:'markdown-v1',body:`New [Bob](concord-mention:${ids.bob}) ${randomUUID()}`});assert.equal(r.statusCode,201,r.body);return r.json().id;};
  await request('bob','PUT','/v1/notification-settings',{...setting,browser_enabled:false});
  const old=await mention();
  assert.equal((await request('bob','POST',claim,{})).json().suppressed,'disabled');
  assert.equal((await request('bob','PUT','/v1/notification-settings',{...setting,quiet_start:'25:00'})).statusCode,400);
  assert.equal((await request('bob','PUT','/v1/notification-settings',setting)).statusCode,200);
  const id=await mention();
  assert.equal((await request('bob','POST',claim,{})).json().suppressed,'quiet-hours');
  assert.equal((await pool.query('SELECT 1 FROM notification_claims WHERE message_id=$1',[id])).rowCount,0);
  await request('bob','PUT','/v1/notification-settings',{...setting,quiet_enabled:false});
  await pool.query('INSERT INTO channel_preferences(channel_id,user_id,muted) VALUES($1,$2,true) ON CONFLICT(channel_id,user_id) DO UPDATE SET muted=true',[ids.channel,ids.bob]);
  assert.equal((await request('bob','POST',claim,{})).json().items.length,0);
  await pool.query('UPDATE channel_preferences SET muted=false,hidden=false WHERE channel_id=$1 AND user_id=$2',[ids.channel,ids.bob]);
  const claims=await Promise.all(Array.from({length:6},()=>request('bob','POST',claim,{})));
  const items=claims.flatMap(r=>{assert.equal(r.statusCode,200,r.body);return r.json().items;});
  assert.deepEqual(items.map(i=>i.id),[id]);assert.ok(!JSON.stringify(items).includes('body'));
  assert.equal((await pool.query('SELECT 1 FROM notification_claims WHERE message_id=$1',[old])).rowCount,0);
  const deleted=await mention();await request('alice','DELETE',`${messages}/${deleted}`);
  assert.equal((await request('bob','POST',claim,{})).json().items.length,0);
  const read=await mention();await pool.query('INSERT INTO read_positions(channel_id,user_id,seq) SELECT channel_id,$2,seq FROM messages WHERE id=$1 ON CONFLICT(channel_id,user_id) DO UPDATE SET seq=excluded.seq',[read,ids.bob]);
  assert.equal((await request('bob','POST',claim,{})).json().items.length,0);
  const hidden=await mention();
  await pool.query('UPDATE channel_preferences SET hidden=true WHERE channel_id=$1 AND user_id=$2',[ids.channel,ids.bob]);
  assert.equal((await request('bob','POST',claim,{})).json().items.length,0);
  await request('alice','DELETE',`${messages}/${hidden}`);
  await pool.query('UPDATE channel_preferences SET hidden=false WHERE channel_id=$1 AND user_id=$2',[ids.channel,ids.bob]);
  await pool.query('UPDATE memberships SET active=false WHERE user_id=$1 AND org_id=$2',[ids.bob,ids.org]);
  try{assert.equal((await request('bob','POST',claim,{})).statusCode,404);}finally{await pool.query('UPDATE memberships SET active=true WHERE user_id=$1 AND org_id=$2',[ids.bob,ids.org]);}
  assert.equal((await request('eve','POST',claim,{})).statusCode,404);
  await request('bob','PUT','/v1/notification-settings',{...setting,browser_enabled:false});
});

test('digest scheduling and delivery enforce private access, quiet hours, retry bounds and ambiguous-send isolation',async()=>{
  const {scheduleDigest,runDigestJob}=await import('../services/core/digest-jobs.ts');
  const {emailConfiguration,emailFailure}=await import('../services/core/email.ts');
  assert.throws(()=>emailConfiguration({}),/unconfigured/);
  assert.throws(()=>emailConfiguration({SMTP_HOST:'mailpit',SMTP_LOCAL_CAPTURE:'true',NODE_ENV:'production'}),/development/);
  assert.throws(()=>emailConfiguration({SMTP_HOST:'external.example'}),/requires/);
  assert.equal(emailFailure({code:'ESOCKET',originalCode:'ECONNREFUSED',syscall:'connect',command:'CONN'}),'retry');assert.equal(emailFailure({code:'ECONNECTION',command:'CONN'}),'uncertain');assert.equal(emailFailure({responseCode:451}),'retry');assert.equal(emailFailure({responseCode:550}),'dead');assert.equal(emailFailure({code:'ETIMEDOUT'}),'uncertain');
  await pool.query('UPDATE notification_settings SET digest_enabled=false');
  await pool.query('DELETE FROM digest_items WHERE user_id=$1',[ids.bob]);
  await pool.query('DELETE FROM digest_jobs WHERE user_id=$1',[ids.bob]);
  await pool.query('INSERT INTO channel_members(org_id,channel_id,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[ids.org,ids.private,ids.bob]);
  const setting={browser_enabled:false,quiet_enabled:true,quiet_start:'00:00',quiet_end:'00:00',digest_enabled:true};
  assert.equal((await request('bob','PUT','/v1/notification-settings',setting)).statusCode,200);
  const fresh=async()=>{const r=await request('alice','POST',`/v1/channels/${ids.private}/messages`,{clientId:randomUUID(),body:'Private digest fixture '+randomUUID()});assert.equal(r.statusCode,201,r.body);return r.json().id;};
  const message=await fresh();
  await Promise.all([scheduleDigest(),scheduleDigest(),scheduleDigest()]);
  const jobs=(await pool.query('SELECT * FROM digest_jobs WHERE user_id=$1',[ids.bob])).rows;assert.equal(jobs.length,1);const id=jobs[0].id;
  assert.equal((await pool.query('SELECT 1 FROM digest_items WHERE job_id=$1 AND message_id=$2',[id,message])).rowCount,1);
  let sends=0;
  await runDigestJob(async()=>{sends++;});assert.equal(sends,0);
  assert.equal((await pool.query('SELECT attempts FROM digest_jobs WHERE id=$1',[id])).rows[0].attempts,0);
  await request('bob','PUT','/v1/notification-settings',{...setting,quiet_enabled:false});
  await pool.query('UPDATE digest_jobs SET available_at=now() WHERE id=$1',[id]);
  await Promise.all([runDigestJob(async mail=>{sends++;assert.equal(mail.privateCount,1);assert.equal(mail.count,1);assert.equal(mail.to,'bob@acme.test');assert.ok(!('body' in mail));}),runDigestJob(async()=>{sends++;})]);assert.equal(sends,1);
  assert.equal((await pool.query('SELECT state FROM digest_jobs WHERE id=$1',[id])).rows[0].state,'sent');
  assert.equal((await request('eve','GET','/v1/digest-jobs')).json().jobs.length,0);
  let bucket=1;
  const queued=async()=>{const message=await fresh(),job=randomUUID();await pool.query("INSERT INTO digest_jobs(id,user_id,org_id,bucket) VALUES($1,$2,$3,date_trunc('hour',now())-($4*interval '1 hour'))",[job,ids.bob,ids.org,bucket++]);await pool.query('INSERT INTO digest_items(user_id,message_id,job_id) VALUES($1,$2,$3)',[ids.bob,message,job]);return job;};
  const revoked=await queued();await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[ids.private,ids.bob]);await runDigestJob(async()=>{throw new Error('Revoked recipient must never reach transport');});assert.equal((await pool.query('SELECT state FROM digest_jobs WHERE id=$1',[revoked])).rows[0].state,'cancelled');
  await pool.query('INSERT INTO channel_members(org_id,channel_id,user_id) VALUES($1,$2,$3)',[ids.org,ids.private,ids.bob]);
  const retry=await queued();await runDigestJob(async()=>{throw {code:'ESOCKET',originalCode:'ECONNREFUSED',syscall:'connect',command:'CONN'};});assert.equal((await pool.query('SELECT state FROM digest_jobs WHERE id=$1',[retry])).rows[0].state,'queued');
  await pool.query('UPDATE digest_jobs SET attempts=4,available_at=now() WHERE id=$1',[retry]);await runDigestJob(async()=>{throw {code:'ESOCKET',originalCode:'ECONNREFUSED',syscall:'connect',command:'CONN'};});assert.equal((await pool.query('SELECT state FROM digest_jobs WHERE id=$1',[retry])).rows[0].state,'dead');
  const uncertain=await queued();await runDigestJob(async()=>{throw {code:'ETIMEDOUT'};});assert.equal((await pool.query('SELECT state FROM digest_jobs WHERE id=$1',[uncertain])).rows[0].state,'uncertain');
  const crashed=await queued();await pool.query("UPDATE digest_jobs SET state='sending',lease_id=$2,lease_until=now()-interval '1 second' WHERE id=$1",[crashed,randomUUID()]);await runDigestJob(async()=>{throw new Error('Uncertain sends must not retry');});assert.equal((await pool.query('SELECT state FROM digest_jobs WHERE id=$1',[crashed])).rows[0].state,'uncertain');
  await request('bob','PUT','/v1/notification-settings',{...setting,digest_enabled:false});
});

test('reply activity enforces recipient, current channel access and parent/reply deletion',async()=>{
  const path=`/v1/channels/${ids.channel}/messages`,feed=`/v1/organizations/${ids.org}/activity?filter=replies`;
  const post=async(user:string,body:string,parentId?:string)=>{const r=await request(user,'POST',path,{clientId:randomUUID(),body,parentId});assert.equal(r.statusCode,201,r.body);return r.json().id;};
  const parent=await post('bob','reply activity parent'),reply=await post('alice','reply activity child',parent),self=await post('bob','self reply',parent);
  const items=(await request('bob','GET',feed)).json().items;
  assert.equal(items.filter((r:{id:string})=>r.id===reply).length,1);assert.equal(items.find((r:{id:string})=>r.id===reply).replied,true);
  assert.ok(!items.some((r:{id:string})=>r.id===self));
  assert.ok(!(await request('alice','GET',feed)).json().items.some((r:{id:string})=>r.id===reply));
  assert.equal((await request('eve','GET',feed)).statusCode,404);
  await request('bob','DELETE',`${path}/${parent}`);
  assert.ok(!(await request('bob','GET',feed)).json().items.some((r:{id:string})=>r.id===reply));
  const p2=await post('bob','second parent'),r2=await post('alice','second reply',p2);
  await request('alice','DELETE',`${path}/${r2}`);
  assert.ok(!(await request('bob','GET',feed)).json().items.some((r:{id:string})=>r.id===r2));
  const privateChannel=randomUUID();
  await pool.query("INSERT INTO channels(id,org_id,team_id,name,kind) SELECT $1,org_id,team_id,'Reply ACL fixture','private' FROM channels WHERE id=$2",[privateChannel,ids.channel]);
  await pool.query('INSERT INTO channel_members(org_id,channel_id,user_id) VALUES($4,$1,$2),($4,$1,$3)',[privateChannel,ids.alice,ids.bob,ids.org]);
  const privatePath=`/v1/channels/${privateChannel}/messages`;
  const p=(await request('bob','POST',privatePath,{clientId:randomUUID(),body:'private parent'})).json();
  const r=await request('alice','POST',privatePath,{clientId:randomUUID(),body:'private reply',parentId:p.id});assert.equal(r.statusCode,201,r.body);
  assert.ok((await request('bob','GET',feed)).json().items.some((i:{id:string})=>i.id===r.json().id));
  await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[privateChannel,ids.bob]);
  assert.ok(!(await request('bob','GET',feed)).json().items.some((i:{id:string})=>i.id===r.json().id));
});

test('reply alert opt-in is independent, cutoff-bound and deduplicates overlapping categories',async()=>{
  const path=`/v1/channels/${ids.channel}/messages`,claim=`/v1/organizations/${ids.org}/notification-claims`;
  const previous=(await request('bob','GET','/v1/notification-settings')).json();
  const setting={browser_enabled:false,browser_replies_enabled:false,quiet_enabled:false,quiet_start:'22:00',quiet_end:'08:00'};
  const post=async(user:string,body:string,parentId?:string)=>{const r=await request(user,'POST',path,{clientId:randomUUID(),body,parentId,format:'markdown-v1'});assert.equal(r.statusCode,201,r.body);return r.json().id;};
  try{
    await request('bob','PUT','/v1/notification-settings',setting);
    const parent=await post('bob','reply alert parent'),old=await post('alice','before opt-in',parent);
    await request('bob','PUT','/v1/notification-settings',{...setting,browser_replies_enabled:true});
    // Older clients do not erase new preferences when the additive field is omitted.
    const {browser_replies_enabled: omitted,...legacy}=setting;assert.equal(omitted,false);
    await request('bob','PUT','/v1/notification-settings',legacy);
    assert.equal((await request('bob','GET','/v1/notification-settings')).json().browser_replies_enabled,true);
    const reply=await post('alice','new reply',parent),mention=await post('alice',`[Bob](concord-mention:${ids.bob}) mention only`);
    const results=await Promise.all([request('bob','POST',claim,{}),request('bob','POST',claim,{})]);
    const items=results.flatMap(r=>r.json().items);
    assert.deepEqual(items.filter(i=>i.id===reply).map(i=>i.kind),['reply']);assert.ok(!items.some(i=>[old,mention].includes(i.id)));
    await request('bob','PUT','/v1/notification-settings',{...setting,browser_enabled:true,browser_replies_enabled:true,quiet_enabled:true,quiet_start:'00:00',quiet_end:'00:00'});
    const both=await post('alice',`[Bob](concord-mention:${ids.bob}) both categories`,parent);
    assert.equal((await request('bob','POST',claim,{})).json().suppressed,'quiet-hours');
    await request('bob','PUT','/v1/notification-settings',{...setting,browser_enabled:true,browser_replies_enabled:true});
    const overlap=(await request('bob','POST',claim,{})).json().items.filter((i:{id:string})=>i.id===both);assert.equal(overlap.length,1);assert.equal(overlap[0].kind,'mention');
    const withdrawn=await post('alice','parent deleted before claim',parent);
    await request('bob','DELETE',`${path}/${parent}`);
    assert.ok(!(await request('bob','POST',claim,{})).json().items.some((i:{id:string})=>i.id===withdrawn));
    await request('bob','PUT','/v1/notification-settings',setting);
    assert.equal((await request('bob','POST',claim,{})).json().suppressed,'disabled');
  }finally{await request('bob','PUT','/v1/notification-settings',previous);}
});

test('invitation inbox isolates recipients and serializes concurrent identity acceptance',async()=>{
  const org=randomUUID();await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Inbox test')",[org]);await pool.query("INSERT INTO memberships VALUES($1,$2,'owner',true)",[org,ids.alice]);
  const invite=async()=>{const r=await request('alice','POST',`/v1/organizations/${org}/invitations`,{email:'bob@acme.test',role:'guest'});assert.equal(r.statusCode,200,r.body);return r.json();};
  const first=await invite(),second=await invite(),expired=await invite(),revoked=await invite();
  await pool.query("UPDATE invitations SET expires_at=now()-interval '1 minute' WHERE id=$1",[expired.id]);await request('alice','DELETE',`/v1/organizations/${org}/invitations/${revoked.id}`);
  const inbox=(await request('bob','GET','/v1/invitations')).json().invitations.filter((i:{org_id:string})=>i.org_id===org);
  assert.equal(inbox.length,2);assert.ok(inbox.every((i:Record<string,unknown>)=>!('token' in i)&&!('token_hash' in i)&&!('email' in i)));
  assert.ok(!(await request('eve','GET','/v1/invitations')).json().invitations.some((i:{org_id:string})=>i.org_id===org));
  assert.equal((await request('eve','POST','/v1/invitations/accept',{invitationId:first.id})).statusCode,404);
  assert.equal((await request('bob','POST','/v1/invitations/accept',{invitationId:expired.id})).statusCode,404);
  assert.equal((await request('bob','POST','/v1/invitations/accept',{invitationId:revoked.id})).statusCode,404);
  assert.equal((await request('bob','POST','/v1/invitations/accept',{invitationId:first.id,token:first.token})).statusCode,400);
  const results=await Promise.all([request('bob','POST','/v1/invitations/accept',{invitationId:first.id}),request('bob','POST','/v1/invitations/accept',{token:second.token})]);assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,409]);
  assert.equal((await pool.query('SELECT 1 FROM memberships WHERE org_id=$1 AND user_id=$2',[org,ids.bob])).rowCount,1);
  assert.ok(!(await request('bob','GET','/v1/invitations')).json().invitations.some((i:{org_id:string})=>i.org_id===org));
  await pool.query('UPDATE memberships SET active=false WHERE org_id=$1 AND user_id=$2',[org,ids.bob]);
  const later=await invite();assert.equal((await request('bob','POST','/v1/invitations/accept',{invitationId:later.id})).statusCode,409);
  assert.ok(!(await request('bob','GET','/v1/invitations')).json().invitations.some((i:{org_id:string})=>i.org_id===org));
});

test('recipient decline is scoped, audited and cannot grant or revoke membership',async()=>{
  const org=randomUUID();await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Decline test')",[org]);await pool.query("INSERT INTO memberships VALUES($1,$2,'owner',true)",[org,ids.alice]);
  const invite=(await request('alice','POST',`/v1/organizations/${org}/invitations`,{email:'bob@acme.test',role:'guest'})).json();
  assert.equal((await request('eve','DELETE',`/v1/invitations/${invite.id}`)).statusCode,404);
  assert.equal((await request('bob','DELETE',`/v1/invitations/${invite.id}`)).statusCode,200);
  assert.equal((await request('bob','DELETE',`/v1/invitations/${invite.id}`)).statusCode,404);
  assert.equal((await request('bob','POST','/v1/invitations/accept',{token:invite.token})).statusCode,404);
  assert.equal((await pool.query('SELECT 1 FROM memberships WHERE org_id=$1 AND user_id=$2',[org,ids.bob])).rowCount,0);
  assert.equal((await pool.query("SELECT 1 FROM audit WHERE org_id=$1 AND actor_id=$2 AND action='invitation.declined'",[org,ids.bob])).rowCount,1);
  const next=(await request('alice','POST',`/v1/organizations/${org}/invitations`,{email:'bob@acme.test',role:'guest'})).json();
  assert.equal((await request('bob','POST','/v1/invitations/accept',{invitationId:next.id})).statusCode,200);
  assert.equal((await request('bob','DELETE',`/v1/invitations/${next.id}`)).statusCode,404);
  assert.equal((await pool.query('SELECT 1 FROM memberships WHERE org_id=$1 AND user_id=$2 AND active',[org,ids.bob])).rowCount,1);
});


test('accept and decline races serialize without audit foreign-key deadlocks',async()=>{
  for(let n=0;n<4;n++){
    const org=randomUUID();await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Invitation race')",[org]);await pool.query("INSERT INTO memberships VALUES($1,$2,'owner',true)",[org,ids.alice]);
    const invite=(await request('alice','POST',`/v1/organizations/${org}/invitations`,{email:'bob@acme.test',role:'guest'})).json();
    const results=await Promise.all([request('bob','POST','/v1/invitations/accept',{invitationId:invite.id}),request('bob','DELETE',`/v1/invitations/${invite.id}`)]);
    assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,404]);
    const stored=(await pool.query('SELECT revoked,accepted_by FROM invitations WHERE id=$1',[invite.id])).rows[0];
    assert.notEqual(stored.revoked,stored.accepted_by===ids.bob);
    assert.equal((await pool.query('SELECT 1 FROM memberships WHERE org_id=$1 AND user_id=$2',[org,ids.bob])).rowCount,stored.revoked?0:1);
  }
});
