import {z} from 'zod';
export const maxImageArchiveBytes=4*1024*1024*1024;
export const imageArchiveSchema=z.object({format:z.literal('aes-256-gcm-v1'),name:z.string().regex(/^core-images-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.bin$/),bytes:z.number().int().min(36).max(maxImageArchiveBytes),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
