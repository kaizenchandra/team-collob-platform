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
  const query=pool.query,diagnostics:unknown[]=[];
  pool.query=((...args:unknown[])=>{
    const begin=Date.now();
    return (Reflect.apply(query,pool,args) as Promise<unknown>).catch((error:Error&{code?:string})=>{
      diagnostics.push({name:error.name,code:error.code,message:error.message,ms:Date.now()-begin,total:pool.totalCount,idle:pool.idleCount,waiting:pool.waitingCount});
      throw error;
    });
  }) as typeof pool.query;
  try{
    const r = await request("guest", "GET", `/v1/organizations/${ids.org}/bootstrap`);
    assert.equal(r.statusCode, 200, JSON.stringify({body:r.body,diagnostics}));
    assert(!r.json().channels.some((x: { id: string }) => x.id === ids.private));
    assert.equal((await request("guest", "GET", `/v1/channels/${ids.private}/messages`)).statusCode,404);
  }finally{pool.query=query;}
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
  const preparing=await queued();let preparationSends=0;
  await pool.query('ALTER TABLE digest_items RENAME TO digest_items_preparation_fault');
  try{await runDigestJob(async()=>{preparationSends++;});}finally{await pool.query('ALTER TABLE digest_items_preparation_fault RENAME TO digest_items');}
  const preparationState=(await pool.query('SELECT state,last_error,attempts FROM digest_jobs WHERE id=$1',[preparing])).rows[0];
  assert.deepEqual(preparationState,{state:'queued',last_error:'preparation_unavailable',attempts:1});assert.equal(preparationSends,0);
  await pool.query('UPDATE digest_jobs SET available_at=now() WHERE id=$1',[preparing]);await runDigestJob(async()=>{preparationSends++;});assert.equal(preparationSends,1);assert.equal((await pool.query('SELECT state FROM digest_jobs WHERE id=$1',[preparing])).rows[0].state,'sent');
  const exhaustedPreparation=await queued();await pool.query('UPDATE digest_jobs SET attempts=4 WHERE id=$1',[exhaustedPreparation]);
  await pool.query('ALTER TABLE digest_items RENAME TO digest_items_preparation_fault');
  try{await runDigestJob(async()=>{throw new Error('Preparation failure must not reach SMTP');});}finally{await pool.query('ALTER TABLE digest_items_preparation_fault RENAME TO digest_items');}
  assert.deepEqual((await pool.query('SELECT state,last_error,attempts FROM digest_jobs WHERE id=$1',[exhaustedPreparation])).rows[0],{state:'dead',last_error:'preparation_unavailable',attempts:5});
  const retry=await queued();await runDigestJob(async()=>{throw {code:'ESOCKET',originalCode:'ECONNREFUSED',syscall:'connect',command:'CONN'};});assert.equal((await pool.query('SELECT state FROM digest_jobs WHERE id=$1',[retry])).rows[0].state,'queued');
  await pool.query('UPDATE digest_jobs SET attempts=4,available_at=now() WHERE id=$1',[retry]);await runDigestJob(async()=>{throw {code:'ESOCKET',originalCode:'ECONNREFUSED',syscall:'connect',command:'CONN'};});assert.equal((await pool.query('SELECT state FROM digest_jobs WHERE id=$1',[retry])).rows[0].state,'dead');
  const uncertain=await queued();await runDigestJob(async()=>{throw {code:'ETIMEDOUT'};});assert.equal((await pool.query('SELECT state FROM digest_jobs WHERE id=$1',[uncertain])).rows[0].state,'uncertain');
  const acknowledgementFailure=await queued();let acknowledgedSends=0;
  try{await runDigestJob(async()=>{acknowledgedSends++;await pool.query('ALTER TABLE audit RENAME TO audit_digest_ack_fault');});}finally{await pool.query('ALTER TABLE audit_digest_ack_fault RENAME TO audit');}
  assert.equal(acknowledgedSends,1);assert.deepEqual((await pool.query('SELECT state,last_error,accepted_at FROM digest_jobs WHERE id=$1',[acknowledgementFailure])).rows[0],{state:'uncertain',last_error:'acceptance_unknown',accepted_at:null});
  await runDigestJob(async()=>{acknowledgedSends++;});assert.equal(acknowledgedSends,1);
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

test('organizer edits enforce revisions, reset rescheduled responses and serialize cancellation',async()=>{
  const base=`/v1/organizations/${ids.org}/meetings`,body={title:'Edit meeting',startsAt:'2026-12-20T10:00:00Z',endsAt:'2026-12-20T11:00:00Z',timezone:'UTC',description:'Original',attendees:[ids.bob]};
  const created=await request('alice','POST',base,body);assert.equal(created.statusCode,200,created.body);const id=created.json().id,path=`${base}/${id}`,edit={revision:1,title:body.title,startsAt:body.startsAt,endsAt:body.endsAt,timezone:'UTC',description:'Changed'};
  assert.equal((await request('bob','PUT',`${path}/details`,edit)).statusCode,404);assert.equal((await request('eve','PUT',`${path}/details`,edit)).statusCode,404);
  assert.equal((await request('alice','PUT',`${path}/details`,{...edit,timezone:'invalid/timezone'})).statusCode,400);
  assert.equal((await request('alice','PUT',`${path}/details`,{...edit,startsAt:'2026-12-20T11:00:00.900Z',endsAt:'2026-12-20T11:00:00Z'})).statusCode,400);
  await request('bob','PATCH',path,{response:'accepted'});
  assert.equal((await request('alice','PUT',`${path}/details`,edit)).statusCode,200);
  assert.equal((await pool.query('SELECT response FROM meeting_attendees WHERE meeting_id=$1 AND user_id=$2',[id,ids.bob])).rows[0].response,'accepted');
  assert.equal((await request('alice','PUT',`${path}/details`,edit)).statusCode,409);
  const rescheduled={...edit,revision:2,startsAt:'2026-12-20T12:00:00Z',endsAt:'2026-12-20T13:00:00Z'};
  const concurrent=await Promise.all([request('alice','PUT',`${path}/details`,rescheduled),request('alice','PUT',`${path}/details`,{...rescheduled,title:'Concurrent'})]);assert.deepEqual(concurrent.map(r=>r.statusCode).sort(),[200,409]);
  assert.equal((await pool.query('SELECT response FROM meeting_attendees WHERE meeting_id=$1 AND user_id=$2',[id,ids.bob])).rows[0].response,'pending');
  assert.equal((await request('alice','PATCH',path,{})).statusCode,400);
  assert.equal((await request('alice','PATCH',path,{cancelled:true,response:'accepted'})).statusCode,400);
  assert.equal((await request('alice','PATCH',path,{cancelled:true})).statusCode,200);
  assert.equal((await request('bob','PATCH',path,{response:'accepted'})).statusCode,409);
  assert.equal((await request('alice','PUT',`${path}/details`,{...rescheduled,revision:4})).statusCode,409);
  assert.equal((await pool.query('SELECT revision FROM meetings WHERE id=$1',[id])).rows[0].revision,4);
});

test('meeting roster edits preserve retained RSVP and revoke removed attendee access',async()=>{
  const base=`/v1/organizations/${ids.org}/meetings`,body={title:'Roster test',startsAt:'2026-11-22T10:00:00Z',endsAt:'2026-11-22T11:00:00Z',timezone:'UTC',attendees:[ids.bob]};
  const created=await request('alice','POST',base,body);assert.equal(created.statusCode,200,created.body);const id=created.json().id,path=`${base}/${id}`,edit={revision:1,title:body.title,description:'',startsAt:body.startsAt,endsAt:body.endsAt,timezone:'UTC',attendees:[ids.bob,ids.guest,ids.guest]};
  await request('bob','PATCH',path,{response:'accepted'});
  assert.equal((await request('bob','PUT',`${path}/details`,edit)).statusCode,404);
  assert.equal((await request('alice','PUT',`${path}/details`,{...edit,attendees:[ids.eve]})).statusCode,404);
  const disabled=randomUUID();await pool.query("INSERT INTO users(id,email,name,disabled) VALUES($1,$2,'Disabled roster fixture',true)",[disabled,`${disabled}@test.invalid`]);await pool.query("INSERT INTO memberships VALUES($1,$2,'member',true)",[ids.org,disabled]);
  assert.equal((await request('alice','PUT',`${path}/details`,{...edit,attendees:[disabled]})).statusCode,404);
  assert.equal((await request('alice','POST',base,{...body,attendees:[disabled]})).statusCode,404);
  assert.equal((await request('alice','PUT',`${path}/details`,edit)).statusCode,200);
  const rows=(await pool.query('SELECT user_id,response FROM meeting_attendees WHERE meeting_id=$1',[id])).rows;assert.equal(rows.length,3);assert.equal(rows.find(r=>r.user_id===ids.bob).response,'accepted');assert.equal(rows.find(r=>r.user_id===ids.guest).response,'pending');assert.equal(rows.find(r=>r.user_id===ids.alice).response,'accepted');
  const findMeeting=async(user:string)=>{
    let cursor:{startsAt:string;id:string}|null=null;const seen=new Set<string>();
    do{const query=new URLSearchParams({from:'2026-11-22T00:00:00Z',to:'2026-11-23T00:00:00Z',limit:'100',...(cursor?{afterStart:cursor.startsAt,afterId:cursor.id}:{})});const result=await request(user,'GET',`${base}?${query}`);assert.equal(result.statusCode,200,result.body);const page=result.json(),found=page.meetings.find((meeting:{id:string})=>meeting.id===id);if(found)return found;cursor=page.nextCursor;if(cursor){assert.ok(!seen.has(cursor.id));seen.add(cursor.id);}}while(cursor);
  };
  const attendeeView=await findMeeting('bob');assert.ok(attendeeView);assert.equal(attendeeView.attendee_ids,null);
  const ownerView=await findMeeting('alice');assert.ok(ownerView);assert.equal(ownerView.attendee_ids.length,3);
  assert.equal((await request('alice','PUT',`${path}/details`,{...edit,revision:2,attendees:[ids.guest]})).statusCode,200);
  assert.equal(await findMeeting('bob'),undefined);assert.equal((await request('bob','PATCH',path,{response:'accepted'})).statusCode,404);
  const {attendees,...legacy}=edit;assert.ok(attendees.length);assert.equal((await request('alice','PUT',`${path}/details`,{...legacy,revision:3})).statusCode,200);assert.equal((await pool.query('SELECT 1 FROM meeting_attendees WHERE meeting_id=$1',[id])).rowCount,2);
  assert.equal((await request('alice','PUT',`${path}/details`,{...edit,revision:4,attendees:[ids.bob]})).statusCode,200);assert.equal((await pool.query('SELECT response FROM meeting_attendees WHERE meeting_id=$1 AND user_id=$2',[id,ids.bob])).rows[0].response,'pending');
});

test('calendar keyset pages preserve microsecond ordering, range bounds and current access',async()=>{
  const org=randomUUID(),meetingIds=Array.from({length:105},()=>randomUUID());await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Calendar pages')",[org]);await pool.query("INSERT INTO memberships VALUES($1,$2,'owner',true),($1,$3,'member',true)",[org,ids.alice,ids.bob]);
  await pool.query("INSERT INTO meetings(id,org_id,title,starts_at,ends_at,timezone,organizer_id) SELECT id,$2,'Page fixture','2032-01-01T10:00:00.000001Z','2032-01-01T11:00:00Z','UTC',$3 FROM unnest($1::uuid[]) id",[meetingIds,org,ids.alice]);
  await pool.query("INSERT INTO meeting_attendees(meeting_id,user_id,response) SELECT id,$2,'pending' FROM unnest($1::uuid[]) id",[meetingIds,ids.bob]);
  const base=`/v1/organizations/${org}/meetings`;let cursor:{startsAt:string;id:string}|null=null;const seen:string[]=[];
  do{const query=new URLSearchParams({limit:'37'});if(cursor){query.set('afterStart',cursor.startsAt);query.set('afterId',cursor.id);}const r=await request('bob','GET',`${base}?${query}`);assert.equal(r.statusCode,200,r.body);const page=r.json();assert.ok(page.meetings.length<=37);seen.push(...page.meetings.map((m:{id:string})=>m.id));cursor=page.nextCursor;if(cursor)assert.equal(cursor.startsAt,'2032-01-01T10:00:00.000001Z');assert.ok(seen.length<=105);}while(cursor);
  assert.deepEqual(seen,[...meetingIds].sort());assert.equal(new Set(seen).size,105);
  for(const query of ['limit=101','afterId='+meetingIds[0],'from=2032-01-01T00:00:00Z','from=2032-01-01T00:00:00Z&to=2034-01-01T00:00:00Z'])assert.equal((await request('bob','GET',`${base}?${query}`)).statusCode,400);
  assert.equal((await request('bob','GET',`${base}?from=2032-01-01T10:30:00Z&to=2032-01-01T11:30:00Z`)).json().meetings.length,50);
  assert.equal((await request('bob','GET',`${base}?from=2032-01-01T11:00:00Z&to=2032-01-01T12:00:00Z`)).json().meetings.length,0);
  const first=(await request('bob','GET',`${base}?limit=100`)).json();await pool.query('DELETE FROM meeting_attendees WHERE meeting_id=$1 AND user_id=$2',[seen[104],ids.bob]);const query=new URLSearchParams({afterStart:first.nextCursor.startsAt,afterId:first.nextCursor.id});assert.equal((await request('bob','GET',`${base}?${query}`)).json().meetings.length,4);
  assert.equal((await request('eve','GET',`${base}?${query}`)).statusCode,404);
});

test('calendar change counters are durable, recipient-scoped and transactional',async()=>{
  const org=randomUUID();await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Calendar changes')",[org]);await pool.query("INSERT INTO memberships VALUES($1,$2,'owner',true),($1,$3,'member',true),($1,$4,'guest',true)",[org,ids.alice,ids.bob,ids.guest]);
  const base=`/v1/organizations/${org}`,version=async(user:string)=>{const r=await request(user,'GET',`${base}/calendar-version`);assert.equal(r.statusCode,200,r.body);return r.json().revision;};
  assert.equal(await version('bob'),'0');assert.equal((await request('eve','GET',`${base}/calendar-version`)).statusCode,404);
  const body={title:'Counter meeting',startsAt:'2026-12-21T10:00:00Z',endsAt:'2026-12-21T11:00:00Z',timezone:'UTC',attendees:[ids.bob]};const id=(await request('alice','POST',`${base}/meetings`,body)).json().id;
  assert.equal(await version('alice'),'1');assert.equal(await version('bob'),'1');assert.equal(await version('guest'),'0');
  const edit={...body,revision:1,description:'Update',attendees:[ids.guest]};
  assert.equal((await request('alice','PUT',`${base}/meetings/${id}/details`,{...edit,attendees:[ids.eve]})).statusCode,404);assert.equal(await version('bob'),'1');
  assert.equal((await request('alice','PUT',`${base}/meetings/${id}/details`,edit)).statusCode,200);assert.equal(await version('bob'),'2');assert.equal(await version('guest'),'1');assert.equal(await version('alice'),'2');
  assert.equal((await request('alice','PUT',`${base}/meetings/${id}/details`,edit)).statusCode,409);assert.equal(await version('alice'),'2');
  await request('guest','PATCH',`${base}/meetings/${id}`,{response:'accepted'});assert.equal(await version('guest'),'2');assert.equal(await version('alice'),'3');assert.equal(await version('bob'),'2');
  await request('alice','PATCH',`${base}/meetings/${id}`,{cancelled:true});assert.equal(await version('guest'),'3');assert.equal(await version('alice'),'4');assert.equal(await version('bob'),'2');
  await request('alice','PATCH',`${base}/meetings/${id}`,{cancelled:true});assert.equal(await version('alice'),'4');
  assert.equal((await pool.query('SELECT revision FROM calendar_versions WHERE org_id=$1 AND user_id=$2',[org,ids.alice])).rows[0].revision,'4');
});

test('recurring series is atomic, retry-safe, scoped and cancelled without resurrection',async()=>{
  const org=randomUUID();await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Series test')",[org]);await pool.query("INSERT INTO memberships VALUES($1,$2,'owner',true),($1,$3,'member',true)",[org,ids.alice,ids.bob]);const base=`/v1/organizations/${org}/meetings`;
  const body={title:'Weekly planning',startsAt:'2026-03-01T14:00:00Z',endsAt:'2026-03-01T15:00:00Z',timezone:'America/New_York',attendees:[ids.bob],clientId:randomUUID(),recurrence:{frequency:'weekly',interval:1,count:3,repeatedTime:'reject'}};
  const results=await Promise.all([request('alice','POST',base,body),request('alice','POST',base,body)]);for(const r of results)assert.equal(r.statusCode,200,r.body);const series=results[0].json();assert.deepEqual(results[1].json().occurrenceIds,series.occurrenceIds);assert.equal(series.occurrenceIds.length,3);
  assert.equal((await request('alice','POST',base,{...body,title:'Changed retry'})).statusCode,409);
  assert.equal((await request('alice','POST',base,{...body,clientId:randomUUID(),startsAt:'2026-03-01T07:30:00Z',endsAt:'2026-03-01T08:30:00Z'})).statusCode,400);
  assert.equal((await pool.query('SELECT 1 FROM meetings WHERE org_id=$1',[org])).rowCount,3);
  const rows=(await request('bob','GET',base)).json().meetings;assert.equal(rows[1].starts_at,'2026-03-08T13:00:00.000Z');assert.deepEqual(rows.map((r:{series_ordinal:number})=>r.series_ordinal),[1,2,3]);assert.ok(rows.every((r:{series_count:number})=>r.series_count===3));
  const target=`${base}/${series.occurrenceIds[0]}/series`;
  assert.equal((await request('bob','PATCH',target,{cancelled:true})).statusCode,404);assert.equal((await request('eve','PATCH',target,{cancelled:true})).statusCode,404);
  assert.equal((await request('bob','PATCH',`${base}/${series.occurrenceIds[1]}`,{response:'accepted'})).statusCode,200);
  assert.equal((await request('alice','PATCH',target,{cancelled:true})).statusCode,200);const version=(await request('alice','GET',`/v1/organizations/${org}/calendar-version`)).json().revision;
  assert.ok((await request('bob','GET',base)).json().meetings.every((r:{cancelled:boolean})=>r.cancelled));assert.equal((await request('bob','PATCH',`${base}/${series.occurrenceIds[1]}`,{response:'accepted'})).statusCode,409);
  assert.equal((await request('alice','PATCH',target,{cancelled:true})).statusCode,200);assert.equal((await request('alice','GET',`/v1/organizations/${org}/calendar-version`)).json().revision,version);
  assert.equal((await request('alice','POST',base,body)).json().replayed,true);assert.equal((await pool.query('SELECT 1 FROM meetings WHERE series_id=$1 AND NOT cancelled',[series.seriesId])).rowCount,0);
});

test('series edits are revision-scoped, preserve cancelled occurrences and serialize individual edits',async()=>{
  const org=randomUUID();await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Series edits')",[org]);await pool.query("INSERT INTO memberships VALUES($1,$2,'owner',true),($1,$3,'member',true),($1,$4,'guest',true)",[org,ids.alice,ids.bob,ids.guest]);const base=`/v1/organizations/${org}/meetings`;
  const created=(await request('alice','POST',base,{title:'Original series',startsAt:'2026-12-01T10:00:00Z',endsAt:'2026-12-01T11:00:00Z',timezone:'UTC',attendees:[ids.bob],clientId:randomUUID(),recurrence:{frequency:'daily',interval:1,count:3}})).json();const [first,second,last]=created.occurrenceIds,target=`${base}/${first}/series/details`;
  await request('bob','PATCH',`${base}/${first}`,{response:'accepted'});await request('alice','PATCH',`${base}/${last}`,{cancelled:true});const edit={revision:2,title:'Updated series',description:'Shared details',attendees:[ids.bob,ids.guest]};
  assert.equal((await request('bob','PUT',target,edit)).statusCode,404);assert.equal((await request('eve','PUT',target,edit)).statusCode,404);assert.equal((await request('alice','PUT',target,{...edit,revision:1})).statusCode,409);
  const changed=await request('alice','PUT',target,edit);assert.equal(changed.statusCode,200,changed.body);assert.equal(changed.json().occurrences,2);
  const rows=(await pool.query('SELECT * FROM meetings WHERE series_id=$1 ORDER BY series_ordinal',[created.seriesId])).rows;assert.deepEqual(rows.map(r=>r.title),['Updated series','Updated series','Original series']);assert.equal(rows[2].cancelled,true);assert.equal(rows[0].starts_at.toISOString(),'2026-12-01T10:00:00.000Z');
  assert.equal((await pool.query('SELECT response FROM meeting_attendees WHERE meeting_id=$1 AND user_id=$2',[first,ids.bob])).rows[0].response,'accepted');assert.equal((await pool.query('SELECT 1 FROM meeting_attendees WHERE user_id=$1 AND meeting_id=ANY($2::uuid[]) AND response=\'pending\'',[ids.guest,[first,second]])).rowCount,2);
  assert.equal((await request('alice','PUT',target,{...edit,revision:3,attendees:[ids.eve]})).statusCode,404);
  assert.equal((await request('alice','PUT',target,{...edit,revision:3,attendees:[ids.guest]})).statusCode,200);assert.equal((await request('bob','PATCH',`${base}/${first}`,{response:'accepted'})).statusCode,404);assert.equal((await request('bob','GET',base)).json().meetings.length,1);
  const single={revision:3,title:'One occurrence',description:'',startsAt:'2026-12-01T10:00:00Z',endsAt:'2026-12-01T11:00:00Z',timezone:'UTC'};
  const race=await Promise.all([request('alice','PUT',target,{...edit,revision:4,attendees:[ids.guest]}),request('alice','PUT',`${base}/${first}/details`,single)]);assert.deepEqual(race.map(r=>r.statusCode).sort(),[200,409]);
  assert.equal((await request('alice','PATCH',`${base}/${first}/series`,{cancelled:true})).statusCode,200);assert.equal((await request('alice','PUT',target,{...edit,revision:6})).statusCode,409);
});

test('series rescheduling preserves IDs/cancelled exceptions and updates canonical anchor atomically',async()=>{
  const org=randomUUID();await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Series schedule')",[org]);await pool.query("INSERT INTO memberships VALUES($1,$2,'owner',true),($1,$3,'member',true)",[org,ids.alice,ids.bob]);const base=`/v1/organizations/${org}/meetings`;
  const created=await request('alice','POST',base,{title:'Canonical schedule',startsAt:'2026-03-01T14:00:00Z',endsAt:'2026-03-01T15:00:00Z',timezone:'America/New_York',attendees:[ids.bob],clientId:randomUUID(),recurrence:{frequency:'weekly',interval:1,count:3}});assert.equal(created.statusCode,200,created.body);const series=created.json(),[first,second,last]=series.occurrenceIds,target=`${base}/${second}/series`;
  await request('bob','PATCH',`${base}/${second}`,{response:'accepted'});await request('alice','PATCH',`${base}/${last}`,{cancelled:true});
  const info=(await request('alice','GET',target)).json();assert.equal(info.anchor_starts_at,'2026-03-01T14:00:00.000Z');assert.ok(!('request_hash' in info));assert.equal((await request('bob','GET',target)).statusCode,404);
  const schedule={revision:info.revision,startsAt:'2026-03-02T15:00:00Z',endsAt:'2026-03-02T16:00:00Z',timezone:'UTC',frequency:'daily',interval:2,repeatedTime:'reject'};
  assert.equal((await request('bob','PUT',`${target}/schedule`,schedule)).statusCode,404);assert.equal((await request('eve','PUT',`${target}/schedule`,schedule)).statusCode,404);
  const changed=await request('alice','PUT',`${target}/schedule`,schedule);assert.equal(changed.statusCode,200,changed.body);assert.equal(changed.json().rescheduled,2);
  const rows=(await pool.query('SELECT * FROM meetings WHERE series_id=$1 ORDER BY series_ordinal',[series.seriesId])).rows;assert.deepEqual(rows.map(r=>r.id),series.occurrenceIds);assert.equal(rows[0].starts_at.toISOString(),'2026-03-02T15:00:00.000Z');assert.equal(rows[1].starts_at.toISOString(),'2026-03-04T15:00:00.000Z');assert.equal(rows[2].starts_at.toISOString(),'2026-03-15T13:00:00.000Z');assert.equal(rows[2].cancelled,true);assert.equal((await pool.query('SELECT response FROM meeting_attendees WHERE meeting_id=$1 AND user_id=$2',[second,ids.bob])).rows[0].response,'pending');
  assert.equal((await request('alice','PUT',`${target}/schedule`,schedule)).statusCode,409);
  const invalid={...schedule,revision:changed.json().revision,startsAt:'2026-03-01T07:30:00Z',endsAt:'2026-03-01T08:30:00Z',timezone:'America/New_York',frequency:'weekly',interval:1};assert.equal((await request('alice','PUT',`${target}/schedule`,invalid)).statusCode,400);assert.equal((await request('alice','GET',target)).json().revision,changed.json().revision);
  await request('bob','PATCH',`${base}/${second}`,{response:'accepted'});const same=await request('alice','PUT',`${target}/schedule`,{...schedule,revision:changed.json().revision});assert.equal(same.statusCode,200,same.body);assert.equal(same.json().rescheduled,0);assert.equal((await pool.query('SELECT response FROM meeting_attendees WHERE meeting_id=$1 AND user_id=$2',[second,ids.bob])).rows[0].response,'accepted');
  await request('alice','PATCH',`${base}/${first}`,{cancelled:true});assert.equal((await request('alice','GET',target)).json().anchor_starts_at,'2026-03-02T15:00:00.000Z');
});

test('monthly/yearly rules persist policy and preserve legacy retry identity',async()=>{
  const org=randomUUID();await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Month series')",[org]);await pool.query("INSERT INTO memberships VALUES($1,$2,'owner',true)",[org,ids.alice]);const base=`/v1/organizations/${org}/meetings`;
  const body={title:'Month end',startsAt:'2030-01-31T10:00:00Z',endsAt:'2030-01-31T11:00:00Z',timezone:'UTC',attendees:[],clientId:randomUUID(),recurrence:{frequency:'monthly',interval:1,count:4,repeatedTime:'reject'}};
  assert.equal((await request('alice','POST',base,body)).statusCode,400);assert.equal((await pool.query('SELECT 1 FROM meeting_series WHERE org_id=$1',[org])).rowCount,0);
  const created=await request('alice','POST',base,{...body,recurrence:{...body.recurrence,monthDayPolicy:'constrain'}});assert.equal(created.statusCode,200,created.body);const series=created.json(),target=`${base}/${series.id}/series`;
  const info=(await request('alice','GET',target)).json();assert.equal(info.month_day_policy,'constrain');assert.deepEqual((await request('alice','GET',base)).json().meetings.map((m:{starts_at:string})=>m.starts_at.slice(0,10)),['2030-01-31','2030-02-28','2030-03-31','2030-04-30']);
  const changed=await request('alice','PUT',`${target}/schedule`,{revision:info.revision,startsAt:'2032-02-29T10:00:00Z',endsAt:'2032-02-29T11:00:00Z',timezone:'UTC',frequency:'yearly',interval:1,repeatedTime:'reject'});assert.equal(changed.statusCode,200,changed.body);assert.equal((await request('alice','GET',target)).json().month_day_policy,'constrain');
  assert.deepEqual((await request('alice','GET',base)).json().meetings.map((m:{starts_at:string})=>m.starts_at.slice(0,10)),['2032-02-29','2033-02-28','2034-02-28','2035-02-28']);
  const legacy={...body,clientId:randomUUID(),startsAt:'2030-01-01T10:00:00Z',endsAt:'2030-01-01T11:00:00Z',recurrence:{frequency:'weekly',interval:1,count:2,repeatedTime:'reject'}};const saved=await request('alice','POST',base,legacy);assert.equal(saved.statusCode,200,saved.body);
  const {createHash}=await import('node:crypto');const oldHash=createHash('sha256').update(JSON.stringify({title:legacy.title,startsAt:legacy.startsAt,endsAt:legacy.endsAt,timezone:legacy.timezone,description:'',attendees:[],clientId:undefined,recurrence:legacy.recurrence})).digest('hex');assert.equal((await pool.query('SELECT request_hash FROM meeting_series WHERE id=$1',[saved.json().seriesId])).rows[0].request_hash,oldHash);
  assert.equal((await request('alice','POST',base,{...legacy,recurrence:{...legacy.recurrence,monthDayPolicy:'reject'}})).json().replayed,true);
});

test('series expansion preserves existing identities and original creation replay',async()=>{
  const org=randomUUID();await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Series expansion')",[org]);await pool.query("INSERT INTO memberships VALUES($1,$2,'owner',true),($1,$3,'member',true),($1,$4,'guest',true)",[org,ids.alice,ids.bob,ids.guest]);const base=`/v1/organizations/${org}/meetings`,body={title:'Original expansion',startsAt:'2030-01-01T10:00:00Z',endsAt:'2030-01-01T11:00:00Z',timezone:'UTC',attendees:[ids.bob,ids.guest],clientId:randomUUID(),recurrence:{frequency:'weekly',interval:1,count:3}};
  const made=(await request('alice','POST',base,body)).json(),[first,second,last]=made.occurrenceIds;await request('bob','PATCH',`${base}/${first}`,{response:'accepted'});
  assert.equal((await request('alice','PUT',`${base}/${second}/details`,{revision:1,title:'Tail template',description:'Copied into additions',startsAt:'2030-01-08T10:00:00Z',endsAt:'2030-01-08T11:00:00Z',timezone:'UTC',attendees:[ids.guest]})).statusCode,200);await request('alice','PATCH',`${base}/${last}`,{cancelled:true});
  const target=`${base}/${first}/series`,info=(await request('alice','GET',target)).json(),schedule={revision:info.revision,startsAt:info.anchor_starts_at,endsAt:info.anchor_ends_at,timezone:info.timezone,frequency:info.frequency,interval:info.interval,repeatedTime:info.repeated_time,count:5};
  assert.equal((await request('bob','PUT',`${target}/schedule`,schedule)).statusCode,404);assert.equal((await request('alice','PUT',`${target}/schedule`,{...schedule,count:2})).statusCode,400);assert.equal((await request('alice','PUT',`${target}/schedule`,{...schedule,count:53})).statusCode,400);
  const r=await request('alice','PUT',`${target}/schedule`,schedule);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().added,2);assert.equal(r.json().rescheduled,0);
  const rows=(await pool.query('SELECT * FROM meetings WHERE series_id=$1 ORDER BY series_ordinal',[made.seriesId])).rows;assert.equal(rows.length,5);assert.deepEqual(rows.slice(0,3).map(m=>m.id),made.occurrenceIds);assert.equal(rows[2].cancelled,true);assert.ok(rows.slice(3).every(m=>m.title==='Tail template'&&m.description==='Copied into additions'));
  assert.equal((await pool.query('SELECT response FROM meeting_attendees WHERE meeting_id=$1 AND user_id=$2',[first,ids.bob])).rows[0].response,'accepted');
  for(const row of rows.slice(3)){assert.equal((await pool.query('SELECT response FROM meeting_attendees WHERE meeting_id=$1 AND user_id=$2',[row.id,ids.guest])).rows[0].response,'pending');assert.equal((await pool.query('SELECT 1 FROM meeting_attendees WHERE meeting_id=$1 AND user_id=$2',[row.id,ids.bob])).rowCount,0);}
  assert.equal((await request('alice','PUT',`${target}/schedule`,schedule)).statusCode,409);assert.deepEqual((await request('alice','POST',base,body)).json().occurrenceIds,made.occurrenceIds);
  const current=(await request('alice','GET',target)).json();await pool.query('UPDATE memberships SET active=false WHERE org_id=$1 AND user_id=$2',[org,ids.guest]);assert.equal((await request('alice','PUT',`${target}/schedule`,{...schedule,revision:current.revision,count:6})).statusCode,404);await pool.query('UPDATE memberships SET active=true WHERE org_id=$1 AND user_id=$2',[org,ids.guest]);assert.equal((await request('alice','PUT',`${target}/schedule`,{...schedule,revision:current.revision,count:52,interval:12})).statusCode,400);assert.equal((await pool.query('SELECT 1 FROM meetings WHERE series_id=$1',[made.seriesId])).rowCount,5);
});

test('upcoming-only series changes preserve historical rows and reject backward shifts',async()=>{
  const org=randomUUID();await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Upcoming scope')",[org]);await pool.query("INSERT INTO memberships VALUES($1,$2,'owner',true),($1,$3,'member',true),($1,$4,'guest',true)",[org,ids.alice,ids.bob,ids.guest]);const now=(await pool.query('SELECT clock_timestamp() t')).rows[0].t.getTime(),start=new Date(now-36*3600000).toISOString(),end=new Date(now-35*3600000).toISOString(),base=`/v1/organizations/${org}/meetings`;
  const made=(await request('alice','POST',base,{title:'History preserved',startsAt:start,endsAt:end,timezone:'UTC',attendees:[ids.bob],clientId:randomUUID(),recurrence:{frequency:'daily',interval:1,count:4}})).json();
  for(const id of made.occurrenceIds)await request('bob','PATCH',`${base}/${id}`,{response:'accepted'});
  const historical=(await pool.query('SELECT * FROM meetings WHERE id=ANY($1::uuid[]) ORDER BY id',[made.occurrenceIds.slice(0,2)])).rows;
  const target=`${base}/${made.id}/series`,info=(await request('alice','GET',target)).json();const details=await request('alice','PUT',`${target}/details`,{revision:info.revision,title:'Upcoming updated',description:'Only future',attendees:[ids.guest],futureOnly:true});assert.equal(details.statusCode,200,details.body);assert.equal(details.json().occurrences,2);assert.equal(details.json().preserved,2);
  assert.deepEqual((await pool.query('SELECT * FROM meetings WHERE id=ANY($1::uuid[]) ORDER BY id',[made.occurrenceIds.slice(0,2)])).rows,historical);assert.equal((await request('bob','GET',base)).json().meetings.length,2);assert.equal((await request('bob','PATCH',`${base}/${made.occurrenceIds[2]}`,{response:'accepted'})).statusCode,404);
  const schedule={revision:details.json().revision,startsAt:new Date(Date.parse(start)+2*3600000).toISOString(),endsAt:new Date(Date.parse(end)+2*3600000).toISOString(),timezone:'UTC',frequency:'daily',interval:1,repeatedTime:'reject',futureOnly:true};const changed=await request('alice','PUT',`${target}/schedule`,schedule);assert.equal(changed.statusCode,200,changed.body);assert.equal(changed.json().rescheduled,2);assert.equal(changed.json().preserved,2);
  assert.deepEqual((await pool.query('SELECT * FROM meetings WHERE id=ANY($1::uuid[]) ORDER BY id',[made.occurrenceIds.slice(0,2)])).rows,historical);assert.equal((await pool.query('SELECT response FROM meeting_attendees WHERE meeting_id=$1 AND user_id=$2',[made.occurrenceIds[0],ids.bob])).rows[0].response,'accepted');
  assert.equal((await request('alice','PUT',`${target}/schedule`,{...schedule,revision:changed.json().revision,startsAt:new Date(now-10*86400000).toISOString(),endsAt:new Date(now-10*86400000+3600000).toISOString()})).statusCode,400);assert.equal((await request('alice','GET',target)).json().revision,changed.json().revision);
  const old=(await request('alice','POST',base,{title:'All historical',startsAt:new Date(now-10*86400000).toISOString(),endsAt:new Date(now-10*86400000+3600000).toISOString(),timezone:'UTC',attendees:[],clientId:randomUUID(),recurrence:{frequency:'daily',interval:1,count:2}})).json();assert.equal((await request('alice','PUT',`${base}/${old.id}/series/details`,{revision:1,title:'Cannot change',description:'',attendees:[],futureOnly:true})).statusCode,409);
});

