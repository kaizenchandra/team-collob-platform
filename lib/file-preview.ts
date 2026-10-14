import { z } from "zod";

export const previewMimeTypes = ["text/plain", "text/markdown", "text/csv"];
export const previewLimit = 32768;
export const filePreviewSchema = z.object({
  text: z.string().max(previewLimit),
  truncated: z.boolean(),
  bytes: z.number().int().min(0).max(1048576),
  limit: z.literal(previewLimit),
});
export type FilePreview = z.infer<typeof filePreviewSchema>;
