import {compactDecrypt, CompactEncrypt} from "jose";
import {z} from "zod";
import {randomBytes} from "node:crypto";
import {mkdir, readFile, stat, writeFile} from "node:fs/promises";
import {dirname} from "node:path";

const keyId = z.string().regex(/^[a-zA-Z0-9_-]{1,48}$/);
const schema = z
    .object({
        active: keyId,
        keys: z.record(keyId, z.string().regex(/^[A-Za-z0-9_-]{43}$/)),
    })
    .strict();

export function tokenVault(input: unknown) {
    const ring = schema.parse(input);
    const entries = Object.entries(ring.keys);
    if (entries.length < 1 || entries.length > 4 || !ring.keys[ring.active])
        throw new Error("Invalid identity token keyring");
    const keys = new Map(
        entries.map(([id, value]) => [id, Buffer.from(value, "base64url")]),
    );
    for (const key of keys.values())
        if (key.length !== 32) throw new Error("Identity token key must be256bits");
    return {
        async seal(token: string, binding: string) {
            z.string().min(1).max(16000).parse(token);
            return new CompactEncrypt(
                new TextEncoder().encode(JSON.stringify({token, binding})),
            )
                .setProtectedHeader({
                    alg: "dir",
                    enc: "A256GCM",
                    kid: ring.active,
                    typ: "concord-provider-token+jwe",
                })
                .encrypt(keys.get(ring.active)!);
        },
        async open(value: string, binding: string) {
            if (value.length > 24000)
                throw new Error("Invalid encrypted identity credential");
            const result = await compactDecrypt(
                value,
                (header) => {
                    if (
                        header.typ !== "concord-provider-token+jwe" ||
                        !header.kid ||
                        !keys.has(header.kid)
                    )
                        throw new Error("Unavailable identity token key");
                    return keys.get(header.kid)!;
                },
                {
                    keyManagementAlgorithms: ["dir"],
                    contentEncryptionAlgorithms: ["A256GCM"],
                },
            );
            const payload = z
                .object({
                    token: z.string().min(1).max(16000),
                    binding: z.literal(binding),
                })
                .strict()
                .parse(JSON.parse(new TextDecoder().decode(result.plaintext)));
            return payload.token;
        },
    };
}

export type TokenVault = ReturnType<typeof tokenVault>;
export const credentialBinding = (
    tokenHash: string,
    issuer: string,
    client: string,
    subject: string,
) => JSON.stringify([tokenHash, issuer, client, subject]);

export async function loadTokenVault(path: string, createLocal = false) {
    try {
        await stat(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !createLocal)
            throw new Error("Identity token keyring is unavailable");
        await mkdir(dirname(path), {recursive: true, mode: 0o700});
        try {
            await writeFile(
                path,
                JSON.stringify({
                    active: "local-v1",
                    keys: {"local-v1": randomBytes(32).toString("base64url")},
                }),
                {flag: "wx", mode: 0o600},
            );
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
    }
    if ((await stat(path)).size > 8192)
        throw new Error("Invalid identity token keyring size");
    return tokenVault(JSON.parse(await readFile(path, "utf8")));
}