test('upcoming cancellation preserves started meetings and is idempotent',async()=>{
  const org=randomUUID();await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Upcoming cancellation')",[org]);await pool.query("INSERT INTO memberships VALUES($1,$2,'owner',true),($1,$3,'member',true)",[org,ids.alice,ids.bob]);
  const now=Date.now(),base=`/v1/organizations/${org}/meetings`,payload={title:'Cancellation scope',startsAt:new Date(now-36*3600000).toISOString(),endsAt:new Date(now-35*3600000).toISOString(),timezone:'UTC',attendees:[ids.bob],clientId:randomUUID(),recurrence:{frequency:'daily',interval:1,count:4}};
  const created=await request('alice','POST',base,payload);assert.equal(created.statusCode,200,created.body);const made=created.json(),target=`${base}/${made.id}/series`;
  for(const id of made.occurrenceIds)assert.equal((await request('bob','PATCH',`${base}/${id}`,{response:'accepted'})).statusCode,200);
  const history=async()=>(await pool.query('SELECT * FROM meetings WHERE id=ANY($1::uuid[]) ORDER BY id',[made.occurrenceIds.slice(0,2)])).rows;
  const before=await history();assert.equal((await request('bob','PATCH',target,{cancelled:true,futureOnly:true})).statusCode,404);assert.equal((await request('eve','PATCH',target,{cancelled:true,futureOnly:true})).statusCode,404);
  const result=await request('alice','PATCH',target,{cancelled:true,futureOnly:true});assert.equal(result.statusCode,200,result.body);assert.equal(result.json().cancelled,2);assert.equal(result.json().preserved,2);assert.deepEqual(await history(),before);
  assert.equal((await pool.query('SELECT response FROM meeting_attendees WHERE meeting_id=$1 AND user_id=$2',[made.id,ids.bob])).rows[0].response,'accepted');assert.equal((await request('bob','PATCH',`${base}/${made.occurrenceIds[2]}`,{response:'accepted'})).statusCode,409);
  const snapshot=async()=>(await pool.query('SELECT revision,cancelled FROM meeting_series WHERE id=$1',[made.seriesId])).rows;const counters=async()=>(await pool.query('SELECT * FROM calendar_versions WHERE org_id=$1 ORDER BY user_id',[org])).rows;
  const series=await snapshot(),versions=await counters();assert.equal(series[0].cancelled,false);assert.equal((await request('alice','PATCH',target,{cancelled:true,futureOnly:true})).json().cancelled,0);assert.deepEqual(await snapshot(),series);assert.deepEqual(await counters(),versions);
  assert.deepEqual((await request('alice','POST',base,payload)).json().occurrenceIds,made.occurrenceIds);assert.deepEqual(await history(),before);
  const ongoing=(await request('alice','POST',base,{...payload,clientId:randomUUID(),startsAt:new Date(now-1800000).toISOString(),endsAt:new Date(now+1800000).toISOString(),recurrence:{frequency:'daily',interval:1,count:2}})).json();
  const ongoingRow=(await pool.query('SELECT * FROM meetings WHERE id=$1',[ongoing.id])).rows[0];const ongoingResult=await request('alice','PATCH',`${base}/${ongoing.id}/series`,{cancelled:true,futureOnly:true});assert.equal(ongoingResult.json().cancelled,1);assert.equal(ongoingResult.json().preserved,1);assert.deepEqual((await pool.query('SELECT * FROM meetings WHERE id=$1',[ongoing.id])).rows[0],ongoingRow);
  assert.equal((await request('alice','PATCH',target,{cancelled:true})).json().cancelled,2);assert.equal((await snapshot())[0].cancelled,true);assert.equal((await pool.query('SELECT count(*) FROM meetings WHERE series_id=$1 AND NOT cancelled',[made.seriesId])).rows[0].count,'0');
});

test('personal reminders persist, suppress safely and rearm only after time changes',async()=>{
  const org=randomUUID();await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Reminder checks')",[org]);await pool.query("INSERT INTO memberships VALUES($1,$2,'owner',true),($1,$3,'member',true)",[org,ids.alice,ids.bob]);
  const base=`/v1/organizations/${org}`,start=new Date(Date.now()+180000).toISOString(),end=new Date(Date.now()+360000).toISOString();const made=(await request('alice','POST',`${base}/meetings`,{title:'Due meeting',startsAt:start,endsAt:end,timezone:'UTC',attendees:[ids.bob]})).json(),target=`${base}/meetings/${made.id}/reminder`,due=async(user='bob')=>await request(user,'GET',`${base}/meeting-reminders`);
  const previous=(await pool.query('SELECT quiet_enabled,quiet_start,quiet_end FROM notification_settings WHERE user_id=$1',[ids.bob])).rows[0];
  try{
    await pool.query('UPDATE notification_settings SET quiet_enabled=false WHERE user_id=$1',[ids.bob]);
    assert.deepEqual((await due()).json().items,[]);assert.equal((await request('eve','PUT',target,{minutes:5})).statusCode,404);assert.equal((await request('bob','PUT',target,{minutes:7})).statusCode,400);
    assert.equal((await request('bob','PUT',target,{minutes:5})).statusCode,200);assert.equal((await request('bob','PUT',target,{minutes:5})).statusCode,200);assert.equal((await pool.query('SELECT count(*) FROM meeting_reminders WHERE meeting_id=$1',[made.id])).rows[0].count,'1');
    let item=(await due()).json().items[0];assert.equal(item.title,'Due meeting');assert.deepEqual((await due('alice')).json().items,[]);assert.equal((await request('bob','GET',`${base}/meetings`)).json().meetings[0].reminder_minutes,5);
    assert.equal((await request('bob','POST',`${target}/dismiss`,{startsAt:new Date(Date.parse(start)+1000).toISOString()})).statusCode,409);assert.equal((await request('bob','POST',`${target}/dismiss`,{startsAt:item.starts_at})).statusCode,200);assert.equal((await request('bob','POST',`${target}/dismiss`,{startsAt:item.starts_at})).statusCode,200);assert.deepEqual((await due()).json().items,[]);
    let row=(await request('alice','GET',`${base}/meetings`)).json().meetings[0];const updated=await request('alice','PUT',`${base}/meetings/${made.id}/details`,{revision:row.revision,title:'Retitled',description:'',startsAt:row.starts_at,endsAt:row.ends_at,timezone:'UTC',attendees:[ids.bob]});assert.equal(updated.statusCode,200,updated.body);assert.deepEqual((await due()).json().items,[]);
    row=(await request('alice','GET',`${base}/meetings`)).json().meetings[0];assert.equal((await request('alice','PUT',`${base}/meetings/${made.id}/details`,{revision:row.revision,title:'Moved',description:'',startsAt:new Date(Date.parse(start)+30000).toISOString(),endsAt:new Date(Date.parse(end)+30000).toISOString(),timezone:'UTC',attendees:[ids.bob]})).statusCode,200);item=(await due()).json().items[0];assert.equal(item.title,'Moved');
    await pool.query("INSERT INTO notification_settings(user_id,quiet_enabled,quiet_start,quiet_end) VALUES($1,true,'00:00','00:00') ON CONFLICT(user_id) DO UPDATE SET quiet_enabled=true,quiet_start='00:00',quiet_end='00:00'",[ids.bob]);assert.equal((await due()).json().suppressed,'quiet-hours');assert.deepEqual((await due()).json().items,[]);await pool.query('UPDATE notification_settings SET quiet_enabled=false WHERE user_id=$1',[ids.bob]);
    await request('bob','PATCH',`${base}/meetings/${made.id}`,{response:'declined'});assert.deepEqual((await due()).json().items,[]);await request('bob','PATCH',`${base}/meetings/${made.id}`,{response:'accepted'});assert.equal((await due()).json().items.length,1);
    await pool.query('UPDATE memberships SET active=false WHERE org_id=$1 AND user_id=$2',[org,ids.bob]);assert.equal((await due()).statusCode,404);await pool.query('UPDATE memberships SET active=true WHERE org_id=$1 AND user_id=$2',[org,ids.bob]);
    row=(await request('alice','GET',`${base}/meetings`)).json().meetings[0];await request('alice','PUT',`${base}/meetings/${made.id}/details`,{revision:row.revision,title:'Withdrawn',description:'',startsAt:row.starts_at,endsAt:row.ends_at,timezone:'UTC',attendees:[]});assert.equal((await request('bob','PUT',target,{minutes:15})).statusCode,404);assert.equal((await pool.query('SELECT count(*) FROM meeting_reminders WHERE meeting_id=$1',[made.id])).rows[0].count,'0');assert.deepEqual((await due()).json().items,[]);
    const outside=(await request('alice','POST',`${base}/meetings`,{title:'Outside window',startsAt:new Date(Date.now()+2*3600000).toISOString(),endsAt:new Date(Date.now()+3*3600000).toISOString(),timezone:'UTC',attendees:[]})).json();const outsideTarget=`${base}/meetings/${outside.id}/reminder`;await request('alice','PUT',outsideTarget,{minutes:60});assert.deepEqual((await due('alice')).json().items,[]);await pool.query("UPDATE meetings SET starts_at=now()-interval '1 minute' WHERE id=$1",[outside.id]);assert.deepEqual((await due('alice')).json().items,[]);await request('alice','PUT',outsideTarget,{minutes:0});assert.equal((await pool.query('SELECT count(*) FROM meeting_reminders WHERE meeting_id=$1',[outside.id])).rows[0].count,'0');
    await request('alice','PUT',target,{minutes:5});await request('alice','PATCH',`${base}/meetings/${made.id}`,{cancelled:true});assert.deepEqual((await due('alice')).json().items,[]);assert.equal((await request('alice','PUT',target,{minutes:5})).statusCode,409);
  }finally{if(previous)await pool.query('UPDATE notification_settings SET quiet_enabled=$2,quiet_start=$3,quiet_end=$4 WHERE user_id=$1',[ids.bob,previous.quiet_enabled,previous.quiet_start,previous.quiet_end]);else await pool.query('DELETE FROM notification_settings WHERE user_id=$1',[ids.bob]);}
});

test('channel posting policy serializes new writes, preserves accepted retries and enforces current roles',async()=>{
  const org=randomUUID(),team=randomUUID(),id=randomUUID();await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Posting policy test')",[org]);await pool.query("INSERT INTO memberships VALUES($1,$2,'owner',true),($1,$3,'member',true),($1,$4,'guest',true)",[org,ids.alice,ids.bob,ids.guest]);await pool.query("INSERT INTO teams(id,org_id,name) VALUES($1,$2,'Policy team')",[team,org]);await pool.query("INSERT INTO channels(id,org_id,team_id,name,kind) VALUES($1,$2,$3,'Restricted channel','private')",[id,org,team]);await pool.query('INSERT INTO channel_members VALUES($1,$2,$3),($1,$2,$4),($1,$2,$5)',[org,id,ids.alice,ids.bob,ids.guest]);
  const base=`/v1/channels/${id}`,policy=`${base}/posting-policy`,body={clientId:randomUUID(),body:'Accepted before restriction'},sent=await request('bob','POST',`${base}/messages`,body);assert.equal(sent.statusCode,201,sent.body);const original=sent.json();await request('bob','PUT',`${base}/draft`,{body:'Preserved draft'});
  assert.equal((await request('bob','PATCH',policy,{revision:1,restricted:true})).statusCode,403);assert.equal((await request('eve','PATCH',policy,{revision:1,restricted:true})).statusCode,404);
  const locked=await request('alice','PATCH',policy,{revision:1,restricted:true});assert.equal(locked.statusCode,200,locked.body);assert.equal(locked.json().revision,2);assert.equal((await request('alice','PATCH',policy,{revision:1,restricted:false})).statusCode,409);assert.equal((await request('alice','PATCH',policy,{revision:2,restricted:true})).json().revision,2);
  for(const user of ['bob','guest'])assert.equal((await request(user,'POST',`${base}/messages`,{clientId:randomUUID(),body:'Not permitted',parentId:original.id})).statusCode,403);
  assert.equal((await request('bob','PATCH',`${base}/messages/${original.id}`,{body:'Not permitted edit'})).statusCode,403);assert.equal((await request('bob','GET',`${base}/messages`)).json().messages[0].body,body.body);assert.equal((await request('bob','GET',`${base}/draft`)).json().body,'Preserved draft');
  const replay=await request('bob','POST',`${base}/messages`,body);assert.equal(replay.statusCode,201,replay.body);assert.equal(replay.json().id,original.id);assert.equal((await request('bob','POST',`${base}/messages`,{...body,body:'Different replay'})).statusCode,409);
  assert.equal((await request('bob','POST',`${base}/messages/${original.id}/reactions`,{emoji:'👍',active:true})).statusCode,200);assert.equal((await request('alice','POST',`${base}/messages`,{clientId:randomUUID(),body:'Owner permitted'})).statusCode,201);
  await pool.query("UPDATE memberships SET role='admin' WHERE org_id=$1 AND user_id=$2",[org,ids.bob]);assert.equal((await request('bob','PATCH',`${base}/messages/${original.id}`,{body:'Admin edit'})).statusCode,200);await pool.query("UPDATE memberships SET role='member' WHERE org_id=$1 AND user_id=$2",[org,ids.bob]);assert.equal((await request('bob','PATCH',`${base}/messages/${original.id}`,{body:'Role revoked'})).statusCode,403);assert.equal((await request('bob','DELETE',`${base}/messages/${original.id}`)).statusCode,200);
  assert.equal((await request('alice','PATCH',policy,{revision:2,restricted:false})).statusCode,200);assert.equal((await request('bob','POST',`${base}/messages`,{clientId:randomUUID(),body:'Member restored'})).statusCode,201);
  const race=await Promise.all([request('alice','PATCH',policy,{revision:3,restricted:true}),request('alice','PATCH',policy,{revision:3,restricted:true})]);assert.deepEqual(race.map(r=>r.statusCode).sort(),[200,409]);
  assert.equal((await pool.query("SELECT count(*) FROM audit WHERE org_id=$1 AND action='channel.posting_policy_changed'",[org])).rows[0].count,'3');assert.equal((await pool.query("SELECT count(*) FROM outbox WHERE channel_id=$1 AND type='channel.updated'",[id])).rows[0].count,'3');
  const direct=(await request('alice','POST',`/v1/organizations/${org}/channels`,{name:'Private chat',kind:'direct',teamId:null,members:[ids.bob]})).json();assert.equal((await request('alice','PATCH',`/v1/channels/${direct.id}/posting-policy`,{revision:1,restricted:true})).statusCode,400);
  await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[id,ids.alice]);assert.equal((await request('alice','PATCH',policy,{revision:4,restricted:false})).statusCode,404);
});

test('message reports preserve privacy, bound abuse and serialize audited moderation',async()=>{
  const org=randomUUID(),team=randomUUID(),id=randomUUID();await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Report checks')",[org]);await pool.query("INSERT INTO memberships VALUES($1,$2,'owner',true),($1,$3,'member',true)",[org,ids.alice,ids.bob]);await pool.query("INSERT INTO teams(id,org_id,name) VALUES($1,$2,'Report team')",[team,org]);await pool.query("INSERT INTO channels(id,org_id,team_id,name,kind,posting_restricted) VALUES($1,$2,$3,'Report private','private',true)",[id,org,team]);await pool.query('INSERT INTO channel_members VALUES($1,$2,$3),($1,$2,$4)',[org,id,ids.alice,ids.bob]);
  const base=`/v1/channels/${id}`,queue=`/v1/organizations/${org}/message-reports`,messages:string[]=[],reports:string[]=[];
  for(let i=0;i<11;i++){const sent=await request('alice','POST',`${base}/messages`,{clientId:randomUUID(),body:`Current message ${i}`});assert.equal(sent.statusCode,201,sent.body);messages.push(sent.json().id);}
  const path=`${base}/messages/${messages[0]}/report`,payload={reason:'harassment',details:'Private report context'};assert.deepEqual((await request('bob','GET',path)).json(),{report:null});assert.equal((await request('eve','POST',path,payload)).statusCode,404);assert.equal((await request('bob','GET',queue)).statusCode,403);
  assert.equal((await request('bob','POST',path,{reason:'invalid'})).statusCode,400);assert.equal((await request('bob','POST',path,{reason:'other',details:'x'.repeat(1001)})).statusCode,400);
  const made=await request('bob','POST',path,payload);assert.equal(made.statusCode,200,made.body);reports.push(made.json().report.id);assert.equal((await request('bob','POST',path,payload)).json().report.id,reports[0]);assert.equal((await request('bob','POST',path,{...payload,details:'Changed'})).statusCode,409);assert.equal((await request('alice','GET',path)).json().report,null);
  await pool.query("INSERT INTO memberships VALUES($1,$2,'admin',true)",[org,ids.eve]);assert.deepEqual((await request('eve','GET',queue)).json().items,[]);assert.equal((await request('eve','POST',`${queue}/${reports[0]}/resolve`,{revision:1,action:'remove'})).statusCode,404);await pool.query('INSERT INTO channel_members VALUES($1,$2,$3)',[org,id,ids.eve]);
  await request('alice','PATCH',`${base}/messages/${messages[0]}`,{body:'Edited since report'});assert.equal((await request('alice','GET',queue)).json().items[0].message_body,'Edited since report');
  for(let i=1;i<10;i++){const r=await request('bob','POST',`${base}/messages/${messages[i]}/report`,{reason:'spam'});assert.equal(r.statusCode,200,r.body);reports.push(r.json().report.id);}
  assert.equal((await request('bob','POST',`${base}/messages/${messages[10]}/report`,{reason:'spam'})).statusCode,429);assert.equal((await request('bob','POST',path,payload)).json().report.id,reports[0]);
  await pool.query("UPDATE message_reports SET created_at=date_trunc('second',now())+interval '0.123456 seconds' WHERE channel_id=$1",[id]);let cursor:{createdAt:string;id:string}|null=null;const seen:string[]=[];
  do{const query=new URLSearchParams({limit:'3'});if(cursor){query.set('beforeCreated',cursor.createdAt);query.set('beforeId',cursor.id);}const page=await request('alice','GET',`${queue}?${query}`);assert.equal(page.statusCode,200,page.body);const data=page.json();seen.push(...data.items.map((r:{id:string})=>r.id));cursor=data.nextCursor;if(cursor)assert.match(cursor.createdAt,/\.123456Z$/);}while(cursor);assert.deepEqual(seen.sort(),reports.toSorted());assert.equal((await request('alice','GET',`${queue}?beforeId=${reports[0]}`)).statusCode,400);
  const other=randomUUID();await pool.query("INSERT INTO channels(id,org_id,team_id,name,kind) VALUES($1,$2,$3,'Other report channel','private')",[other,org,team]);await pool.query('INSERT INTO channel_members VALUES($1,$2,$3)',[org,other,ids.bob]);assert.equal((await request('bob','POST',`/v1/channels/${other}/messages/${messages[0]}/report`,payload)).statusCode,404);
  await pool.query('INSERT INTO message_mentions(message_id,user_id) VALUES($1,$2)',[messages[0],ids.bob]);const decisions=await Promise.all([request('alice','POST',`${queue}/${reports[0]}/resolve`,{revision:1,action:'remove',note:'Owner decision'}),request('eve','POST',`${queue}/${reports[0]}/resolve`,{revision:1,action:'remove',note:'Admin decision'})]);assert.deepEqual(decisions.map(r=>r.statusCode).sort(),[200,409]);const winner=decisions[0].statusCode===200?'alice':'eve',note=winner==='alice'?'Owner decision':'Admin decision';assert.equal((await request(winner,'POST',`${queue}/${reports[0]}/resolve`,{revision:1,action:'remove',note})).statusCode,200);assert.equal((await request(winner,'POST',`${queue}/${reports[0]}/resolve`,{revision:2,action:'dismiss'})).statusCode,409);
  assert.equal((await request('bob','GET',path)).json().report.status,'removed');assert.ok(!('resolution_note' in (await request('bob','GET',path)).json().report));assert.equal((await request('bob','POST',path,payload)).json().report.status,'removed');assert.equal((await request('alice','POST',path,payload)).statusCode,404);assert.equal((await pool.query('SELECT body,deleted FROM messages WHERE id=$1',[messages[0]])).rows[0].body,'');assert.equal((await pool.query('SELECT count(*) FROM message_mentions WHERE message_id=$1',[messages[0]])).rows[0].count,'0');assert.equal((await pool.query("SELECT count(*) FROM outbox WHERE channel_id=$1 AND type='message.deleted'",[id])).rows[0].count,'1');
  assert.equal((await request('alice','POST',`${queue}/${reports[1]}/resolve`,{revision:1,action:'dismiss',note:'No action'})).statusCode,200);assert.equal((await pool.query('SELECT deleted FROM messages WHERE id=$1',[messages[1]])).rows[0].deleted,false);assert.equal((await request('alice','GET',`${queue}?status=dismissed`)).json().items.length,1);
  const auditRows=(await pool.query("SELECT metadata FROM audit WHERE org_id=$1 AND action IN ('message.reported','message.report_resolved')",[org])).rows;assert.equal(auditRows.length,12);assert.ok(!JSON.stringify(auditRows).includes('Private report context'));assert.ok(!JSON.stringify(auditRows).includes(note));
  await pool.query("UPDATE memberships SET role='member' WHERE org_id=$1 AND user_id=$2",[org,ids.eve]);assert.equal((await request('eve','GET',queue)).statusCode,403);await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[id,ids.alice]);assert.deepEqual((await request('alice','GET',queue)).json().items,[]);assert.equal((await request('alice','POST',`${queue}/${reports[2]}/resolve`,{revision:1,action:'dismiss'})).statusCode,404);await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[id,ids.bob]);assert.equal((await request('bob','GET',path)).statusCode,404);assert.equal((await request('bob','POST',path,payload)).statusCode,404);
  const direct=(await request('alice','POST',`/v1/organizations/${org}/channels`,{name:'Unconfigured report scope',kind:'direct',teamId:null,members:[ids.bob]})).json();const dm=(await request('alice','POST',`/v1/channels/${direct.id}/messages`,{clientId:randomUUID(),body:'Direct scope'})).json();assert.equal((await request('bob','POST',`/v1/channels/${direct.id}/messages/${dm.id}/report`,{reason:'other'})).statusCode,400);
});

test('audit search is tenant authorized, exact, time bounded and bigint safe',async()=>{
  const org=randomUUID(),target=`Literal_%' ${randomUUID()}`,base=`/v1/organizations/${org}/audit`,large=BigInt('9007199254741000')+BigInt('0x'+randomUUID().replaceAll('-','').slice(0,10))*BigInt(1000),eventIds=Array.from({length:7},(_,i)=>(large+BigInt(i)).toString());
  await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Audit search fixture')",[org]);await pool.query("INSERT INTO memberships VALUES($1,$2,'owner',true),($1,$3,'member',true)",[org,ids.alice,ids.bob]);
  try{
    const specs=[['audit.fixture',ids.alice,target,'2030-01-01T00:00:00.000000Z'],['audit.fixture',ids.bob,target,'2030-01-01T00:00:00.000001Z'],['audit.fixture',ids.alice,'Other target','2030-01-01T00:00:01Z'],['audit.other',null,target,'2030-01-01T00:00:02Z'],['audit.fixture_extra',ids.alice,target,'2030-01-01T00:00:00.500000Z']];
    for(let i=0;i<specs.length;i++){const [action,actor,t,at]=specs[i];await pool.query('INSERT INTO audit(id,org_id,actor_id,action,target,created_at,metadata) VALUES($1,$2,$3,$4,$5,$6,$7)',[eventIds[i],org,actor,action,t,at,JSON.stringify({fixture:org})]);}
    for(let i=5;i<7;i++)await pool.query("INSERT INTO audit(id,org_id,actor_id,action,target,metadata) VALUES($1,$2,$3,'audit.fixture',$4,$5)",[eventIds[i],i===5?ids.other:null,ids.alice,target,JSON.stringify({fixture:org})]);
    const get=async(query:Record<string,string>={},user='alice')=>request(user,'GET',`${base}?${new URLSearchParams(query)}`);assert.equal((await get({},'bob')).statusCode,403);assert.equal((await get({},'eve')).statusCode,404);const all=(await get()).json();assert.equal(all.items.length,5);assert.equal(all.nextCursor,null);assert.deepEqual(all.items.map((r:{id:string})=>r.id),eventIds.slice(0,5).toReversed());assert.ok(all.items.every((r:{org_id:string;id:unknown})=>r.org_id===org&&typeof r.id==='string'));
    assert.equal((await get({action:'audit.fixture'})).json().items.length,3);assert.equal((await get({actor:ids.alice})).json().items.length,3);assert.equal((await get({actor:ids.eve})).json().items.length,0);assert.equal((await get({target})).json().items.length,4);assert.equal((await get({target:'Literal_%'})).json().items.length,0);
    const scoped=(await get({action:'audit.fixture',actor:ids.alice,target,from:'2030-01-01T00:00:00Z',to:'2030-01-01T00:00:01Z'})).json();assert.deepEqual(scoped.items.map((r:{id:string})=>r.id),[eventIds[0]]);assert.deepEqual((await get({from:'2030-01-01T00:00:00.000000Z',to:'2030-01-01T00:00:00.000001Z'})).json().items.map((r:{id:string})=>r.id),[eventIds[0]]);
    let beforeId:string|undefined;const seen:string[]=[];do{const r=await get({limit:'2',...(beforeId?{beforeId}:{})});assert.equal(r.statusCode,200,r.body);const page=r.json();seen.push(...page.items.map((e:{id:string})=>e.id));beforeId=page.nextCursor??undefined;if(beforeId)assert.ok(BigInt(beforeId)>BigInt(Number.MAX_SAFE_INTEGER));}while(beforeId);assert.deepEqual(seen,eventIds.slice(0,5).toReversed());assert.equal(new Set(seen).size,5);
    for(const value of ['0','01','-1','1.5','1e3','not-a-number','9223372036854775808'])assert.equal((await get({beforeId:value})).statusCode,400);
    for(const q of [{limit:'0'},{limit:'101'},{limit:'x'},{actor:'bad'},{action:'%wildcard%'},{from:'2030-01-01T00:00:00Z'},{from:'2030-01-02T00:00:00Z',to:'2030-01-01T00:00:00Z'},{from:'2030-01-01T00:00:00Z',to:'2031-01-03T00:00:00Z'},{admin:'true'}] as Record<string,string>[])assert.equal((await get(q)).statusCode,400);
    assert.equal((await get({beforeId:'9223372036854775807',from:'2030-01-01T00:00:00Z',to:'2031-01-02T00:00:00Z'})).statusCode,200);
    await pool.query("UPDATE memberships SET role='admin' WHERE org_id=$1 AND user_id=$2",[org,ids.bob]);assert.equal((await get({},'bob')).statusCode,200);await pool.query('UPDATE memberships SET active=false WHERE org_id=$1 AND user_id=$2',[org,ids.bob]);assert.equal((await get({beforeId:eventIds[4]},'bob')).statusCode,404);assert.equal((await get({actor:ids.bob})).json().items.length,1);await pool.query("UPDATE memberships SET role='member' WHERE org_id=$1 AND user_id=$2",[org,ids.alice]);assert.equal((await get({beforeId:eventIds[4]})).statusCode,403);
  }finally{await pool.query("DELETE FROM audit WHERE metadata->>'fixture'=$1",[org]);await pool.query('UPDATE memberships SET active=false WHERE org_id=$1',[org]);}
});

test('audit export is scoped, lossless, bounded and audited with serialized generation quotas',async()=>{
  const org=randomUUID(),base=`/v1/organizations/${org}/audit/export`,target=`Export_%' ${randomUUID()}`,id=(BigInt('9007199254741000')+BigInt('0x'+randomUUID().replaceAll('-','').slice(0,10))*BigInt(1000)).toString(),action='audit.export_fixture';
  await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Audit export fixture')",[org]);await pool.query("INSERT INTO memberships VALUES($1,$2,'owner',true),($1,$3,'member',true)",[org,ids.alice,ids.bob]);
  try{
    await pool.query('INSERT INTO audit(id,org_id,actor_id,action,target,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)',[id,org,ids.alice,action,target,'{"large":9007199254740993,"text":"<script>literal</script>"}','2030-01-01T00:00:00.123456Z']);
    for(const tenant of [ids.other,null])await pool.query('INSERT INTO audit(org_id,actor_id,action,target,metadata) VALUES($1,$2,$3,$4,$5)',[tenant,ids.alice,action,target,JSON.stringify({fixture:org})]);
    const get=async(q:Record<string,string>={},user='alice')=>request(user,'GET',`${base}?${new URLSearchParams(q)}`),filters={action,actor:ids.alice,target,from:'2030-01-01T00:00:00Z',to:'2030-01-02T00:00:00Z'},generated=async()=>Number((await pool.query("SELECT count(*) FROM audit WHERE org_id=$1 AND action='audit.export_generated'",[org])).rows[0].count);
    assert.equal((await get(filters,'bob')).statusCode,403);assert.equal((await get(filters,'eve')).statusCode,404);assert.equal(await generated(),0);
    const response=await get(filters);assert.equal(response.statusCode,200,response.body);const document=response.json();assert.equal(document.format,'concord.audit.v1');assert.equal(document.organizationId,org);assert.equal(document.count,1);assert.equal(document.items[0].id,id);assert.equal(document.items[0].created_at,'2030-01-01T00:00:00.123456Z');assert.match(response.body,/"large"\s*:\s*9007199254740993/);assert.match(response.headers['content-disposition'] as string,/^attachment; filename="audit-[a-f0-9-]+\.json"$/);assert.match(response.headers['cache-control'] as string,/no-store/);assert.equal(response.headers['x-content-type-options'],'nosniff');assert.ok(String(response.headers['access-control-expose-headers']).includes('X-Export-SHA256'));
    const {createHash}=await import('node:crypto');const digest=createHash('sha256').update(response.rawPayload).digest('hex');assert.equal(response.headers['x-export-sha256'],digest);const record=(await pool.query("SELECT metadata FROM audit WHERE org_id=$1 AND action='audit.export_generated' AND target=$2",[org,document.exportId])).rows[0];assert.deepEqual(record.metadata,{count:1,bytes:response.rawPayload.length,sha256:digest});assert.ok(!JSON.stringify(record.metadata).includes(target));
    const second=await get(filters);assert.equal(second.statusCode,200);assert.notEqual(second.json().exportId,document.exportId);assert.deepEqual(second.json().items,document.items);assert.equal((await get({action,target,from:'2030-01-01T00:00:00.123456Z',to:'2030-01-01T00:00:00.123457Z'})).json().count,1);assert.equal((await get({action:'no.audit.events'})).json().count,0);assert.equal(await generated(),4);
    const race=await Promise.all([get(filters),get(filters)]);assert.deepEqual(race.map(r=>r.statusCode).sort(),[200,429]);assert.equal(race.find(r=>r.statusCode===429)?.headers['retry-after'],'60');assert.equal(await generated(),5);
    await pool.query("UPDATE audit SET created_at=now()-interval '61 seconds' WHERE org_id=$1 AND action='audit.export_generated'",[org]);const prior=await get({action:'audit.export_generated',target:document.exportId});assert.equal(prior.statusCode,200);assert.equal(prior.json().count,1);assert.ok(prior.json().items.every((r:{target:string})=>r.target!==prior.json().exportId));
    for(const q of [{limit:'1'},{beforeId:id},{actor:'bad'},{from:'2030-01-01T00:00:00Z'},{from:'2030-01-02T00:00:00Z',to:'2030-01-01T00:00:00Z'}] as Record<string,string>[])assert.equal((await get(q)).statusCode,400);
    await pool.query("INSERT INTO audit(org_id,actor_id,action,target) SELECT $1,$2,'audit.bulk_export',i::text FROM generate_series(1,1000) i",[org,ids.alice]);const boundary=await get({action:'audit.bulk_export'});assert.equal(boundary.statusCode,200,boundary.body);assert.equal(boundary.json().count,1000);assert.ok(boundary.json().items.every((r:{id:unknown;org_id:string})=>typeof r.id==='string'&&r.org_id===org));
    const beforeRejected=await generated();await pool.query("INSERT INTO audit(org_id,action,target) VALUES($1,'audit.bulk_export','1001')",[org]);const tooMany=await get({action:'audit.bulk_export'});assert.equal(tooMany.statusCode,413);assert.equal(tooMany.headers['content-disposition'],undefined);
    await pool.query("INSERT INTO audit(org_id,action,target,metadata) VALUES($1,'audit.huge_export','oversize',$2)",[org,JSON.stringify({text:'x'.repeat(2*1024*1024)})]);const tooLarge=await get({action:'audit.huge_export'});assert.equal(tooLarge.statusCode,413);assert.equal(tooLarge.headers['content-disposition'],undefined);assert.equal(await generated(),beforeRejected);
    await pool.query("UPDATE memberships SET role='admin' WHERE org_id=$1 AND user_id=$2",[org,ids.bob]);assert.equal((await get(filters,'bob')).statusCode,200);await pool.query("UPDATE memberships SET role='member' WHERE org_id=$1 AND user_id=$2",[org,ids.bob]);assert.equal((await get(filters,'bob')).statusCode,403);await pool.query('UPDATE memberships SET active=false WHERE org_id=$1 AND user_id=$2',[org,ids.alice]);assert.equal((await get(filters)).statusCode,404);
  }finally{await pool.query("DELETE FROM audit WHERE org_id=$1 OR metadata->>'fixture'=$2",[org,org]);await pool.query('UPDATE memberships SET active=false WHERE org_id=$1',[org]);}
});

