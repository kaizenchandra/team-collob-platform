import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  savePending,
  pendingFor,
  pendingMessages,
  removePending,
  retainIdentity,
  clearPending,
  pendingStorageKey,
  type PendingMessage,
} from "../lib/pending-messages.ts";
class MemoryStorage implements Storage {
  data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}
function operation(): PendingMessage {
  return {
    id: randomUUID(),
    userId: randomUUID(),
    orgId: randomUUID(),
    channelId: randomUUID(),
    body: "Unconfirmed content",
    parentId: null,
  };
}
test("unconfirmed operations survive a new reader with their immutable ID and thread", () => {
  const storage = new MemoryStorage(),
    p = { ...operation(), parentId: randomUUID() };
  savePending(storage, p);
  const reloaded = new MemoryStorage();
  reloaded.data = new Map(storage.data);
  assert.deepEqual(pendingFor(reloaded, p.userId, p.orgId, p.channelId), p);
  assert.throws(
    () => savePending(reloaded, { ...p, id: randomUUID() }),
    /existing unconfirmed/,
  );
  savePending(reloaded, p);
  assert.equal(pendingMessages(reloaded).length, 1);
  removePending(reloaded, p.id);
  assert.equal(reloaded.length, 0);
});
test("pending scope cannot cross identity, organization or channel and sign-in removes previous identity", () => {
  const storage = new MemoryStorage(),
    p = operation(),
    other = operation();
  savePending(storage, p);
  savePending(storage, other);
  assert.equal(pendingFor(storage, randomUUID(), p.orgId, p.channelId), null);
  assert.equal(pendingFor(storage, p.userId, randomUUID(), p.channelId), null);
  assert.equal(pendingFor(storage, p.userId, p.orgId, randomUUID()), null);
  retainIdentity(storage, other.userId);
  assert.deepEqual(pendingMessages(storage), [other]);
  clearPending(storage);
  assert.equal(storage.length, 0);
});
test("storage failure cannot silently discard the operation; malformed storage fails closed", () => {
  const storage = new MemoryStorage();
  storage.setItem(pendingStorageKey, "{broken");
  assert.throws(() => pendingMessages(storage), /storage is invalid/);
  clearPending(storage);
  storage.setItem = () => {
    throw new Error("Quota exceeded");
  };
  assert.throws(() => savePending(storage, operation()), /No message was sent/);
});
test("pending operation capacity is bounded without evicting unresolved sends", () => {
  const storage = new MemoryStorage();
  const first = operation();
  savePending(storage, first);
  for (let i = 1; i < 32; i++) savePending(storage, operation());
  assert.throws(() => savePending(storage, operation()), /Too many/);
  assert.equal(pendingMessages(storage).length, 32);
  assert.deepEqual(
    pendingFor(storage, first.userId, first.orgId, first.channelId),
    first,
  );
});

test("formatted pending operations retain the original format and legacy records remain plain-compatible", () => {
  const storage = new MemoryStorage(), p = {...operation(),format:"markdown-v1" as const};
  savePending(storage,p);
  assert.equal(pendingFor(storage,p.userId,p.orgId,p.channelId)?.format,"markdown-v1");
  assert.throws(()=>savePending(storage,{...p,format:"plain"}),/existing unconfirmed/);
  clearPending(storage);
  const legacy = operation();
  storage.setItem(pendingStorageKey,JSON.stringify([legacy]));
  assert.equal(pendingFor(storage,legacy.userId,legacy.orgId,legacy.channelId)?.format ?? "plain","plain");
});

test("attachment references survive recovery and cannot change on an unconfirmed operation",()=>{
  const storage=new MemoryStorage(),p={...operation(),attachmentIds:[randomUUID()]};
  savePending(storage,p);
  assert.deepEqual(pendingFor(storage,p.userId,p.orgId,p.channelId)?.attachmentIds,p.attachmentIds);
  assert.throws(()=>savePending(storage,{...p,attachmentIds:[randomUUID()]}),/existing unconfirmed/);
  assert.throws(()=>savePending(new MemoryStorage(),{...p,attachmentIds:["not-an-id"]}));
});

test("upload recovery retains scoped identity without storing bytes and clears on logout",async()=>{
  const {beginUpload,finishUpload,uploadStorageKey}=await import("../lib/pending-uploads.ts");
  const storage=new MemoryStorage(),user=randomUUID(),channel=randomUUID(),fingerprint="a".repeat(64);
  const id=beginUpload(storage,user,channel,fingerprint);
  assert.equal(beginUpload(storage,user,channel,fingerprint),id);
  assert.notEqual(beginUpload(storage,randomUUID(),channel,fingerprint),id);
  assert.notEqual(beginUpload(storage,user,randomUUID(),fingerprint),id);
  finishUpload(storage,id);assert.notEqual(beginUpload(storage,user,channel,fingerprint),id);
  clearPending(storage);assert.equal(storage.getItem(uploadStorageKey),null);
  storage.setItem(uploadStorageKey,"broken");assert.throws(()=>beginUpload(storage,user,channel,fingerprint),/recovery data/);
});
