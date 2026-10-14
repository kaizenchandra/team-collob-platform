import {GetObjectCommand, PutObjectCommand, S3Client} from "@aws-sdk/client-s3";
import {createHash} from "node:crypto";
import {z} from "zod";

export type ObjectFile = {
    id: string;
    org_id: string;
    bytes: number | string;
    sha256: string;
    object_key?: string | null;
    object_bucket?: string | null
};

export function objectStorageConfigured() {
    if (!["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"].some(key => process.env[key])) return false;
    configuration();
    return true;
}

function configuration() {
    const {
        S3_ENDPOINT: endpoint,
        S3_BUCKET: bucket,
        S3_ACCESS_KEY_ID: accessKeyId,
        S3_SECRET_ACCESS_KEY: secretAccessKey
    } = process.env;
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) throw new Error("Object storage configuration incomplete");
    const url = new URL(endpoint);
    if (url.username || url.password || url.search || url.hash || !["https:", "http:"].includes(url.protocol)) throw new Error("Invalid object endpoint");
    if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && process.env.S3_ALLOW_INSECURE_LOCAL === "true")) throw new Error("Object storage requires HTTPS");
    if (process.env.NODE_ENV === "production" && (accessKeyId.startsWith("local-") || secretAccessKey.startsWith("local-"))) throw new Error("Development object credentials forbidden");
    return {bucket, endpoint, credentials: {accessKeyId, secretAccessKey}};
}

export function objectKey(file: ObjectFile) {
    return `${z.uuid().parse(file.org_id)}/${z.uuid().parse(file.id)}/${z.string().regex(/^[a-f0-9]{64}$/).parse(file.sha256)}`;
}

function checkBytes(file: ObjectFile, bytes: Buffer) {
    if (bytes.length > 1048576 || bytes.length !== Number(file.bytes) || createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error("Object integrity verification failed");
}

function client() {
    const c = configuration();
    return {
        bucket: c.bucket,
        s3: new S3Client({
            endpoint: c.endpoint,
            credentials: c.credentials,
            region: process.env.S3_REGION ?? "us-east-1",
            forcePathStyle: true,
            maxAttempts: 2,
            requestChecksumCalculation: "WHEN_REQUIRED",
            responseChecksumValidation: "WHEN_REQUIRED"
        })
    };
}

export async function readObject(file: ObjectFile) {
    const expected = objectKey(file), {s3, bucket} = client();
    if (file.object_key !== expected || file.object_bucket !== bucket) {
        s3.destroy();
        throw new Error("Object pointer unavailable");
    }
    try {
        const response = await s3.send(new GetObjectCommand({
            Bucket: bucket,
            Key: expected
        }), {abortSignal: AbortSignal.timeout(15000)});
        const body = response.Body;
        if (!body) throw new Error("Object body unavailable");
        try {
            if (response.ContentLength !== Number(file.bytes) || Number(file.bytes) > 1048576) throw new Error("Invalid object length");
            const parts: Buffer[] = [];
            let size = 0;
            for await(const chunk of body as AsyncIterable<Uint8Array>) {
                const part = Buffer.from(chunk);
                size += part.length;
                if (size > 1048576 || size > Number(file.bytes)) throw new Error("Object size exceeded");
                parts.push(part);
            }
            const bytes = Buffer.concat(parts);
            checkBytes(file, bytes);
            return bytes;
        } finally {
            if ("destroy" in body && typeof body.destroy === "function") body.destroy();
        }
    } finally {
        s3.destroy();
    }
}

export async function putVerifiedObject(file: ObjectFile, bytes: Buffer) {
    checkBytes(file, bytes);
    const key = objectKey(file), {s3, bucket} = client();
    try {
        await s3.send(new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: bytes,
            ContentType: "application/octet-stream",
            ContentLength: bytes.length,
            Metadata: {sha256: file.sha256}
        }), {abortSignal: AbortSignal.timeout(15000)});
    } finally {
        s3.destroy();
    }
    await readObject({...file, object_key: key, object_bucket: bucket});
    return {object_key: key, object_bucket: bucket};
}