test('administrative usage reports preserve exact aggregates, UTC boundaries and current resource authorization',async()=>{
  const org=randomUUID(),other=randomUUID(),team=randomUUID(),visible=randomUUID(),hidden=randomUUID(),standard=randomUUID(),direct=randomUUID(),foreign=randomUUID();
  const path=`/v1/organizations/${org}/usage?from=2026-10-01&to=2026-10-04`,alice=ids.alice,bob=ids.bob;
  try{
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Usage verification'),($2,'Usage foreign verification')",[org,other]);
    await pool.query("INSERT INTO memberships(org_id,user_id,role) VALUES($1,$3,'owner'),($1,$4,'member'),($2,$3,'owner')",[org,other,alice,bob]);
    await pool.query("INSERT INTO teams(id,org_id,name) VALUES($1,$2,'Usage team')",[team,org]);
    await pool.query("INSERT INTO team_members(org_id,team_id,user_id) VALUES($1,$2,$3)",[org,team,alice]);
    await pool.query("INSERT INTO channels(id,org_id,team_id,name,kind,archived) VALUES($1,$6,$7,'Visible','private',true),($2,$6,$7,'Hidden','private',false),($3,$6,$7,'Standard','standard',false),($4,$6,NULL,'Direct','direct',false),($5,$8,NULL,'Foreign','group',false)",[visible,hidden,standard,direct,foreign,org,team,other]);
    await pool.query('INSERT INTO channel_members(org_id,channel_id,user_id) VALUES($1,$2,$6),($1,$3,$7),($1,$4,$6),($5,$8,$6)',[org,visible,hidden,direct,other,alice,bob,foreign]);
    const message=async(channel:string,tenant:string,author:string,seq:number,date:string,deleted=false)=>{
      await pool.query('INSERT INTO messages(id,org_id,channel_id,user_id,client_id,seq,body,created_at,deleted) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[randomUUID(),tenant,channel,author,randomUUID(),seq,'Synthetic usage content must never be exposed',date,deleted]);
    };
    await message(visible,org,alice,1,'2026-10-01T00:00:00Z');
    await message(visible,org,bob,2,'2026-10-01T23:59:59.999999Z');
    await message(standard,org,alice,1,'2026-10-02T00:00:00Z');
    await message(direct,org,alice,1,'2026-10-02T12:00:00Z');
    await message(visible,org,alice,3,'2026-10-04T00:00:00Z'); // exclusive
    await message(visible,org,bob,4,'2026-09-30T23:59:59.999999Z');
    await message(visible,org,bob,5,'2026-10-01T12:00:00Z',true);
    await message(hidden,org,bob,1,'2026-10-01T12:00:00Z');
    await message(foreign,other,alice,1,'2026-10-01T12:00:00Z');
    const file=async(channel:string,tenant:string,bytes:string,state:string,root:string|null=null)=>{
      const id=randomUUID();await pool.query('INSERT INTO files(id,org_id,channel_id,name,mime,bytes,storage_key,sha256,state,created_by,created_at,revision_root,revision_number) VALUES($1::uuid,$2,$3,$4,$5,$6,($1::uuid)::text,$7,$8,$9,$10,$11,$12)',[id,tenant,channel,'Synthetic metadata only','text/plain',bytes,'0'.repeat(64),state,alice,'2020-01-01T00:00:00Z',root,root?2:1]);return id;
    };
    const root=await file(visible,org,'9007199254740993','ready');
    await file(visible,org,'7','quarantined',root);await file(standard,org,'11','blocked');await file(direct,org,'13','ready');
    await file(visible,org,'1000','deleted');await file(hidden,org,'1000','ready');await file(foreign,other,'1000','ready');
    const meeting=async(tenant:string,organizer:string,starts:string,ends:string,cancelled=false,attendee=false)=>{
      const id=randomUUID();await pool.query('INSERT INTO meetings(id,org_id,title,starts_at,ends_at,timezone,organizer_id,cancelled) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,tenant,'Synthetic private title',starts,ends,'UTC',organizer,cancelled]);if(attendee)await pool.query("INSERT INTO meeting_attendees(meeting_id,user_id,response) VALUES($1,$2,'declined')",[id,alice]);return id;
    };
    await meeting(org,alice,'2026-10-01T00:00:00Z','2026-10-01T00:01:00.123456Z');
    await meeting(org,bob,'2026-10-02T12:00:00Z','2026-10-02T13:00:00Z',false,true);
    await meeting(org,alice,'2026-10-03T23:59:59Z','2026-10-04T00:00:59Z'); // full duration
    await meeting(org,bob,'2026-10-01T12:00:00Z','2026-10-01T13:00:00Z'); // inaccessible
    await meeting(org,alice,'2026-10-01T12:00:00Z','2026-10-01T13:00:00Z',true);
    await meeting(org,alice,'2026-10-04T00:00:00Z','2026-10-04T01:00:00Z');
    await meeting(org,alice,'2026-09-30T23:59:00Z','2026-10-01T00:01:00Z'); // starts before range
    await meeting(other,alice,'2026-10-01T12:00:00Z','2026-10-01T13:00:00Z');
    assert.equal((await request('bob','GET',path)).statusCode,403);
    assert.equal((await request('eve','GET',path)).statusCode,404);
    const r=await request('alice','GET',path);assert.equal(r.statusCode,200,r.body);assert.equal(r.headers['cache-control'],'no-store');
    const report=r.json();assert.equal(report.organizationId,org);assert.equal(report.scope,'caller-authorized-resources');assert.deepEqual(report.range,{from:'2026-10-01',to:'2026-10-04'});
    assert.deepEqual(report.totals,{channels:'3',archivedChannels:'1',messagesCreated:'4',activeAuthors:'2',registeredFileVersions:'4',registeredFileBytes:'9007199254741024',scheduledMeetings:'3',scheduledSeconds:'3720.123456'});
    assert.deepEqual(report.daily,[
      {date:'2026-10-01',messagesCreated:'2',activeAuthors:'2',scheduledMeetings:'1',scheduledSeconds:'60.123456'},
      {date:'2026-10-02',messagesCreated:'2',activeAuthors:'1',scheduledMeetings:'1',scheduledSeconds:'3600.000000'},
      {date:'2026-10-03',messagesCreated:'0',activeAuthors:'0',scheduledMeetings:'1',scheduledSeconds:'60.000000'},
    ]);
    assert.ok(!r.body.includes('Synthetic'));assert.ok(!r.body.includes(hidden));assert.ok(!r.body.includes(bob));
    const auditRows=(await pool.query("SELECT metadata,target FROM audit WHERE org_id=$1 AND action='usage.report_viewed'",[org])).rows;assert.deepEqual(auditRows,[{metadata:{from:'2026-10-01',to:'2026-10-04'},target:org}]);
    for(const query of ['', 'from=2026-10-01','from=2026-02-30&to=2026-03-02','from=2026-10-02&to=2026-10-01','from=2026-10-01&to=2026-10-01','from=2026-10-01&to=2026-11-02','from=2026-10-01T00:00:00Z&to=2026-10-04','from=2026-10-01&to=2026-10-04&user='+bob])assert.equal((await request('alice','GET',`/v1/organizations/${org}/usage?${query}`)).statusCode,400,query);
    assert.equal((await pool.query("SELECT count(*) FROM audit WHERE org_id=$1 AND action='usage.report_viewed'",[org])).rows[0].count,'1');
    const empty=(await request('alice','GET',`/v1/organizations/${org}/usage?from=2030-01-01&to=2030-02-01`)).json();assert.equal(empty.daily.length,31);assert.ok(empty.daily.every((d:{messagesCreated:string;scheduledMeetings:string})=>d.messagesCreated==='0'&&d.scheduledMeetings==='0'));assert.equal(empty.totals.registeredFileBytes,'9007199254741024');
    // Historical author remains counted, but revoking channel/team access removes the resource aggregates.
    await pool.query('UPDATE memberships SET active=false WHERE org_id=$1 AND user_id=$2',[org,bob]);
    await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[visible,alice]);await pool.query('DELETE FROM team_members WHERE team_id=$1 AND user_id=$2',[team,alice]);
    const reduced=(await request('alice','GET',path)).json();assert.equal(reduced.totals.channels,'1');assert.equal(reduced.totals.messagesCreated,'1');assert.equal(reduced.totals.registeredFileBytes,'13');
    await pool.query("UPDATE memberships SET role='admin' WHERE org_id=$1 AND user_id=$2",[org,bob]);await pool.query('UPDATE memberships SET active=true WHERE org_id=$1 AND user_id=$2',[org,bob]);
    assert.equal((await request('bob','GET',path)).statusCode,200);
    await pool.query("UPDATE memberships SET role='member' WHERE org_id=$1 AND user_id=$2",[org,alice]);assert.equal((await request('alice','GET',path)).statusCode,403);
    await pool.query('UPDATE memberships SET active=false WHERE org_id=$1 AND user_id=$2',[org,alice]);assert.equal((await request('alice','GET',path)).statusCode,404);
    const {usageReport:contract}=await import('../lib/usage-contract.ts');assert.equal(contract.safeParse({...report,daily:report.daily.slice(1)}).success,false);assert.equal(contract.safeParse({...report,totals:{...report.totals,registeredFileBytes:9007199254741024}}).success,false);
  }finally{
    await pool.query('DELETE FROM meeting_attendees WHERE meeting_id IN(SELECT id FROM meetings WHERE org_id=ANY($1::uuid[]))',[[org,other]]);await pool.query('DELETE FROM meetings WHERE org_id=ANY($1::uuid[])',[[org,other]]);
    await pool.query('DELETE FROM files WHERE org_id=ANY($1::uuid[]) AND revision_root IS NOT NULL',[[org,other]]);await pool.query('DELETE FROM files WHERE org_id=ANY($1::uuid[])',[[org,other]]);
    await pool.query('DELETE FROM messages WHERE org_id=ANY($1::uuid[])',[[org,other]]);await pool.query('DELETE FROM channel_members WHERE org_id=ANY($1::uuid[])',[[org,other]]);await pool.query('DELETE FROM channels WHERE org_id=ANY($1::uuid[])',[[org,other]]);
    await pool.query('DELETE FROM team_members WHERE org_id=ANY($1::uuid[])',[[org,other]]);await pool.query('DELETE FROM teams WHERE org_id=ANY($1::uuid[])',[[org,other]]);await pool.query('DELETE FROM audit WHERE org_id=ANY($1::uuid[])',[[org,other]]);await pool.query('DELETE FROM memberships WHERE org_id=ANY($1::uuid[])',[[org,other]]);await pool.query('DELETE FROM organizations WHERE id=ANY($1::uuid[])',[[org,other]]);
  }
});

test('group participants, concurrent renames and departure enforce current access without deleting shared history',async()=>{
  const create=await request('alice','POST',`/v1/organizations/${ids.org}/channels`,{name:'Lifecycle group',kind:'group',teamId:null,members:[ids.bob,ids.guest]});assert.equal(create.statusCode,200,create.body);
  const id=create.json().id,base=`/v1/channels/${id}`;
  const current=async()=>Number((await pool.query('SELECT revision FROM channels WHERE id=$1',[id])).rows[0].revision);
  try{
    const read=await request('bob','GET',`${base}/chat`);assert.equal(read.statusCode,200);assert.deepEqual(read.json().participants.map((p:{id:string})=>p.id).sort(),[ids.alice,ids.bob,ids.guest].sort());
    assert.equal((await request('eve','GET',`${base}/chat`)).statusCode,404);
    assert.equal((await request('alice','GET',`/v1/channels/${ids.channel}/chat`)).statusCode,404);
    assert.equal((await request('alice','PATCH',`/v1/channels/${ids.channel}/group-name`,{name:'Denied',revision:1})).statusCode,400);
    assert.equal((await request('alice','POST',`/v1/channels/${ids.channel}/leave-group`,{})).statusCode,400);
    const revision=await current();
    for(const body of [{name:'',revision},{name:'x',revision,extra:true},{name:'x'}, {name:'x',revision:0}])assert.equal((await request('bob','PATCH',`${base}/group-name`,body)).statusCode,400);
    assert.equal((await request('alice','PATCH',`${base}/details`,{name:'Bypass',description:'',archived:false})).statusCode,409);
    assert.equal((await request('guest','PATCH',`${base}/group-name`,{name:'Lifecycle group',revision})).statusCode,200);assert.equal(await current(),revision);
    const renamed=await Promise.all([request('alice','PATCH',`${base}/group-name`,{name:'First',revision}),request('bob','PATCH',`${base}/group-name`,{name:'Second',revision})]);assert.deepEqual(renamed.map(r=>r.statusCode).sort(),[200,409]);
    const sent=await request('bob','POST',`${base}/messages`,{clientId:randomUUID(),body:'Retained after departure'});assert.equal(sent.statusCode,201);
    await pool.query("INSERT INTO drafts(channel_id,user_id,body) VALUES($1,$2,'Personal draft')",[id,ids.bob]);
    await pool.query('INSERT INTO channel_preferences(channel_id,user_id,pinned) VALUES($1,$2,true)',[id,ids.bob]);
    assert.equal((await request('bob','POST',`${base}/leave-group`,{userId:ids.alice})).statusCode,400);
    const left=await Promise.all([request('bob','POST',`${base}/leave-group`,{}),request('bob','POST',`${base}/leave-group`,{})]);assert.deepEqual(left.map(r=>r.statusCode).sort(),[200,404]);
    for(const suffix of ['chat','members','messages','files','receipts','draft'])assert.equal((await request('bob','GET',`${base}/${suffix}`)).statusCode,404,suffix);
    assert.equal((await request('bob','POST',`${base}/messages`,{clientId:randomUUID(),body:'Denied'})).statusCode,404);
    assert.equal((await request('bob','PATCH',`${base}/group-name`,{name:'Denied',revision:await current()})).statusCode,404);
    assert.equal((await pool.query('SELECT 1 FROM drafts WHERE channel_id=$1 AND user_id=$2',[id,ids.bob])).rowCount,0);
    assert.equal((await pool.query('SELECT 1 FROM channel_preferences WHERE channel_id=$1 AND user_id=$2',[id,ids.bob])).rowCount,0);
    assert.equal((await request('alice','GET',`${base}/messages`)).json().messages[0].body,'Retained after departure');
    assert.equal((await request('alice','GET',`${base}/chat`)).json().participants.length,2);
    const audits=(await pool.query("SELECT action,metadata FROM audit WHERE target=$1 AND action IN('group.renamed','group.left') ORDER BY id",[id])).rows;assert.equal(audits.length,2);assert.deepEqual(audits[1],{action:'group.left',metadata:{}});assert.ok(!JSON.stringify(audits).includes('First'));assert.ok(!JSON.stringify(audits).includes('Personal'));
    assert.equal((await pool.query("SELECT 1 FROM outbox WHERE channel_id=$1 AND type='channel.updated'",[id])).rowCount,2);
    await pool.query('UPDATE memberships SET active=false WHERE org_id=$1 AND user_id=$2',[ids.org,ids.guest]);assert.equal((await request('alice','GET',`${base}/chat`)).json().participants.length,1);assert.equal((await request('guest','GET',`${base}/chat`)).statusCode,404);
    await pool.query('UPDATE memberships SET active=true WHERE org_id=$1 AND user_id=$2',[ids.org,ids.guest]);
    await pool.query('UPDATE channels SET archived=true WHERE id=$1',[id]);assert.equal((await request('alice','PATCH',`${base}/group-name`,{name:'Archived',revision:await current()})).statusCode,409);
    assert.equal((await request('guest','POST',`${base}/leave-group`,{})).statusCode,200);assert.equal((await request('alice','POST',`${base}/leave-group`,{})).statusCode,200);
    assert.equal((await pool.query('SELECT 1 FROM messages WHERE channel_id=$1',[id])).rowCount,1);
  }finally{
    await pool.query('UPDATE memberships SET active=true WHERE org_id=$1 AND user_id=$2',[ids.org,ids.guest]);
    await pool.query('DELETE FROM messages WHERE channel_id=$1',[id]);await pool.query('DELETE FROM channel_members WHERE channel_id=$1',[id]);await pool.query('DELETE FROM drafts WHERE channel_id=$1',[id]);await pool.query('DELETE FROM channel_preferences WHERE channel_id=$1',[id]);await pool.query('DELETE FROM outbox WHERE channel_id=$1',[id]);await pool.query('DELETE FROM audit WHERE target=$1',[id]);await pool.query('DELETE FROM channels WHERE id=$1',[id]);
  }
});

test('direct participant snapshots do not permit group lifecycle mutations',async()=>{
  const created=await request('alice','POST',`/v1/organizations/${ids.org}/channels`,{name:'Direct participant verification',kind:'direct',teamId:null,members:[ids.bob]});assert.equal(created.statusCode,200);const id=created.json().id,base=`/v1/channels/${id}`;
  try{
    const chat=await request('bob','GET',`${base}/chat`);assert.equal(chat.statusCode,200);assert.equal(chat.json().kind,'direct');assert.equal(chat.json().participants.length,2);
    assert.equal((await request('alice','PATCH',`${base}/group-name`,{name:'Not a group',revision:chat.json().revision})).statusCode,400);
    assert.equal((await request('bob','POST',`${base}/leave-group`,{})).statusCode,400);
    assert.equal((await request('guest','GET',`${base}/chat`)).statusCode,404);
    assert.equal((await pool.query('SELECT 1 FROM channel_members WHERE channel_id=$1',[id])).rowCount,2);
  }finally{await pool.query('DELETE FROM channel_members WHERE channel_id=$1',[id]);await pool.query('DELETE FROM audit WHERE target=$1',[id]);await pool.query('DELETE FROM channels WHERE id=$1',[id]);}
});

test('administrator group grants explicitly authorize retained history and serialize revocation and limits',async()=>{
  const org=randomUUID(),disabled=randomUUID(),inactive=randomUUID(),filler=Array.from({length:100},()=>randomUUID());let id='';
  const file=randomUUID(),{fileRoot}=await import('../services/core/file-content.ts'),{mkdir,writeFile,rm}=await import('node:fs/promises'),{createHash}=await import('node:crypto');
  const bytes=Buffer.from('Retained file before admission');

  const revision=async()=>Number((await pool.query('SELECT revision FROM channels WHERE id=$1',[id])).rows[0].revision);
  const change=async(actor:string,method:'PUT'|'DELETE',target:string,rev?:number)=>request(actor,method,`/v1/channels/${id}/group-members/${target}`,{revision:rev??await revision(),...(method==='PUT'?{history:'all-retained'}:{})});
  try{
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Group grant verification')",[org]);
    await pool.query("INSERT INTO memberships(org_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member'),($1,$4,'guest')",[org,ids.alice,ids.bob,ids.guest]);
    for(const user of [disabled,inactive,...filler]){await pool.query("INSERT INTO users(id,email,name,disabled) VALUES($1,$2,'Synthetic grant identity',$3)",[user,`${user}@grant.test`,user===disabled]);await pool.query("INSERT INTO memberships(org_id,user_id,role,active) VALUES($1,$2,'member',$3)",[org,user,user!==inactive]);}
    const made=await request('alice','POST',`/v1/organizations/${org}/channels`,{name:'Grant group',kind:'group',teamId:null,members:[ids.guest]});assert.equal(made.statusCode,200,made.body);id=made.json().id;
    const path=`/v1/channels/${id}`,url=`${path}/group-members/${ids.bob}`;
    // A test-only ready local file isolates authorization from the independently tested scanning pipeline.
    await mkdir(fileRoot(),{recursive:true});await writeFile(`${fileRoot()}/${file}`,bytes);
    await pool.query("INSERT INTO files(id,org_id,channel_id,name,mime,bytes,storage_key,sha256,state,created_by) VALUES($1,$2,$3,'history.txt','text/plain',$4,($1::uuid)::text,$5,'ready',$6)",[file,org,id,bytes.length,createHash('sha256').update(bytes).digest('hex'),ids.alice]);
    const download=`${path}/files/${file}/download`;assert.equal((await request('bob','GET',download)).statusCode,404);
    const sent=await request('alice','POST',`${path}/messages`,{clientId:randomUUID(),body:'History before explicit grant'});assert.equal(sent.statusCode,201);
    assert.equal((await request('alice','GET',`${path}/chat`)).json().can_manage,true);assert.equal((await request('guest','GET',`${path}/chat`)).json().can_manage,false);
    assert.equal((await request('bob','GET',`${path}/messages`)).statusCode,404);
    for(const b of [{revision:1},{revision:1,history:'future-only'},{revision:1,history:'all-retained',extra:true},{revision:0,history:'all-retained'}])assert.equal((await request('alice','PUT',url,b)).statusCode,400);
    assert.equal((await change('guest','PUT',ids.bob)).statusCode,403);assert.equal((await change('bob','PUT',ids.bob)).statusCode,404);assert.equal((await change('eve','PUT',ids.bob)).statusCode,404);
    // Workspace ownership alone is not a private group admission bypass.
    await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[id,ids.alice]);assert.equal((await change('alice','PUT',ids.alice)).statusCode,404);await pool.query('INSERT INTO channel_members VALUES($1,$2,$3)',[org,id,ids.alice]);
    for(const user of [ids.eve,disabled,inactive,randomUUID()])assert.equal((await change('alice','PUT',user)).statusCode,404);
    const initial=await revision(),race=await Promise.all([change('alice','PUT',ids.bob,initial),change('alice','PUT',ids.bob,initial)]);assert.deepEqual(race.map(r=>r.statusCode).sort(),[200,409]);
    assert.equal((await request('bob','GET',`${path}/messages`)).json().messages[0].body,'History before explicit grant');
    assert.equal((await request('bob','GET',download)).body,bytes.toString());
    assert.equal((await change('alice','PUT',ids.bob)).json().changed,false);assert.equal(await revision(),initial+1);
    assert.equal((await change('alice','DELETE',ids.alice.toUpperCase())).statusCode,400);
    await pool.query("INSERT INTO drafts(channel_id,user_id,body) VALUES($1,$2,'Removed private draft')",[id,ids.bob]);await pool.query('INSERT INTO channel_preferences(channel_id,user_id,pinned) VALUES($1,$2,true)',[id,ids.bob]);
    const rev=await revision(),removed=await Promise.all([change('alice','DELETE',ids.bob,rev),change('alice','DELETE',ids.bob,rev)]);assert.deepEqual(removed.map(r=>r.statusCode).sort(),[200,409]);
    assert.equal((await change('alice','DELETE',ids.bob)).json().changed,false);assert.equal((await request('bob','GET',download)).statusCode,404);
    for(const suffix of ['chat','messages','members','files','draft'])assert.equal((await request('bob','GET',`${path}/${suffix}`)).statusCode,404,suffix);
    assert.equal((await pool.query('SELECT 1 FROM drafts WHERE channel_id=$1 AND user_id=$2',[id,ids.bob])).rowCount,0);assert.equal((await pool.query('SELECT 1 FROM channel_preferences WHERE channel_id=$1 AND user_id=$2',[id,ids.bob])).rowCount,0);
    assert.equal((await change('alice','PUT',ids.bob)).statusCode,200);assert.equal((await request('bob','GET',`${path}/messages`)).json().messages.length,1);assert.equal((await request('bob','GET',`${path}/draft`)).json().body,'');
    const audits=(await pool.query("SELECT action,metadata FROM audit WHERE target=$1 AND action LIKE 'group.participant_%' ORDER BY id",[id])).rows;assert.deepEqual(audits.map(r=>r.action),['group.participant_added','group.participant_removed','group.participant_added']);assert.equal(audits[0].metadata.history,'all-retained');assert.equal(audits[0].metadata.userId,ids.bob);assert.ok(!JSON.stringify(audits).includes('private draft'));assert.equal((await pool.query("SELECT 1 FROM outbox WHERE channel_id=$1 AND type='channel.updated'",[id])).rowCount,3);
    // Current role is authoritative even while group membership remains.
    await pool.query("UPDATE memberships SET role='member' WHERE org_id=$1 AND user_id=$2",[org,ids.alice]);assert.equal((await change('alice','DELETE',ids.bob)).statusCode,403);assert.equal((await request('alice','GET',`${path}/chat`)).json().can_manage,false);await pool.query("UPDATE memberships SET role='owner' WHERE org_id=$1 AND user_id=$2",[org,ids.alice]);
    await pool.query('UPDATE channels SET archived=true WHERE id=$1',[id]);assert.equal((await change('alice','DELETE',ids.bob)).statusCode,409);assert.equal((await change('alice','PUT',filler[0])).statusCode,409);await pool.query('UPDATE channels SET archived=false WHERE id=$1',[id]);
    for(const user of filler.slice(0,97))await pool.query('INSERT INTO channel_members VALUES($1,$2,$3)',[org,id,user]);
    assert.equal((await change('alice','PUT',filler[97])).statusCode,409);assert.equal((await change('alice','DELETE',filler[0])).statusCode,200);assert.equal((await change('alice','PUT',filler[97])).statusCode,200);
    // A direct chat keeps its fixed participant boundary.
    await pool.query("UPDATE channels SET kind='direct' WHERE id=$1",[id]);assert.equal((await change('alice','PUT',filler[98])).statusCode,400);assert.equal((await change('alice','DELETE',ids.bob)).statusCode,400);
  }finally{
    await rm(`${fileRoot()}/${file}`,{force:true});
    if(id){await pool.query('DELETE FROM files WHERE channel_id=$1',[id]);await pool.query('DELETE FROM messages WHERE channel_id=$1',[id]);for(const table of ['drafts','channel_preferences','read_positions','channel_members','outbox'])await pool.query(`DELETE FROM ${table} WHERE channel_id=$1`,[id]);await pool.query('DELETE FROM channels WHERE id=$1',[id]);}
    await pool.query('DELETE FROM audit WHERE org_id=$1',[org]);await pool.query('DELETE FROM memberships WHERE org_id=$1',[org]);await pool.query('DELETE FROM organizations WHERE id=$1',[org]);await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[disabled,inactive,...filler]]);
  }
});

test('channel settings enforce current admin access, revisions, archive state and parent-team restoration',async()=>{
  const org=randomUUID(),team=randomUUID(),channels:string[]=[];
  const create=async(kind:string)=>{const r=await request('alice','POST',`/v1/organizations/${org}/channels`,{name:`Settings ${kind}`,description:'Initial',kind,teamId:team,members:[ids.bob]});assert.equal(r.statusCode,200,r.body);channels.push(r.json().id);return r.json().id as string;};
  try{
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Channel settings verification')",[org]);await pool.query("INSERT INTO memberships(org_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",[org,ids.alice,ids.bob]);await pool.query("INSERT INTO teams(id,org_id,name) VALUES($1,$2,'Settings team')",[team,org]);await pool.query("INSERT INTO team_members VALUES($1,$2,$3,'owner'),($1,$2,$4,'member')",[org,team,ids.alice,ids.bob]);
    for(const kind of ['standard','private','shared']){
      const id=await create(kind),base=`/v1/channels/${id}`,original=(await request('alice','GET',`${base}/settings`)).json();assert.equal(original.kind,kind);assert.equal(original.revision,1);assert.equal((await request('bob','GET',`${base}/settings`)).statusCode,403);assert.equal((await request('eve','GET',`${base}/settings`)).statusCode,404);
      const edit={name:'Updated settings',description:'Literal <script>not markup</script>',archived:false,revision:1};
      assert.equal((await request('bob','PATCH',`${base}/details`,edit)).statusCode,403);assert.equal((await request('eve','PATCH',`${base}/details`,edit)).statusCode,404);
      assert.equal((await request('alice','PATCH',`${base}/details`,{name:'Legacy',description:'',archived:false})).statusCode,409);
      for(const body of [{...edit,name:' '},{...edit,name:'x'.repeat(161)},{...edit,description:'x'.repeat(1001)},{...edit,revision:0},{...edit,extra:true}])assert.equal((await request('alice','PATCH',`${base}/details`,body)).statusCode,400);
      const noop=await request('alice','PATCH',`${base}/details`,{name:original.name,description:original.description,archived:original.archived,revision:1});assert.equal(noop.json().changed,false);assert.equal(noop.json().revision,1);
      const race=await Promise.all([request('alice','PATCH',`${base}/details`,edit),request('alice','PATCH',`${base}/details`,{...edit,name:'Concurrent'})]);assert.deepEqual(race.map(r=>r.statusCode).sort(),[200,409]);
      const fresh=(await request('alice','GET',`${base}/settings`)).json();assert.equal(fresh.revision,2);assert.equal(fresh.description,edit.description);
      await request('bob','PUT',`${base}/draft`,{body:'Retained archived draft'});
      const archived=await request('alice','PATCH',`${base}/details`,{...edit,name:fresh.name,archived:true,revision:2});assert.equal(archived.statusCode,200);assert.equal((await request('bob','POST',`${base}/messages`,{clientId:randomUUID(),body:'Archived denial'})).statusCode,409);assert.equal((await request('bob','GET',`${base}/draft`)).json().body,'Retained archived draft');assert.equal((await request('bob','GET',`${base}/messages`)).statusCode,200);
      const restore=await request('alice','PATCH',`${base}/details`,{...edit,name:fresh.name,revision:3});assert.equal(restore.statusCode,200);assert.equal((await request('bob','POST',`${base}/messages`,{clientId:randomUUID(),body:'After restoration'})).statusCode,201);
      const audits=(await pool.query("SELECT metadata FROM audit WHERE target=$1 AND action='channel.updated' ORDER BY id",[id])).rows;assert.equal(audits.length,3);assert.equal(audits[1].metadata.archived,true);assert.ok(!JSON.stringify(audits).includes('<script>'));assert.equal((await pool.query("SELECT 1 FROM outbox WHERE channel_id=$1 AND type='channel.updated'",[id])).rowCount,3);
      await pool.query("UPDATE memberships SET role='member' WHERE org_id=$1 AND user_id=$2",[org,ids.alice]);assert.equal((await request('alice','PATCH',`${base}/details`,{...edit,revision:4})).statusCode,403);await pool.query("UPDATE memberships SET role='owner' WHERE org_id=$1 AND user_id=$2",[org,ids.alice]);
    }
    const id=channels[1],base=`/v1/channels/${id}`;
    // Even workspace owners must retain private membership.
    await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[id,ids.alice]);assert.equal((await request('alice','GET',`${base}/settings`)).statusCode,404);await pool.query('INSERT INTO channel_members VALUES($1,$2,$3)',[org,id,ids.alice]);
    assert.equal((await request('alice','PATCH',`/v1/organizations/${org}/teams/${team}`,{name:'Archived team',archived:true})).statusCode,200);
    const current=(await request('alice','GET',`${base}/settings`)).json();assert.equal(current.archived,true);const restore={name:current.name,description:current.description,archived:false,revision:current.revision};assert.equal((await request('alice','PATCH',`${base}/details`,restore)).statusCode,409);
    await request('alice','PATCH',`/v1/organizations/${org}/teams/${team}`,{name:'Restored team',archived:false});assert.equal((await request('alice','PATCH',`${base}/details`,restore)).statusCode,409);
  }finally{
    for(const id of channels){for(const table of ['messages','drafts','channel_preferences','read_positions','channel_members','outbox'])await pool.query(`DELETE FROM ${table} WHERE channel_id=$1`,[id]);await pool.query('DELETE FROM channels WHERE id=$1',[id]);}
    await pool.query('DELETE FROM team_members WHERE team_id=$1',[team]);await pool.query('DELETE FROM teams WHERE id=$1',[team]);await pool.query('DELETE FROM audit WHERE org_id=$1',[org]);await pool.query('DELETE FROM memberships WHERE org_id=$1',[org]);await pool.query('DELETE FROM organizations WHERE id=$1',[org]);
  }
});

test('team ownership transfers atomically to eligible members and inactive owners cannot permit abandonment',async()=>{
  const org=randomUUID(),team=randomUUID(),inactive=randomUUID(),disabled=randomUUID(),channels:string[]=[];
  const base=`/v1/organizations/${org}/teams/${team}`,owners=[ids.alice,inactive].sort();
  const transfer=(actor:string,userId:string,expectedOwners=owners)=>request(actor,'POST',`${base}/transfer-ownership`,{userId,expectedOwners});
  try{
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Ownership verification')",[org]);
    for(const user of [inactive,disabled])await pool.query("INSERT INTO users(id,email,name,disabled) VALUES($1,$2,'Inactive owner fixture',$3)",[user,`${user}@ownership.test`,user===disabled]);
    await pool.query("INSERT INTO memberships(org_id,user_id,role,active) VALUES($1,$2,'owner',true),($1,$3,'member',true),($1,$4,'guest',true),($1,$5,'member',false),($1,$6,'member',true)",[org,ids.alice,ids.bob,ids.guest,inactive,disabled]);
    await pool.query("INSERT INTO teams(id,org_id,name) VALUES($1,$2,'Ownership team')",[team,org]);await pool.query("INSERT INTO team_members VALUES($1,$2,$3,'owner'),($1,$2,$4,'member'),($1,$2,$5,'member'),($1,$2,$6,'owner'),($1,$2,$7,'member')",[org,team,ids.alice,ids.bob,ids.guest,inactive,disabled]);
    for(const kind of ['standard','private']){const r=await request('alice','POST',`/v1/organizations/${org}/channels`,{name:`Ownership ${kind}`,kind,teamId:team,members:[ids.bob]});assert.equal(r.statusCode,200);channels.push(r.json().id);}
    const snapshot=(await request('alice','GET',`${base}/ownership`)).json();assert.equal(snapshot.teamId,team);assert.equal(snapshot.can_transfer,true);assert.deepEqual(snapshot.owners.map((p:{id:string})=>p.id).sort(),owners);assert.deepEqual(snapshot.candidates.map((p:{id:string})=>p.id),[ids.bob]);assert.equal((await request('bob','GET',`${base}/ownership`)).json().can_transfer,false);
    assert.equal((await request('eve','GET',`${base}/ownership`)).statusCode,404);assert.equal((await transfer('eve',ids.bob)).statusCode,404);assert.equal((await transfer('bob',ids.alice)).statusCode,403);assert.equal((await transfer('guest',ids.bob)).statusCode,403);
    assert.equal((await request('alice','POST',`${base}/leave`,{})).statusCode,409);assert.equal((await request('alice','POST',`/v1/organizations/${org}/teams/${randomUUID()}/leave`,{})).statusCode,404);
    await pool.query('DELETE FROM team_members WHERE team_id=$1 AND user_id=$2',[team,ids.alice]);assert.equal((await request('alice','GET',`${base}/ownership`)).statusCode,404);assert.equal((await transfer('alice',ids.bob)).statusCode,404);await pool.query("INSERT INTO team_members VALUES($1,$2,$3,'owner')",[org,team,ids.alice]);
    for(const payload of [{userId:ids.bob},{userId:ids.bob,expectedOwners:[]},{userId:ids.bob,expectedOwners:[ids.alice,ids.alice.toUpperCase()]},{userId:ids.bob,expectedOwners:owners,extra:true}])assert.equal((await request('alice','POST',`${base}/transfer-ownership`,payload)).statusCode,400);
    assert.equal((await transfer('alice',ids.bob,[ids.alice])).statusCode,409);assert.equal((await transfer('alice',ids.alice.toUpperCase())).statusCode,400);
    for(const user of [ids.guest,ids.eve,inactive,disabled,randomUUID()])assert.equal((await transfer('alice',user)).statusCode,404);
    await pool.query('UPDATE teams SET archived=true WHERE id=$1',[team]);assert.equal((await transfer('alice',ids.bob)).statusCode,409);assert.equal((await request('alice','GET',`${base}/ownership`)).json().can_transfer,false);await pool.query('UPDATE teams SET archived=false WHERE id=$1',[team]);
    const race=await Promise.all([transfer('alice',ids.bob,owners.map(v=>v.toUpperCase())),transfer('alice',ids.bob)]);assert.deepEqual(race.map(r=>r.statusCode).sort(),[200,403]);
    assert.equal((await transfer('alice',ids.bob)).statusCode,403);assert.equal((await request('alice','GET',`${base}/ownership`)).json().can_transfer,false);assert.equal((await request('bob','GET',`${base}/ownership`)).json().can_transfer,true);
    assert.equal((await pool.query('SELECT role FROM memberships WHERE org_id=$1 AND user_id=$2',[org,ids.bob])).rows[0].role,'member');assert.equal((await request('bob','GET',`/v1/channels/${channels[1]}/messages`)).statusCode,200);
    assert.equal((await request('alice','POST',`${base}/leave`,{})).statusCode,200);for(const channel of channels)assert.equal((await request('alice','GET',`/v1/channels/${channel}/messages`)).statusCode,404);
    assert.equal((await request('bob','POST',`${base}/leave`,{})).statusCode,409);
    await pool.query('UPDATE memberships SET active=true WHERE org_id=$1 AND user_id=$2',[org,inactive]);await pool.query('UPDATE users SET disabled=true WHERE id=$1',[inactive]);assert.equal((await request('bob','POST',`${base}/leave`,{})).statusCode,409);
    const nextOwners=[ids.bob,inactive].sort();assert.equal((await transfer('bob',ids.alice,nextOwners)).statusCode,404);await request('alice','POST',`${base}/join`,{});assert.equal((await transfer('bob',ids.alice,nextOwners)).statusCode,200);assert.equal((await request('alice','GET',`/v1/channels/${channels[1]}/messages`)).statusCode,404);assert.equal((await request('bob','POST',`${base}/leave`,{})).statusCode,200);assert.equal((await request('alice','POST',`${base}/leave`,{})).statusCode,409);
    const audit=(await pool.query("SELECT metadata FROM audit WHERE org_id=$1 AND action='team.ownership_transferred' ORDER BY id",[org])).rows;assert.deepEqual(audit,[{metadata:{from:ids.alice,to:ids.bob}},{metadata:{from:ids.bob,to:ids.alice}}]);
  }finally{
    for(const id of channels){await pool.query('DELETE FROM channel_members WHERE channel_id=$1',[id]);await pool.query('DELETE FROM channels WHERE id=$1',[id]);}
    await pool.query('DELETE FROM audit WHERE org_id=$1',[org]);await pool.query('DELETE FROM team_members WHERE team_id=$1',[team]);await pool.query('DELETE FROM teams WHERE id=$1',[team]);await pool.query('DELETE FROM memberships WHERE org_id=$1',[org]);await pool.query('DELETE FROM organizations WHERE id=$1',[org]);await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[inactive,disabled]]);
  }
});

