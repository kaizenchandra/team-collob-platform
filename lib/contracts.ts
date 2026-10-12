import { z } from "zod";
export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  title: z.string(),
  timezone: z.string(),
  status: z.string(),
  preferences: z.record(z.string(), z.unknown()),
});
export const sessionSchema = z.object({
  user: userSchema,
  organizations: z.array(
    z.object({ id: z.string(), name: z.string(), role: z.string() }),
  ),
});
export type Session = z.infer<typeof sessionSchema>;
export type Person = {
  id: string;
  name: string;
  email: string;
  title: string;
  role: string;
  presence: string;
};
export type Channel = {
  id: string;
  name: string;
  description: string;
  kind: string;
  team_id: string | null;
  archived: boolean;
  pinned: boolean;
  muted: boolean;
  hidden: boolean;
  unread: number;
  preview: string | null;
  revision: number;
};
export type Bootstrap = {
  role: string;
  teams: { id: string; name: string; archived: boolean }[];
  channels: Channel[];
  people: Person[];
};
export const messageView = z.object({
  attachments: z.array(z.object({id:z.uuid(),name:z.string().nullable(),state:z.enum(["ready","unavailable"])})).default([]),
  mentions: z.array(z.object({id: z.uuid(), name: z.string()})).default([]),
  format: z.enum(["plain", "markdown-v1"]).default("plain"),
  id: z.string(),
  user_id: z.string(),
  name: z.string(),
  body: z.string(),
  seq: z.string(),
  created_at: z.string(),
  edited_at: z.string().nullable(),
  deleted: z.boolean(),
  parent_id: z.string().nullable(),
  reactions: z.array(z.object({ emoji: z.string(), userId: z.string() })),
  saved: z.boolean(),
});
export const historySchema = z.object({
  messages: z.array(messageView),
  hasMore: z.boolean(),
  channel: z.unknown(),
});
export type Message = z.infer<typeof messageView>;
export type Task = {
  id: string;
  title: string;
  assignee: string | null;
  priority: string;
  due_date: string | null;
  status: "todo" | "doing" | "done";
};
export type FormRecord = {
  id: string;
  title: string;
  questions: string[];
  my_answers: string[] | null;
  created_by: string;
};
export type Meeting = {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  organizer_id: string;
  cancelled: boolean;
  response: string;
};
export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4100";
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${API}/v1${path}`, {
    method,
    credentials: "include",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(data.error ?? "Request failed", response.status);
  return data as T;
}
