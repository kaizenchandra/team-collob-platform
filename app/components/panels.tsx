"use client";
/* Remote snapshots and live subscriptions intentionally reset state on resource changes.
   This prevents showing the previous resource while asynchronous requests are pending. */
/* eslint-disable react-hooks/set-state-in-effect */
import {beginUpload,finishUpload} from "@/lib/pending-uploads";
import { useState, useEffect, useCallback, type FormEvent } from "react";
import { Plus, CalendarDays, FileText, Upload } from "lucide-react";
import {
  api,
  API,
  type Person,
  type Task,
  type FormRecord,
  type Meeting,
  type Session,
  type Channel,
} from "@/lib/contracts";
import { Empty, Modal, Unavailable } from "./primitives";
import { AcceptInvitation } from "./membership-panels";

type Report = (e: unknown) => void;
export function WorkPanel({
  stream,
  tab,
  people,
  userId,
  report,
}: {
  stream: string;
  tab: string;
  people: Person[];
  userId: string;
  report: Report;
}) {
  const [tasks, setTasks] = useState<Task[]>([]),
    [forms, setForms] = useState<FormRecord[]>([]),
    [modal, setModal] = useState(false),
    [title, setTitle] = useState(""),
    [assignee, setAssignee] = useState(""),
    [priority, setPriority] = useState("normal"),
    [due, setDue] = useState(""),
    [questions, setQuestions] = useState(""),
    [commentTask, setCommentTask] = useState<Task | null>(null),
    [comments, setComments] = useState<
      { id: string; body: string; name: string }[]
    >([]),
    [comment, setComment] = useState("");
  const load = useCallback(async () => {
    if (tab === "Tasks")
      setTasks(
        (await api<{ tasks: Task[] }>(`/channels/${stream}/tasks`)).tasks,
      );
    else
      setForms(
        (await api<{ forms: FormRecord[] }>(`/channels/${stream}/forms`)).forms,
      );
  }, [stream, tab]);
  useEffect(() => {
    void load().catch(report);
    const timer = setInterval(() => void load().catch(report), 10000);
    return () => clearInterval(timer);
  }, [load, report]);
  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      await api(
        `/channels/${stream}/${tab === "Tasks" ? "tasks" : "forms"}`,
        "POST",
        tab === "Tasks"
          ? {
              title,
              assigneeId: assignee || null,
              priority,
              dueDate: due || null,
            }
          : { title, questions: questions.split("\n").filter(Boolean) },
      );
      setModal(false);
      setTitle("");
      await load();
    } catch (e) {
      report(e);
    }
  }
  return (
    <div className="content-pad work-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">PRIVATE CHANNEL WORKSPACE</span>
          <h2>
            {tab === "Tasks"
              ? "Make progress, together."
              : "A place for every perspective."}
          </h2>
        </div>
        <button className="primary" onClick={() => setModal(true)}>
          <Plus size={16} />
          New {tab === "Tasks" ? "task" : "form"}
        </button>
      </div>
      {tab === "Tasks" ? (
        <div className="task-board">
          {(["todo", "doing", "done"] as const).map((status, i) => (
            <section className="task-column" key={status}>
              <h3>
                <i />
                {["To do", "In progress", "Done"][i]}
                <span>{tasks.filter((t) => t.status === status).length}</span>
              </h3>
              {tasks
                .filter((t) => t.status === status)
                .map((t) => (
                  <article className="task-card" key={t.id}>
                    <span className={`priority ${t.priority}`}>
                      {t.priority}
                    </span>
                    <h4>{t.title}</h4>
                    <p>{t.assignee ?? "Unassigned"}</p>
                    {t.due_date && (
                      <small>
                        <CalendarDays size={12} />
                        {new Date(t.due_date).toLocaleDateString()}
                      </small>
                    )}
                    <label className="sr-only" htmlFor={`status-${t.id}`}>
                      Task status for {t.title}
                    </label>
                    <select
                      id={`status-${t.id}`}
                      value={t.status}
                      onChange={async (e) => {
                        try {
                          await api(
                            `/channels/${stream}/tasks/${t.id}`,
                            "PATCH",
                            { status: e.target.value },
                          );
                          await load();
                        } catch (e) {
                          report(e);
                        }
                      }}
                    >
                      <option value="todo">To do</option>
                      <option value="doing">In progress</option>
                      <option value="done">Done</option>
                    </select>
                    <button
                      className="text-button"
                      onClick={async () => {
                        setCommentTask(t);
                        try {
                          setComments(
                            (
                              await api<{ comments: typeof comments }>(
                                `/channels/${stream}/tasks/${t.id}/comments`,
                              )
                            ).comments,
                          );
                        } catch (e) {
                          report(e);
                        }
                      }}
                    >
                      Comments
                    </button>
                  </article>
                ))}
              {!tasks.some((t) => t.status === status) && (
                <p className="column-empty">Nothing here yet</p>
              )}
            </section>
          ))}
        </div>
      ) : (
        <div className="form-grid">
          {forms.map((f) => (
            <ResponseForm
              key={f.id}
              form={f}
              stream={stream}
              userId={userId}
              report={report}
            />
          ))}
          {!forms.length && (
            <Empty title="Ask your team">
              Create a form to collect feedback, ideas, or decisions.
            </Empty>
          )}
        </div>
      )}
      {modal && (
        <Modal
          title={`New ${tab === "Tasks" ? "task" : "form"}`}
          onClose={() => setModal(false)}
        >
          <form className="modal-body" onSubmit={create}>
            <label>
              Title
              <input
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={500}
              />
            </label>
            {tab === "Tasks" ? (
              <>
                <label>
                  Assign to
                  <select
                    value={assignee}
                    onChange={(e) => setAssignee(e.target.value)}
                  >
                    <option value="">Unassigned</option>
                    {people.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <small>
                    Only members with channel access can be assigned.
                  </small>
                </label>
                <label>
                  Priority
                  <select
                    value={priority}
                    onChange={(e) => setPriority(e.target.value)}
                  >
                    <option value="low">Low</option>
                    <option value="normal">Normal</option>
                    <option value="high">High</option>
                  </select>
                </label>
                <label>
                  Due date
                  <input
                    type="date"
                    value={due}
                    onChange={(e) => setDue(e.target.value)}
                  />
                </label>
              </>
            ) : (
              <label>
                Questions (one per line)
                <textarea
                  required
                  value={questions}
                  onChange={(e) => setQuestions(e.target.value)}
                />
              </label>
            )}
            <button className="primary">Create</button>
          </form>
        </Modal>
      )}
      {commentTask && (
        <Modal title={commentTask.title} onClose={() => setCommentTask(null)}>
          <div className="modal-body">
            {comments.map((c) => (
              <p key={c.id}>
                <strong>{c.name}</strong>
                <br />
                {c.body}
              </p>
            ))}
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await api(
                    `/channels/${stream}/tasks/${commentTask.id}/comments`,
                    "POST",
                    { body: comment },
                  );
                  setComment("");
                  setComments(
                    (
                      await api<{ comments: typeof comments }>(
                        `/channels/${stream}/tasks/${commentTask.id}/comments`,
                      )
                    ).comments,
                  );
                } catch (e) {
                  report(e);
                }
              }}
            >
              <label>
                Comment
                <textarea
                  required
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                />
              </label>
              <button className="primary">Add comment</button>
            </form>
          </div>
        </Modal>
      )}
    </div>
  );
}
function ResponseForm({
  form,
  stream,
  userId,
  report,
}: {
  form: FormRecord;
  stream: string;
  userId: string;
  report: Report;
}) {
  const [answers, setAnswers] = useState(
      form.my_answers ?? form.questions.map(() => ""),
    ),
    [saved, setSaved] = useState(!!form.my_answers),
    [responses, setResponses] = useState<
      { name: string; answers: string[] }[] | null
    >(null);
  return (
    <form
      className="card"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api(`/channels/${stream}/forms/${form.id}/responses`, "POST", {
            answers,
          });
          setSaved(true);
        } catch (e) {
          report(e);
        }
      }}
    >
      <h3>{form.title}</h3>
      {form.questions.map((q, i) => (
        <label key={i}>
          {q}
          <textarea
            value={answers[i]}
            maxLength={2000}
            required
            onChange={(e) => {
              setAnswers((a) =>
                a.map((s, j) => (j === i ? e.target.value : s)),
              );
              setSaved(false);
            }}
          />
        </label>
      ))}
      <button className="primary">
        {saved ? "Update response" : "Submit response"}
      </button>
      {saved && <p role="status">Your response is saved.</p>}
      {form.created_by === userId && (
        <button
          className="secondary"
          type="button"
          onClick={async () => {
            try {
              setResponses(
                (
                  await api<{ responses: NonNullable<typeof responses> }>(
                    `/channels/${stream}/forms/${form.id}/responses`,
                  )
                ).responses,
              );
            } catch (e) {
              report(e);
            }
          }}
        >
          View responses
        </button>
      )}
      {responses?.map((r, i) => (
        <div className="result-card" key={i}>
          <strong>{r.name}</strong>
          {r.answers.map((a, j) => (
            <p key={j}>
              {form.questions[j]}: {a}
            </p>
          ))}
        </div>
      ))}
    </form>
  );
}
export function CalendarPanel({
  org,
  people,
  userId,
  report,
}: {
  org: string;
  people: Person[];
  userId: string;
  report: Report;
}) {
  const [meetings, setMeetings] = useState<Meeting[]>([]),
    [modal, setModal] = useState(false),
    [title, setTitle] = useState(""),
    [start, setStart] = useState(""),
    [end, setEnd] = useState(""),
    [attendees, setAttendees] = useState<string[]>([]);
  const load = useCallback(
    async () =>
      setMeetings(
        (await api<{ meetings: Meeting[] }>(`/organizations/${org}/meetings`))
          .meetings,
      ),
    [org],
  );
  useEffect(() => {
    void load().catch(report);
  }, [load, report]);
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">MAKE TIME FOR WHAT MATTERS</span>
          <h1>Your calendar</h1>
          <p>
            Plan the next conversation. Times shown in{" "}
            {Intl.DateTimeFormat().resolvedOptions().timeZone}.
          </p>
        </div>
        <button className="primary" onClick={() => setModal(true)}>
          <Plus size={17} />
          Schedule meeting
        </button>
      </div>
      <div className="content-pad">
        <Unavailable title="Local scheduling only">
          External calendar synchronization, recurrence, availability, and
          joining real media are not configured in this increment.
        </Unavailable>
        {meetings.length ? (
          meetings.map((m) => (
            <article className="meeting-card" key={m.id}>
              <div className="date-block">
                <strong>{new Date(m.starts_at).getDate()}</strong>
                <span>
                  {new Date(m.starts_at).toLocaleDateString([], {
                    month: "short",
                  })}
                </span>
              </div>
              <div>
                <h3>
                  {m.title}
                  {m.cancelled && " · Cancelled"}
                </h3>
                <p>
                  {new Date(m.starts_at).toLocaleString()} –{" "}
                  {new Date(m.ends_at).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
                <small>
                  {m.response} · {m.timezone}
                </small>
              </div>
              {!m.cancelled && (
                <div className="meeting-actions">
                  {m.organizer_id === userId ? (
                    <button
                      className="secondary"
                      onClick={async () => {
                        try {
                          await api(
                            `/organizations/${org}/meetings/${m.id}`,
                            "PATCH",
                            { cancelled: true },
                          );
                          await load();
                        } catch (e) {
                          report(e);
                        }
                      }}
                    >
                      Cancel meeting
                    </button>
                  ) : (
                    <>
                      <label className="sr-only" htmlFor={m.id}>
                        RSVP
                      </label>
                      <select
                        id={m.id}
                        value={m.response}
                        onChange={async (e) => {
                          try {
                            await api(
                              `/organizations/${org}/meetings/${m.id}`,
                              "PATCH",
                              { response: e.target.value },
                            );
                            await load();
                          } catch (e) {
                            report(e);
                          }
                        }}
                      >
                        <option value="pending" disabled>
                          Respond
                        </option>
                        <option value="accepted">Accept</option>
                        <option value="tentative">Tentative</option>
                        <option value="declined">Decline</option>
                      </select>
                    </>
                  )}
                </div>
              )}
            </article>
          ))
        ) : (
          <Empty title="Room for your next big idea">
            Schedule a meeting and invite people from your workspace.
          </Empty>
        )}
      </div>
      {modal && (
        <Modal title="Schedule a meeting" onClose={() => setModal(false)}>
          <form
            className="modal-body"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api(`/organizations/${org}/meetings`, "POST", {
                  title,
                  startsAt: new Date(start).toISOString(),
                  endsAt: new Date(end).toISOString(),
                  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                  attendees,
                });
                setModal(false);
                await load();
              } catch (e) {
                report(e);
              }
            }}
          >
            <label>
              Meeting title
              <input
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label>
              Starts
              <input
                type="datetime-local"
                required
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </label>
            <label>
              Ends
              <input
                type="datetime-local"
                required
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </label>
            <fieldset>
              <legend>Invite attendees</legend>
              {people
                .filter((p) => p.id !== userId)
                .map((p) => (
                  <label className="check-label" key={p.id}>
                    <input
                      type="checkbox"
                      checked={attendees.includes(p.id)}
                      onChange={(e) =>
                        setAttendees((a) =>
                          e.target.checked
                            ? [...a, p.id]
                            : a.filter((x) => x !== p.id),
                        )
                      }
                    />
                    {p.name}
                  </label>
                ))}
            </fieldset>
            <button className="primary">Schedule meeting</button>
          </form>
        </Modal>
      )}
    </>
  );
}
export function SettingsPanel({
  session,
  onSave,
  report,
}: {
  session: Session;
  onSave: () => Promise<void>;
  report: Report;
}) {
  const [name, setName] = useState(session.user.name),
    [title, setTitle] = useState(session.user.title),
    [timezone, setTimezone] = useState(session.user.timezone),
    [status, setStatus] = useState(session.user.status),
    [theme, setTheme] = useState(
      session.user.preferences.theme === "dark" ? "dark" : "light",
    ),
    [receipts, setReceipts] = useState(
      session.user.preferences.readReceipts !== false,
    ),
    [saved, setSaved] = useState(false);
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">MAKE IT YOURS</span>
          <h1>Profile & preferences</h1>
          <p>Small details that make your workspace feel like you.</p>
        </div>
      </div>
      <div className="content-pad">
        <form
          className="card settings-form"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api("/profile", "PATCH", {
                name,
                title,
                timezone,
                status,
                preferences: {
                  ...session.user.preferences,
                  theme,
                  readReceipts: receipts,
                },
              });
              await onSave();
              setSaved(true);
            } catch (e) {
              report(e);
            }
          }}
        >
          <h2>Your profile</h2>
          <label>
            Display name
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Job information
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label>
            Timezone
            <input
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
            />
          </label>
          <label>
            Status message
            <input
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              maxLength={200}
            />
          </label>
          <h2>Preferences</h2>
          <label>
            Appearance
            <select value={theme} onChange={(e) => setTheme(e.target.value)}>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={receipts}
              onChange={(e) => setReceipts(e.target.checked)}
            />
            Share per-recipient read receipts
          </label>
          <p className="muted">
            Your read position remains private when receipts are disabled.
            Unread counts still work.
          </p>
          <button className="primary">Save preferences</button>
          {saved && <p role="status">Preferences saved.</p>}
          <Unavailable title="Additional preferences are not available yet">
            Language/RTL, device preferences, browser notifications, and quiet
            hours are pending implementation. Profile photos are not supported
            in this increment.
          </Unavailable>
        </form>
        <RecoverySettings />
        <AcceptInvitation onSave={onSave} report={report} />
      </div>
    </>
  );
}
function RecoverySettings() {
  const [state, setState] = useState<
    "loading" | "available" | "unconfigured" | "error"
  >("loading");
  const load = useCallback(async () => {
    setState("loading");
    try {
      const result = await api<{ recoveryCodes: boolean }>("/capabilities");
      setState(result.recoveryCodes ? "available" : "unconfigured");
    } catch {
      setState("error");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section className="card settings-form" aria-labelledby="recovery-title">
      <h2 id="recovery-title">Sign-in recovery</h2>
      <p>
        Recovery codes let you sign in with your password when your
        authenticator is unavailable. Save them somewhere private before you
        need them.
      </p>
      {state === "available" ? (
        <>
          <a
            className="secondary sso"
            href={`${API}/v1/auth/login?action=recovery-codes`}
          >
            Manage recovery codes
          </a>
          <p className="muted">
            Your identity provider will ask you to authenticate and confirm
            enrollment. Replacing a set invalidates its unused codes. Codes are
            never stored in this workspace.
          </p>
        </>
      ) : (
        <p role="status">
          {state === "loading"
            ? "Checking provider capabilities…"
            : state === "unconfigured"
              ? "Recovery-code management is not configured for this deployment."
              : "Could not check recovery availability."}
        </p>
      )}
      {state === "error" && (
        <button onClick={() => void load()}>Retry recovery availability</button>
      )}
      <p className="muted">
        Forgotten-password and lost-all-factors recovery are not available in
        this release. Contact your identity administrator.
      </p>
    </section>
  );
}
export function FilesPanel({
  userId,
  stream,
  report,
}: {
  userId: string;
  stream: string;
  report: Report;
}) {
  const [files, setFiles] = useState<
      { id: string; name: string; bytes: string; state: string; scan_status: string }[]
    >([]),
    [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const response=await api<{files: typeof files}>(`/channels/${stream}/files`);
    setFiles(response.files);
  },[stream]);
  useEffect(()=>{
    let active=true,pending=false;
    const refresh=async()=>{if(pending)return;pending=true;try{const r=await api<{files: typeof files}>(`/channels/${stream}/files`);if(active)setFiles(r.files);}catch(e){if(active){setFiles([]);report(e);}}finally{pending=false;}};
    void refresh();const timer=setInterval(()=>{void refresh();},3000);
    return()=>{active=false;clearInterval(timer);};
  },[stream,report]);
  return (
    <div className="content-pad">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">SHARED IN THIS CONVERSATION</span>
          <h2>Files</h2>
        </div>
        <label className="primary upload-button">
          <Upload size={16} />
          {busy ? "Uploading…" : "Upload file"}
          <input
            type="file"
            disabled={busy}
            onChange={async (e) => {
              const input=e.currentTarget;
              const file = input.files?.[0];
              if (!file) return;
              setBusy(true);
              try {
                if (file.size > 1024 * 1024)
                  throw new Error("Local uploads are limited to 1 MB.");
                const data = await new Promise<string>((resolve, reject) => {
                  const r = new FileReader();
                  r.onload = () => resolve(String(r.result).split(",")[1]);
                  r.onerror = reject;
                  r.readAsDataURL(file);
                });
                const mime=file.type || "application/octet-stream";
                const digest=async(bytes:BufferSource)=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),v=>v.toString(16).padStart(2,"0")).join("");
                const hash=await digest(await file.arrayBuffer());
                const fingerprint=await digest(new TextEncoder().encode(JSON.stringify([file.name,mime,hash])));
                const clientId=beginUpload(window.sessionStorage,userId,stream,fingerprint);
                await api(`/channels/${stream}/files`, "POST", {
                  clientId,
                  name: file.name,
                  mime,
                  content: data,
                });
                finishUpload(window.sessionStorage,clientId);
                await load();
              } catch (e) {
                report(e);
              } finally {
                input.value="";
                setBusy(false);
              }
            }}
          />
        </label>
      </div>
      <Unavailable title="Scan before download">
        Supported: TXT, MD, CSV, PDF, PNG and JPEG up to1MB. Files stay quarantined until a real malware scan succeeds. Rejected files cannot be downloaded. Scanning may take time or remain unavailable; failed jobs can be retried by the uploader. If an upload is interrupted, reselect the same file to retry safely, including after reload. Previews, versions and coauthoring remain unavailable.
      </Unavailable>
      {files.length ? (
        files.map((f) => (
          <div className="file-row" key={f.id}>
            <FileText size={24} />
            <div>
              <strong>{f.name}</strong>
              <small>
                {Math.ceil(Number(f.bytes) / 1024)} KB · {f.state} · scan {f.scan_status}
              </small>
            </div>
            {f.state === "ready" && <a className="secondary" href={`${API}/v1/channels/${stream}/files/${f.id}/download`}>Download</a>}
            {f.state === "quarantined" && f.scan_status === "dead" && <button className="secondary" onClick={async()=>{try{await api(`/channels/${stream}/files/${f.id}/retry`,"POST",{});await load();}catch(e){report(e);}}}>Retry scan</button>}
            <button
              className="secondary"
              onClick={async () => {
                try {
                  await api(`/channels/${stream}/files/${f.id}`, "DELETE");
                  await load();
                } catch (e) {
                  report(e);
                }
              }}
            >
              Delete
            </button>
          </div>
        ))
      ) : (
        <Empty title="Everything in its place">
          Files uploaded to this channel appear here with their processing
          status.
        </Empty>
      )}
    </div>
  );
}
export function MigrationPanel({
  channel,
  teams,
  people,
  onDone,
  report,
}: {
  channel: Channel;
  teams: { id: string; name: string }[];
  people: Person[];
  onDone: () => void;
  report: Report;
}) {
  const [kind, setKind] = useState(channel.kind),
    [teamId, setTeam] = useState(channel.team_id ?? ""),
    [members, setMembers] = useState<string[]>([]),
    [preview, setPreview] = useState<Record<string, unknown> | null>(null),
    [key] = useState(() => crypto.randomUUID());
  const name = (id: string) => people.find((p) => p.id === id)?.name ?? id;
  return (
    <div className="modal-body">
      <Unavailable title="Historical access changes">
        Newly granted members will be able to read all existing history.
        Revocation cannot recall downloaded content. Migration is limited to
        teams in this workspace.
      </Unavailable>
      <label>
        Channel type
        <select
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setPreview(null);
          }}
        >
          {["standard", "private", "shared"].map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
      </label>
      <label>
        Destination team
        <select
          value={teamId}
          onChange={(e) => {
            setTeam(e.target.value);
            setPreview(null);
          }}
        >
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      {kind !== "standard" && (
        <fieldset>
          <legend>Explicit access (you remain a member)</legend>
          {people.map((p) => (
            <label className="check-label" key={p.id}>
              <input
                type="checkbox"
                checked={members.includes(p.id)}
                onChange={(e) => {
                  setMembers((m) =>
                    e.target.checked
                      ? [...m, p.id]
                      : m.filter((x) => x !== p.id),
                  );
                  setPreview(null);
                }}
              />
              {p.name} · {p.role}
            </label>
          ))}
        </fieldset>
      )}
      <button
        className="secondary"
        onClick={async () => {
          try {
            setPreview(
              await api(`/channels/${channel.id}/migration-preview`, "POST", {
                kind,
                teamId,
                members,
              }),
            );
          } catch (e) {
            report(e);
          }
        }}
      >
        Preview permission changes
      </button>
      {preview && (
        <div className="migration-preview">
          <h3>Review access changes</h3>
          <p>
            Granted:{" "}
            {(preview.granted as string[]).map(name).join(", ") || "None"}
          </p>
          <p>
            Revoked:{" "}
            {(preview.revoked as string[]).map(name).join(", ") || "None"}
          </p>
          <p>{String(preview.history)}</p>
          <button
            className="primary"
            onClick={async () => {
              try {
                await api(`/channels/${channel.id}/migrate`, "POST", {
                  kind,
                  teamId,
                  members,
                  preview,
                  clientId: key,
                });
                onDone();
              } catch (e) {
                report(e);
                setPreview(null);
              }
            }}
          >
            Confirm and apply
          </button>
        </div>
      )}
    </div>
  );
}
