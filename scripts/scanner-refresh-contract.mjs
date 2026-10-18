import {z} from 'zod';
const digest=z.string().regex(/^[a-f0-9]{64}$/);
export const scannerRefreshSchema=z.object({originEnvelope:z.string().min(1).max(128*1024*1024),originSha256:digest,previousArtifactSha256:digest,previousScannerImage:z.string().regex(/^sha256:[a-f0-9]{64}$/),refreshedAt:z.iso.datetime(),immutableSha256:digest}).strict();