test('private/shared explicit grants serialize access, include retained content and revoke without changing team membership',async()=>{
  const org=randomUUID(),team=randomUUID(),inactive=randomUUID(),disabled=randomUUID(),filler=Array.from({length:99},()=>randomUUID()),channels:string[]=[],files:string[]=[];
  const {fileRoot}=await import('../services/core/file-content.ts'),{mkdir,writeFile,rm}=await import('node:fs/promises'),{createHash}=await import('node:crypto');
  try{
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Explicit access verification')",[org]);await pool.query("INSERT INTO memberships(org_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member'),($1,$4,'guest')",[org,ids.alice,ids.bob,ids.guest]);
    for(const user of [inactive,disabled,...filler]){await pool.query("INSERT INTO users(id,email,name,disabled) VALUES($1,$2,'Synthetic access identity',$3)",[user,`${user}@channel-access.test`,user===disabled]);await pool.query("INSERT INTO memberships(org_id,user_id,role,active) VALUES($1,$2,'member',$3)",[org,user,user!==inactive]);}
    await pool.query("INSERT INTO teams(id,org_id,name) VALUES($1,$2,'Access team')",[team,org]);await pool.query("INSERT INTO team_members VALUES($1,$2,$3,'owner')",[org,team,ids.alice]);
    for(const kind of ['private','shared']){
      const created=await request('alice','POST',`/v1/organizations/${org}/channels`,{name:`Explicit ${kind}`,kind,teamId:team,members:[]});assert.equal(created.statusCode,200);const id=created.json().id;channels.push(id);const base=`/v1/channels/${id}`,revision=async()=>Number((await pool.query('SELECT revision FROM channels WHERE id=$1',[id])).rows[0].revision);
      const change=async(actor:string,method:'PUT'|'DELETE',user:string,rev?:number)=>request(actor,method,`${base}/explicit-members/${user}`,{revision:rev??await revision(),...(method==='PUT'?{history:'all-retained'}:{})});
      await request('alice','POST',`${base}/messages`,{clientId:randomUUID(),body:'Prior private/shared content'});
      if(kind==='private'){assert.equal((await request('alice','POST',`${base}/tasks`,{title:'Retained task',assigneeId:null,priority:'normal',dueDate:null})).statusCode,200);assert.equal((await request('alice','POST',`${base}/forms`,{title:'Retained form',questions:['Existing question']})).statusCode,200);}
      const file=randomUUID(),bytes=Buffer.from('Retained explicit file bytes');files.push(file);await mkdir(fileRoot(),{recursive:true});await writeFile(`${fileRoot()}/${file}`,bytes);await pool.query("INSERT INTO files(id,org_id,channel_id,name,mime,bytes,storage_key,sha256,state,created_by) VALUES($1,$2,$3,'access.txt','text/plain',$4,($1::uuid)::text,$5,'ready',$6)",[file,org,id,bytes.length,createHash('sha256').update(bytes).digest('hex'),ids.alice]);
      const download=`${base}/files/${file}/download`;assert.equal((await request('bob','GET',download)).statusCode,404);assert.equal((await request('alice','GET',`${base}/access`)).json().members.length,1);
      assert.equal((await change('eve','PUT',ids.bob)).statusCode,404);assert.equal((await change('bob','PUT',ids.bob)).statusCode,404);
      for(const payload of [{revision:1},{revision:1,history:'future-only'},{revision:1,history:'all-retained',extra:true}])assert.equal((await request('alice','PUT',`${base}/explicit-members/${ids.bob}`,payload)).statusCode,400);
      for(const user of [ids.eve,inactive,disabled,randomUUID()])assert.equal((await change('alice','PUT',user)).statusCode,404);
      await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[id,ids.alice]);assert.equal((await request('alice','GET',`${base}/access`)).statusCode,404);assert.equal((await change('alice','PUT',ids.alice)).statusCode,404);await pool.query('INSERT INTO channel_members VALUES($1,$2,$3)',[org,id,ids.alice]);
      const first=await revision(),race=await Promise.all([change('alice','PUT',ids.bob,first),change('alice','PUT',ids.bob,first)]);assert.deepEqual(race.map(r=>r.statusCode).sort(),[200,409]);assert.equal((await change('alice','PUT',ids.bob)).json().changed,false);
      assert.equal((await request('bob','GET',`${base}/messages`)).json().messages[0].body,'Prior private/shared content');assert.equal((await request('bob','GET',download)).body,bytes.toString());assert.equal((await pool.query('SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2',[team,ids.bob])).rowCount,0);
      if(kind==='private'){assert.equal((await request('bob','GET',`${base}/tasks`)).json().tasks[0].title,'Retained task');assert.equal((await request('bob','GET',`${base}/forms`)).json().forms[0].title,'Retained form');}
      assert.equal((await request('bob','GET',`${base}/access`)).statusCode,403);assert.equal((await change('bob','DELETE',ids.alice)).statusCode,403);assert.equal((await change('alice','DELETE',ids.alice.toUpperCase())).statusCode,400);
      await request('bob','PUT',`${base}/draft`,{body:'Personal removed draft'});await pool.query('INSERT INTO channel_preferences(channel_id,user_id,pinned) VALUES($1,$2,true)',[id,ids.bob]);
      const rev=await revision(),removed=await Promise.all([change('alice','DELETE',ids.bob,rev),change('alice','DELETE',ids.bob,rev)]);assert.deepEqual(removed.map(r=>r.statusCode).sort(),[200,409]);assert.equal((await change('alice','DELETE',ids.bob)).json().changed,false);
      for(const suffix of ['messages','files','tasks','forms','draft'])assert.equal((await request('bob','GET',`${base}/${suffix}`)).statusCode,404);assert.equal((await request('bob','GET',download)).statusCode,404);
      assert.equal((await pool.query('SELECT 1 FROM channel_preferences WHERE channel_id=$1 AND user_id=$2',[id,ids.bob])).rowCount,0);assert.equal((await change('alice','PUT',ids.bob)).statusCode,200);assert.equal((await request('bob','GET',`${base}/draft`)).json().body,'');
      const audit=(await pool.query("SELECT action,metadata FROM audit WHERE target=$1 AND action IN('channel.member_added','channel.member_removed') ORDER BY id",[id])).rows;assert.deepEqual(audit.map(r=>r.action),['channel.member_added','channel.member_removed','channel.member_added']);assert.equal(audit[0].metadata.history,'all-retained');assert.ok(!JSON.stringify(audit).includes('Prior private'));assert.equal((await pool.query("SELECT 1 FROM outbox WHERE channel_id=$1 AND type='channel.updated'",[id])).rowCount,3);
      await pool.query('INSERT INTO channel_members VALUES($1,$2,$3)',[org,id,inactive]);assert.equal((await request('alice','GET',`${base}/access`)).json().members.find((m:{id:string})=>m.id===inactive).active,false);assert.equal((await change('alice','DELETE',inactive)).statusCode,200);
      assert.equal((await change('alice','PUT',ids.guest)).statusCode,200);assert.equal((await change('guest','PUT',filler[0])).statusCode,403);assert.equal((await change('alice','DELETE',ids.guest)).statusCode,200);
      await pool.query("UPDATE memberships SET role='member' WHERE org_id=$1 AND user_id=$2",[org,ids.alice]);assert.equal((await change('alice','DELETE',ids.bob)).statusCode,403);await pool.query("UPDATE memberships SET role='owner' WHERE org_id=$1 AND user_id=$2",[org,ids.alice]);
      await pool.query('UPDATE channels SET archived=true WHERE id=$1',[id]);assert.equal((await change('alice','DELETE',ids.bob)).statusCode,409);await pool.query('UPDATE channels SET archived=false WHERE id=$1',[id]);
      for(const user of filler.slice(0,98))await pool.query('INSERT INTO channel_members VALUES($1,$2,$3)',[org,id,user]);assert.equal((await change('alice','PUT',filler[98])).statusCode,409);
      for(const other of ['standard','direct','group']){await pool.query('UPDATE channels SET kind=$2 WHERE id=$1',[id,other]);assert.equal((await request('alice','GET',`${base}/access`)).statusCode,400);assert.equal((await change('alice','DELETE',ids.bob)).statusCode,400);}await pool.query('UPDATE channels SET kind=$2 WHERE id=$1',[id,kind]);
    }
  }finally{
    for(const file of files)await rm(`${fileRoot()}/${file}`,{force:true});
    for(const id of channels){for(const table of ['tasks','forms','files','messages','drafts','channel_preferences','read_positions','channel_members','outbox'])await pool.query(`DELETE FROM ${table} WHERE channel_id=$1`,[id]);await pool.query('DELETE FROM channels WHERE id=$1',[id]);}
    await pool.query('DELETE FROM audit WHERE org_id=$1',[org]);await pool.query('DELETE FROM team_members WHERE team_id=$1',[team]);await pool.query('DELETE FROM teams WHERE id=$1',[team]);await pool.query('DELETE FROM memberships WHERE org_id=$1',[org]);await pool.query('DELETE FROM organizations WHERE id=$1',[org]);await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[inactive,disabled,...filler]]);
  }
});

test('admin team membership grants only standard history, removes private access, preserves shared grants and fences stale creation',async()=>{
  const org=randomUUID(),team=randomUUID(),inactive=randomUUID(),disabled=randomUUID(),file=randomUUID(),filler=Array.from({length:998},()=>randomUUID());const channels:string[]=[];
  const {fileRoot}=await import('../services/core/file-content.ts'),{mkdir,writeFile,rm}=await import('node:fs/promises'),{createHash}=await import('node:crypto');
  const base=`/v1/organizations/${org}/teams/${team}`,token=async()=>(await request('alice','GET',`${base}/members`)).json().membershipToken;
  const change=async(actor:string,method:'PUT'|'DELETE',user:string,expectedMembership?:string)=>request(actor,method,`${base}/members/${user}`,{expectedMembership:expectedMembership??await token(),...(method==='PUT'?{history:'all-retained-standard'}:{})});
  try{
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Team member verification')",[org]);await pool.query("INSERT INTO memberships(org_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member'),($1,$4,'guest')",[org,ids.alice,ids.bob,ids.guest]);
    for(const user of [inactive,disabled]){await pool.query("INSERT INTO users(id,email,name,disabled) VALUES($1,$2,'Synthetic team candidate',$3)",[user,`${user}@team-member.test`,user===disabled]);await pool.query("INSERT INTO memberships(org_id,user_id,role,active) VALUES($1,$2,'member',$3)",[org,user,user!==inactive]);}
    await pool.query("INSERT INTO teams(id,org_id,name) VALUES($1,$2,'Member team')",[team,org]);await pool.query("INSERT INTO team_members VALUES($1,$2,$3,'owner')",[org,team,ids.alice]);
    for(const kind of ['standard','private','shared']){const r=await request('alice','POST',`/v1/organizations/${org}/channels`,{name:`Team ${kind}`,kind,teamId:team,members:[]});assert.equal(r.statusCode,200);channels.push(r.json().id);}
    const [standard,privateId,shared]=channels;await request('alice','POST',`/v1/channels/${standard}/messages`,{clientId:randomUUID(),body:'Retained team history'});
    const bytes=Buffer.from('Standard history file');await mkdir(fileRoot(),{recursive:true});await writeFile(`${fileRoot()}/${file}`,bytes);await pool.query("INSERT INTO files(id,org_id,channel_id,name,mime,bytes,storage_key,sha256,state,created_by) VALUES($1,$2,$3,'team.txt','text/plain',$4,($1::uuid)::text,$5,'ready',$6)",[file,org,standard,bytes.length,createHash('sha256').update(bytes).digest('hex'),ids.alice]);
    const first=await token();assert.match(first,/^[a-f0-9]{64}$/);assert.equal((await change('bob','PUT',ids.bob,first)).statusCode,403);assert.equal((await change('eve','PUT',ids.bob,first)).statusCode,404);
    for(const body of [{expectedMembership:first},{expectedMembership:'wrong',history:'all-retained-standard'},{expectedMembership:first,history:'all-retained'},{expectedMembership:first,history:'all-retained-standard',role:'owner'}])assert.equal((await request('alice','PUT',`${base}/members/${ids.bob}`,body)).statusCode,400);
    assert.equal((await change('alice','PUT',ids.bob,'0'.repeat(64))).statusCode,409);for(const user of [inactive,disabled,ids.eve,randomUUID()])assert.equal((await change('alice','PUT',user,first)).statusCode,404);
    await pool.query('DELETE FROM team_members WHERE team_id=$1 AND user_id=$2',[team,ids.alice]);assert.equal((await request('alice','GET',`${base}/members`)).statusCode,404);assert.equal((await change('alice','PUT',ids.alice,first)).statusCode,404);await pool.query("INSERT INTO team_members VALUES($1,$2,$3,'owner')",[org,team,ids.alice]);
    const raced=await Promise.all([change('alice','PUT',ids.bob,first),change('alice','PUT',ids.bob,first)]);assert.deepEqual(raced.map(r=>r.statusCode).sort(),[200,409]);assert.equal((await change('alice','PUT',ids.bob)).json().changed,false);
    assert.equal((await request('bob','GET',`/v1/channels/${standard}/messages`)).json().messages[0].body,'Retained team history');assert.equal((await request('bob','GET',`/v1/channels/${standard}/files/${file}/download`)).body,bytes.toString());for(const id of [privateId,shared])assert.equal((await request('bob','GET',`/v1/channels/${id}/messages`)).statusCode,404);
    assert.equal((await change('alice','PUT',ids.guest)).statusCode,200);assert.equal((await request('guest','GET',`/v1/channels/${standard}/messages`)).statusCode,200);assert.equal((await change('guest','DELETE',ids.bob)).statusCode,403);
    assert.equal((await change('alice','DELETE',ids.alice.toUpperCase())).statusCode,400);
    await pool.query("INSERT INTO team_members VALUES($1,$2,$3,'owner')",[org,team,inactive]);assert.equal((await change('alice','DELETE',inactive)).statusCode,409);await pool.query('DELETE FROM team_members WHERE team_id=$1 AND user_id=$2',[team,inactive]);
    await pool.query("UPDATE memberships SET role='member' WHERE org_id=$1 AND user_id=$2",[org,ids.alice]);assert.equal((await request('alice','GET',`${base}/members`)).statusCode,403);await pool.query("UPDATE memberships SET role='owner' WHERE org_id=$1 AND user_id=$2",[org,ids.alice]);
    await pool.query('UPDATE teams SET archived=true WHERE id=$1',[team]);assert.equal((await change('alice','DELETE',ids.bob)).statusCode,409);assert.equal((await request('bob','POST',`/v1/organizations/${org}/channels`,{name:'Archived creation',kind:'private',teamId:team,members:[]})).statusCode,404);await pool.query('UPDATE teams SET archived=false WHERE id=$1',[team]);
    for(const id of [privateId,shared]){const revision=(await request('alice','GET',`/v1/channels/${id}/access`)).json().revision;assert.equal((await request('alice','PUT',`/v1/channels/${id}/explicit-members/${ids.bob}`,{revision,history:'all-retained'})).statusCode,200);}
    for(const id of channels){await request('bob','PUT',`/v1/channels/${id}/draft`,{body:'Membership draft'});await pool.query('INSERT INTO channel_preferences(channel_id,user_id,pinned) VALUES($1,$2,true)',[id,ids.bob]);}
    const before=(await pool.query('SELECT id,revision FROM channels WHERE team_id=$1',[team])).rows,previous=await token();const removed=await Promise.all([change('alice','DELETE',ids.bob,previous),change('alice','DELETE',ids.bob,previous)]);assert.deepEqual(removed.map(r=>r.statusCode).sort(),[200,409]);assert.equal(removed.find(r=>r.statusCode===200)!.json().channelsAffected,2);
    for(const id of [standard,privateId]){assert.equal((await request('bob','GET',`/v1/channels/${id}/messages`)).statusCode,404);assert.equal((await pool.query('SELECT 1 FROM drafts WHERE channel_id=$1 AND user_id=$2',[id,ids.bob])).rowCount,0);assert.equal((await pool.query('SELECT revision FROM channels WHERE id=$1',[id])).rows[0].revision,before.find(c=>c.id===id).revision+1);}
    assert.equal((await request('bob','GET',`/v1/channels/${standard}/files/${file}/download`)).statusCode,404);assert.equal((await request('bob','GET',`/v1/channels/${shared}/draft`)).json().body,'Membership draft');assert.equal((await pool.query('SELECT revision FROM channels WHERE id=$1',[shared])).rows[0].revision,before.find(c=>c.id===shared).revision);
    const revision=(await request('alice','GET',`/v1/channels/${privateId}/access`)).json().revision;await request('alice','PUT',`/v1/channels/${privateId}/explicit-members/${ids.bob}`,{revision,history:'all-retained'});assert.equal((await change('alice','DELETE',ids.bob)).json().changed,false);assert.equal((await request('bob','GET',`/v1/channels/${privateId}/messages`)).statusCode,200);
    // Open-team self-join is still allowed; removal is not a durable ban.
    assert.equal((await request('bob','POST',`${base}/join`,{})).statusCode,200);
    // Reproduce an authorization snapshot waiting on the team lock, then remove its membership before releasing it.
    const lock=await pool.connect();let creating:ReturnType<typeof request>|undefined;
    try{await lock.query('BEGIN');await lock.query('SELECT id FROM teams WHERE id=$1 FOR UPDATE',[team]);creating=request('bob','POST',`/v1/organizations/${org}/channels`,{name:'Fenced creation',kind:'private',teamId:team,members:[]});
      let waiting=false;for(let i=0;i<100&&!waiting;i++){waiting=!!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'SELECT t.id FROM teams t JOIN team_members%' AND wait_event_type='Lock'")).rowCount;if(!waiting)await new Promise(r=>setTimeout(r,10));}assert.equal(waiting,true);
      await lock.query('DELETE FROM team_members WHERE team_id=$1 AND user_id=$2',[team,ids.bob]);await lock.query('COMMIT');const result=await creating;if(result.statusCode===200)channels.push(result.json().id);assert.equal(result.statusCode,404);
    }finally{await lock.query('ROLLBACK');lock.release();if(creating)await creating;}
    const audits=(await pool.query("SELECT action,metadata FROM audit WHERE org_id=$1 AND action IN('team.member_added','team.member_removed') ORDER BY id",[org])).rows;assert.equal(audits.length,3);assert.equal(audits[0].metadata.history,'all-retained-standard');assert.equal(audits[2].metadata.privateGrantsRemoved,1);assert.ok(!JSON.stringify(audits).includes(privateId));
    // Exercise the actual bounded roster/admission boundary without creating files or channels per candidate.
    await pool.query("INSERT INTO users(id,email,name) SELECT id,id::text||'@team-cap.test','Capacity fixture' FROM unnest($1::uuid[]) id",[filler]);await pool.query("INSERT INTO memberships(org_id,user_id,role) SELECT $1,id,'member' FROM unnest($2::uuid[]) id",[org,filler]);await pool.query("INSERT INTO team_members(org_id,team_id,user_id) SELECT $1,$2,id FROM unnest($3::uuid[]) id",[org,team,filler]);assert.equal((await request('alice','GET',`${base}/members`)).json().members.length,1000);assert.equal((await change('alice','PUT',ids.bob)).statusCode,409);assert.equal((await change('alice','DELETE',filler[0])).statusCode,200);assert.equal((await change('alice','PUT',ids.bob)).statusCode,200);await pool.query("INSERT INTO team_members VALUES($1,$2,$3,'member')",[org,team,filler[0]]);assert.equal((await request('alice','GET',`${base}/members`)).statusCode,413);
  }finally{
    await rm(`${fileRoot()}/${file}`,{force:true});for(const id of channels){for(const table of ['files','messages','drafts','channel_preferences','read_positions','channel_members','outbox'])await pool.query(`DELETE FROM ${table} WHERE channel_id=$1`,[id]);await pool.query('DELETE FROM channels WHERE id=$1',[id]);}
    await pool.query('DELETE FROM audit WHERE org_id=$1',[org]);await pool.query('DELETE FROM team_members WHERE team_id=$1',[team]);await pool.query('DELETE FROM teams WHERE id=$1',[team]);await pool.query('DELETE FROM memberships WHERE org_id=$1',[org]);await pool.query('DELETE FROM organizations WHERE id=$1',[org]);await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[inactive,disabled,...filler]]);
  }
});

test('ownerless team recovery requires joined workspace ownership and fences reactivation without restoring former ownership',async()=>{
  const org=randomUUID(),team=randomUUID(),empty=randomUUID(),inactive=randomUUID(),disabled=randomUUID(),channels:string[]=[];
  const base=`/v1/organizations/${org}/teams/${team}`,view=async()=>(await request('alice','GET',`${base}/ownership`)).json();
  const recover=async(actor:string,userId:string,expectedRecovery?:string)=>request(actor,'POST',`${base}/recover-ownership`,{userId,expectedRecovery:expectedRecovery??(await view()).recoveryToken,confirm:true});
  try{
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Ownership recovery verification')",[org]);
    for(const user of [inactive,disabled])await pool.query("INSERT INTO users(id,email,name,disabled) VALUES($1,$2,'Former inactive owner',$3)",[user,`${user}@owner-recovery.test`,user===disabled]);
    await pool.query("INSERT INTO memberships(org_id,user_id,role,active) VALUES($1,$2,'owner',true),($1,$3,'member',true),($1,$4,'guest',true),($1,$5,'member',false),($1,$6,'member',true)",[org,ids.alice,ids.bob,ids.guest,inactive,disabled]);
    await pool.query("INSERT INTO teams(id,org_id,name) VALUES($1,$2,'Lost ownership')",[team,org]);await pool.query("INSERT INTO team_members VALUES($1,$2,$3,'member'),($1,$2,$4,'member'),($1,$2,$5,'member'),($1,$2,$6,'owner'),($1,$2,$7,'owner')",[org,team,ids.alice,ids.bob,ids.guest,inactive,disabled]);
    for(const kind of ['standard','private']){const r=await request('alice','POST',`/v1/organizations/${org}/channels`,{name:`Recovery ${kind}`,kind,teamId:team,members:[]});assert.equal(r.statusCode,200);channels.push(r.json().id);}
    const first=await view();assert.equal(first.can_recover,true);assert.equal(first.can_transfer,false);assert.equal(first.owners.length,2);assert.ok(first.owners.every((o:{active:boolean})=>!o.active));assert.match(first.recoveryToken,/^[a-f0-9]{64}$/);
    for(const payload of [{userId:ids.bob,expectedRecovery:first.recoveryToken},{userId:ids.bob,expectedRecovery:first.recoveryToken,confirm:false},{userId:ids.bob,expectedRecovery:'invalid',confirm:true},{userId:ids.bob,expectedRecovery:first.recoveryToken,confirm:true,reactivate:true}])assert.equal((await request('alice','POST',`${base}/recover-ownership`,payload)).statusCode,400);
    assert.equal((await recover('eve',ids.bob,first.recoveryToken)).statusCode,404);assert.equal((await recover('bob',ids.bob,first.recoveryToken)).statusCode,403);assert.equal((await recover('guest',ids.bob,first.recoveryToken)).statusCode,403);
    await pool.query("UPDATE memberships SET role='admin' WHERE org_id=$1 AND user_id=$2",[org,ids.alice]);assert.equal((await recover('alice',ids.bob,first.recoveryToken)).statusCode,403);assert.equal((await view()).can_recover,false);await pool.query("UPDATE memberships SET role='owner' WHERE org_id=$1 AND user_id=$2",[org,ids.alice]);
    await pool.query('DELETE FROM team_members WHERE team_id=$1 AND user_id=$2',[team,ids.alice]);assert.equal((await recover('alice',ids.bob,first.recoveryToken)).statusCode,404);await pool.query("INSERT INTO team_members VALUES($1,$2,$3,'member')",[org,team,ids.alice]);
    assert.equal((await recover('alice',ids.bob,'0'.repeat(64))).statusCode,409);for(const user of [inactive,disabled,ids.guest,ids.eve,randomUUID()])assert.equal((await recover('alice',user)).statusCode,404);
    await pool.query('UPDATE teams SET archived=true WHERE id=$1',[team]);assert.equal((await recover('alice',ids.bob,first.recoveryToken)).statusCode,409);assert.equal((await view()).can_recover,false);await pool.query('UPDATE teams SET archived=false WHERE id=$1',[team]);
    // A concurrent account reactivation commits while recovery waits for its membership lock.
    const lock=await pool.connect();let pending:ReturnType<typeof recover>|undefined;
    try{await lock.query('BEGIN');await lock.query('SELECT user_id FROM memberships WHERE org_id=$1 AND user_id=$2 FOR UPDATE',[org,inactive]);pending=recover('alice',ids.bob,first.recoveryToken);
      let waiting=false;for(let i=0;i<100&&!waiting;i++){waiting=!!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'SELECT user_id FROM memberships WHERE org_id=%' AND wait_event_type='Lock'")).rowCount;if(!waiting)await new Promise(r=>setTimeout(r,10));}assert.equal(waiting,true);await lock.query('UPDATE memberships SET active=true WHERE org_id=$1 AND user_id=$2',[org,inactive]);await lock.query('COMMIT');assert.equal((await pending).statusCode,409);
    }finally{await lock.query('ROLLBACK');lock.release();if(pending)await pending;}
    assert.equal((await view()).can_recover,false);assert.equal((await pool.query("SELECT 1 FROM audit WHERE org_id=$1 AND action='team.ownership_recovered'",[org])).rowCount,0);await pool.query('UPDATE memberships SET active=false WHERE org_id=$1 AND user_id=$2',[org,inactive]);
    const race=await Promise.all([recover('alice',ids.bob,first.recoveryToken),recover('alice',ids.bob,first.recoveryToken)]);assert.deepEqual(race.map(r=>r.statusCode).sort(),[200,409]);assert.equal(race.find(r=>r.statusCode===200)!.json().formerOwnersReset,2);
    assert.equal((await recover('alice',ids.alice,first.recoveryToken)).statusCode,409);assert.equal((await view()).can_recover,false);assert.equal((await request('bob','GET',`${base}/ownership`)).json().can_transfer,true);assert.equal((await pool.query('SELECT role FROM memberships WHERE org_id=$1 AND user_id=$2',[org,ids.bob])).rows[0].role,'member');
    assert.equal((await request('bob','GET',`/v1/channels/${channels[0]}/messages`)).statusCode,200);assert.equal((await request('bob','GET',`/v1/channels/${channels[1]}/messages`)).statusCode,404);assert.equal((await request('bob','POST',`${base}/leave`,{})).statusCode,409);
    await pool.query('UPDATE memberships SET active=true WHERE org_id=$1 AND user_id=$2',[org,inactive]);await pool.query('UPDATE users SET disabled=false WHERE id=$1',[disabled]);const restored=(await view()).owners;assert.deepEqual(restored.map((o:{id:string})=>o.id),[ids.bob]);assert.equal((await pool.query("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=ANY($2::uuid[]) AND role='member'",[team,[inactive,disabled]])).rowCount,2);
    assert.equal((await pool.query('SELECT 1 FROM outbox WHERE channel_id=ANY($1::uuid[])',[channels])).rowCount,0);assert.ok((await pool.query('SELECT revision FROM channels WHERE team_id=$1',[team])).rows.every(r=>r.revision===1));
    const audits=(await pool.query("SELECT metadata FROM audit WHERE org_id=$1 AND action='team.ownership_recovered'",[org])).rows;assert.deepEqual(audits,[{metadata:{newOwner:ids.bob,formerOwners:[inactive,disabled].sort()}}]);
    // A joined workspace owner can also repair a team with no owner rows at all.
    await pool.query("INSERT INTO teams(id,org_id,name) VALUES($1,$2,'Empty owner set')",[empty,org]);await pool.query("INSERT INTO team_members VALUES($1,$2,$3,'member')",[org,empty,ids.alice]);const snapshot=(await request('alice','GET',`/v1/organizations/${org}/teams/${empty}/ownership`)).json();assert.equal(snapshot.can_recover,true);assert.equal((await request('alice','POST',`/v1/organizations/${org}/teams/${empty}/recover-ownership`,{userId:ids.alice,expectedRecovery:snapshot.recoveryToken,confirm:true})).statusCode,200);
  }finally{
    for(const id of channels){await pool.query('DELETE FROM channel_members WHERE channel_id=$1',[id]);await pool.query('DELETE FROM channels WHERE id=$1',[id]);}await pool.query('DELETE FROM audit WHERE org_id=$1',[org]);await pool.query('DELETE FROM team_members WHERE org_id=$1',[org]);await pool.query('DELETE FROM teams WHERE org_id=$1',[org]);await pool.query('DELETE FROM memberships WHERE org_id=$1',[org]);await pool.query('DELETE FROM organizations WHERE id=$1',[org]);await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[inactive,disabled]]);
  }
});

test('deleted file recovery rechecks owner, ACL, archive, quota and lifecycle token, rescans one version and fences old scan leases',async()=>{
  const {runFileJob}=await import('../services/core/file-jobs.ts');
  await pool.query("UPDATE file_scan_jobs SET status='cancelled',lease_id=NULL,lease_until=NULL WHERE status IN ('queued','running')");
  const channel=(await request('alice','POST',`/v1/organizations/${ids.org}/channels`,{name:'File recovery fixture',kind:'private',teamId:ids.team,members:[ids.bob]})).json().id;
  const base=`/v1/channels/${channel}/files`,list=`/v1/channels/${channel}/deleted-files`,created:string[]=[];
  const upload=async(versionOf?:string)=>{const r=await request('alice','POST',base,{name:'recover.txt',mime:'text/plain',content:Buffer.from('Recovery integrity fixture').toString('base64'),...(versionOf?{versionOf}: {})});assert.equal(r.statusCode,200,r.body);created.push(r.json().id);return r.json().id as string;};
  const revision=async(file:string)=>(await pool.query('SELECT lifecycle_revision FROM files WHERE id=$1',[file])).rows[0].lifecycle_revision;
  const restore=(file:string,expectedRevision:number,user='alice')=>request(user,'POST',`${base}/${file}/restore`,{expectedRevision,confirm:true});
  const original=await upload();await runFileJob(async()=>({state:'ready',version:'test-only'}));const version=await upload(original);await runFileJob(async()=>({state:'ready',version:'test-only'}));
  assert.equal((await request('alice','DELETE',`${base}/${original}`)).statusCode,200);const token=await revision(original),versionToken=await revision(version);
  assert.equal((await request('alice','GET',list)).json().files.length,2);assert.deepEqual((await request('bob','GET',list)).json().files,[]);assert.equal((await request('eve','GET',list)).statusCode,404);
  assert.equal((await restore(original,token,'bob')).statusCode,404);assert.equal((await restore(original,token,'eve')).statusCode,404);assert.equal((await restore(version,versionToken)).statusCode,409);
  assert.equal((await request('alice','POST',`${base}/${original}/restore`,{expectedRevision:token})).statusCode,400);
  await pool.query('UPDATE channels SET archived=true WHERE id=$1',[channel]);assert.equal((await restore(original,token)).statusCode,409);await pool.query('UPDATE channels SET archived=false WHERE id=$1',[channel]);
  // Quota must include recovered bytes, not only new uploads.
  const quota=randomUUID();try{await pool.query("INSERT INTO files(id,org_id,channel_id,name,mime,bytes,storage_key,sha256,state,created_by) VALUES($1,$2,$3,'quota.txt','text/plain',104857600,($1::uuid)::text,'unused','ready',$4)",[quota,ids.org,channel,ids.alice]);assert.equal((await restore(original,token)).statusCode,413);}finally{await pool.query('DELETE FROM files WHERE id=$1',[quota]);}
  await request('alice','DELETE',`${base}/${original}`);assert.equal(await revision(original),token);
  const concurrent=await Promise.all([restore(original,token),restore(original,token)]);assert.deepEqual(concurrent.map(r=>r.statusCode).sort(),[200,409]);assert.equal((await request('alice','GET',`${base}/${original}/download`)).statusCode,409);
  assert.equal((await pool.query('SELECT state FROM files WHERE id=$1',[version])).rows[0].state,'deleted');assert.equal((await restore(version,versionToken)).statusCode,200);
  // Restore resets old scan metadata and lease, and a stale verdict cannot publish.
  await runFileJob(async()=>{
    await request('alice','DELETE',`${base}/${original}`);assert.equal((await restore(original,await revision(original))).statusCode,200);return {state:'ready',version:'stale-test-verdict'};
  });
  assert.equal((await pool.query('SELECT state FROM files WHERE id=$1',[original])).rows[0].state,'quarantined');
  const job=(await pool.query('SELECT * FROM file_scan_jobs WHERE file_id=$1',[original])).rows[0];assert.equal(job.status,'queued');assert.equal(job.attempts,0);assert.equal(job.scanner_version,null);assert.equal(job.lease_id,null);
  assert.equal((await restore(original,token)).statusCode,409);
  await runFileJob(async()=>({state:'ready',version:'fresh-test-only'}));assert.equal((await request('bob','GET',`${base}/${original}/download`)).body,'Recovery integrity fixture');
  await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[channel,ids.alice]);assert.equal((await restore(version,await revision(version))).statusCode,404);assert.equal((await request('alice','GET',list)).statusCode,404);await pool.query('INSERT INTO channel_members VALUES($1,$2,$3)',[ids.org,channel,ids.alice]);
  // Missing retained bytes stay inaccessible and follow normal retry/dead behavior.
  const {unlink}=await import('node:fs/promises');const {fileRoot}=await import('../services/core/file-content.ts');const path=await import('node:path');await unlink(path.join(fileRoot(),version));assert.equal((await restore(version,await revision(version))).statusCode,200);await runFileJob(async()=>({state:'ready',version:'must-not-be-called'}));assert.equal((await request('alice','GET',`${base}/${version}/download`)).statusCode,409);
  assert.equal((await pool.query("SELECT 1 FROM audit WHERE action='file.restore_requested' AND target=$1",[original])).rowCount,2);
  await request('alice','DELETE',`${base}/${original}`);
});

test('deleted-file metadata listing is uploader-scoped, bounded and does not expose storage or scan internals',async()=>{
  const idsCreated:string[]=Array.from({length:101},()=>randomUUID());
  try{
    await pool.query("INSERT INTO files(id,org_id,channel_id,name,mime,bytes,storage_key,sha256,state,created_by) SELECT x,$2,$3,'deleted.txt','text/plain',1,x::text,'private-digest','deleted',$4 FROM unnest($1::uuid[]) x",[idsCreated,ids.org,ids.channel,ids.alice]);
    const r=await request('alice','GET',`/v1/channels/${ids.channel}/deleted-files`);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().hasMore,true);assert.equal(r.json().files.length,100);assert.deepEqual(Object.keys(r.json().files[0]).sort(),['id','name','bytes','revision_root','revision_number','lifecycle_revision'].sort());
    assert.ok(!(await request('bob','GET',`/v1/channels/${ids.channel}/deleted-files`)).json().files.some((f:{id:string})=>idsCreated.includes(f.id)));
  }finally{await pool.query('DELETE FROM files WHERE id=ANY($1::uuid[])',[idsCreated]);}
});

