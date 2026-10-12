"use client";
/* eslint-disable react-hooks/set-state-in-effect -- Hydrate authoritative remote membership snapshots. */
import { useState, useEffect, useCallback } from "react";
import { Users, Plus } from "lucide-react";
import { api, type Person } from "@/lib/contracts";
import { Avatar, Empty, Unavailable } from "./primitives";
type Report = (e: unknown) => void;
export function TeamsPanel({
  org,
  role,
  refresh,
  report,
}: {
  org: string;
  role: string;
  refresh: () => Promise<void>;
  report: Report;
}) {
  const [teams, setTeams] = useState<
    { id: string; name: string; joined: boolean; archived: boolean }[]
  >([]);
  const load = useCallback(
    async () =>
      setTeams(
        (await api<{ teams: typeof teams }>(`/organizations/${org}/teams`))
          .teams,
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
          <span className="eyebrow">A SPACE FOR EVERY TEAM</span>
          <h1>Discover your teams</h1>
          <p>
            Join a team to access its standard channels. Private channels
            require explicit membership.
          </p>
        </div>
        <Users size={30} />
      </div>
      <div className="content-pad form-grid">
        {teams.map((t) => (
          <div className="card" key={t.id}>
            <h2>{t.name}</h2>
            <p>
              {t.archived
                ? "Archived"
                : t.joined
                  ? "You are a member"
                  : "Open to workspace members"}
            </p>
            <button
              className="secondary"
              disabled={t.archived || role === "guest"}
              onClick={async () => {
                try {
                  await api(
                    `/organizations/${org}/teams/${t.id}/${t.joined ? "leave" : "join"}`,
                    "POST",
                    {},
                  );
                  await load();
                  await refresh();
                } catch (e) {
                  report(e);
                }
              }}
            >
              {t.joined ? "Leave team" : "Join team"}
            </button>
            {["owner", "admin"].includes(role) && (
              <button
                className="secondary"
                onClick={async () => {
                  try {
                    await api(`/organizations/${org}/teams/${t.id}`, "PATCH", {
                      name: t.name,
                      archived: !t.archived,
                    });
                    await load();
                    await refresh();
                  } catch (e) {
                    report(e);
                  }
                }}
              >
                {t.archived ? "Restore" : "Archive"}
              </button>
            )}
          </div>
        ))}
        {!teams.length && (
          <Empty title="Build your first team">
            Use the + beside Your Teams to create a space.
          </Empty>
        )}
      </div>
    </>
  );
}
export function MembershipPanel({
  org,
  people,
  refresh,
  report,
}: {
  org: string;
  people: Person[];
  refresh: () => Promise<void>;
  report: Report;
}) {
  const [email, setEmail] = useState(""),
    [role, setRole] = useState("guest"),
    [token, setToken] = useState(""),
    [invites, setInvites] = useState<
      {
        id: string;
        email: string;
        role: string;
        expires_at: string;
        revoked: boolean;
        accepted_by: string | null;
      }[]
    >([]);
  const load = useCallback(
    async () =>
      setInvites(
        (
          await api<{ invitations: typeof invites }>(
            `/organizations/${org}/invitations`,
          )
        ).invitations,
      ),
    [org],
  );
  useEffect(() => {
    void load().catch(report);
  }, [load, report]);
  return (
    <>
      <section className="card">
        <h2>Workspace members</h2>
        <p>
          Changes apply to this workspace only. Removing access also ends active
          subscriptions.
        </p>
        {people.map((p) => (
          <div className="member-row" key={p.id}>
            <Avatar name={p.name} small />
            <div>
              <strong>{p.name}</strong>
              <small>{p.email}</small>
            </div>
            <label className="sr-only" htmlFor={`role-${p.id}`}>
              Role for {p.name}
            </label>
            <select
              id={`role-${p.id}`}
              value={p.role}
              onChange={async (e) => {
                try {
                  await api(`/organizations/${org}/members/${p.id}`, "PATCH", {
                    role: e.target.value,
                    active: true,
                  });
                  await refresh();
                } catch (e) {
                  report(e);
                }
              }}
            >
              {["owner", "admin", "member", "guest"].map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
            <button
              className="secondary"
              onClick={async () => {
                try {
                  await api(`/organizations/${org}/members/${p.id}`, "PATCH", {
                    role: p.role,
                    active: false,
                  });
                  await refresh();
                } catch (e) {
                  report(e);
                }
              }}
            >
              Remove
            </button>
          </div>
        ))}
      </section>
      <form
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const result = await api<{ token: string }>(
              `/organizations/${org}/invitations`,
              "POST",
              { email, role },
            );
            setToken(result.token);
            setEmail("");
            await load();
          } catch (e) {
            report(e);
          }
        }}
      >
        <h2>Invite a colleague or guest</h2>
        <label>
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="guest">Guest</option>
            <option value="member">Member</option>
          </select>
        </label>
        <button className="primary">
          <Plus size={15} />
          Create invitation
        </button>
        {token && (
          <label className="invitation-token">
            Single-use token (expires in 7 days)
            <input readOnly value={token} onFocus={(e) => e.target.select()} />
            <small>
              Share securely. The invited user accepts it from Settings after
              signing in with the invited email.
            </small>
          </label>
        )}
        <Unavailable title="Manual invitation delivery">
          Email is not configured. The invited identity must already be
          provisioned by an administrator. Production identity onboarding
          remains incomplete.
        </Unavailable>
        {invites.map((i) => (
          <div className="member-row" key={i.id}>
            <div>
              <strong>{i.email}</strong>
              <small>
                {i.accepted_by
                  ? "Accepted"
                  : i.revoked
                    ? "Revoked"
                    : `Expires ${new Date(i.expires_at).toLocaleDateString()}`}
              </small>
            </div>
            {!i.revoked && !i.accepted_by && (
              <button
                type="button"
                className="secondary"
                onClick={async () => {
                  try {
                    await api(
                      `/organizations/${org}/invitations/${i.id}`,
                      "DELETE",
                    );
                    await load();
                  } catch (e) {
                    report(e);
                  }
                }}
              >
                Revoke
              </button>
            )}
          </div>
        ))}
      </form>
    </>
  );
}
export function AcceptInvitation({
  onSave,
  report,
}: {
  onSave: () => Promise<void>;
  report: Report;
}) {
  const [token, setToken] = useState(""),
    [done, setDone] = useState(false);
  return (
    <form
      className="card settings-form"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api("/invitations/accept", "POST", { token });
          setDone(true);
          setToken("");
          await onSave();
        } catch (e) {
          report(e);
        }
      }}
    >
      <h2>Join another workspace</h2>
      <label>
        Invitation token
        <input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          required
          minLength={64}
          maxLength={64}
        />
      </label>
      <button className="secondary">Accept invitation</button>
      {done && (
        <p role="status">
          Workspace added. Choose it from the workspace selector.
        </p>
      )}
    </form>
  );
}
