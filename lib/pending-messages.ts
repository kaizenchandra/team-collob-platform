import { uploadStorageKey } from "./pending-uploads.ts";
import { z } from "zod";

export const pendingStorageKey = "concord.pending-messages.v1";
const pendingSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  orgId: z.uuid(),
  channelId: z.uuid(),
  body: z.string().min(1).max(10000),
  format: z.enum(["plain", "markdown-v1"]).optional(),
  parentId: z.uuid().nullable(),
  attachmentIds: z.array(z.uuid()).max(10).optional(),
});
export type PendingMessage = z.infer<typeof pendingSchema>;
const listSchema = z.array(pendingSchema).max(32);

// Browser storage is untrusted and is never used to grant resource access.
export function pendingMessages(storage: Storage): PendingMessage[] {
  const raw = storage.getItem(pendingStorageKey);
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(
      "Pending-message storage is invalid. Clear pending sends in Help before sending again.",
    );
  }
  const parsed = listSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(
      "Pending-message storage is invalid. Clear pending sends in Help before sending again.",
    );
  return parsed.data;
}
export function pendingFor(
  storage: Storage,
  userId: string,
  orgId: string,
  channelId: string,
) {
  return (
    pendingMessages(storage).find(
      (p) =>
        p.userId === userId && p.orgId === orgId && p.channelId === channelId,
    ) ?? null
  );
}
export function savePending(storage: Storage, pending: PendingMessage) {
  const value = pendingSchema.parse(pending);
  const items = pendingMessages(storage);
  const previous = items.find(
    (p) => p.userId === value.userId && p.channelId === value.channelId,
  );
  if (previous && JSON.stringify(previous) !== JSON.stringify(value))
    throw new Error(
      "Resolve the existing unconfirmed message before sending another.",
    );
  if (!previous) items.push(value);
  if (items.length > 32)
    throw new Error(
      "Too many unconfirmed messages. Resolve pending sends before sending again.",
    );
  try {
    storage.setItem(pendingStorageKey, JSON.stringify(items));
  } catch {
    throw new Error(
      "Cannot preserve this send for recovery. Allow browser session storage, then retry. No message was sent.",
    );
  }
}
export function removePending(storage: Storage, id: string) {
  const remaining = pendingMessages(storage).filter((p) => p.id !== id);
  if (remaining.length)
    storage.setItem(pendingStorageKey, JSON.stringify(remaining));
  else storage.removeItem(pendingStorageKey);
}
export function retainIdentity(storage: Storage, userId: string) {
  const items = pendingMessages(storage).filter((p) => p.userId === userId);
  if (items.length) storage.setItem(pendingStorageKey, JSON.stringify(items));
  else storage.removeItem(pendingStorageKey);
}
export function clearPending(storage: Storage) {
  storage.removeItem(uploadStorageKey);
  storage.removeItem(pendingStorageKey);
}