test('owner-only channel preservation freezes destructive message/file paths, serializes hold changes and keeps reads/additions/scanned recovery available',async()=>{
  const isolated=await createApp();
  const request=(user:string,method:'GET'|'POST'|'PATCH'|'DELETE'|'PUT',url:string,payload?:unknown)=>isolated.inject({method,url,headers:{origin,cookie:cookies[user]},payload:payload as Record<string,unknown>});
  const org=randomUUID(),team=randomUUID(),channels:string[]=[],files:string[]=[];
  const note='Private case reference <hold-2026>';
  try{
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Preservation verification')",[org]);await pool.query("INSERT INTO memberships(org_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'guest')",[org,ids.alice,ids.bob,ids.guest]);await pool.query("INSERT INTO teams(id,org_id,name) VALUES($1,$2,'Preservation team')",[team,org]);await pool.query("INSERT INTO team_members VALUES($1,$2,$3,'owner')",[org,team,ids.alice]);
    for(const kind of ['private','standard','shared']){const r=await request('alice','POST',`/v1/organizations/${org}/channels`,{name:`Hold ${kind}`,kind,teamId:team,members:[ids.bob,ids.guest]});assert.equal(r.statusCode,200,r.body);channels.push(r.json().id);}
    const id=channels[0],base=`/v1/channels/${id}`,url=`${base}/preservation`,snap=async()=>(await request('alice','GET',url)).json();
    const change=(active:boolean,expectedRevision:number,reason=note,user='alice')=>request(user,'PUT',url,{active,reason,expectedRevision,confirm:true});
    assert.deepEqual(await snap(),{id,active:false,reason:'',revision:0});
    for(const user of ['bob','guest']){assert.equal((await request(user,'GET',url)).statusCode,403);assert.equal((await change(true,0,note,user)).statusCode,403);}assert.equal((await request('eve','GET',url)).statusCode,404);
    await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[id,ids.alice]);assert.equal((await change(true,0)).statusCode,404);await pool.query('INSERT INTO channel_members VALUES($1,$2,$3)',[org,id,ids.alice]);
    for(const body of [{active:true,reason:note,expectedRevision:0},{active:true,reason:' ',expectedRevision:0,confirm:true},{active:true,reason:note,expectedRevision:0,confirm:true,extra:true},{active:true,reason:note,expectedRevision:-1,confirm:true}])assert.equal((await request('alice','PUT',url,body)).statusCode,400);
    assert.equal((await change(false,0,'')).json().changed,false);
    const message=(await request('bob','POST',`${base}/messages`,{clientId:randomUUID(),body:'Held original body'})).json().id;
    const uploaded=await request('alice','POST',`${base}/files`,{name:'held.txt',mime:'text/plain',content:Buffer.from('Held file bytes').toString('base64')});assert.equal(uploaded.statusCode,200);files.push(uploaded.json().id);const file=files[0];await request('alice','DELETE',`${base}/files/${file}`);const fileRevision=(await pool.query('SELECT lifecycle_revision FROM files WHERE id=$1',[file])).rows[0].lifecycle_revision;
    const report=(await request('guest','POST',`${base}/messages/${message}/report`,{reason:'other',details:'Preservation review'})).json().report;
    const race=await Promise.all([change(true,0),change(true,0)]);assert.deepEqual(race.map(r=>r.statusCode).sort(),[200,409]);assert.equal((await change(true,1)).json().changed,false);
    for(const kindId of channels.slice(1))assert.equal((await request('alice','PUT',`/v1/channels/${kindId}/preservation`,{active:true,reason:note,expectedRevision:0,confirm:true})).statusCode,200);
    assert.equal((await request('bob','PATCH',`${base}/messages/${message}`,{body:'Blocked edit'})).statusCode,409);for(const user of ['bob','alice'])assert.equal((await request(user,'DELETE',`${base}/messages/${message}`)).statusCode,409);
    assert.equal((await request('alice','DELETE',`${base}/files/${file}`)).statusCode,409);assert.equal((await request('alice','POST',`${base}/files/${file}/restore`,{expectedRevision:fileRevision,confirm:true})).statusCode,200);assert.equal((await request('alice','GET',`${base}/files/${file}/download`)).statusCode,409);
    const resolve=`/v1/organizations/${org}/message-reports/${report.id}/resolve`;
    assert.equal((await request('bob','POST',resolve,{revision:1,action:'remove',note:'Cannot bypass hold'})).statusCode,409);assert.equal((await pool.query('SELECT status FROM message_reports WHERE id=$1',[report.id])).rows[0].status,'open');assert.equal((await pool.query('SELECT body FROM messages WHERE id=$1',[message])).rows[0].body,'Held original body');
    assert.equal((await request('bob','POST',resolve,{revision:1,action:'dismiss',note:'Preservation review'})).statusCode,200);
    const history=(await request('bob','GET',`${base}/messages`)).json();assert.ok(!JSON.stringify(history).includes(note));assert.equal((await request('bob','POST',`${base}/messages`,{clientId:randomUUID(),body:'Additive content remains allowed'})).statusCode,201);
    const another=await request('alice','POST',`${base}/files`,{name:'new-held.txt',mime:'text/plain',content:Buffer.from('New immutable upload').toString('base64')});assert.equal(another.statusCode,200);files.push(another.json().id);
    // Hold changes work for archived channels, and stale release cannot silently clear a newer note.
    await pool.query('UPDATE channels SET archived=true WHERE id=$1',[id]);assert.equal((await change(true,1,'Updated confidential note')).statusCode,200);assert.equal((await change(false,1)).statusCode,409);assert.equal((await snap()).active,true);await pool.query('UPDATE channels SET archived=false WHERE id=$1',[id]);
    assert.equal((await change(false,2)).statusCode,200);assert.equal((await request('bob','PATCH',`${base}/messages/${message}`,{body:'Allowed edit after release'})).statusCode,200);
    // A deletion begun before a hold commits must re-read the hold after waiting for the channel lock.
    const lock=await pool.connect();let pending:ReturnType<typeof request>|undefined;
    try{await lock.query('BEGIN');await lock.query('SELECT id FROM channels WHERE id=$1 FOR UPDATE',[id]);pending=request('bob','DELETE',`${base}/messages/${message}`);
      let waiting=false;for(let i=0;i<100&&!waiting;i++){waiting=!!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'SELECT c.* FROM channels c WHERE c.id=$2%' AND wait_event_type='Lock'")).rowCount;if(!waiting)await new Promise(r=>setTimeout(r,10));}assert.equal(waiting,true);
      await lock.query("UPDATE channel_preservation SET active=true,revision=revision+1 WHERE channel_id=$1",[id]);await lock.query('COMMIT');assert.equal((await pending).statusCode,409);
    }finally{await lock.query('ROLLBACK');lock.release();if(pending)await pending;}
    assert.equal((await change(false,4)).statusCode,200);assert.equal((await request('bob','DELETE',`${base}/messages/${message}`)).statusCode,200);assert.equal((await request('alice','DELETE',`${base}/files/${file}`)).statusCode,200);
    const audits=(await pool.query("SELECT metadata FROM audit WHERE org_id=$1 AND action='channel.preservation_changed' AND target=$2 ORDER BY id",[org,id])).rows;assert.deepEqual(audits.map(r=>r.metadata),[{active:true,revision:1},{active:true,revision:2},{active:false,revision:3},{active:false,revision:5}]);assert.ok(!JSON.stringify(audits).includes(note));
    // A current owner losing role while a hold operation waits cannot use its earlier authority snapshot.
    const roleLock=await pool.connect();let hold:ReturnType<typeof change>|undefined;
    try{await roleLock.query('BEGIN');await roleLock.query('SELECT user_id FROM memberships WHERE org_id=$1 AND user_id=$2 FOR UPDATE',[org,ids.alice]);hold=change(true,5);
      let waiting=false;for(let i=0;i<100&&!waiting;i++){waiting=!!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'SELECT role FROM memberships WHERE org_id=%' AND wait_event_type='Lock'")).rowCount;if(!waiting)await new Promise(r=>setTimeout(r,10));}assert.equal(waiting,true);await roleLock.query("UPDATE memberships SET role='admin' WHERE org_id=$1 AND user_id=$2",[org,ids.alice]);await roleLock.query('COMMIT');assert.equal((await hold).statusCode,403);
    }finally{await roleLock.query('ROLLBACK');roleLock.release();if(hold)await hold;await pool.query("UPDATE memberships SET role='owner' WHERE org_id=$1 AND user_id=$2",[org,ids.alice]);}
  }finally{
    const {rm}=await import('node:fs/promises'),{fileRoot}=await import('../services/core/file-content.ts');for(const f of files)await rm(`${fileRoot()}/${f}`,{force:true});
    await pool.query('DELETE FROM file_scan_jobs WHERE file_id=ANY($1::uuid[])',[files]);
    for(const id of channels){for(const table of ['channel_preservation','message_reports','files','messages','drafts','channel_preferences','read_positions','channel_members','outbox'])await pool.query(`DELETE FROM ${table} WHERE channel_id=$1`,[id]);await pool.query('DELETE FROM channels WHERE id=$1',[id]);}
    await pool.query('DELETE FROM audit WHERE org_id=$1',[org]);await pool.query('DELETE FROM team_members WHERE org_id=$1',[org]);await pool.query('DELETE FROM teams WHERE org_id=$1',[org]);await pool.query('DELETE FROM memberships WHERE org_id=$1',[org]);await pool.query('DELETE FROM organizations WHERE id=$1',[org]);
    await isolated.close();
  }
});

test('manual message retention bounds exact approved batches, honors current owner/hold state and retains files/reference metadata',async()=>{
  const isolated=await createApp(),request=(user:string,method:'GET'|'POST'|'PUT'|'PATCH'|'DELETE',url:string,payload?:unknown)=>isolated.inject({method,url,headers:{origin,cookie:cookies[user]},payload:payload as Record<string,unknown>});
  const org=randomUUID(),team=randomUUID(),channels:string[]=[],old=Array.from({length:101},()=>randomUUID()),recent=randomUUID(),deleted=randomUUID(),file=randomUUID(),report=randomUUID();
  try{
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Message retention verification')",[org]);await pool.query("INSERT INTO memberships(org_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'guest')",[org,ids.alice,ids.bob,ids.guest]);await pool.query("INSERT INTO teams(id,org_id,name) VALUES($1,$2,'Retention team')",[team,org]);await pool.query("INSERT INTO team_members VALUES($1,$2,$3,'owner')",[org,team,ids.alice]);
    for(const kind of ['private','standard','shared']){const r=await request('alice','POST',`/v1/organizations/${org}/channels`,{name:`Retention ${kind}`,kind,teamId:team,members:[ids.bob,ids.guest]});assert.equal(r.statusCode,200);channels.push(r.json().id);}
    const id=channels[0],base=`/v1/channels/${id}`,url=`${base}/message-retention`,policy=async()=>(await request('alice','GET',url)).json(),preview=async()=>(await request('alice','GET',url+'/preview')).json(),save=(days:number|null,expectedRevision:number)=>request('alice','PUT',url,{days,expectedRevision,confirm:true}),apply=(p:Record<string,unknown>,user='alice')=>request(user,'POST',url+'/apply',{expectedRevision:p.policyRevision,asOf:p.asOf,token:p.token,confirm:true});
    assert.deepEqual(await policy(),{id,days:null,revision:0,held:false});assert.equal((await preview()).token,null);assert.equal((await save(null,0)).json().changed,false);
    for(const user of ['bob','guest'])for(const suffix of ['', '/preview'])assert.equal((await request(user,'GET',url+suffix)).statusCode,403);assert.equal((await request('eve','GET',url)).statusCode,404);
    assert.equal((await request('bob','PUT',url,{days:30,expectedRevision:0,confirm:true})).statusCode,403);
    await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[id,ids.alice]);assert.equal((await save(30,0)).statusCode,404);await pool.query('INSERT INTO channel_members VALUES($1,$2,$3)',[org,id,ids.alice]);
    for(const payload of [{days:0,expectedRevision:0,confirm:true},{days:3651,expectedRevision:0,confirm:true},{days:1.5,expectedRevision:0,confirm:true},{days:30,expectedRevision:0},{days:30,expectedRevision:0,confirm:true,extra:true}])assert.equal((await request('alice','PUT',url,payload)).statusCode,400);
    for(const other of channels.slice(1))assert.equal((await request('alice','PUT',`/v1/channels/${other}/message-retention`,{days:30,expectedRevision:0,confirm:true})).statusCode,200);
    await pool.query("INSERT INTO messages(id,org_id,channel_id,user_id,client_id,seq,body,created_at) SELECT mid,$2,$3,$4,mid,n,'Expired retention text '||n,now()-interval '40 days' FROM unnest($1::uuid[]) WITH ORDINALITY t(mid,n)",[old,org,id,ids.bob]);
    for(const [mid,seq,age,isDeleted] of [[recent,102,1,false],[deleted,103,60,true]] as const)await pool.query("INSERT INTO messages(id,org_id,channel_id,user_id,client_id,seq,body,created_at,deleted) VALUES($1,$2,$3,$4,$1,$5,$6,now()-$7*interval '1 day',$8)",[mid,org,id,ids.bob,seq,isDeleted?'':'Recent retention text',age,isDeleted]);
    await pool.query('UPDATE channels SET sequence=103 WHERE id=$1',[id]);await pool.query("UPDATE messages SET body=$2,format='markdown-v1',created_at=now()-interval '41 days' WHERE id=$1",[old[0],`Expired [Alice](concord-mention:${ids.alice})`]);await pool.query('INSERT INTO message_mentions VALUES($1,$2)',[old[0],ids.alice]);
    await pool.query("INSERT INTO files(id,org_id,channel_id,name,mime,bytes,storage_key,sha256,created_by) VALUES($1,$2,$3,'retained.txt','text/plain',1,($1::uuid)::text,$4,$5)",[file,org,id,'0'.repeat(64),ids.alice]);await pool.query('INSERT INTO message_attachments VALUES($1,$2)',[old[0],file]);await pool.query('UPDATE messages SET attachment_ids=$2 WHERE id=$1',[old[0],[file]]);await pool.query("INSERT INTO reactions VALUES($1,$2,'👍')",[old[0],ids.alice]);await pool.query('INSERT INTO saved_messages VALUES($1,$2)',[old[0],ids.alice]);await pool.query("INSERT INTO message_reports(id,org_id,channel_id,message_id,reporter_id,reason) VALUES($1,$2,$3,$4,$5,'other')",[report,org,id,old[0],ids.bob]);
    assert.equal((await save(30,0)).statusCode,200);assert.equal((await save(30,1)).json().changed,false);assert.equal((await save(20,0)).statusCode,409);assert.equal((await pool.query('SELECT 1 FROM messages WHERE channel_id=$1 AND deleted AND body<>\'\'',[id])).rowCount,0);assert.equal((await pool.query('SELECT 1 FROM messages WHERE channel_id=$1 AND NOT deleted',[id])).rowCount,102);
    let p=await preview();assert.equal(p.count,100);assert.equal(p.hasMore,true);assert.equal(p.held,false);assert.ok(!JSON.stringify(p).includes('Expired'));assert.ok(!JSON.stringify(p).includes(old[0]));
    for(const user of ['bob','guest'])assert.equal((await apply(p,user)).statusCode,403);assert.equal((await apply(p,'eve')).statusCode,404);
    for(const payload of [{expectedRevision:1,asOf:p.asOf,token:p.token},{expectedRevision:1,asOf:p.asOf,token:'bad',confirm:true},{expectedRevision:1,asOf:p.asOf,token:p.token,confirm:true,extra:true}])assert.equal((await request('alice','POST',url+'/apply',payload)).statusCode,400);
    assert.equal((await apply({...p,asOf:new Date(Date.now()+60000).toISOString()})).statusCode,409);assert.equal((await apply({...p,asOf:new Date(Date.now()-660000).toISOString()})).statusCode,409);
    assert.equal((await request('bob','PATCH',`${base}/messages/${old[0]}`,{body:'Edited after retention preview'})).statusCode,200);assert.equal((await apply(p)).statusCode,409);
    p=await preview();assert.equal((await save(31,1)).statusCode,200);assert.equal((await apply(p)).statusCode,409);assert.equal((await save(null,2)).statusCode,200);assert.equal((await preview()).count,0);assert.equal((await save(30,3)).statusCode,200);
    p=await preview();const holdUrl=base+'/preservation';assert.equal((await request('alice','PUT',holdUrl,{active:true,reason:'Hold blocks retention',expectedRevision:0,confirm:true})).statusCode,200);assert.equal((await preview()).held,true);assert.equal((await preview()).token,null);assert.equal((await apply(p)).statusCode,409);await request('alice','PUT',holdUrl,{active:false,reason:'Hold blocks retention',expectedRevision:1,confirm:true});assert.equal((await apply(p)).statusCode,409);
    // Preserve mention/reference records for the actual eligible batch after testing stale edits.
    await pool.query('INSERT INTO message_mentions VALUES($1,$2)',[old[0],ids.alice]);
    p=await preview();await pool.query('UPDATE channels SET archived=true WHERE id=$1',[id]);const raced=await Promise.all([apply(p),apply(p)]);assert.deepEqual(raced.map(r=>r.statusCode).sort(),[200,409]);assert.equal(raced.find(r=>r.statusCode===200)!.json().count,100);assert.equal((await apply(p)).statusCode,409);p=await preview();assert.equal(p.count,1);assert.equal(p.hasMore,false);assert.equal((await apply(p)).json().count,1);assert.equal((await preview()).token,null);
    assert.equal((await pool.query('SELECT body FROM messages WHERE id=$1',[recent])).rows[0].body,'Recent retention text');assert.equal((await pool.query('SELECT 1 FROM messages WHERE id=ANY($1::uuid[]) AND deleted AND body=\'\'',[old])).rowCount,101);assert.equal((await pool.query('SELECT sequence FROM channels WHERE id=$1',[id])).rows[0].sequence,'103');
    assert.equal((await pool.query('SELECT 1 FROM message_mentions WHERE message_id=ANY($1::uuid[])',[old])).rowCount,0);assert.equal((await pool.query('SELECT 1 FROM message_attachments WHERE message_id=$1',[old[0]])).rowCount,1);assert.equal((await pool.query('SELECT state FROM files WHERE id=$1',[file])).rows[0].state,'quarantined');for(const table of ['reactions','saved_messages'])assert.equal((await pool.query(`SELECT 1 FROM ${table} WHERE message_id=$1`,[old[0]])).rowCount,1);assert.equal((await pool.query('SELECT status FROM message_reports WHERE id=$1',[report])).rows[0].status,'open');
    assert.equal((await pool.query("SELECT 1 FROM outbox WHERE channel_id=$1 AND type='message.deleted'",[id])).rowCount,101);const audits=(await pool.query("SELECT metadata FROM audit WHERE target=$1 AND action='channel.message_retention_applied' ORDER BY id",[id])).rows;assert.deepEqual(audits.map(r=>r.metadata.count),[100,1]);assert.ok(audits.every(r=>Object.keys(r.metadata).sort().join(',')==='asOf,count,policyRevision'));assert.ok(!JSON.stringify(audits).includes('Edited after'));
    // Make one new eligible fixture, then fence a pending batch with a hold commit.
    await pool.query("UPDATE messages SET created_at=now()-interval '40 days' WHERE id=$1",[recent]);p=await preview();const lock=await pool.connect();let pending:ReturnType<typeof apply>|undefined;
    try{await lock.query('BEGIN');await lock.query('SELECT id FROM channels WHERE id=$1 FOR UPDATE',[id]);pending=apply(p);let waiting=false;for(let i=0;i<100&&!waiting;i++){waiting=!!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'SELECT c.* FROM channels c WHERE c.id=$2%' AND wait_event_type='Lock'")).rowCount;if(!waiting)await new Promise(r=>setTimeout(r,10));}assert.equal(waiting,true);await lock.query('UPDATE channel_preservation SET active=true,revision=revision+1 WHERE channel_id=$1',[id]);await lock.query('COMMIT');assert.equal((await pending).statusCode,409);}finally{await lock.query('ROLLBACK');lock.release();if(pending)await pending;}
    await request('alice','PUT',holdUrl,{active:false,reason:'Hold blocks retention',expectedRevision:3,confirm:true});p=await preview();const roleLock=await pool.connect();let revoked:ReturnType<typeof apply>|undefined;
    try{await roleLock.query('BEGIN');await roleLock.query('SELECT user_id FROM memberships WHERE org_id=$1 AND user_id=$2 FOR UPDATE',[org,ids.alice]);revoked=apply(p);let waiting=false;for(let i=0;i<100&&!waiting;i++){waiting=!!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'SELECT role FROM memberships WHERE org_id=%' AND wait_event_type='Lock'")).rowCount;if(!waiting)await new Promise(r=>setTimeout(r,10));}assert.equal(waiting,true);await roleLock.query("UPDATE memberships SET role='admin' WHERE org_id=$1 AND user_id=$2",[org,ids.alice]);await roleLock.query('COMMIT');assert.equal((await revoked).statusCode,403);}finally{await roleLock.query('ROLLBACK');roleLock.release();if(revoked)await revoked;}
    assert.equal((await pool.query('SELECT deleted FROM messages WHERE id=$1',[recent])).rows[0].deleted,false);
  }finally{
    for(const table of ['message_mentions','message_attachments','reactions','saved_messages'])await pool.query(`DELETE FROM ${table} WHERE message_id IN (SELECT id FROM messages WHERE channel_id=ANY($1::uuid[]))`,[channels]);
    for(const id of channels){for(const table of ['channel_message_retention','channel_preservation','message_reports','files','messages','drafts','channel_preferences','read_positions','channel_members','outbox'])await pool.query(`DELETE FROM ${table} WHERE channel_id=$1`,[id]);await pool.query('DELETE FROM channels WHERE id=$1',[id]);}
    for(const table of ['audit','team_members','teams','memberships'])await pool.query(`DELETE FROM ${table} WHERE org_id=$1`,[org]);await pool.query('DELETE FROM organizations WHERE id=$1',[org]);await isolated.close();
  }
});

test('manual file retention keeps families whole, fences scans and preserves recoverable bytes under current owner and hold rules',async()=>{
  const isolated=await createApp(),request=(user:string,method:'GET'|'POST'|'PUT'|'PATCH'|'DELETE',url:string,payload?:unknown)=>isolated.inject({method,url,headers:{origin,cookie:cookies[user]},payload:payload as Record<string,unknown>});
  const org=randomUUID(),team=randomUUID(),channels:string[]=[],files:string[]=[],real:string[]=[];
  const {runFileJob}=await import('../services/core/file-jobs.ts'),{readFile,rm}=await import('node:fs/promises'),{fileRoot}=await import('../services/core/file-content.ts');
  try{
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'File retention verification')",[org]);await pool.query("INSERT INTO memberships(org_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'guest')",[org,ids.alice,ids.bob,ids.guest]);await pool.query("INSERT INTO teams(id,org_id,name) VALUES($1,$2,'File retention team')",[team,org]);await pool.query("INSERT INTO team_members VALUES($1,$2,$3,'owner')",[org,team,ids.alice]);
    for(const kind of ['private','standard','shared']){const r=await request('alice','POST',`/v1/organizations/${org}/channels`,{name:`File retention ${kind}`,kind,teamId:team,members:[ids.bob,ids.guest]});assert.equal(r.statusCode,200);channels.push(r.json().id);}
    const id=channels[0],base=`/v1/channels/${id}`,url=base+'/file-retention',get=async()=>(await request('alice','GET',url)).json(),preview=async()=>(await request('alice','GET',url+'/preview')).json(),save=(days:number|null,expectedRevision:number)=>request('alice','PUT',url,{days,expectedRevision,confirm:true}),apply=(p:Record<string,unknown>,user='alice')=>request(user,'POST',url+'/apply',{expectedRevision:p.policyRevision,asOf:p.asOf,token:p.token,confirm:true});
    assert.deepEqual(await get(),{id,days:null,revision:0,held:false});assert.equal((await preview()).token,null);assert.equal((await save(null,0)).json().changed,false);
    for(const user of ['bob','guest'])for(const suffix of ['','/preview'])assert.equal((await request(user,'GET',url+suffix)).statusCode,403);assert.equal((await request('eve','GET',url)).statusCode,404);
    assert.equal((await request('bob','PUT',url,{days:30,expectedRevision:0,confirm:true})).statusCode,403);
    await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[id,ids.alice]);assert.equal((await save(30,0)).statusCode,404);await pool.query('INSERT INTO channel_members VALUES($1,$2,$3)',[org,id,ids.alice]);
    for(const payload of [{days:0,expectedRevision:0,confirm:true},{days:3651,expectedRevision:0,confirm:true},{days:1.5,expectedRevision:0,confirm:true},{days:30,expectedRevision:0},{days:30,expectedRevision:0,confirm:true,extra:true}])assert.equal((await request('alice','PUT',url,payload)).statusCode,400);
    for(const other of channels.slice(1))assert.equal((await request('alice','PUT',`/v1/channels/${other}/file-retention`,{days:30,expectedRevision:0,confirm:true})).statusCode,200);
    const upload=async(versionOf?:string)=>{const r=await request('bob','POST',base+'/files',{name:'retention-family.txt',mime:'text/plain',content:Buffer.from('Recoverable retention bytes').toString('base64'),...(versionOf?{versionOf}:{})});assert.equal(r.statusCode,200);const f=r.json().id;files.push(f);real.push(f);return f;};
    const original=await upload();await pool.query("UPDATE file_scan_jobs SET available_at='1900-01-01' WHERE file_id=$1",[original]);await runFileJob(async()=>({state:'ready',version:'test-only'}));const version=await upload(original);await pool.query("UPDATE file_scan_jobs SET available_at='1900-01-01' WHERE file_id=$1",[version]);await runFileJob(async()=>({state:'ready',version:'test-only'}));
    const message=(await request('bob','POST',base+'/messages',{clientId:randomUUID(),body:'Retained attachment reference',attachmentIds:[original]})).json().id;
    await pool.query("UPDATE files SET created_at=now()-interval '60 days' WHERE id=ANY($1::uuid[])",[real]);assert.equal((await save(30,0)).statusCode,200);assert.equal((await save(30,1)).json().changed,false);assert.equal((await save(20,0)).statusCode,409);
    let p=await preview();assert.equal(p.count,2);assert.equal(p.families,1);assert.ok(!JSON.stringify(p).includes(original));assert.ok(!JSON.stringify(p).includes('retention-family'));
    const recentVersion=await upload(original);assert.equal((await apply(p)).statusCode,409);assert.equal((await preview()).count,0);
    await request('bob','DELETE',`${base}/files/${recentVersion}`);assert.equal((await preview()).count,0,'A recently created deleted version still keeps family ineligible');await pool.query("UPDATE files SET created_at=now()-interval '60 days' WHERE id=$1",[recentVersion]);
    p=await preview();for(const user of ['bob','guest'])assert.equal((await apply(p,user)).statusCode,403);assert.equal((await apply(p,'eve')).statusCode,404);
    for(const payload of [{expectedRevision:1,asOf:p.asOf,token:p.token},{expectedRevision:1,asOf:p.asOf,token:'bad',confirm:true},{expectedRevision:1,asOf:p.asOf,token:p.token,confirm:true,extra:true}])assert.equal((await request('alice','POST',url+'/apply',payload)).statusCode,400);
    assert.equal((await apply({...p,asOf:new Date(Date.now()+60000).toISOString()})).statusCode,409);assert.equal((await apply({...p,asOf:new Date(Date.now()-660000).toISOString()})).statusCode,409);
    assert.equal((await save(31,1)).statusCode,200);assert.equal((await apply(p)).statusCode,409);assert.equal((await save(null,2)).statusCode,200);assert.equal((await preview()).count,0);assert.equal((await save(30,3)).statusCode,200);
    p=await preview();const holdUrl=base+'/preservation',hold=(active:boolean,expectedRevision:number)=>request('alice','PUT',holdUrl,{active,reason:'File retention hold',expectedRevision,confirm:true});await hold(true,0);assert.equal((await preview()).held,true);assert.equal((await preview()).token,null);assert.equal((await apply(p)).statusCode,409);await hold(false,1);assert.equal((await apply(p)).statusCode,409);
    // Snapshot every version row: changed scan/storage state invalidates prior approval.
    p=await preview();await pool.query("UPDATE files SET state='quarantined' WHERE id=$1",[original]);assert.equal((await apply(p)).statusCode,409);
    const insert=async(age:number,root:string|null=null,n=1,state='quarantined')=>{const f=randomUUID();files.push(f);await pool.query("INSERT INTO files(id,org_id,channel_id,name,mime,bytes,storage_key,sha256,created_by,created_at,revision_root,revision_number,state) VALUES($1,$2,$3,'synthetic.txt','text/plain',1,($1::uuid)::text,$4,$5,now()-$6*interval '1 day',$7,$8,$9)",[f,org,id,'0'.repeat(64),ids.bob,age,root,n,state]);return f;};
    const singles=[];for(let i=0;i<97;i++)singles.push(await insert(50));const three=await insert(40);const family=[three,await insert(40,three,2),await insert(40,three,3)];const fresh=await insert(1),recentFamily=await insert(60);await insert(1,recentFamily,2,'deleted');
    for(const f of [...singles,...family])await pool.query("INSERT INTO file_scan_jobs(file_id,status,lease_id,lease_until) VALUES($1,'running',$2,now()+interval '1 hour')",[f,randomUUID()]);
    p=await preview();assert.equal(p.count,99);assert.equal(p.families,98);assert.equal(p.hasMore,true);assert.equal(p.bytes,2*Buffer.byteLength('Recoverable retention bytes')+97);
    // A verdict begun before batch deletion cannot resurrect a deleted file.
    await pool.query("UPDATE file_scan_jobs SET status='queued',available_at='1900-01-01',lease_id=NULL,lease_until=NULL WHERE file_id=$1",[original]);let scanned=false;
    await runFileJob(async bytes=>{scanned=true;assert.equal(bytes.toString(),'Recoverable retention bytes');const races=await Promise.all([apply(p),apply(p)]);assert.deepEqual(races.map(r=>r.statusCode).sort(),[200,409]);return {state:'ready',version:'stale-retention-verdict'};});assert.equal(scanned,true);
    assert.equal((await pool.query('SELECT state,lifecycle_revision FROM files WHERE id=$1',[original])).rows[0].state,'deleted');assert.equal((await request('bob','GET',`${base}/files/${original}/download`)).statusCode,404);assert.equal((await apply(p)).statusCode,409);
    assert.equal((await pool.query('SELECT state FROM files WHERE id=$1',[three])).rows[0].state,'quarantined','Next family must remain whole');p=await preview();assert.equal(p.count,3);assert.equal(p.families,1);assert.equal(p.hasMore,false);await pool.query('UPDATE channels SET archived=true WHERE id=$1',[id]);assert.equal((await apply(p)).statusCode,200);await pool.query('UPDATE channels SET archived=false WHERE id=$1',[id]);assert.equal((await preview()).count,0);
    assert.equal((await pool.query('SELECT state FROM files WHERE id=$1',[fresh])).rows[0].state,'quarantined');assert.equal((await pool.query('SELECT state FROM files WHERE id=$1',[recentFamily])).rows[0].state,'quarantined');assert.equal((await pool.query('SELECT lifecycle_revision FROM files WHERE id=$1',[recentVersion])).rows[0].lifecycle_revision,2);
    const jobs=(await pool.query('SELECT status,lease_id,lease_until FROM file_scan_jobs WHERE file_id=ANY($1::uuid[])',[[original,version,...singles,...family]])).rows;assert.ok(jobs.every(j=>j.status==='cancelled'&&j.lease_id===null&&j.lease_until===null));
    assert.equal((await pool.query('SELECT body FROM messages WHERE id=$1',[message])).rows[0].body,'Retained attachment reference');assert.equal((await pool.query('SELECT 1 FROM message_attachments WHERE message_id=$1',[message])).rowCount,1);assert.equal((await readFile(`${fileRoot()}/${original}`)).toString(),'Recoverable retention bytes');
    const audits=(await pool.query("SELECT metadata FROM audit WHERE target=$1 AND action='channel.file_retention_applied' ORDER BY id",[id])).rows;assert.deepEqual(audits.map(a=>a.metadata.count),[99,3]);assert.ok(audits.every(a=>Object.keys(a.metadata).sort().join(',')==='asOf,count,families,policyRevision'));assert.ok(!JSON.stringify(audits).includes('synthetic.txt'));
    const deleted=(await request('bob','GET',base+'/deleted-files')).json();assert.equal(deleted.files.length,100);assert.equal(deleted.hasMore,true);assert.deepEqual((await request('alice','GET',base+'/deleted-files')).json().files,[]);
    assert.equal((await request('alice','POST',`${base}/files/${original}/restore`,{expectedRevision:2,confirm:true})).statusCode,404);assert.equal((await request('bob','POST',`${base}/files/${version}/restore`,{expectedRevision:2,confirm:true})).statusCode,409);assert.equal((await request('bob','POST',`${base}/files/${original}/restore`,{expectedRevision:2,confirm:true})).statusCode,200);assert.equal((await request('bob','GET',`${base}/files/${original}/download`)).statusCode,409);await pool.query("UPDATE file_scan_jobs SET available_at='1900-01-01' WHERE file_id=$1",[original]);await runFileJob(async()=>({state:'ready',version:'fresh-retention-scan'}));assert.equal((await request('bob','GET',`${base}/files/${original}/download`)).body,'Recoverable retention bytes');
    // A hold committed while apply waits for channel lock fences the old preview.
    p=await preview();const lock=await pool.connect();let pending:ReturnType<typeof apply>|undefined;
    try{await lock.query('BEGIN');await lock.query('SELECT id FROM channels WHERE id=$1 FOR UPDATE',[id]);pending=apply(p);let waiting=false;for(let i=0;i<100&&!waiting;i++){waiting=!!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'SELECT c.* FROM channels c WHERE c.id=$2%' AND wait_event_type='Lock'")).rowCount;if(!waiting)await new Promise(r=>setTimeout(r,10));}assert.equal(waiting,true);await lock.query('UPDATE channel_preservation SET active=true,revision=revision+1 WHERE channel_id=$1',[id]);await lock.query('COMMIT');assert.equal((await pending).statusCode,409);}finally{await lock.query('ROLLBACK');lock.release();if(pending)await pending;}
    await hold(false,3);p=await preview();const roleLock=await pool.connect();let revoked:ReturnType<typeof apply>|undefined;
    try{await roleLock.query('BEGIN');await roleLock.query('SELECT user_id FROM memberships WHERE org_id=$1 AND user_id=$2 FOR UPDATE',[org,ids.alice]);revoked=apply(p);let waiting=false;for(let i=0;i<100&&!waiting;i++){waiting=!!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'SELECT role FROM memberships WHERE org_id=%' AND wait_event_type='Lock'")).rowCount;if(!waiting)await new Promise(r=>setTimeout(r,10));}assert.equal(waiting,true);await roleLock.query("UPDATE memberships SET role='admin' WHERE org_id=$1 AND user_id=$2",[org,ids.alice]);await roleLock.query('COMMIT');assert.equal((await revoked).statusCode,403);}finally{await roleLock.query('ROLLBACK');roleLock.release();if(revoked)await revoked;}
    assert.equal((await pool.query('SELECT state FROM files WHERE id=$1',[original])).rows[0].state,'ready');
  }finally{
    for(const f of real)await rm(`${fileRoot()}/${f}`,{force:true});await pool.query('DELETE FROM message_attachments WHERE message_id IN (SELECT id FROM messages WHERE org_id=$1)',[org]);await pool.query('DELETE FROM file_scan_jobs WHERE file_id=ANY($1::uuid[])',[files]);await pool.query('DELETE FROM files WHERE revision_root IS NOT NULL AND channel_id=ANY($1::uuid[])',[channels]);
    for(const id of channels){for(const table of ['channel_file_retention','channel_preservation','files','messages','drafts','channel_preferences','read_positions','channel_members','outbox'])await pool.query(`DELETE FROM ${table} WHERE channel_id=$1`,[id]);await pool.query('DELETE FROM channels WHERE id=$1',[id]);}
    for(const table of ['audit','team_members','teams','memberships'])await pool.query(`DELETE FROM ${table} WHERE org_id=$1`,[org]);await pool.query('DELETE FROM organizations WHERE id=$1',[org]);await isolated.close();
  }
});

test('deleted-file keyset pages preserve microseconds and ties, survive boundary removal and recheck uploader/channel access',async()=>{
  const isolated=await createApp(),request=(user:string,url:string)=>isolated.inject({url,headers:{origin,cookie:cookies[user]}}),org=randomUUID(),team=randomUUID(),channels:string[]=[],files:string[]=[],owned=Array.from({length:253},()=>randomUUID());
  try{
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Deleted file page verification')",[org]);await pool.query("INSERT INTO memberships(org_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",[org,ids.alice,ids.bob]);await pool.query("INSERT INTO teams(id,org_id,name) VALUES($1,$2,'Recovery pagination team')",[team,org]);await pool.query("INSERT INTO team_members VALUES($1,$2,$3,'owner')",[org,team,ids.alice]);
    for(let i=0;i<2;i++){const r=await isolated.inject({method:'POST',url:`/v1/organizations/${org}/channels`,headers:{origin,cookie:cookies.alice},payload:{name:'Recovery pages '+i,kind:'private',teamId:team,members:[ids.bob]}});assert.equal(r.statusCode,200);channels.push(r.json().id);}
    const id=channels[0],url=`/v1/channels/${id}/deleted-files`,encode=(cursor:{createdAt:string;id:string})=>'?'+new URLSearchParams({beforeCreated:cursor.createdAt,beforeId:cursor.id}).toString();
    const insert=async(values:string[],user:string,channelId=id)=>{files.push(...values);await pool.query("INSERT INTO files(id,org_id,channel_id,name,mime,bytes,storage_key,sha256,state,created_by,created_at) SELECT x,$2,$3,'page.txt','text/plain',1,x::text,'not-exposed','deleted',$4,'2026-01-01T00:00:00Z'::timestamptz+(n%3)*interval '1 microsecond' FROM unnest($1::uuid[]) WITH ORDINALITY t(x,n)",[values,org,channelId,user]);};
    await insert(owned,ids.alice);const bob=Array.from({length:3},()=>randomUUID()),other=Array.from({length:5},()=>randomUUID());await insert(bob,ids.bob);await insert(other,ids.alice,channels[1]);
    const before=await pool.query('SELECT (SELECT count(*) FROM audit WHERE org_id=$1) audits,(SELECT count(*) FROM outbox WHERE org_id=$1) events',[org]);
    const first=await request('alice',url);assert.equal(first.statusCode,200,first.body);let page=first.json();assert.equal(page.files.length,100);assert.equal(page.hasMore,true);assert.match(page.nextCursor.createdAt,/\.000001Z$/);assert.deepEqual(Object.keys(page.files[0]).sort(),['id','name','bytes','revision_root','revision_number','lifecycle_revision'].sort());
    const expected=(await pool.query('SELECT id FROM files WHERE id=ANY($1::uuid[]) ORDER BY created_at DESC,id DESC',[owned])).rows.map(r=>r.id),seen=page.files.map((f:{id:string})=>f.id),boundary=page.nextCursor.id;
    await pool.query("UPDATE files SET state='ready' WHERE id=$1",[boundary]);
    const newer=randomUUID();files.push(newer);await pool.query("INSERT INTO files(id,org_id,channel_id,name,mime,bytes,storage_key,sha256,state,created_by,created_at) VALUES($1,$2,$3,'newer.txt','text/plain',1,($1::uuid)::text,'hidden','deleted',$4,'2026-01-02')",[newer,org,id,ids.alice]);
    for(let i=0;i<2;i++){const r=await request('alice',url+encode(page.nextCursor));assert.equal(r.statusCode,200,r.body);page=r.json();assert.equal(page.files.length,i===0?100:53);seen.push(...page.files.map((f:{id:string})=>f.id));}
    assert.deepEqual(seen,expected);assert.equal(new Set(seen).size,253);assert.equal(page.hasMore,false);assert.equal(page.nextCursor,null);assert.ok(!seen.includes(newer));assert.equal((await request('alice',url)).json().files[0].id,newer);
    const earliest=encode({createdAt:'2000-01-01T00:00:00.000000Z',id:randomUUID()});assert.deepEqual((await request('alice',url+earliest)).json(),{files:[],hasMore:false,nextCursor:null});
    for(const query of ['?beforeId='+randomUUID(),'?beforeCreated=2026-01-01T00%3A00%3A00Z','?beforeCreated=bad&beforeId='+randomUUID(),'?beforeCreated=0000-01-01T00%3A00%3A00Z&beforeId='+randomUUID(),'?beforeCreated=2026-01-01T00%3A00%3A00Z&beforeId=bad','?limit=101','?unknown=true'])assert.equal((await request('alice',url+query)).statusCode,400,query);
    assert.deepEqual((await request('bob',url)).json().files.map((f:{id:string})=>f.id).sort(),bob.sort());assert.equal((await request('eve',url+encode(first.json().nextCursor))).statusCode,404);
    const otherPage=(await request('alice',`/v1/channels/${channels[1]}/deleted-files`+encode({createdAt:'2099-01-01T00:00:00Z',id:boundary}))).json();assert.deepEqual(otherPage.files.map((f:{id:string})=>f.id).sort(),other.sort());
    await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[id,ids.alice]);assert.equal((await request('alice',url+encode(first.json().nextCursor))).statusCode,404);await pool.query('INSERT INTO channel_members VALUES($1,$2,$3)',[org,id,ids.alice]);
    await pool.query('UPDATE memberships SET active=false WHERE org_id=$1 AND user_id=$2',[org,ids.alice]);assert.equal((await request('alice',url)).statusCode,404);await pool.query('UPDATE memberships SET active=true WHERE org_id=$1 AND user_id=$2',[org,ids.alice]);
    assert.deepEqual((await pool.query('SELECT (SELECT count(*) FROM audit WHERE org_id=$1) audits,(SELECT count(*) FROM outbox WHERE org_id=$1) events',[org])).rows,before.rows);
  }finally{
    await pool.query('DELETE FROM files WHERE id=ANY($1::uuid[])',[files]);for(const id of channels){for(const table of ['drafts','channel_preferences','read_positions','channel_members','outbox'])await pool.query(`DELETE FROM ${table} WHERE channel_id=$1`,[id]);await pool.query('DELETE FROM channels WHERE id=$1',[id]);}for(const table of ['audit','team_members','teams','memberships'])await pool.query(`DELETE FROM ${table} WHERE org_id=$1`,[org]);await pool.query('DELETE FROM organizations WHERE id=$1',[org]);await isolated.close();
  }
});

test('original-file pages traverse ties and microseconds, exclude versions/deleted rows and recheck conversation access',async()=>{
  const isolated=await createApp(),request=(user:string,url:string)=>isolated.inject({url,headers:{origin,cookie:cookies[user]}}),org=randomUUID(),team=randomUUID(),channels:string[]=[],files:string[]=[],originals=Array.from({length:253},()=>randomUUID());
  try{
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Original file page verification')",[org]);await pool.query("INSERT INTO memberships(org_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",[org,ids.alice,ids.bob]);await pool.query("INSERT INTO teams(id,org_id,name) VALUES($1,$2,'Original file pagination team')",[team,org]);await pool.query("INSERT INTO team_members VALUES($1,$2,$3,'owner')",[org,team,ids.alice]);
    for(let i=0;i<2;i++){const r=await isolated.inject({method:'POST',url:`/v1/organizations/${org}/channels`,headers:{origin,cookie:cookies.alice},payload:{name:'Original pages '+i,kind:'private',teamId:team,members:[ids.bob]}});assert.equal(r.statusCode,200);channels.push(r.json().id);}
    const id=channels[0],url=`/v1/channels/${id}/files`,encode=(cursor:{createdAt:string;id:string})=>'?'+new URLSearchParams({beforeCreated:cursor.createdAt,beforeId:cursor.id}).toString();
    files.push(...originals);await pool.query("INSERT INTO files(id,org_id,channel_id,name,mime,bytes,storage_key,sha256,state,created_by,created_at) SELECT x,$2,$3,'original-page.txt','text/plain',1,x::text,'not-exposed','ready',CASE WHEN n%2=0 THEN $4::uuid ELSE $5::uuid END,'2026-01-01T00:00:00Z'::timestamptz+(n%3)*interval '1 microsecond' FROM unnest($1::uuid[]) WITH ORDINALITY t(x,n)",[originals,org,id,ids.alice,ids.bob]);
    const version=randomUUID(),deleted=randomUUID(),other=randomUUID();files.push(version,deleted,other);
    await pool.query("INSERT INTO files(id,org_id,channel_id,name,mime,bytes,storage_key,sha256,state,created_by,revision_root,revision_number) VALUES($1,$4,$5,'version.txt','text/plain',1,($1::uuid)::text,'private','ready',$7,$8,2),($2,$4,$5,'deleted.txt','text/plain',1,($2::uuid)::text,'private','deleted',$7,NULL,1),($3,$4,$6,'other.txt','text/plain',1,($3::uuid)::text,'private','ready',$7,NULL,1)",[version,deleted,other,org,id,channels[1],ids.bob,originals[0]]);
    await pool.query("UPDATE files SET state='quarantined' WHERE id=$1",[originals[1]]);await pool.query("INSERT INTO file_scan_jobs(file_id,status,attempts) VALUES($1,'dead',5)",[originals[1]]);await pool.query("UPDATE files SET state='rejected' WHERE id=$1",[originals[2]]);
    const before=(await pool.query('SELECT (SELECT count(*) FROM audit WHERE org_id=$1) audits,(SELECT count(*) FROM outbox WHERE org_id=$1) events',[org])).rows;
    const first=await request('alice',url);assert.equal(first.statusCode,200,first.body);let page=first.json();assert.equal(page.files.length,100);assert.equal(page.hasMore,true);assert.match(page.nextCursor.createdAt,/\.000001Z$/);assert.deepEqual(Object.keys(page.files[0]).sort(),['id','name','mime','bytes','state','created_at','created_by','revision_number','scan_status','attempts'].sort());
    assert.deepEqual((await request('bob',url)).json(),first.json());
    const expected=(await pool.query('SELECT id FROM files WHERE id=ANY($1::uuid[]) ORDER BY created_at DESC,id DESC',[originals])).rows.map(r=>r.id),seen=page.files.map((f:{id:string})=>f.id),allRows=[...page.files],boundary=page.nextCursor.id;
    await pool.query("UPDATE files SET state='deleted' WHERE id=$1",[boundary]);
    const newer=randomUUID();files.push(newer);await pool.query("INSERT INTO files(id,org_id,channel_id,name,mime,bytes,storage_key,sha256,state,created_by,created_at) VALUES($1,$2,$3,'newer.txt','text/plain',1,($1::uuid)::text,'not-exposed','ready',$4,'2026-01-02')",[newer,org,id,ids.alice]);
    for(let i=0;i<2;i++){const r=await request('bob',url+encode(page.nextCursor));assert.equal(r.statusCode,200,r.body);page=r.json();assert.equal(page.files.length,i===0?100:53);seen.push(...page.files.map((f:{id:string})=>f.id));allRows.push(...page.files);}
    assert.deepEqual(seen,expected);assert.equal(new Set(seen).size,253);assert.equal(page.hasMore,false);assert.equal(page.nextCursor,null);assert.ok(!seen.includes(newer));assert.ok(!seen.includes(version));assert.ok(!seen.includes(deleted));assert.ok(!seen.includes(other));assert.equal(allRows.find(f=>f.id===originals[1]).scan_status,'dead');assert.equal(allRows.find(f=>f.id===originals[1]).attempts,5);assert.equal(allRows.find(f=>f.id===originals[2]).state,'rejected');assert.equal((await request('alice',url)).json().files[0].id,newer);
    assert.deepEqual((await request('alice',url+encode({createdAt:'2000-01-01T00:00:00.000000Z',id:randomUUID()}))).json(),{files:[],hasMore:false,nextCursor:null});
    for(const query of ['?beforeId='+randomUUID(),'?beforeCreated=2026-01-01T00%3A00%3A00Z','?beforeCreated=bad&beforeId='+randomUUID(),'?beforeCreated=0000-01-01T00%3A00%3A00Z&beforeId='+randomUUID(),'?beforeCreated=2026-01-01T00%3A00%3A00Z&beforeId=bad','?limit=101','?unknown=true'])assert.equal((await request('alice',url+query)).statusCode,400,query);
    assert.equal((await request('eve',url+encode(first.json().nextCursor))).statusCode,404);assert.deepEqual((await request('alice',`/v1/channels/${channels[1]}/files`+encode({createdAt:'2099-01-01T00:00:00Z',id:boundary}))).json().files.map((f:{id:string})=>f.id),[other]);
    await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[id,ids.alice]);assert.equal((await request('alice',url+encode(first.json().nextCursor))).statusCode,404);await pool.query('INSERT INTO channel_members VALUES($1,$2,$3)',[org,id,ids.alice]);
    await pool.query('UPDATE memberships SET active=false WHERE org_id=$1 AND user_id=$2',[org,ids.bob]);assert.equal((await request('bob',url)).statusCode,404);await pool.query('UPDATE memberships SET active=true WHERE org_id=$1 AND user_id=$2',[org,ids.bob]);
    assert.deepEqual((await pool.query('SELECT (SELECT count(*) FROM audit WHERE org_id=$1) audits,(SELECT count(*) FROM outbox WHERE org_id=$1) events',[org])).rows,before);
  }finally{
    await pool.query('DELETE FROM file_scan_jobs WHERE file_id=ANY($1::uuid[])',[files]);await pool.query('DELETE FROM files WHERE revision_root IS NOT NULL AND channel_id=ANY($1::uuid[])',[channels]);await pool.query('DELETE FROM files WHERE id=ANY($1::uuid[])',[files]);for(const id of channels){for(const table of ['drafts','channel_preferences','read_positions','channel_members','outbox'])await pool.query(`DELETE FROM ${table} WHERE channel_id=$1`,[id]);await pool.query('DELETE FROM channels WHERE id=$1',[id]);}for(const table of ['audit','team_members','teams','memberships'])await pool.query(`DELETE FROM ${table} WHERE org_id=$1`,[org]);await pool.query('DELETE FROM organizations WHERE id=$1',[org]);await isolated.close();
  }
});

test('workspace filename search is literal, bounded, scoped, current-access checked and metadata-only',async()=>{
  const isolated=await createApp(),org=randomUUID(),team=randomUUID(),channels:string[]=[],files:string[]=[],token='Report%_Needle-'+randomUUID(),visible=Array.from({length:53},()=>randomUUID());
  const search=(user:string,q:string,extra:Record<string,string>={})=>isolated.inject({url:`/v1/organizations/${org}/search?`+new URLSearchParams({q,...extra}),headers:{origin,cookie:cookies[user]}});
  try{
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Filename search verification')",[org]);await pool.query("INSERT INTO memberships(org_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",[org,ids.alice,ids.bob]);await pool.query("INSERT INTO teams(id,org_id,name) VALUES($1,$2,'Filename search team')",[team,org]);await pool.query("INSERT INTO team_members VALUES($1,$2,$3,'owner')",[org,team,ids.alice]);
    for(let i=0;i<3;i++){const made=await isolated.inject({method:'POST',url:`/v1/organizations/${org}/channels`,headers:{origin,cookie:cookies.alice},payload:{name:'Filename scope '+i,kind:'private',teamId:team,members:i===2?[]:[ids.bob]}});assert.equal(made.statusCode,200);channels.push(made.json().id);}
    files.push(...visible);await pool.query("INSERT INTO files(id,org_id,channel_id,name,mime,bytes,storage_key,sha256,state,created_by,created_at) SELECT x,$2,$3,$4||'-'||n::text||'.txt','text/plain',1,x::text,'not-for-search','ready',$5,'2026-01-01T00:00:00Z'::timestamptz+(n%3)*interval '1 microsecond' FROM unnest($1::uuid[]) WITH ORDINALITY t(x,n)",[visible,org,channels[0],token,ids.alice]);
    await pool.query("UPDATE files SET state='quarantined' WHERE id=$1",[visible[1]]);await pool.query("UPDATE files SET state='rejected' WHERE id=$1",[visible[2]]);
    const other=randomUUID(),hidden=randomUUID(),deleted=randomUUID(),version=randomUUID(),decoy=randomUUID();files.push(other,hidden,deleted,version,decoy);
    for(const [id,channelId,state,root,name] of [[other,channels[1],'ready',null,token],[hidden,channels[2],'ready',null,token],[deleted,channels[0],'deleted',null,token],[version,channels[0],'ready',visible[0],token],[decoy,channels[0],'ready',null,token.replace('%_','XX')]] as const)await pool.query("INSERT INTO files(id,org_id,channel_id,name,mime,bytes,storage_key,sha256,state,created_by,revision_root,revision_number) VALUES($1,$2,$3,$4,'text/plain',1,($1::uuid)::text,'not-for-search',$5,$6,$7,$8)",[id,org,channelId,name,state,ids.alice,root,root?2:1]);
    const term='searchscope'+randomUUID().replaceAll('-','');for(const channelId of channels){const made=await isolated.inject({method:'POST',url:`/v1/channels/${channelId}/messages`,headers:{origin,cookie:cookies.alice},payload:{clientId:randomUUID(),body:term}});assert.equal(made.statusCode,201);}
    const before=(await pool.query('SELECT (SELECT count(*) FROM audit WHERE org_id=$1) audits,(SELECT count(*) FROM outbox WHERE org_id=$1) events',[org])).rows;
    let result=await search('bob',token.toUpperCase(),{type:'files'});assert.equal(result.statusCode,200,result.body);assert.equal(result.json().type,'files');assert.equal(result.json().results.length,50);assert.equal(result.json().hasMore,true);
    const expected=(await pool.query('SELECT id FROM files WHERE id=ANY($1::uuid[]) ORDER BY created_at DESC,id DESC LIMIT 50',[[...visible,other]])).rows.map(row=>row.id);assert.deepEqual(result.json().results.map((row:{id:string})=>row.id),expected);assert.deepEqual(Object.keys(result.json().results[0]).sort(),['id','name','mime','bytes','state','channel_id','channel_name','created_at'].sort());
    for(const name of [token,'%', '_']){result=await search('bob',name,{type:'files',channelId:channels[1]});assert.deepEqual(result.json().results.map((row:{id:string})=>row.id),[other]);assert.equal(result.json().hasMore,false);}
    assert.equal((await search('bob',token+'-2.txt',{type:'files'})).json().results[0].state,'quarantined');assert.equal((await search('bob',token+'-3.txt',{type:'files'})).json().results[0].state,'rejected');assert.deepEqual((await search('bob',term,{type:'files'})).json().results,[]);
    assert.equal((await search('bob',term)).json().type,'messages');assert.equal((await search('bob',term)).json().results.length,2);result=await search('bob',term,{channelId:channels[1]});assert.equal(result.json().results.length,1);assert.equal(result.json().results[0].channel_id,channels[1]);
    for(const type of ['files','messages']){assert.equal((await search('bob',token,{type,channelId:channels[2]})).statusCode,404);assert.equal((await search('bob',token,{type,channelId:ids.channel})).statusCode,404);}
    assert.equal((await search('eve',token,{type:'files'})).statusCode,404);
    for(const [q,extra] of [['',{type:'files'}],[' ',{type:'files'}],['x'.repeat(201),{type:'files'}],[token,{type:'people'}],[token,{type:'files',channelId:'bad'}],[token,{type:'files',unknown:'true'}],[token,{type:'files',limit:'100'}]] as [string,Record<string,string>][])assert.equal((await search('bob',q,extra)).statusCode,400);
    await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[channels[0],ids.bob]);assert.deepEqual((await search('bob',token,{type:'files'})).json().results.map((row:{id:string})=>row.id),[other]);assert.equal((await search('bob',token,{type:'files',channelId:channels[0]})).statusCode,404);
    await pool.query('UPDATE memberships SET active=false WHERE org_id=$1 AND user_id=$2',[org,ids.bob]);assert.equal((await search('bob',token,{type:'files'})).statusCode,404);await pool.query('UPDATE memberships SET active=true WHERE org_id=$1 AND user_id=$2',[org,ids.bob]);
    assert.deepEqual((await pool.query('SELECT (SELECT count(*) FROM audit WHERE org_id=$1) audits,(SELECT count(*) FROM outbox WHERE org_id=$1) events',[org])).rows,before);
  }finally{
    await pool.query('DELETE FROM files WHERE revision_root IS NOT NULL AND channel_id=ANY($1::uuid[])',[channels]);await pool.query('DELETE FROM files WHERE id=ANY($1::uuid[])',[files]);for(const channelId of channels){for(const table of ['messages','drafts','channel_preferences','read_positions','channel_members','outbox'])await pool.query(`DELETE FROM ${table} WHERE channel_id=$1`,[channelId]);await pool.query('DELETE FROM channels WHERE id=$1',[channelId]);}for(const table of ['audit','team_members','teams','memberships'])await pool.query(`DELETE FROM ${table} WHERE org_id=$1`,[org]);await pool.query('DELETE FROM organizations WHERE id=$1',[org]);await isolated.close();
  }
});

test('message and filename search pages preserve exact boundaries, survive mutation and never expand query or access scope',async()=>{
  const isolated=await createApp(),org=randomUUID(),team=randomUUID(),channels:string[]=[],token='searchpages'+randomUUID().replaceAll('-','');
  const fetch=(type:string,params:Record<string,string>={},user='bob')=>isolated.inject({url:`/v1/organizations/${org}/search?`+new URLSearchParams({q:token,type,...params}),headers:{origin,cookie:cookies[user]}});
  try{
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Search page verification')",[org]);await pool.query("INSERT INTO memberships(org_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",[org,ids.alice,ids.bob]);await pool.query("INSERT INTO teams(id,org_id,name) VALUES($1,$2,'Search page team')",[team,org]);await pool.query("INSERT INTO team_members VALUES($1,$2,$3,'owner')",[org,team,ids.alice]);
    for(let i=0;i<3;i++){const made=await isolated.inject({method:'POST',url:`/v1/organizations/${org}/channels`,headers:{origin,cookie:cookies.alice},payload:{name:'Search pages '+i,kind:'private',teamId:team,members:i===2?[]:[ids.bob]}});assert.equal(made.statusCode,200);channels.push(made.json().id);}
    const before=(await pool.query('SELECT (SELECT count(*) FROM audit WHERE org_id=$1) audits,(SELECT count(*) FROM outbox WHERE org_id=$1) events',[org])).rows;
    for(const type of ['messages','files']){
      const table=type==='messages'?'messages':'files',values=Array.from({length:123},()=>randomUUID()),other=randomUUID(),hidden=randomUUID(),newer=randomUUID();
      if(type==='messages')await pool.query("INSERT INTO messages(id,org_id,channel_id,user_id,client_id,seq,body,created_at) SELECT x,$2,$3,$4,x,n,$5,'2026-01-01T00:00:00Z'::timestamptz+(n%3)*interval '1 microsecond' FROM unnest($1::uuid[]) WITH ORDINALITY t(x,n)",[values,org,channels[0],ids.alice,token]);
      else await pool.query("INSERT INTO files(id,org_id,channel_id,name,mime,bytes,storage_key,sha256,state,created_by,created_at) SELECT x,$2,$3,$4||'.txt','text/plain',1,x::text,'not-exposed','quarantined',$5,'2026-01-01T00:00:00Z'::timestamptz+(n%3)*interval '1 microsecond' FROM unnest($1::uuid[]) WITH ORDINALITY t(x,n)",[values,org,channels[0],token,ids.alice]);
      const insert=async(id:string,channelId:string,date:string)=>{if(type==='messages')await pool.query("INSERT INTO messages(id,org_id,channel_id,user_id,client_id,seq,body,created_at) VALUES($1,$2,$3,$4,$1,124,$5,$6)",[id,org,channelId,ids.alice,token,date]);else await pool.query("INSERT INTO files(id,org_id,channel_id,name,mime,bytes,storage_key,sha256,state,created_by,created_at) VALUES($1,$2,$3,$4,'text/plain',1,($1::uuid)::text,'not-exposed','quarantined',$5,$6)",[id,org,channelId,token,ids.alice,date]);};
      await insert(other,channels[1],'2020-01-01');await insert(hidden,channels[2],'2020-01-01');
      const expected=(await pool.query(`SELECT id FROM ${table} WHERE id=ANY($1::uuid[]) ORDER BY created_at DESC,id DESC`,[values])).rows.map(row=>row.id),first=await fetch(type,{channelId:channels[0]});assert.equal(first.statusCode,200,first.body);let page=first.json();assert.equal(page.results.length,50);assert.equal(page.hasMore,true);assert.match(page.nextCursor.createdAt,/\.000001Z$/);assert.ok(!('cursor_created' in page.results[0]));
      const seen=page.results.map((row:{id:string})=>row.id),boundary=page.nextCursor,encode=(cursor:{createdAt:string;id:string})=>({beforeCreated:cursor.createdAt,beforeId:cursor.id});
      if(type==='messages')await pool.query('UPDATE messages SET deleted=true WHERE id=$1',[boundary.id]);else await pool.query("UPDATE files SET state='deleted' WHERE id=$1",[boundary.id]);await insert(newer,channels[0],'2026-01-02');
      for(let index=0;index<2;index++){const result=await fetch(type,{channelId:channels[0],...encode(page.nextCursor)});assert.equal(result.statusCode,200,result.body);page=result.json();assert.equal(page.results.length,index===0?50:23);seen.push(...page.results.map((row:{id:string})=>row.id));}
      assert.deepEqual(seen,expected);assert.equal(new Set(seen).size,123);assert.equal(page.hasMore,false);assert.equal(page.nextCursor,null);assert.equal((await fetch(type,{channelId:channels[0]})).json().results[0].id,newer);
      const empty=await fetch(type,{channelId:channels[0],beforeCreated:'2000-01-01T00:00:00.000000Z',beforeId:randomUUID()});assert.deepEqual(empty.json(),{type,results:[],hasMore:false,nextCursor:null});
      assert.deepEqual((await fetch(type,{channelId:channels[1],...encode(boundary)})).json().results.map((row:{id:string})=>row.id),[other]);assert.deepEqual((await fetch(type,{q:'unmatched'+token,...encode(boundary)})).json().results,[]);
      for(const params of [{beforeId:boundary.id},{beforeCreated:boundary.createdAt},{beforeCreated:'bad',beforeId:boundary.id},{beforeCreated:'0000-01-01T00:00:00Z',beforeId:boundary.id},{beforeCreated:boundary.createdAt,beforeId:'bad'}] as Record<string,string>[])assert.equal((await fetch(type,params)).statusCode,400);
      assert.equal((await fetch(type,{...encode(boundary)},'eve')).statusCode,404);assert.equal((await fetch(type,{channelId:channels[2],...encode(boundary)})).statusCode,404);
      await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[channels[0],ids.bob]);assert.equal((await fetch(type,{channelId:channels[0],...encode(boundary)})).statusCode,404);assert.deepEqual((await fetch(type,{...encode(boundary)})).json().results.map((row:{id:string})=>row.id),[other]);await pool.query('INSERT INTO channel_members VALUES($1,$2,$3)',[org,channels[0],ids.bob]);
      await pool.query('UPDATE memberships SET active=false WHERE org_id=$1 AND user_id=$2',[org,ids.bob]);assert.equal((await fetch(type,{...encode(boundary)})).statusCode,404);await pool.query('UPDATE memberships SET active=true WHERE org_id=$1 AND user_id=$2',[org,ids.bob]);
    }
    assert.deepEqual((await pool.query('SELECT (SELECT count(*) FROM audit WHERE org_id=$1) audits,(SELECT count(*) FROM outbox WHERE org_id=$1) events',[org])).rows,before);
  }finally{
    for(const channelId of channels){for(const table of ['files','messages','drafts','channel_preferences','read_positions','channel_members','outbox'])await pool.query(`DELETE FROM ${table} WHERE channel_id=$1`,[channelId]);await pool.query('DELETE FROM channels WHERE id=$1',[channelId]);}for(const table of ['audit','team_members','teams','memberships'])await pool.query(`DELETE FROM ${table} WHERE org_id=$1`,[org]);await pool.query('DELETE FROM organizations WHERE id=$1',[org]);await isolated.close();
  }
});

test('exact linked message reads are scoped, minimized, current-access checked and withdraw deleted content/attachment names',async()=>{
  const isolated=await createApp(),org=randomUUID(),team=randomUUID(),channels:string[]=[],file=randomUUID();
  const counts=async()=>(await pool.query('SELECT (SELECT count(*) FROM audit WHERE org_id=$1) audits,(SELECT count(*) FROM outbox WHERE org_id=$1) events,(SELECT count(*) FROM read_positions r JOIN channels c ON c.id=r.channel_id WHERE c.org_id=$1) reads',[org])).rows;
  const get=async(user:string,message:string,channelId=channels[0],orgId:string=org,query='')=>{const before=await counts(),response=await isolated.inject({url:`/v1/organizations/${orgId}/channels/${channelId}/messages/${message}${query}`,headers:{origin,cookie:cookies[user]}});assert.deepEqual(await counts(),before);return response;};
  try{
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Linked message verification')",[org]);await pool.query("INSERT INTO memberships(org_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",[org,ids.alice,ids.bob]);await pool.query("INSERT INTO teams(id,org_id,name) VALUES($1,$2,'Linked message team')",[team,org]);await pool.query("INSERT INTO team_members VALUES($1,$2,$3,'owner')",[org,team,ids.alice]);
    for(let index=0;index<2;index++){const made=await isolated.inject({method:'POST',url:`/v1/organizations/${org}/channels`,headers:{origin,cookie:cookies.alice},payload:{name:'Linked scope '+index,kind:'private',teamId:team,members:index?[]:[ids.bob]}});assert.equal(made.statusCode,200);channels.push(made.json().id);}
    await pool.query("INSERT INTO files(id,org_id,channel_id,name,mime,bytes,storage_key,sha256,state,created_by) VALUES($1,$2,$3,'linked-metadata.txt','text/plain',1,($1::uuid)::text,$4,'ready',$5)",[file,org,channels[0],'0'.repeat(64),ids.alice]);
    const body=`**Linked** [Bob](concord-mention:${ids.bob})`,made=await isolated.inject({method:'POST',url:`/v1/channels/${channels[0]}/messages`,headers:{origin,cookie:cookies.alice},payload:{clientId:randomUUID(),body,format:'markdown-v1',attachmentIds:[file]}});assert.equal(made.statusCode,201,made.body);const id=made.json().id;
    let response=await get('bob',id);assert.equal(response.statusCode,200,response.body);assert.deepEqual(Object.keys(response.json().message).sort(),['id','body','format','created_at','edited_at','parent_id','name','mentions','attachments','saved'].sort());assert.deepEqual(response.json().channel,{id:channels[0],name:'Linked scope 0'});assert.equal(response.json().message.id,id);assert.equal(response.json().message.body,body);assert.equal(response.json().message.format,'markdown-v1');assert.equal(response.json().message.mentions[0].id,ids.bob);assert.deepEqual(response.json().message.attachments,[{id:file,name:'linked-metadata.txt',state:'ready'}]);
    assert.equal(response.json().message.saved,false);
    const save=async(user:string,saved:boolean,channelId=channels[0],query='',extra={})=>isolated.inject({method:'POST',url:`/v1/channels/${channelId}/messages/${id}/save${query}`,headers:{origin,cookie:cookies[user]},payload:{saved,...extra}});
    assert.equal((await save('bob',true)).statusCode,200);assert.equal((await get('bob',id)).json().message.saved,true);assert.equal((await get('alice',id)).json().message.saved,false);
    assert.equal((await save('alice',true)).statusCode,200);assert.equal((await save('bob',false)).statusCode,200);assert.equal((await get('bob',id)).json().message.saved,false);assert.equal((await get('alice',id)).json().message.saved,true);
    assert.equal((await save('eve',true)).statusCode,404);assert.equal((await save('bob',true,channels[1])).statusCode,404);assert.equal((await save('bob',true,channels[0],'?extra=1')).statusCode,400);assert.equal((await save('bob',true,channels[0],'',{extra:true})).statusCode,400);
    for(const args of [['eve',id,channels[0],org],['bob',id,channels[1],org],['alice',id,channels[0],ids.org],['bob',randomUUID(),channels[0],org]])assert.equal((await get(...args as [string,string,string,string])).statusCode,404);
    assert.equal((await get('bob',id,channels[0],org,'?unknown=true')).statusCode,400);assert.equal((await get('bob','bad')).statusCode,400);
    await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[channels[0],ids.bob]);assert.equal((await get('bob',id)).statusCode,404);await pool.query('INSERT INTO channel_members VALUES($1,$2,$3)',[org,channels[0],ids.bob]);await pool.query('UPDATE memberships SET active=false WHERE org_id=$1 AND user_id=$2',[org,ids.bob]);assert.equal((await get('bob',id)).statusCode,404);await pool.query('UPDATE memberships SET active=true WHERE org_id=$1 AND user_id=$2',[org,ids.bob]);
    await pool.query('UPDATE channels SET archived=true WHERE id=$1',[channels[0]]);assert.equal((await get('bob',id)).statusCode,200);await pool.query('UPDATE channels SET archived=false WHERE id=$1',[channels[0]]);
    for(const state of ['quarantined','deleted']){await pool.query('UPDATE files SET state=$1 WHERE id=$2',[state,file]);assert.deepEqual((await get('bob',id)).json().message.attachments,[{id:file,name:null,state:'unavailable'}]);}
    const changed=await isolated.inject({method:'PATCH',url:`/v1/channels/${channels[0]}/messages/${id}`,headers:{origin,cookie:cookies.alice},payload:{body:'Updated linked text'}});assert.equal(changed.statusCode,200);response=await get('bob',id);assert.equal(response.json().message.body,'Updated linked text');assert.deepEqual(response.json().message.mentions,[]);assert.ok(response.json().message.edited_at);
    assert.equal((await isolated.inject({method:'DELETE',url:`/v1/channels/${channels[0]}/messages/${id}`,headers:{origin,cookie:cookies.alice}})).statusCode,200);response=await get('bob',id);assert.equal(response.statusCode,404);assert.ok(!response.body.includes('Updated linked text'));assert.ok(!response.body.includes('linked-metadata.txt'));assert.equal((await save('bob',true)).statusCode,404);
  }finally{
    await pool.query('DELETE FROM saved_messages WHERE message_id IN(SELECT id FROM messages WHERE channel_id=ANY($1::uuid[]))',[channels]);
    await pool.query('DELETE FROM message_attachments WHERE file_id=$1',[file]);await pool.query('DELETE FROM files WHERE id=$1',[file]);for(const channelId of channels){for(const table of ['messages','drafts','channel_preferences','read_positions','channel_members','outbox'])await pool.query(`DELETE FROM ${table} WHERE channel_id=$1`,[channelId]);await pool.query('DELETE FROM channels WHERE id=$1',[channelId]);}for(const table of ['audit','team_members','teams','memberships'])await pool.query(`DELETE FROM ${table} WHERE org_id=$1`,[org]);await pool.query('DELETE FROM organizations WHERE id=$1',[org]);await isolated.close();
  }
});

test('exact file source reads minimize metadata and enforce original/current organization and conversation scope without writes',async()=>{
  const org=randomUUID(),team=randomUUID(),channels:string[]=[],root=randomUUID(),revision=randomUUID();
  const get=async(user='bob',file:string=root,channelId=channels[0],orgId:string=org,query='')=>{
    const counts=async()=>(await pool.query('SELECT (SELECT count(*) FROM audit WHERE org_id=$1) audits,(SELECT count(*) FROM outbox WHERE org_id=$1) events,(SELECT count(*) FROM read_positions r JOIN channels c ON c.id=r.channel_id WHERE c.org_id=$1) reads',[org])).rows;
    const before=await counts(),response=await request(user,'GET',`/v1/organizations/${orgId}/channels/${channelId}/files/${file}${query}`);assert.deepEqual(await counts(),before);return response;
  };
  try{
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Exact file verification')",[org]);await pool.query("INSERT INTO memberships(org_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",[org,ids.alice,ids.bob]);await pool.query("INSERT INTO teams(id,org_id,name) VALUES($1,$2,'Exact file team')",[team,org]);await pool.query("INSERT INTO team_members VALUES($1,$2,$3,'owner')",[org,team,ids.alice]);
    for(let i=0;i<2;i++){const made=await request('alice','POST',`/v1/organizations/${org}/channels`,{name:'Exact files '+i,kind:'private',teamId:team,members:i?[]:[ids.bob]});assert.equal(made.statusCode,200);channels.push(made.json().id);}
    for(const [id,parent,number] of [[root,null,1],[revision,root,2]])await pool.query("INSERT INTO files(id,org_id,channel_id,name,mime,bytes,storage_key,sha256,state,created_by,revision_root,revision_number) VALUES($1,$2,$3,'source.txt','text/plain',17,($1::uuid)::text,$4,'quarantined',$5,$6,$7)",[id,org,channels[0],'0'.repeat(64),ids.alice,parent,number]);
    let response=await get();assert.equal(response.statusCode,200,response.body);assert.deepEqual(Object.keys(response.json().file).sort(),['id','name','mime','bytes','state','created_at','scan_status'].sort());assert.equal(response.json().file.id,root);assert.equal(response.json().file.bytes,'17');assert.equal(response.json().file.state,'quarantined');assert.equal(response.json().file.scan_status,null);assert.deepEqual(response.json().channel,{id:channels[0],name:'Exact files 0'});
    for(const args of [['eve',root,channels[0],org],['bob',root,channels[1],org],['alice',root,channels[0],ids.org],['bob',revision,channels[0],org],['bob',randomUUID(),channels[0],org]])assert.equal((await get(...args as [string,string,string,string])).statusCode,404);
    assert.equal((await get('bob','bad')).statusCode,400);assert.equal((await get('bob',root,channels[0],org,'?unknown=1')).statusCode,400);
    await pool.query('UPDATE channels SET archived=true WHERE id=$1',[channels[0]]);assert.equal((await get()).statusCode,200);
    await pool.query('UPDATE memberships SET active=false WHERE org_id=$1 AND user_id=$2',[org,ids.bob]);assert.equal((await get()).statusCode,404);await pool.query('UPDATE memberships SET active=true WHERE org_id=$1 AND user_id=$2',[org,ids.bob]);
    await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[channels[0],ids.bob]);assert.equal((await get()).statusCode,404);await pool.query('INSERT INTO channel_members VALUES($1,$2,$3)',[org,channels[0],ids.bob]);
    await pool.query("UPDATE files SET state='deleted' WHERE id=$1 OR revision_root=$1",[root]);response=await get();assert.equal(response.statusCode,404);assert.ok(!response.body.includes('source.txt'));
  }finally{
    await pool.query('DELETE FROM files WHERE revision_root=$1',[root]);await pool.query('DELETE FROM files WHERE id=$1',[root]);for(const channelId of channels){for(const table of ['channel_preferences','read_positions','channel_members','outbox'])await pool.query(`DELETE FROM ${table} WHERE channel_id=$1`,[channelId]);await pool.query('DELETE FROM channels WHERE id=$1',[channelId]);}for(const table of ['audit','team_members','teams','memberships'])await pool.query(`DELETE FROM ${table} WHERE org_id=$1`,[org]);await pool.query('DELETE FROM organizations WHERE id=$1',[org]);
  }
});

