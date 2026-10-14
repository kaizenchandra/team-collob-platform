import {randomUUID} from "node:crypto";
import {migrate, pool, transaction} from "./db.ts";
import {passwordHash} from "./security.ts";

export const ids = {
    org: "11111111-1111-4111-8111-111111111111",
    other: "22222222-2222-4222-8222-222222222222",
    alice: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    bob: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    eve: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    guest: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    team: "33333333-3333-4333-8333-333333333333",
    channel: "44444444-4444-4444-8444-444444444444",
    private: "55555555-5555-4555-8555-555555555555",
};

export async function seed() {
    if (process.env.NODE_ENV === "production" || process.env.DEV_AUTH !== "true")
        throw new Error("Seed requires DEV_AUTH=true and non-production");
    await migrate();
    await transaction(async (db) => {
        if ((await db.query("SELECT 1 FROM users LIMIT 1")).rowCount) return;
        for (const [id, email, name] of [
            [ids.alice, "alice@acme.test", "Alice Morgan"],
            [ids.bob, "bob@acme.test", "Bob Chen"],
            [ids.eve, "eve@northstar.test", "Eve Williams"],
            [ids.guest, "guest@partner.test", "Sam Rivera"],
        ])
            await db.query(
                "INSERT INTO users(id,email,name,password_hash,title) VALUES($1,$2,$3,$4,$5)",
                [
                    id,
                    email,
                    name,
                    passwordHash("Development123!"),
                    "Product & engineering",
                ],
            );
        await db.query("INSERT INTO organizations(id,name) VALUES($1,$2),($3,$4)", [
            ids.org,
            "Acme Studio",
            ids.other,
            "Northstar Labs",
        ]);
        for (const [org, user, role] of [
            [ids.org, ids.alice, "owner"],
            [ids.org, ids.bob, "member"],
            [ids.org, ids.guest, "guest"],
            [ids.other, ids.eve, "owner"],
            [ids.other, ids.alice, "member"],
        ])
            await db.query("INSERT INTO memberships VALUES($1,$2,$3,true)", [
                org,
                user,
                role,
            ]);
        await db.query("INSERT INTO teams(id,org_id,name) VALUES($1,$2,$3)", [
            ids.team,
            ids.org,
            "Product & Engineering",
        ]);
        for (const user of [ids.alice, ids.bob, ids.guest])
            await db.query("INSERT INTO team_members VALUES($1,$2,$3,$4)", [
                ids.org,
                ids.team,
                user,
                user === ids.alice ? "owner" : "member",
            ]);
        for (const [id, name, kind, description] of [
            [
                ids.channel,
                "General",
                "standard",
                "The home for ideas, updates, and everything we build together.",
            ],
            [
                ids.private,
                "Launch planning",
                "private",
                "A private space to bring our next release to life.",
            ],
            [
                randomUUID(),
                "Design exchange",
                "shared",
                "Share work in progress and get a fresh perspective.",
            ],
        ]) {
            await db.query(
                "INSERT INTO channels(id,org_id,team_id,name,kind,description) VALUES($1,$2,$3,$4,$5,$6)",
                [id, ids.org, ids.team, name, kind, description],
            );
            for (const user of [ids.alice, ids.bob])
                await db.query("INSERT INTO channel_members VALUES($1,$2,$3)", [
                    ids.org,
                    id,
                    user,
                ]);
        }
        let seq = 0;
        for (const [user, body] of [
            [
                ids.alice,
                "Welcome to Concord 👋\nThis is our space to stay connected, share ideas, and move work forward.",
            ],
            [
                ids.bob,
                "I’ve set up Launch planning for our private release discussions. Bring your questions and ideas!",
            ],
        ])
            await db.query(
                "INSERT INTO messages(id,org_id,channel_id,user_id,client_id,seq,body) VALUES($1,$2,$3,$4,$5,$6,$7)",
                [randomUUID(), ids.org, ids.channel, user, randomUUID(), ++seq, body],
            );
        await db.query("UPDATE channels SET sequence=$1 WHERE id=$2", [
            seq,
            ids.channel,
        ]);
    });
}

if (process.argv[1]?.endsWith("seed.ts")) {
    await seed();
    await pool.end();
    console.log("Development seed ready.");
}