test('saved message pages are personal, current-access scoped, bounded and read-only over exact cursor boundaries',async()=>{
  const isolated=await createApp(),request=(user:string,method:'GET'|'POST',url:string,payload?:unknown)=>isolated.inject({method,url,headers:{origin,cookie:cookies[user]},payload:payload as Record<string,unknown>});
  const org=randomUUID(),team=randomUUID(),channels:string[]=[],idsMade:string[]=Array.from({length:56},()=>randomUUID());
  const counts=async()=>(await pool.query('SELECT (SELECT count(*) FROM audit WHERE org_id=$1) audits,(SELECT count(*) FROM outbox WHERE org_id=$1) events,(SELECT count(*) FROM read_positions r JOIN channels c ON c.id=r.channel_id WHERE c.org_id=$1) reads',[org])).rows;
  const get=async(query='',user='bob',scope:string=org)=>{const before=await counts(),response=await request(user,'GET',`/v1/organizations/${scope}/saved-messages${query}`);assert.deepEqual(await counts(),before);return response;};
  const cursor=(value:{createdAt:string;id:string})=>'?'+new URLSearchParams({beforeCreated:value.createdAt,beforeId:value.id});
  try{
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Saved collection verification')",[org]);await pool.query("INSERT INTO memberships(org_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",[org,ids.alice,ids.bob]);await pool.query("INSERT INTO teams(id,org_id,name) VALUES($1,$2,'Saved team')",[team,org]);await pool.query("INSERT INTO team_members VALUES($1,$2,$3,'owner')",[org,team,ids.alice]);
    for(let i=0;i<2;i++){const made=await request('alice','POST',`/v1/organizations/${org}/channels`,{name:'Saved channel '+i,kind:'private',teamId:team,members:i?[]:[ids.bob]});assert.equal(made.statusCode,200);channels.push(made.json().id);}
    for(let i=0;i<56;i++){
      await pool.query("INSERT INTO messages(id,org_id,channel_id,user_id,client_id,seq,body,created_at,deleted) VALUES($1,$2,$3,$4,$1,$5,$6,'2020-01-01T00:00:00Z'::timestamptz + ($7::int * interval '1 microsecond'),$8)",[idsMade[i],org,channels[i===53?1:0],ids.alice,i+1,i===52?'x'.repeat(600):'Saved source '+i,i<3?0:i,i===54]);
      if(i!==55)await pool.query('INSERT INTO saved_messages VALUES($1,$2)',[idsMade[i],ids.bob]);else await pool.query('INSERT INTO saved_messages VALUES($1,$2)',[idsMade[i],ids.alice]);
    }
    const expected=(await pool.query("SELECT id FROM messages WHERE channel_id=$1 AND NOT deleted AND id<>$2 ORDER BY created_at DESC,id DESC",[channels[0],idsMade[55]])).rows.map(row=>row.id);
    const response=await get();assert.equal(response.statusCode,200,response.body);const first=response.json();assert.equal(first.messages.length,50);assert.equal(first.hasMore,true);assert.deepEqual(first.messages.map((row:{id:string})=>row.id),expected.slice(0,50));assert.equal(first.messages[0].excerpt.length,500);assert.deepEqual(Object.keys(first.messages[0]).sort(),['id','channel_id','channel_name','author','created_at','excerpt'].sort());assert.match(first.nextCursor.createdAt,/\.\d{6}Z$/);
    const older=(await get(cursor(first.nextCursor))).json();assert.deepEqual(older.messages.map((row:{id:string})=>row.id),expected.slice(50));assert.equal(older.hasMore,false);assert.equal(older.nextCursor,null);assert.equal(new Set([...first.messages,...older.messages].map(row=>row.id)).size,53);
    for(const bad of ['?beforeId='+idsMade[0],'?beforeCreated=2020-01-01T00:00:00Z','?beforeCreated=0000-01-01T00:00:00Z&beforeId='+idsMade[0],'?beforeCreated=bad&beforeId='+idsMade[0],'?beforeCreated=2020-01-01T00:00:00Z&beforeId=bad','?unknown=1'])assert.equal((await get(bad)).statusCode,400,bad);
    assert.equal((await get('','eve')).statusCode,404);assert.equal((await get('','bob','bad')).statusCode,400);assert.deepEqual((await get('','alice')).json().messages.map((row:{id:string})=>row.id),[idsMade[55]]);assert.equal((await get('','bob',ids.org)).json().messages.some((row:{id:string})=>idsMade.includes(row.id)),false);
    // Removed boundary and new arrivals do not invalidate the older position.
    await pool.query('DELETE FROM saved_messages WHERE message_id=$1 AND user_id=$2',[first.messages.at(-1).id,ids.bob]);assert.deepEqual((await get(cursor(first.nextCursor))).json().messages,older.messages);
    await pool.query('INSERT INTO saved_messages VALUES($1,$2)',[idsMade[55],ids.bob]);assert.equal((await get(cursor(first.nextCursor))).json().messages.some((row:{id:string})=>row.id===idsMade[55]),false);
    await pool.query('DELETE FROM saved_messages WHERE message_id=ANY($1::uuid[]) AND user_id=$2',[older.messages.map((row:{id:string})=>row.id),ids.bob]);assert.deepEqual((await get(cursor(first.nextCursor))).json(),{messages:[],hasMore:false,nextCursor:null});
    await pool.query('UPDATE channels SET archived=true WHERE id=$1',[channels[0]]);const archived=await get();assert.equal(archived.statusCode,200,archived.body);assert.ok(archived.json().messages.length>0);await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[channels[0],ids.bob]);assert.deepEqual((await get()).json().messages,[]);await pool.query('INSERT INTO channel_members VALUES($1,$2,$3)',[org,channels[0],ids.bob]);await pool.query('UPDATE memberships SET active=false WHERE org_id=$1 AND user_id=$2',[org,ids.bob]);assert.equal((await get()).statusCode,404);
  }finally{
    await pool.query('DELETE FROM saved_messages WHERE message_id=ANY($1::uuid[])',[idsMade]);for(const channelId of channels){for(const table of ['messages','channel_preferences','read_positions','channel_members','outbox'])await pool.query(`DELETE FROM ${table} WHERE channel_id=$1`,[channelId]);await pool.query('DELETE FROM channels WHERE id=$1',[channelId]);}for(const table of ['audit','team_members','teams','memberships'])await pool.query(`DELETE FROM ${table} WHERE org_id=$1`,[org]);await pool.query('DELETE FROM organizations WHERE id=$1',[org]);await isolated.close();
  }
});

test('mark unread rewinds only the current reader to a current nondeleted source, never advances, and emits only changed events',async()=>{
  const isolated=await createApp(),org=randomUUID(),team=randomUUID(),channels:string[]=[],mids=Array.from({length:3},()=>randomUUID());
  const req=(user:string,url:string,payload:unknown={})=>isolated.inject({method:'POST',url,headers:{origin,cookie:cookies[user]},payload:payload as Record<string,unknown>});
  const unread=(user='bob',mid:string=mids[1],channelId=channels[0],suffix='',payload:unknown={})=>req(user,`/v1/channels/${channelId}/messages/${mid}/unread${suffix}`,payload);
  const positions=async()=>(await pool.query('SELECT user_id,seq FROM read_positions WHERE channel_id=$1 ORDER BY user_id',[channels[0]])).rows;
  const events=async()=>Number((await pool.query('SELECT count(*) n FROM outbox WHERE channel_id=$1',[channels[0]])).rows[0].n);
  try{
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Unread source verification')",[org]);await pool.query("INSERT INTO memberships(org_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",[org,ids.alice,ids.bob]);await pool.query("INSERT INTO teams(id,org_id,name) VALUES($1,$2,'Unread team')",[team,org]);await pool.query("INSERT INTO team_members VALUES($1,$2,$3,'owner')",[org,team,ids.alice]);
    for(let i=0;i<2;i++){const created=await req('alice',`/v1/organizations/${org}/channels`,{name:'Unread source '+i,kind:'private',teamId:team,members:i?[]:[ids.bob]});assert.equal(created.statusCode,200);channels.push(created.json().id);}
    for(let i=0;i<3;i++)await pool.query("INSERT INTO messages(id,org_id,channel_id,user_id,client_id,seq,body) VALUES($1,$2,$3,$4,$1,$5,'Unread boundary fixture')",[mids[i],org,channels[0],ids.alice,i+1]);await pool.query('UPDATE channels SET sequence=3 WHERE id=$1',[channels[0]]);
    await pool.query('INSERT INTO read_positions VALUES($1,$2,3),($1,$3,3)',[channels[0],ids.alice,ids.bob]);let count=await events();const response=await unread();assert.equal(response.statusCode,200,response.body);assert.deepEqual(await positions(),[{user_id:ids.alice,seq:'3'},{user_id:ids.bob,seq:'1'}]);assert.equal(await events(),count+1);count=await events();assert.equal((await unread()).statusCode,200);assert.equal(await events(),count);
    assert.equal((await unread('bob',mids[2])).statusCode,200);assert.equal((await positions())[1].seq,'1');assert.equal(await events(),count);assert.equal((await unread('bob',mids[0])).statusCode,200);assert.equal((await positions())[1].seq,'0');assert.equal(await events(),count+1);
    assert.equal((await req('bob',`/v1/channels/${channels[0]}/read`,{seq:3})).statusCode,200);assert.equal((await positions())[1].seq,'3');
    const before=await positions();count=await events();for(const [user,mid,scope,suffix,body] of [['eve',mids[1],channels[0],'',{}],['bob',mids[1],channels[1],'',{}],['bob',randomUUID(),channels[0],'',{}],['bob','bad',channels[0],'',{}],['bob',mids[1],channels[0],'?unknown=1',{}],['bob',mids[1],channels[0],'',{seq:1}] ] as const)assert.ok([400,404].includes((await unread(user,mid,scope,suffix,body)).statusCode));assert.deepEqual(await positions(),before);assert.equal(await events(),count);
    await pool.query('UPDATE messages SET deleted=true WHERE id=$1',[mids[1]]);assert.equal((await unread()).statusCode,404);assert.deepEqual(await positions(),before);await pool.query('UPDATE messages SET deleted=false WHERE id=$1',[mids[1]]);
    await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[channels[0],ids.bob]);assert.equal((await unread()).statusCode,404);await pool.query('INSERT INTO channel_members VALUES($1,$2,$3)',[org,channels[0],ids.bob]);await pool.query('UPDATE memberships SET active=false WHERE org_id=$1 AND user_id=$2',[org,ids.bob]);assert.equal((await unread()).statusCode,404);await pool.query('UPDATE memberships SET active=true WHERE org_id=$1 AND user_id=$2',[org,ids.bob]);assert.deepEqual(await positions(),before);
    await pool.query('DELETE FROM read_positions WHERE channel_id=$1 AND user_id=$2',[channels[0],ids.bob]);count=await events();assert.equal((await unread()).statusCode,200);assert.deepEqual(await positions(),[{user_id:ids.alice,seq:'3'}]);assert.equal(await events(),count);
    await pool.query('UPDATE channels SET archived=true WHERE id=$1',[channels[0]]);assert.equal((await unread()).statusCode,200);
  }finally{
    for(const channelId of channels){for(const table of ['messages','channel_preferences','read_positions','channel_members','outbox'])await pool.query(`DELETE FROM ${table} WHERE channel_id=$1`,[channelId]);await pool.query('DELETE FROM channels WHERE id=$1',[channelId]);}for(const table of ['audit','team_members','teams','memberships'])await pool.query(`DELETE FROM ${table} WHERE org_id=$1`,[org]);await pool.query('DELETE FROM organizations WHERE id=$1',[org]);await isolated.close();
  }
});

test('personal conversation preferences merge strict partial fields atomically without changing access or drafts',async()=>{
  const isolated=await createApp(),org=randomUUID(),team=randomUUID(),channels:string[]=[];
  const patch=(user:string,payload:unknown,channelId=channels[0],suffix='')=>isolated.inject({method:'PATCH',url:`/v1/channels/${channelId}/preferences${suffix}`,headers:{origin,cookie:cookies[user]},payload:payload as Record<string,unknown>});
  const state=async()=>(await pool.query('SELECT user_id,pinned,muted,hidden FROM channel_preferences WHERE channel_id=$1 ORDER BY user_id',[channels[0]])).rows;
  const counts=async()=>(await pool.query('SELECT (SELECT count(*) FROM audit WHERE org_id=$1) audits,(SELECT count(*) FROM outbox WHERE org_id=$1) events,(SELECT count(*) FROM read_positions WHERE channel_id=$2) reads,(SELECT body FROM drafts WHERE channel_id=$2 AND user_id=$3) draft',[org,channels[0],ids.bob])).rows;
  try{
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Visibility preference verification')",[org]);await pool.query("INSERT INTO memberships(org_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",[org,ids.alice,ids.bob]);await pool.query("INSERT INTO teams(id,org_id,name) VALUES($1,$2,'Visibility team')",[team,org]);await pool.query("INSERT INTO team_members VALUES($1,$2,$3,'owner')",[org,team,ids.alice]);
    for(let i=0;i<2;i++){const response=await isolated.inject({method:'POST',url:`/v1/organizations/${org}/channels`,headers:{origin,cookie:cookies.alice},payload:{name:'Visibility scope '+i,kind:'private',teamId:team,members:i?[]:[ids.bob]}});assert.equal(response.statusCode,200);channels.push(response.json().id);}
    await pool.query("INSERT INTO drafts VALUES($1,$2,'Kept visibility draft',now())",[channels[0],ids.bob]);const before=await counts();
    assert.equal((await patch('bob',{hidden:true})).statusCode,200);assert.deepEqual(await state(),[{user_id:ids.bob,pinned:false,muted:false,hidden:true}]);
    const concurrent=await Promise.all([patch('bob',{pinned:true}),patch('bob',{muted:true})]);assert.ok(concurrent.every(response=>response.statusCode===200));assert.deepEqual(await state(),[{user_id:ids.bob,pinned:true,muted:true,hidden:true}]);
    assert.equal((await patch('alice',{pinned:false,muted:false,hidden:false})).statusCode,200);assert.equal((await patch('bob',{hidden:false})).statusCode,200);assert.deepEqual(await state(),[{user_id:ids.alice,pinned:false,muted:false,hidden:false},{user_id:ids.bob,pinned:true,muted:true,hidden:false}]);
    const snapshot=await state();for(const invalid of [{},{hidden:null},{hidden:'true'},{hidden:true,userId:ids.alice},{unknown:true}])assert.equal((await patch('bob',invalid)).statusCode,400);assert.equal((await patch('bob',{hidden:true},channels[0],'?unknown=1')).statusCode,400);assert.equal((await patch('bob',{hidden:true},'bad')).statusCode,400);assert.equal((await patch('eve',{hidden:true})).statusCode,404);assert.equal((await patch('bob',{hidden:true},channels[1])).statusCode,404);assert.deepEqual(await state(),snapshot);
    await pool.query('UPDATE channels SET archived=true WHERE id=$1',[channels[0]]);assert.equal((await patch('bob',{hidden:true})).statusCode,200);const boot=await isolated.inject({url:`/v1/organizations/${org}/bootstrap`,headers:{origin,cookie:cookies.bob}});assert.equal(boot.json().channels.find((row:{id:string})=>row.id===channels[0]).hidden,true);assert.equal(boot.json().channels.some((row:{id:string})=>row.id===channels[1]),false);
    await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[channels[0],ids.bob]);assert.equal((await patch('bob',{hidden:false})).statusCode,404);await pool.query('INSERT INTO channel_members VALUES($1,$2,$3)',[org,channels[0],ids.bob]);await pool.query('UPDATE memberships SET active=false WHERE org_id=$1 AND user_id=$2',[org,ids.bob]);assert.equal((await patch('bob',{hidden:false})).statusCode,404);assert.equal((await state())[1].hidden,true);assert.deepEqual(await counts(),before);
  }finally{
    for(const channelId of channels){for(const table of ['drafts','channel_preferences','read_positions','channel_members','outbox'])await pool.query(`DELETE FROM ${table} WHERE channel_id=$1`,[channelId]);await pool.query('DELETE FROM channels WHERE id=$1',[channelId]);}for(const table of ['audit','team_members','teams','memberships'])await pool.query(`DELETE FROM ${table} WHERE org_id=$1`,[org]);await pool.query('DELETE FROM organizations WHERE id=$1',[org]);await isolated.close();
  }
});

test('manual presence is personal and workspace scoped, survives heartbeats and expires under connected and stale TTL rules',async()=>{
  const isolated=await createApp(),org=randomUUID(),other=randomUUID();
  const post=(user:string,payload:unknown,scope=org)=>isolated.inject({method:'POST',url:`/v1/organizations/${scope}/presence`,headers:{origin,cookie:cookies[user]},payload:payload as Record<string,unknown>});
  const state=async(user='bob')=>{const r=await isolated.inject({url:`/v1/organizations/${org}/bootstrap`,headers:{origin,cookie:cookies[user]}});assert.equal(r.statusCode,200,r.body);return r.json().people as {id:string;presence:string}[];};
  const row=async(scope=org)=>(await pool.query('SELECT state,override_until,last_seen FROM presence WHERE org_id=$1 AND user_id=$2',[scope,ids.bob])).rows[0];
  try {
    for(const id of [org,other]){await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Presence override verification')",[id]);await pool.query("INSERT INTO memberships(org_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",[id,ids.alice,ids.bob]);}
    assert.equal((await post('alice',{})).statusCode,200);assert.equal((await post('bob',{},other)).statusCode,200);
    for(const value of ['available','busy','dnd','away','offline']) {
      assert.equal((await post('bob',{state:value,minutes:15})).statusCode,200);const before=await row();assert.equal(before.state,value);assert.ok(before.override_until.getTime()>Date.now()+14*60000);
      assert.equal((await post('bob',{})).statusCode,200);assert.equal((await row()).override_until.getTime(),before.override_until.getTime());const people=await state('alice');assert.equal(people.find(p=>p.id===ids.bob)?.presence,value);assert.equal(people.find(p=>p.id===ids.alice)?.presence,'available');assert.equal((await row(other)).state,'available');
    }
    await post('bob',{state:'dnd',minutes:480});const unchanged=await row();for(const payload of [{state:'invalid',minutes:15},{state:'away',minutes:0},{state:'away',minutes:481},{state:'away',minutes:1.5}])assert.equal((await post('bob',payload)).statusCode,400);assert.deepEqual(await row(),unchanged);
    await pool.query("UPDATE presence SET override_until=now()-interval '1 second',last_seen=now() WHERE org_id=$1 AND user_id=$2",[org,ids.bob]);assert.equal((await state()).find(p=>p.id===ids.bob)?.presence,'available');
    await post('bob',{state:'busy',minutes:60});await pool.query("UPDATE presence SET last_seen=now()-interval '61 seconds' WHERE org_id=$1 AND user_id=$2",[org,ids.bob]);assert.equal((await state('alice')).find(p=>p.id===ids.bob)?.presence,'offline');await post('bob',{});assert.equal((await state('alice')).find(p=>p.id===ids.bob)?.presence,'busy');
    assert.equal((await post('eve',{state:'dnd',minutes:15})).statusCode,404);await pool.query('UPDATE memberships SET active=false WHERE org_id=$1 AND user_id=$2',[org,ids.bob]);const inactive=await row();assert.equal((await post('bob',{state:'away',minutes:15})).statusCode,404);assert.deepEqual(await row(),inactive);assert.equal((await state('alice')).some(p=>p.id===ids.bob),false);
    assert.equal((await pool.query('SELECT count(*)::int n FROM audit WHERE org_id=ANY($1::uuid[])',[[org,other]])).rows[0].n,0);assert.equal((await pool.query('SELECT count(*)::int n FROM outbox WHERE org_id=ANY($1::uuid[])',[[org,other]])).rows[0].n,0);
  } finally {for(const id of [org,other]){for(const table of ['presence','memberships'])await pool.query(`DELETE FROM ${table} WHERE org_id=$1`,[id]);await pool.query('DELETE FROM organizations WHERE id=$1',[id]);}await isolated.close();}
});

test('own presence metadata is minimized and clearing an override is scoped, strict and heartbeat neutral',async()=>{
  const isolated=await createApp(),org=randomUUID(),other=randomUUID(),url=(scope:string=org)=>`/v1/organizations/${scope}/presence`;
  const call=(user:string,method:'GET'|'POST'|'DELETE',payload?:unknown,scope:string=org,query='')=>isolated.inject({method,url:url(scope)+query,headers:{origin,cookie:cookies[user]},payload:payload as Record<string,unknown>});
  const row=async(user=ids.bob,scope=org)=>(await pool.query('SELECT * FROM presence WHERE org_id=$1 AND user_id=$2',[scope,user])).rows[0];
  try {
    for(const id of [org,other]){await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Presence automatic verification')",[id]);await pool.query("INSERT INTO memberships(org_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",[id,ids.alice,ids.bob]);}
    let r=await call('bob','GET');assert.equal(r.statusCode,200,r.body);assert.deepEqual(r.json(),{org_id:org,user_id:ids.bob,state:'offline',override:null});assert.equal(await row(),undefined);assert.equal((await call('bob','DELETE',{})).statusCode,200);assert.equal(await row(),undefined);
    for(const [user,scope,state] of [['alice',org,'busy'],['bob',other,'away'],['bob',org,'dnd']] as const)assert.equal((await call(user,'POST',{state,minutes:60},scope)).statusCode,200);
    const before=await row(),alice=await row(ids.alice),outside=await row(ids.bob,other);r=await call('bob','GET');const value=r.json();assert.deepEqual(Object.keys(value).sort(),['org_id','user_id','state','override'].sort());assert.deepEqual(value,{org_id:org,user_id:ids.bob,state:'dnd',override:{state:'dnd',until:before.override_until.toISOString()}});assert.deepEqual(await row(),before);
    for(const payload of [{state:'available'},{userId:ids.alice},{confirm:true},null])assert.equal((await call('bob','DELETE',payload)).statusCode,400);assert.equal((await call('bob','DELETE')).statusCode,400);for(const method of ['GET','DELETE'] as const)assert.equal((await call('bob',method,method==='DELETE'?{}:undefined,org,'?userId='+ids.alice)).statusCode,400);assert.deepEqual(await row(),before);
    assert.equal((await call('bob','DELETE',{})).statusCode,200);const cleared=await row();assert.equal(cleared.state,'available');assert.equal(cleared.override_until,null);assert.equal(cleared.last_seen.getTime(),before.last_seen.getTime());assert.deepEqual((await call('bob','GET')).json(),{org_id:org,user_id:ids.bob,state:'available',override:null});assert.deepEqual(await row(ids.alice),alice);assert.deepEqual(await row(ids.bob,other),outside);await call('bob','DELETE',{});assert.deepEqual(await row(),cleared);
    await call('bob','POST',{state:'offline',minutes:15});await pool.query("UPDATE presence SET last_seen=now()-interval '61 seconds' WHERE org_id=$1 AND user_id=$2",[org,ids.bob]);r=await call('bob','GET');assert.equal(r.json().state,'offline');assert.equal(r.json().override.state,'offline');await call('bob','DELETE',{});assert.equal((await call('bob','GET')).json().state,'offline');
    await call('bob','POST',{state:'away',minutes:15});await pool.query("UPDATE presence SET override_until=now()-interval '1 second' WHERE org_id=$1 AND user_id=$2",[org,ids.bob]);assert.deepEqual((await call('bob','GET')).json(),{org_id:org,user_id:ids.bob,state:'available',override:null});
    for(const method of ['GET','DELETE'] as const)assert.equal((await call('eve',method,method==='DELETE'?{}:undefined)).statusCode,404);await pool.query('UPDATE memberships SET active=false WHERE org_id=$1 AND user_id=$2',[org,ids.bob]);const inactive=await row();for(const method of ['GET','DELETE'] as const)assert.equal((await call('bob',method,method==='DELETE'?{}:undefined)).statusCode,404);assert.deepEqual(await row(),inactive);
    for(const method of ['GET','DELETE'] as const)assert.equal((await call('alice',method,method==='DELETE'?{}:undefined,'bad')).statusCode,400);
    await pool.query('UPDATE users SET disabled=true WHERE id=$1',[ids.alice]);try{for(const method of ['GET','DELETE'] as const)assert.equal((await call('alice',method,method==='DELETE'?{}:undefined)).statusCode,401);assert.deepEqual(await row(ids.alice),alice);}finally{await pool.query('UPDATE users SET disabled=false WHERE id=$1',[ids.alice]);}
    for(const table of ['audit','outbox'])assert.equal((await pool.query(`SELECT count(*)::int n FROM ${table} WHERE org_id=ANY($1::uuid[])`,[[org,other]])).rows[0].n,0);
  } finally {for(const id of [org,other]){for(const table of ['presence','memberships'])await pool.query(`DELETE FROM ${table} WHERE org_id=$1`,[id]);await pool.query('DELETE FROM organizations WHERE id=$1',[id]);}await isolated.close();}
});

test('activity pages retain exact boundaries and current access without read side effects',async()=>{
  const isolated=await createApp(),request=(user:string,method:'GET'|'POST',url:string,payload?:unknown)=>isolated.inject({method,url,headers:{origin,cookie:cookies[user]},payload:payload as Record<string,unknown>});
  const org=randomUUID(),team=randomUUID(),channels:string[]=[],idsMade:string[]=Array.from({length:56},()=>randomUUID());
  const counts=async()=>(await pool.query('SELECT (SELECT count(*) FROM audit WHERE org_id=$1) audits,(SELECT count(*) FROM outbox WHERE org_id=$1) events,(SELECT count(*) FROM read_positions r JOIN channels c ON c.id=r.channel_id WHERE c.org_id=$1) reads',[org])).rows;
  const get=async(query='',user='bob',scope:string=org)=>{const before=await counts(),response=await request(user,'GET',`/v1/organizations/${scope}/activity${query}`);assert.deepEqual(await counts(),before);return response;};
  const cursor=(value:{createdAt:string;id:string})=>'?'+new URLSearchParams({beforeCreated:value.createdAt,beforeId:value.id});
  try{
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Saved collection verification')",[org]);await pool.query("INSERT INTO memberships(org_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",[org,ids.alice,ids.bob]);await pool.query("INSERT INTO teams(id,org_id,name) VALUES($1,$2,'Saved team')",[team,org]);await pool.query("INSERT INTO team_members VALUES($1,$2,$3,'owner')",[org,team,ids.alice]);
    for(let i=0;i<2;i++){const made=await request('alice','POST',`/v1/organizations/${org}/channels`,{name:'Saved channel '+i,kind:'private',teamId:team,members:i?[]:[ids.bob]});assert.equal(made.statusCode,200);channels.push(made.json().id);}
    for(let i=0;i<56;i++){
      await pool.query("INSERT INTO messages(id,org_id,channel_id,user_id,client_id,seq,body,created_at,deleted) VALUES($1,$2,$3,$4,$1,$5,$6,'2020-01-01T00:00:00Z'::timestamptz + ($7::int * interval '1 microsecond'),$8)",[idsMade[i],org,channels[i===53?1:0],i===55?ids.bob:ids.alice,i+1,i===52?'x'.repeat(600):'Saved source '+i,i<10?0:i,i===54]);

    }
    const expected=(await pool.query("SELECT id FROM messages WHERE channel_id=$1 AND NOT deleted AND id<>$2 ORDER BY created_at DESC,id DESC",[channels[0],idsMade[55]])).rows.map(row=>row.id);
    const response=await get();assert.equal(response.statusCode,200,response.body);const first=response.json();assert.equal(first.items.length,50);assert.equal(first.hasMore,true);assert.deepEqual(first.items.map((row:{id:string})=>row.id),expected.slice(0,50));assert.equal(first.items[0].body.length,600);assert.equal('cursor_created' in first.items[0],false);assert.match(first.nextCursor.createdAt,/\.\d{6}Z$/);
    const older=(await get(cursor(first.nextCursor))).json();assert.deepEqual(older.items.map((row:{id:string})=>row.id),expected.slice(50));assert.equal(older.hasMore,false);assert.equal(older.nextCursor,null);assert.equal(new Set([...first.items,...older.items].map(row=>row.id)).size,53);
    for(const bad of ['?beforeId='+idsMade[0],'?beforeCreated=2020-01-01T00:00:00Z','?beforeCreated=0000-01-01T00:00:00Z&beforeId='+idsMade[0],'?beforeCreated=bad&beforeId='+idsMade[0],'?beforeCreated=2020-01-01T00:00:00Z&beforeId=bad','?unknown=1'])assert.equal((await get(bad)).statusCode,400,bad);
    assert.equal((await get('','eve')).statusCode,404);assert.equal((await get('','bob','bad')).statusCode,400);assert.deepEqual((await get('','alice')).json().items.map((row:{id:string})=>row.id),[idsMade[55]]);assert.deepEqual((await get('?filter=mentions')).json().items,[]);assert.deepEqual((await get('?filter=replies')).json().items,[]);assert.equal((await get('','bob',ids.org)).json().items.some((row:{id:string})=>idsMade.includes(row.id)),false);
    // Removed boundary and new arrivals do not invalidate the older position.
    await pool.query('UPDATE messages SET deleted=true WHERE id=$1',[first.items.at(-1).id]);assert.deepEqual((await get(cursor(first.nextCursor))).json().items,older.items);
    await pool.query("UPDATE messages SET created_at=now() WHERE id=$1",[idsMade[52]]);assert.equal((await get(cursor(first.nextCursor))).json().items.some((row:{id:string})=>row.id===idsMade[55]),false);
    await pool.query('UPDATE messages SET deleted=true WHERE id=ANY($1::uuid[])',[older.items.map((row:{id:string})=>row.id)]);assert.deepEqual((await get(cursor(first.nextCursor))).json(),{items:[],hasMore:false,nextCursor:null});
    await pool.query('UPDATE channels SET archived=true WHERE id=$1',[channels[0]]);const archived=await get();assert.equal(archived.statusCode,200,archived.body);assert.ok(archived.json().items.length>0);await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[channels[0],ids.bob]);assert.deepEqual((await get()).json().items,[]);await pool.query('INSERT INTO channel_members VALUES($1,$2,$3)',[org,channels[0],ids.bob]);await pool.query('UPDATE memberships SET active=false WHERE org_id=$1 AND user_id=$2',[org,ids.bob]);assert.equal((await get()).statusCode,404);
  }finally{
    await pool.query('DELETE FROM saved_messages WHERE message_id=ANY($1::uuid[])',[idsMade]);for(const channelId of channels){for(const table of ['messages','channel_preferences','read_positions','channel_members','outbox'])await pool.query(`DELETE FROM ${table} WHERE channel_id=$1`,[channelId]);await pool.query('DELETE FROM channels WHERE id=$1',[channelId]);}for(const table of ['audit','team_members','teams','memberships'])await pool.query(`DELETE FROM ${table} WHERE org_id=$1`,[org]);await pool.query('DELETE FROM organizations WHERE id=$1',[org]);await isolated.close();
  }
});

test('notification preference patches preserve concurrent independent fields and opt-in cutoffs with strict own-state defaults',async()=>{
  const isolated=await createApp(),request=(user:string,method:'GET'|'PUT'|'PATCH',url:string,payload?:unknown)=>isolated.inject({method,url,headers:{origin,cookie:cookies[user]},payload:payload as Record<string,unknown>});
  const db=await pool.connect(),path='/v1/notification-settings';
  const patch=(payload:unknown,suffix='')=>request('bob','PATCH',path+suffix,payload);
  const snapshot=async()=>(await pool.query('SELECT row_to_json(s) value FROM notification_settings s WHERE user_id=$1',[ids.bob])).rows[0]?.value;
  const cutoffs=async()=>(await pool.query('SELECT enabled_at::text,replies_enabled_at::text,digest_since::text,digest_checked_at::text FROM notification_settings WHERE user_id=$1',[ids.bob])).rows[0];
  const counts=async()=>(await pool.query('SELECT (SELECT count(*) FROM audit) audits,(SELECT count(*) FROM outbox) events')).rows;
  await db.query('CREATE TEMP TABLE preference_patch_backup AS SELECT * FROM notification_settings WHERE user_id=$1',[ids.bob]);
  const other=(await request('eve','GET',path)).json(),before=await counts();
  try{
    await db.query('DELETE FROM notification_settings WHERE user_id=$1',[ids.bob]);
    const defaults=(await request('bob','GET',path)).json();assert.equal(defaults.browser_enabled,false);assert.equal(defaults.quiet_start,'22:00');
    assert.equal((await patch({quiet_start:'21:37'})).statusCode,200);const first=(await request('bob','GET',path)).json();assert.deepEqual(first,{...defaults,quiet_start:'21:37'});
    for(const payload of [{},{unknown:true},{user_id:ids.eve},{email_provider:'configured'},{enabled_at:'2000-01-01T00:00:00Z'},{digest_since:'2000-01-01T00:00:00Z'},{browser_enabled:'true'},{quiet_enabled:null},{quiet_start:'25:00'},{quiet_end:'1:00'},{digest_enabled:1},null]){
      const previous=await snapshot();assert.equal((await patch(payload)).statusCode,400,JSON.stringify(payload));assert.deepEqual(await snapshot(),previous);
    }
    assert.equal((await patch({quiet_enabled:true},'?unknown=1')).statusCode,400);
    await pool.query("UPDATE notification_settings SET browser_enabled=false,browser_replies_enabled=false,digest_enabled=false,enabled_at='2000-01-01',replies_enabled_at='2000-01-01',digest_since='2000-01-01',digest_checked_at='2001-01-01' WHERE user_id=$1",[ids.bob]);
    const original=await cutoffs();assert.equal((await patch({quiet_enabled:true})).statusCode,200);assert.deepEqual(await cutoffs(),original);
    assert.equal((await patch({browser_enabled:true,browser_replies_enabled:true,digest_enabled:true})).statusCode,200);const enabled=await cutoffs();for(const field of ['enabled_at','replies_enabled_at','digest_since'])assert.ok(enabled[field]>original[field]);assert.equal(enabled.digest_checked_at,'-infinity');
    assert.equal((await patch({browser_enabled:true,browser_replies_enabled:true,digest_enabled:true})).statusCode,200);assert.deepEqual(await cutoffs(),enabled);
    const results=await Promise.all([patch({quiet_start:'20:15'}),patch({quiet_end:'07:45'})]);assert.deepEqual(results.map(r=>r.statusCode),[200,200]);const combined=(await request('bob','GET',path)).json();assert.equal(combined.quiet_start,'20:15');assert.equal(combined.quiet_end,'07:45');assert.equal(combined.digest_enabled,true);assert.deepEqual(await cutoffs(),enabled);
    assert.equal((await request('bob','PUT',path,{browser_enabled:false,quiet_enabled:false,quiet_start:'22:00',quiet_end:'08:00'})).statusCode,200);const compatible=(await request('bob','GET',path)).json();assert.equal(compatible.browser_replies_enabled,true);assert.equal(compatible.digest_enabled,true);assert.deepEqual(await cutoffs(),enabled);
    assert.deepEqual((await request('eve','GET',path)).json(),other);assert.deepEqual(await counts(),before);
  }finally{await db.query('DELETE FROM notification_settings WHERE user_id=$1',[ids.bob]);await db.query('INSERT INTO notification_settings SELECT * FROM preference_patch_backup');await db.query('DROP TABLE preference_patch_backup');db.release();await isolated.close();}
});

test('read advancement accepts exact bigint strings and legacy safe integers without rounding or unauthorized side effects',async()=>{
  const isolated=await createApp(),request=(user:string,method:'GET'|'POST',url:string,payload?:unknown)=>isolated.inject({method,url,headers:{origin,cookie:cookies[user]},payload:payload as Record<string,unknown>});
  try{
    const made=await request('alice','POST',`/v1/organizations/${ids.org}/channels`,{name:'Exact read positions',kind:'private',teamId:ids.team,members:[ids.bob]});assert.equal(made.statusCode,200,made.body);const channel=made.json().id,path=`/v1/channels/${channel}/read`;
    await pool.query('UPDATE channels SET sequence=$2 WHERE id=$1',[channel,'9007199254740993']);
    const position=async()=>(await pool.query('SELECT seq FROM read_positions WHERE channel_id=$1 AND user_id=$2',[channel,ids.bob])).rows[0]?.seq;
    assert.equal((await request('bob','POST',path,{seq:2})).statusCode,200);assert.equal(await position(),'2');
    assert.equal((await request('bob','POST',path,{seq:'9007199254740992'})).statusCode,200);assert.equal(await position(),'9007199254740992');
    assert.equal((await request('bob','POST',path,{seq:'9007199254740993'})).statusCode,200);assert.equal(await position(),'9007199254740993');
    assert.equal((await request('bob','POST',path,{seq:'9007199254740992'})).statusCode,200);assert.equal(await position(),'9007199254740993');
    const events=async()=>(await pool.query('SELECT count(*)::int n FROM outbox WHERE channel_id=$1',[channel])).rows[0].n,before=await events();
    for(const seq of ['9007199254740994','9223372036854775808','01',' 2','1e3',true,null,[],{},Number.MAX_SAFE_INTEGER+1,-1,1.5])assert.equal((await request('bob','POST',path,{seq})).statusCode,400,JSON.stringify(seq));
    assert.equal((await request('bob','POST',path,{seq:'0',unexpected:true})).statusCode,400);
    assert.equal((await request('eve','POST',path,{seq:'0'})).statusCode,404);
    assert.equal(await position(),'9007199254740993');assert.equal(await events(),before);
    const receipts=(await request('alice','GET',`/v1/channels/${channel}/receipts`)).json().receipts;assert.equal(receipts.find((r:{user_id:string})=>r.user_id===ids.bob).seq,'9007199254740993');
    await pool.query('UPDATE channels SET sequence=$2 WHERE id=$1',[channel,'9223372036854775807']);assert.equal((await request('bob','POST',path,{seq:'9223372036854775807'})).statusCode,200);assert.equal(await position(),'9223372036854775807');
  }finally{await isolated.close();}
});

test('message readers page beyond one hundred with exact positions, current privacy/author access and no read-side writes',async()=>{
  const isolated=await createApp(),request=(user:string,method:'GET'|'POST',url:string,payload?:unknown)=>isolated.inject({method,url,headers:{origin,cookie:cookies[user]},payload:payload as Record<string,unknown>});
  try{
    const made=await request('alice','POST',`/v1/organizations/${ids.org}/channels`,{name:'Paged message readers',kind:'private',teamId:ids.team,members:[ids.bob]});assert.equal(made.statusCode,200,made.body);const channel=made.json().id;
    const other=await request('bob','POST',`/v1/channels/${channel}/messages`,{clientId:randomUUID(),body:'Other author source'});assert.equal(other.statusCode,201);
    await pool.query('UPDATE channels SET sequence=$2 WHERE id=$1',[channel,'9007199254740992']);
    const sent=await request('alice','POST',`/v1/channels/${channel}/messages`,{clientId:randomUUID(),body:'x'.repeat(600)});assert.equal(sent.statusCode,201);const source=sent.json();assert.equal(source.seq,'9007199254740993');
    const people=Array.from({length:110},()=>randomUUID());
    await pool.query(`INSERT INTO users(id,email,name) SELECT id,id::text||'@message-readers.test','Reader '||n FROM unnest($1::uuid[]) WITH ORDINALITY t(id,n)`,[people]);
    await pool.query(`INSERT INTO memberships(org_id,user_id,role) SELECT $2,id,'member' FROM unnest($1::uuid[]) id`,[people,ids.org]);
    await pool.query(`INSERT INTO channel_members SELECT $2,$3,id FROM unnest($1::uuid[]) id`,[people,ids.org,channel]);
    await pool.query(`INSERT INTO read_positions SELECT $2,id,$3::bigint FROM unnest($1::uuid[]) id`,[[...people,ids.alice],channel,source.seq]);
    await pool.query(`UPDATE users SET preferences='{"readReceipts":false}' WHERE id=$1`,[people[0]]);
    await pool.query('UPDATE users SET disabled=true WHERE id=$1',[people[1]]);
    await pool.query('UPDATE memberships SET active=false WHERE org_id=$1 AND user_id=$2',[ids.org,people[2]]);
    await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[channel,people[3]]);
    await pool.query('UPDATE read_positions SET seq=$3 WHERE channel_id=$1 AND user_id=$2',[channel,people[4],'9007199254740992']);
    const path=`/v1/organizations/${ids.org}/channels/${channel}/messages/${source.id}/readers`;
    const counts=async()=>({positions:(await pool.query('SELECT * FROM read_positions WHERE channel_id=$1 ORDER BY user_id',[channel])).rows,outbox:(await pool.query('SELECT count(*)::int n FROM outbox WHERE channel_id=$1',[channel])).rows,audit:(await pool.query('SELECT count(*)::int n FROM audit WHERE org_id=$1',[ids.org])).rows,drafts:(await pool.query('SELECT * FROM drafts WHERE channel_id=$1',[channel])).rows});
    const before=await counts(),first=await request('alice','GET',path);assert.equal(first.statusCode,200,first.body);const a=first.json();assert.equal(a.message.id,source.id);assert.equal(a.message.excerpt.length,500);assert.equal(a.readers.length,50);assert.equal(a.hasMore,true);assert.equal(a.nextCursor,a.readers.at(-1).id);
    const b=(await request('alice','GET',path+'?afterId='+a.nextCursor)).json(),c=(await request('alice','GET',path+'?afterId='+b.nextCursor)).json();assert.equal(b.readers.length,50);assert.equal(c.readers.length,5);assert.equal(c.hasMore,false);assert.equal(c.nextCursor,null);
    const readers=[...a.readers,...b.readers,...c.readers];assert.deepEqual(readers.map(r=>r.id),people.slice(5).sort());assert(readers.every(r=>Object.keys(r).sort().join(',')==='id,name'));assert.deepEqual(await counts(),before);
    assert.equal((await request('bob','GET',path)).statusCode,404);assert.equal((await request('eve','GET',path)).statusCode,404);assert.equal((await request('alice','GET',path.replace(ids.org,ids.other))).statusCode,404);assert.equal((await request('alice','GET',path.replace(source.id,other.json().id))).statusCode,404);assert.equal((await request('alice','GET',path.replace(channel,ids.channel))).statusCode,404);
    for(const query of ['?limit=100','?afterId=bad','?afterId=','?afterId='+people[0]+'&afterId='+people[1]])assert.equal((await request('alice','GET',path+query)).statusCode,400,query);
    await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[channel,ids.alice]);assert.equal((await request('alice','GET',path)).statusCode,404);await pool.query('INSERT INTO channel_members VALUES($1,$2,$3)',[ids.org,channel,ids.alice]);
    await pool.query('UPDATE messages SET deleted=true,body=\'\' WHERE id=$1',[source.id]);assert.equal((await request('alice','GET',path)).statusCode,404);
  }finally{await isolated.close();}
});

test('standard message readers require current inherited team membership and reevaluate privacy on every page',async()=>{
  const isolated=await createApp(),request=(method:'GET'|'POST',url:string,payload?:unknown)=>isolated.inject({method,url,headers:{origin,cookie:cookies.alice},payload:payload as Record<string,unknown>});
  try{
    const made=await request('POST',`/v1/organizations/${ids.org}/channels`,{name:'Inherited reader access',kind:'standard',teamId:ids.team,members:[]});assert.equal(made.statusCode,200);const channel=made.json().id,reader=randomUUID();
    await pool.query('INSERT INTO users(id,email,name) VALUES($1,$2,$3)',[reader,reader+'@message-readers.test','Inherited reader']);await pool.query("INSERT INTO memberships VALUES($1,$2,'member',true)",[ids.org,reader]);
    const sent=await request('POST',`/v1/channels/${channel}/messages`,{clientId:randomUUID(),body:'Inherited source'});assert.equal(sent.statusCode,201);const source=sent.json(),path=`/v1/organizations/${ids.org}/channels/${channel}/messages/${source.id}/readers`;
    await pool.query('INSERT INTO read_positions VALUES($1,$2,$3)',[channel,reader,source.seq]);assert.deepEqual((await request('GET',path)).json().readers,[]);
    await pool.query("INSERT INTO team_members VALUES($1,$2,$3,'member')",[ids.org,ids.team,reader]);assert.equal((await request('GET',path)).json().readers[0].id,reader);
    await pool.query(`UPDATE users SET preferences='{"readReceipts":false}' WHERE id=$1`,[reader]);assert.deepEqual((await request('GET',path)).json().readers,[]);
    await pool.query(`UPDATE users SET preferences='{"readReceipts":true}' WHERE id=$1`,[reader]);assert.equal((await request('GET',path)).json().readers.length,1);
    await pool.query('DELETE FROM team_members WHERE team_id=$1 AND user_id=$2',[ids.team,reader]);assert.deepEqual((await request('GET',path)).json().readers,[]);
  }finally{await isolated.close();}
});

test('direct replies enforce current parent/channel/workspace access and exclude nested, unrelated and deleted rows without read-side writes',async()=>{
  const isolated=await createApp(),request=(user:string,method:'GET'|'POST'|'DELETE',url:string,payload?:unknown)=>isolated.inject({method,url,headers:{origin,cookie:cookies[user]},payload:payload as Record<string,unknown>});
  try{
  const made=await request('alice','POST',`/v1/organizations/${ids.org}/channels`,{name:'Core direct reply access',kind:'private',teamId:ids.team,members:[ids.bob]});assert.equal(made.statusCode,200,made.body);const channel=made.json().id;
  const make=async(body:string,parentId?:string)=>{const r=await request('alice','POST',`/v1/channels/${channel}/messages`,{clientId:randomUUID(),body,parentId});assert.equal(r.statusCode,201,r.body);return r.json().id as string;};
  const parent=await make('Direct parent'),child=await make('Direct <img src=x> child',parent),other=await make('Unrelated parent');await make('Nested child',child);const deleted=await make('Deleted direct child',parent);assert.equal((await request('alice','DELETE',`/v1/channels/${channel}/messages/${deleted}`)).statusCode,200);
  const path=`/v1/organizations/${ids.org}/channels/${channel}/messages/${parent}/replies`;
  const counts=async()=>({reads:(await pool.query('SELECT * FROM read_positions WHERE channel_id=$1',[channel])).rows,drafts:(await pool.query('SELECT * FROM drafts WHERE channel_id=$1',[channel])).rows,outbox:(await pool.query('SELECT count(*)::int n FROM outbox WHERE channel_id=$1',[channel])).rows,audit:(await pool.query('SELECT count(*)::int n FROM audit WHERE org_id=$1',[ids.org])).rows,saved:(await pool.query('SELECT count(*)::int n FROM saved_messages s JOIN messages m ON m.id=s.message_id WHERE m.channel_id=$1',[channel])).rows});
  const before=await counts(),result=await request('bob','GET',path);assert.equal(result.statusCode,200,result.body);assert.equal(result.json().parentId,parent);assert.equal(result.json().channel.id,channel);assert.deepEqual(result.json().replies.map((r:{id:string})=>r.id),[child]);assert.equal(result.json().replies[0].excerpt,'Direct <img src=x> child');assert.equal(result.json().hasMore,false);assert.equal(result.json().nextCursor,null);assert.deepEqual(await counts(),before);
  assert.deepEqual((await request('bob','GET',path.replace(parent,other))).json().replies,[]);
  assert.equal((await request('eve','GET',path)).statusCode,404);assert.equal((await request('guest','GET',path)).statusCode,404);assert.equal((await request('bob','GET',path.replace(channel,ids.channel))).statusCode,404);assert.equal((await request('bob','GET',path.replace(ids.org,ids.other))).statusCode,404);
  await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[channel,ids.bob]);assert.equal((await request('bob','GET',path)).statusCode,404);await pool.query('INSERT INTO channel_members VALUES($1,$2,$3)',[ids.org,channel,ids.bob]);assert.equal((await request('bob','GET',path)).statusCode,200);
  assert.equal((await request('alice','DELETE',`/v1/channels/${channel}/messages/${parent}`)).statusCode,200);assert.equal((await request('bob','GET',path)).statusCode,404);
  }finally{await isolated.close();}
});

test('direct reply pages retain microsecond timestamp ties without gaps, bound excerpts and reject invalid cursor shapes',async()=>{
  const isolated=await createApp(),request=(user:string,method:'GET'|'POST'|'DELETE',url:string,payload?:unknown)=>isolated.inject({method,url,headers:{origin,cookie:cookies[user]},payload:payload as Record<string,unknown>});
  try{
  const made=await request('alice','POST',`/v1/organizations/${ids.org}/channels`,{name:'Core direct reply pages',kind:'private',teamId:ids.team,members:[]});assert.equal(made.statusCode,200,made.body);const channel=made.json().id;
  const parentResponse=await request('alice','POST',`/v1/channels/${channel}/messages`,{clientId:randomUUID(),body:'Paged parent'});assert.equal(parentResponse.statusCode,201);const parent=parentResponse.json().id,children=Array.from({length:53},()=>randomUUID());
  await pool.query(`INSERT INTO messages(id,org_id,channel_id,user_id,client_id,seq,body,parent_id,created_at)
    SELECT id,$2,$3,$4,id,n+1,repeat('x',600),$5,'2026-01-01T00:00:00.123456Z'::timestamptz FROM unnest($1::uuid[]) WITH ORDINALITY t(id,n)`,[children,ids.org,channel,ids.alice,parent]);await pool.query('UPDATE channels SET sequence=54 WHERE id=$1',[channel]);
  const path=`/v1/organizations/${ids.org}/channels/${channel}/messages/${parent}/replies`,first=await request('alice','GET',path);assert.equal(first.statusCode,200,first.body);const page=first.json();assert.equal(page.replies.length,50);assert.equal(page.hasMore,true);assert.equal(page.nextCursor.createdAt,'2026-01-01T00:00:00.123456Z');assert(page.replies.every((r:{excerpt:string})=>r.excerpt.length===500));
  const second=await request('alice','GET',path+'?'+new URLSearchParams({beforeCreated:page.nextCursor.createdAt,beforeId:page.nextCursor.id}));assert.equal(second.statusCode,200,second.body);assert.equal(second.json().replies.length,3);assert.equal(second.json().hasMore,false);assert.equal(second.json().nextCursor,null);assert.deepEqual([...page.replies,...second.json().replies].map((r:{id:string})=>r.id),children.sort().reverse());
  for(const q of ['?beforeId='+parent,'?beforeCreated=2026-01-01T00:00:00.123456Z','?limit=100','?beforeCreated=0000-01-01T00:00:00Z&beforeId='+parent,'?beforeCreated=invalid&beforeId='+parent,'?beforeCreated=2026-01-01T00:00:00Z&beforeId=bad'])assert.equal((await request('alice','GET',path+q)).statusCode,400,q);
  }finally{await isolated.close();}
});

test('call invitations, raised hands and chat enforce session, room, expiry and idempotent-send boundaries',async()=>{
  const mediaApp=await createApp();
  const request=(user:string,method:"GET"|"POST"|"PATCH"|"DELETE"|"PUT",url:string,payload?:unknown)=>mediaApp.inject({method,url,headers:{origin,cookie:cookies[user]},payload:payload as Record<string,unknown>});
  try{
  const made=await request('alice','POST',`/v1/organizations/${ids.org}/channels`,{name:'Call collaboration core',kind:'private',teamId:ids.team,members:[ids.bob,ids.guest]});assert.equal(made.statusCode,200,made.body);const channel=made.json().id,call=randomUUID(),room=randomUUID(),aliceGrant=randomUUID(),bobGrant=randomUUID();
  const {hash}=await import('../services/core/security.ts');
  await pool.query("INSERT INTO media_calls(id,org_id,channel_id,host_user_id,caller_user_id,client_id,mode,ring_until) VALUES($1,$2,$3,$4,$4,$5,'video',now()+interval '45 seconds')",[call,ids.org,channel,ids.alice,randomUUID()]);
  await pool.query("INSERT INTO media_rooms(id,call_id,name,client_id,is_main) VALUES($1,$1,'Main room',$1,true),($2,$1,'Breakout',$2,false)",[call,room]);
  await pool.query("INSERT INTO media_invitations(call_id,user_id,response) VALUES($1,$2,'accepted'),($1,$3,'pending')",[call,ids.alice,ids.bob]);
  for(const [id,user,who] of [[aliceGrant,ids.alice,'alice'],[bobGrant,ids.bob,'bob']])await pool.query("INSERT INTO media_grants(id,call_id,room_id,user_id,client_id,session_hash,recording_consent,expires_at) VALUES($1,$2,$2,$3,$4,$5,false,now()+interval '25 seconds')",[id,call,user,randomUUID(),hash(cookies[who].slice('concord_session='.length))]);
  const base=`/v1/organizations/${ids.org}/calls/${call}`,ag=`${base}/connections/${aliceGrant}`,bg=`${base}/connections/${bobGrant}`;
  assert.ok((await request('bob','GET',`/v1/organizations/${ids.org}/calls/incoming`)).json().calls.some((c:{id:string})=>c.id===call));
  assert.equal((await request('eve','GET',base)).statusCode,404);
  assert.equal((await request('bob','POST',base+'/respond',{response:'accepted',extra:true})).statusCode,400);
  assert.equal((await request('bob','POST',base+'/respond',{response:'accepted'})).statusCode,200);
  assert.equal((await request('bob','POST',base+'/respond',{response:'accepted'})).statusCode,200);
  assert.equal((await request('bob','POST',base+'/respond',{response:'declined'})).statusCode,409);
  assert.equal((await request('alice','POST',ag+'/hand',{raised:true})).statusCode,200);assert.ok((await request('alice','GET',base)).json().participants.find((p:{id:string})=>p.id===aliceGrant).hand_raised_at);
  assert.equal((await request('bob','POST',ag+'/hand',{raised:false})).statusCode,404);
  assert.equal((await request('alice','POST',ag+'/hand',{raised:false})).statusCode,200);
  const clientId=randomUUID(),body={clientId,roomId:call,body:'Hello <img src=x onerror=alert(1)> **literal**'};
  const first=await request('alice','POST',ag+'/chat',body);assert.equal(first.statusCode,200,first.body);assert.equal((await request('alice','POST',ag+'/chat',body)).json().id,first.json().id);
  assert.equal((await request('alice','POST',ag+'/chat',{...body,body:'Changed'})).statusCode,409);
  const messages=(await request('bob','GET',bg+'/chat')).json();assert.equal(messages.messages[0].body,body.body);
  assert.equal((await request('bob','GET',ag+'/chat')).statusCode,404);
  assert.equal((await request('guest','GET',bg+'/chat')).statusCode,404);
  assert.equal((await request('alice','POST',ag+'/chat',{...body,clientId:randomUUID(),roomId:room})).statusCode,409);
  assert.equal((await request('alice','POST',ag+'/chat',{...body,clientId:randomUUID(),body:' '.repeat(3)})).statusCode,400);
  assert.equal((await request('alice','POST',ag+'/chat',{...body,clientId:randomUUID(),body:'a'.repeat(4001)})).statusCode,400);
  await pool.query('UPDATE media_grants SET room_id=$2 WHERE id=$1',[bobGrant,room]);assert.equal((await request('bob','GET',bg+'/chat')).json().messages.length,0);
  const secondSession=await mediaApp.inject({method:'POST',url:'/v1/session',headers:{origin},payload:{email:'alice@acme.test',password:'Development123!'}});assert.equal(secondSession.statusCode,200);assert.equal((await mediaApp.inject({method:'GET',url:ag+'/chat',headers:{origin,cookie:String(secondSession.headers['set-cookie']).split(';')[0]}})).statusCode,404);
  for(let i=0;i<9;i++)assert.equal((await request('alice','POST',ag+'/chat',{roomId:call,clientId:randomUUID(),body:`Bounded message ${i}`})).statusCode,200);
  assert.equal((await request('alice','POST',ag+'/chat',{roomId:call,clientId:randomUUID(),body:'Rate exceeded'})).statusCode,429);assert.equal((await request('alice','POST',ag+'/chat',body)).json().id,first.json().id);
  await pool.query("UPDATE media_grants SET expires_at=now()-interval '1 second' WHERE id=$1",[aliceGrant]);assert.equal((await request('alice','POST',ag+'/hand',{raised:true})).statusCode,403);assert.equal((await request('alice','GET',ag+'/chat')).statusCode,403);
  await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[channel,ids.bob]);assert.equal((await request('bob','GET',bg+'/chat')).statusCode,404);
  await pool.query('UPDATE media_calls SET ended_at=now() WHERE id=$1',[call]);
  }finally{await mediaApp.close();}
});

test('meeting protocol orders hands and chat, binds invitation winners, authorizes host transfer and preserves ended history',async()=>{
 const isolated=await createApp(),req=(user:string,method:'GET'|'POST'|'DELETE',url:string,payload?:unknown)=>isolated.inject({method,url,headers:{origin,cookie:cookies[user]},payload:payload as Record<string,unknown>});
 try{
 const c=await req('alice','POST',`/v1/organizations/${ids.org}/channels`,{name:'Meeting protocol coverage',kind:'group',teamId:null,members:[ids.bob]});assert.equal(c.statusCode,200,c.body);const channel=c.json().id,call=randomUUID(),ag=randomUUID(),bg=randomUUID();const {hash}=await import('../services/core/security.ts');
 await pool.query("INSERT INTO media_calls(id,org_id,channel_id,host_user_id,caller_user_id,client_id,mode,ring_until) VALUES($1,$2,$3,$4,$4,$5,'video',now()+interval '45 seconds')",[call,ids.org,channel,ids.alice,randomUUID()]);await pool.query("INSERT INTO media_rooms(id,call_id,name,client_id,is_main) VALUES($1,$1,'Main room',$1,true)",[call]);await pool.query("INSERT INTO media_invitations(call_id,user_id,response) VALUES($1,$2,'accepted'),($1,$3,'pending')",[call,ids.alice,ids.bob]);
 for(const [id,user,who] of [[ag,ids.alice,'alice'],[bg,ids.bob,'bob']])await pool.query("INSERT INTO media_grants(id,call_id,room_id,user_id,client_id,session_hash,recording_consent,expires_at) VALUES($1,$2,$2,$3,$4,$5,false,now()+interval '5 minutes')",[id,call,user,randomUUID(),hash(cookies[who].slice('concord_session='.length))]);
 // A reconciler updating a grant emits an FK-backed event while an API transaction holds the call lock.
 // NO KEY UPDATE must allow the event's KEY SHARE lock; FOR UPDATE would deadlock with grant renewal.
 const locker=await pool.connect(),writer=await pool.connect();try{await locker.query('BEGIN');const {callAccess}=await import('../services/core/media.ts');await callAccess(locker,ids.alice,ids.org,call,true);await writer.query('BEGIN');await writer.query("SET LOCAL statement_timeout='1500ms'");await writer.query('UPDATE media_grants SET connected_at=now() WHERE id=$1',[ag]);await writer.query('COMMIT');}finally{await writer.query('ROLLBACK');await locker.query('ROLLBACK');writer.release();locker.release();}
 const base=`/v1/organizations/${ids.org}/calls/${call}`,a=`${base}/connections/${ag}`,b=`${base}/connections/${bg}`,device=randomUUID();
 const accepted=await Promise.all([req('bob','POST',base+'/respond',{response:'accepted',clientId:device}),req('bob','POST',base+'/respond',{response:'accepted',clientId:randomUUID()})]);assert.deepEqual(accepted.map(r=>r.statusCode).sort(),[200,409]);
 assert.equal((await req('alice','POST',a+'/hand',{raised:true})).statusCode,200);const initial=(await req('alice','GET',base)).json().participants.find((p:{id:string})=>p.id===ag).hand_order;await req('alice','POST',a+'/hand',{raised:true});await req('bob','POST',b+'/hand',{raised:true});let state=(await req('alice','GET',base)).json();assert.equal(state.participants.find((p:{id:string})=>p.id===ag).hand_order,initial);assert(BigInt(state.participants.find((p:{id:string})=>p.id===bg).hand_order)>BigInt(initial));
 assert.equal((await req('bob','POST',`${base}/participants/${ag}/moderate`,{action:'lower-hand'})).statusCode,403);assert.equal((await req('alice','POST',`${base}/participants/${bg}/moderate`,{action:'lower-hand'})).statusCode,200);assert.equal((await req('alice','POST',`${base}/participants/${bg}/moderate`,{action:'request-unmute'})).statusCode,200);state=(await req('bob','GET',base)).json();assert.equal(state.participants.find((p:{id:string})=>p.id===bg).hand_order,null);assert(state.participants.find((p:{id:string})=>p.id===bg).unmute_requested_at);assert.equal((await req('bob','POST',b+'/dismiss-unmute',{})).statusCode,200);
 await pool.query("INSERT INTO media_messages(id,call_id,room_id,user_id,client_id,body,created_at) SELECT gen_random_uuid(),$1,$1,$2,gen_random_uuid(),'Page message '||n,now()-interval '1 minute' FROM generate_series(1,205) n",[call,ids.alice]);
 let page=(await req('bob','GET',b+'/chat')).json();assert.equal(page.messages.length,100);assert.equal(page.unread,205);const all=[...page.messages];while(page.nextCursor){page=(await req('bob','GET',b+'/chat?before='+page.nextCursor)).json();all.unshift(...page.messages);}assert.equal(all.length,205);assert.equal(new Set(all.map((m:{id:string})=>m.id)).size,205);assert(all.every((m:{seq:string},i:number)=>!i||BigInt(m.seq)>BigInt(all[i-1].seq)));
 assert.equal((await req('bob','GET',b+'/chat?before=9999999999999999999')).statusCode,400);assert.equal((await req('bob','POST',b+'/read-chat',{seq:all[204].seq})).statusCode,200);assert.equal((await req('bob','GET',b+'/chat')).json().unread,0);assert.equal((await req('bob','POST',b+'/read-chat',{seq:'9223372036854775807'})).statusCode,400);
 const body={clientId:randomUUID(),roomId:call,body:'Persist once'};const sends=await Promise.all([req('alice','POST',a+'/chat',body),req('alice','POST',a+'/chat',body)]);assert(sends.every(r=>r.statusCode===200));assert.equal(sends[0].json().id,sends[1].json().id);
 assert.equal((await req('bob','POST',base+'/end',{})).statusCode,403);assert.equal((await req('alice','POST',base+'/host',{userId:ids.guest})).statusCode,404);assert.equal((await req('alice','POST',base+'/host',{userId:ids.bob})).statusCode,200);assert.equal((await req('alice','POST',base+'/end',{})).statusCode,403);
 // A provider is intentionally absent in this DB/API test. End commits despite a failed transport cleanup.
 assert.equal((await req('bob','POST',base+'/end',{})).statusCode,200);assert.equal((await req('bob','POST',base+'/end',{})).statusCode,200);assert.equal((await req('alice','POST',a+'/hand',{raised:true})).statusCode,409);assert.equal((await req('alice','DELETE',a)).statusCode,200);assert.equal((await req('alice','DELETE',a)).statusCode,200);
 const history=await req('bob','GET',base+'/history');assert.equal(history.statusCode,200,history.body);assert.equal(history.json().outcome,'ended');assert(history.json().seconds>=0);assert.equal((await req('bob','GET',base+'/chat')).json().messages.length,50);assert.equal((await req('eve','GET',base+'/history')).statusCode,404);assert.equal((await req('guest','GET',base+'/chat')).statusCode,404);await pool.query('INSERT INTO media_bans VALUES($1,$2)',[call,ids.bob]);assert.equal((await req('bob','GET',base+'/chat')).statusCode,403);assert.equal((await req('bob','GET',base+'/history')).statusCode,403);
 }finally{await isolated.close();}
});

test('media callbacks require a signed body, deduplicate event IDs and never revive an ended meeting',async()=>{
 const isolated=await createApp(),keys=['LIVEKIT_URL','LIVEKIT_API_URL','LIVEKIT_API_KEY','LIVEKIT_API_SECRET','LIVEKIT_ALLOW_INSECURE_LOCAL'],old=keys.map(k=>process.env[k]);
 try{
 Object.assign(process.env,{LIVEKIT_URL:'ws://localhost:9',LIVEKIT_API_URL:'http://localhost:9',LIVEKIT_API_KEY:'test-only-key',LIVEKIT_API_SECRET:'test-only-signing-secret-at-least-32-characters',LIVEKIT_ALLOW_INSECURE_LOCAL:'true'});
 const {AccessToken}=await import('livekit-server-sdk'),{createHash}=await import('node:crypto');const id=randomUUID(),body=JSON.stringify({id,event:'room_finished',room:{name:'cc-'+randomUUID()},createdAt:String(Math.floor(Date.now()/1000))});const token=new AccessToken(process.env.LIVEKIT_API_KEY,process.env.LIVEKIT_API_SECRET,{ttl:30});token.sha256=createHash('sha256').update(body).digest('base64');const authorization=await token.toJwt();
 const callback=(payload:string,auth=authorization)=>isolated.inject({method:'POST',url:'/v1/media/webhook',headers:{'content-type':'application/webhook+json',authorization:auth},payload});assert.equal((await callback(body,'forged')).statusCode,401);assert.equal((await callback(body+' ')).statusCode,401);assert.equal((await callback(body)).statusCode,200);assert.equal((await callback(body)).statusCode,200);assert.equal(Number((await pool.query('SELECT count(*) FROM media_provider_events WHERE id=$1',[id])).rows[0].count),1);
 }finally{keys.forEach((k,i)=>{if(old[i]===undefined)delete process.env[k];else process.env[k]=old[i];});await isolated.close();}
});

test('profile calling resolves one current organization-scoped direct conversation without granting cross-tenant access',async()=>{
 const isolated=await createApp();try{const req=(user:string,userId:string,org=ids.org)=>isolated.inject({method:'POST',url:`/v1/organizations/${org}/direct-conversation`,headers:{origin,cookie:cookies[user]},payload:{userId}});assert.equal((await req('alice',ids.alice)).statusCode,400);assert.equal((await req('alice',ids.eve)).statusCode,404);assert.equal((await req('guest',ids.alice)).statusCode,403);const first=await req('alice',ids.bob);assert.equal(first.statusCode,200,first.body);assert.equal((await req('alice',ids.bob)).json().id,first.json().id);assert.equal((await req('bob',ids.alice)).json().id,first.json().id);assert.equal((await req('bob',ids.alice,ids.other)).statusCode,404);const stream=`/v1/organizations/${ids.org}/media/events`;assert.equal((await isolated.inject({url:stream})).statusCode,401);assert.equal((await isolated.inject({url:stream,headers:{cookie:cookies.alice,origin:'https://untrusted.test'}})).statusCode,403);assert.equal((await isolated.inject({url:stream+'?after=9999999999999999999',headers:{cookie:cookies.alice,origin}})).statusCode,400);assert.equal((await isolated.inject({url:`/v1/organizations/${ids.other}/media/events`,headers:{cookie:cookies.bob,origin}})).statusCode,404);}finally{await isolated.close();}
});

test('provider provisioning outages return actionable failures and retries reuse one authorized device grant',async()=>{
 const isolated=await createApp(),keys=['LIVEKIT_URL','LIVEKIT_API_URL','LIVEKIT_API_KEY','LIVEKIT_API_SECRET','LIVEKIT_ALLOW_INSECURE_LOCAL'],old=keys.map(k=>process.env[k]);let call='';try{
 Object.assign(process.env,{LIVEKIT_URL:'ws://localhost:9',LIVEKIT_API_URL:'http://localhost:9',LIVEKIT_API_KEY:'test-only-key',LIVEKIT_API_SECRET:'test-only-signing-secret-at-least-32-characters',LIVEKIT_ALLOW_INSECURE_LOCAL:'true'});const req=(path:string,payload:unknown)=>isolated.inject({method:'POST',url:`/v1/organizations/${ids.org}/${path}`,headers:{origin,cookie:cookies.alice},payload:payload as Record<string,unknown>});const made=await req('instant-meetings',{clientId:randomUUID(),title:'Unavailable provider test',mode:'audio',userIds:[]});assert.equal(made.statusCode,200,made.body);call=made.json().id;const body={clientId:randomUUID(),recordingConsent:false};for(let i=0;i<2;i++){const result=await req(`calls/${call}/join`,body);assert.equal(result.statusCode,503,result.body);assert.match(result.json().error,/Service temporarily unavailable/);}assert.equal(Number((await pool.query('SELECT count(*) FROM media_grants WHERE call_id=$1',[call])).rows[0].count),1);
 }finally{keys.forEach((k,i)=>{if(old[i]===undefined)delete process.env[k];else process.env[k]=old[i];});if(call){await pool.query("UPDATE media_calls SET ended_at=now(),end_reason='ended' WHERE id=$1",[call]);await pool.query('UPDATE media_grants SET revoked_at=now() WHERE call_id=$1',[call]);}await isolated.close();}
});

test('accept versus end races have one serialized invitation outcome and cannot revive a terminal call',async()=>{
 const isolated=await createApp();try{const req=(user:string,path:string,payload:unknown)=>isolated.inject({method:'POST',url:`/v1/organizations/${ids.org}/${path}`,headers:{origin,cookie:cookies[user]},payload:payload as Record<string,unknown>});const made=await req('alice','channels',{name:'Call cancellation race',kind:'group',teamId:null,members:[ids.bob]});assert.equal(made.statusCode,200,made.body);const channel=made.json().id;
 for(let i=0;i<4;i++){const id=randomUUID();await pool.query("INSERT INTO media_calls(id,org_id,channel_id,host_user_id,caller_user_id,client_id,mode,ring_until) VALUES($1,$2,$3,$4,$4,$1,'audio',now()+interval '45 seconds')",[id,ids.org,channel,ids.alice]);await pool.query("INSERT INTO media_rooms(id,call_id,name,client_id,is_main) VALUES($1,$1,'Main room',$1,true)",[id]);await pool.query("INSERT INTO media_invitations(call_id,user_id,response) VALUES($1,$2,'accepted'),($1,$3,'pending')",[id,ids.alice,ids.bob]);const [accepted,ended]=await Promise.all([req('bob',`calls/${id}/respond`,{response:'accepted',clientId:randomUUID()}),req('alice',`calls/${id}/end`,{})]);assert.equal(ended.statusCode,200,ended.body);assert([200,409].includes(accepted.statusCode));const state=(await pool.query('SELECT x.ended_at,i.response FROM media_calls x JOIN media_invitations i ON i.call_id=x.id WHERE x.id=$1 AND i.user_id=$2',[id,ids.bob])).rows[0];assert(state.ended_at);assert.equal(state.response,accepted.statusCode===200?'accepted':'cancelled');assert.equal((await req('bob',`calls/${id}/respond`,{response:'accepted',clientId:randomUUID()})).statusCode,409);assert.equal((await req('alice',`calls/${id}/end`,{})).statusCode,200);}
 }finally{await isolated.close();}
});

test('a delayed provider creation is fenced before end and cannot recreate an ended room',async()=>{
 const isolated=await createApp(),{RoomServiceClient}=await import('livekit-server-sdk'),{provisionMediaRoom}=await import('../services/core/meeting-protocol.ts'),proto=RoomServiceClient.prototype,saved={list:proto.listRooms,create:proto.createRoom,remove:proto.deleteRoom},keys=['LIVEKIT_URL','LIVEKIT_API_URL','LIVEKIT_API_KEY','LIVEKIT_API_SECRET','LIVEKIT_ALLOW_INSECURE_LOCAL'],old=keys.map(k=>process.env[k]);let release=()=>{},entered=()=>{};const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;}),events:string[]=[];let call='';
 try{
 Object.assign(process.env,{LIVEKIT_URL:'ws://localhost:9',LIVEKIT_API_URL:'http://localhost:9',LIVEKIT_API_KEY:'test-only-key',LIVEKIT_API_SECRET:'test-only-signing-secret-at-least-32-characters',LIVEKIT_ALLOW_INSECURE_LOCAL:'true'});proto.listRooms=async()=>[];proto.createRoom=async options=>{entered();await gate;events.push('create');return {name:options.name} as Awaited<ReturnType<typeof saved.create>>;};proto.deleteRoom=async()=>{events.push('delete');};
 const req=(path:string,payload:unknown)=>isolated.inject({method:'POST',url:`/v1/organizations/${ids.org}/${path}`,headers:{origin,cookie:cookies.alice},payload:payload as Record<string,unknown>});const made=await req('instant-meetings',{clientId:randomUUID(),title:'Delayed provider test',mode:'audio',userIds:[]});assert.equal(made.statusCode,200,made.body);call=made.json().id;const joining=req(`calls/${call}/join`,{clientId:randomUUID(),recordingConsent:false});let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([started,new Promise<void>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Provider creation did not start')),3000);})]);}finally{clearTimeout(timer);}
 const check=await pool.connect();try{await check.query('BEGIN');await assert.rejects(check.query('SELECT id FROM media_calls WHERE id=$1 FOR NO KEY UPDATE NOWAIT',[call]),(e:unknown)=>(e as {code:string}).code==='55P03');}finally{await check.query('ROLLBACK');check.release();}
 const ending=req(`calls/${call}/end`,{});release();assert.equal((await joining).statusCode,200);assert.equal((await ending).statusCode,200);assert.deepEqual(events,['create','delete']);const version=(await pool.query('SELECT provider_room FROM media_rooms WHERE id=$1',[call])).rows[0].provider_room;await assert.rejects(provisionMediaRoom(call,version),(e:unknown)=>(e as {statusCode:number}).statusCode===409);assert.deepEqual(events,['create','delete']);
 }finally{release();proto.listRooms=saved.list;proto.createRoom=saved.create;proto.deleteRoom=saved.remove;keys.forEach((k,i)=>{if(old[i]===undefined)delete process.env[k];else process.env[k]=old[i];});if(call)await pool.query("UPDATE media_calls SET ended_at=coalesce(ended_at,now()) WHERE id=$1",[call]);await isolated.close();}
});
