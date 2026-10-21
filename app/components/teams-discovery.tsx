"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  Users,
  Plus,
  Search,
  RefreshCw,
  Check,
  Archive,
  ArrowRight,
  ChevronDown,
  X,
  LogOut,
} from "lucide-react";
import { api, type Person, type Channel } from "@/lib/contracts";
import { TeamMembers } from "./team-members";
import { TeamOwnership } from "./team-ownership";
type Team = { id: string; name: string; joined: boolean; archived: boolean };
type Filter = "all" | "joined" | "discover" | "archived";
const filters: { id: Filter; label: string }[] = [
  { id: "all", label: "All teams" },
  { id: "joined", label: "My teams" },
  { id: "discover", label: "Discover" },
  { id: "archived", label: "Archived" },
];
export function TeamsPanel({
  org,
  role,
  refresh,
  people,
  userId,
  channels,
  onCreate,
  onOpenChannel,
  teamsVersion,
}: {
  org: string;
  role: string;
  refresh: () => Promise<void>;
  report: (e: unknown) => void;
  people: Person[];
  userId: string;
  channels: Channel[];
  onCreate: () => void;
  onOpenChannel: (id: string) => void;
  teamsVersion: string;
}) {
  const [teams, setTeams] = useState<Team[]>([]),
    [loaded, setLoaded] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState<Filter>("all"),
    [page, setPage] = useState(0),
    [ownership, setOwnership] = useState<string | null>(null),
    [members, setMembers] = useState<string | null>(null),
    [archive, setArchive] = useState<string | null>(null),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [pending, setPending] = useState<Record<string, string>>({});
  const request = useRef<AbortController | null>(null),
    mounted = useRef(false),
    locks = useRef(new Set<string>()),
    search = useRef<HTMLInputElement>(null),
    id = useId();
  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    try {
      const result = await api<{ teams: Team[] }>(
        `/organizations/${org}/teams`,
        "GET",
        undefined,
        AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
      );
      if (!controller.signal.aborted) {
        setTeams(result.teams);
        setLoaded(true);
        return true;
      }
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : "Teams could not be loaded");
    } finally {
      if (request.current === controller) {
        request.current = null;
        setLoading(false);
      }
    }
    return false;
  }, [org]);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      request.current?.abort();
    };
  }, [load, teamsVersion]);
  const admin = ["owner", "admin"].includes(role),
    canJoin = role !== "guest",
    active = teams.filter((t) => !t.archived);
  const counts = {
    all: active.length,
    joined: active.filter((t) => t.joined).length,
    discover: active.filter((t) => !t.joined).length,
    archived: teams.filter((t) => t.archived).length,
  };
  const matching = teams.filter(
    (t) =>
      (filter === "archived"
        ? t.archived
        : !t.archived &&
          (filter === "all" || (filter === "joined" ? t.joined : !t.joined))) &&
      t.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const currentPage = Math.min(
      page,
      Math.max(0, Math.ceil(matching.length / 12) - 1),
    ),
    visible = matching.slice(currentPage * 12, currentPage * 12 + 12);
  function choose(next: Filter) {
    setFilter(next);
    setPage(0);
    setArchive(null);
  }
  async function change(
    t: Team,
    action: "join" | "leave" | "archive" | "restore",
  ) {
    if (locks.current.has(t.id)) return;
    locks.current.add(t.id);
    setPending((v) => ({ ...v, [t.id]: action }));
    setErrors((v) => ({ ...v, [t.id]: "" }));
    setNotice("");
    try {
      await api(
        `/organizations/${org}/teams/${t.id}${action === "join" || action === "leave" ? "/" + action : ""}`,
        action === "join" || action === "leave" ? "POST" : "PATCH",
        action === "join" || action === "leave"
          ? {}
          : { name: t.name, archived: action === "archive" },
        AbortSignal.timeout(8000),
      );
      if (!mounted.current) return;
      setTeams((rows) =>
        rows.map((row) =>
          row.id !== t.id
            ? row
            : {
                ...row,
                ...(action === "join" || action === "leave"
                  ? { joined: action === "join" }
                  : { archived: action === "archive" }),
              },
        ),
      );
      setArchive(null);
      if (action === "leave") {
        setMembers((v) => (v === t.id ? null : v));
        setOwnership((v) => (v === t.id ? null : v));
      }
      setNotice(
        action === "join"
          ? `You joined ${t.name}. Standard channels are now available.`
          : action === "leave"
            ? `You left ${t.name}.`
            : action === "archive"
              ? `${t.name} was archived. Find it under Archived.`
              : `${t.name} was restored. Find it under All teams.`,
      );
      const results = await Promise.allSettled([load(), refresh()]);
      if (mounted.current && results.some((r) => r.status === "rejected"))
        setNotice(
          `Team change saved. Navigation could not refresh; use Refresh teams before continuing.`,
        );
    } catch (e) {
      if (mounted.current)
        setErrors((v) => ({
          ...v,
          [t.id]:
            e instanceof Error
              ? e.message
              : "Change could not be confirmed. Refresh teams before retrying.",
        }));
    } finally {
      locks.current.delete(t.id);
      if (mounted.current)
        setPending((v) => {
          const next = { ...v };
          delete next[t.id];
          return next;
        });
    }
  }
  const onChanged = async () => {
    await load();
    await refresh();
  };
  const reset = () => {
    setQuery("");
    choose("all");
    search.current?.focus();
  };
  return (
    <section className="teams-discovery" aria-labelledby={`${id}-heading`}>
      <div className="page-heading">
        <div>
          <span className="eyebrow">BETTER TOGETHER</span>
          <h1 id={`${id}-heading`}>Discover your teams</h1>
          <p>Find a space to collaborate, or pick up where you left off.</p>
        </div>
        <div className="teams-heading-actions">
          <button
            className="secondary"
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshCw size={16} aria-hidden="true" />
            {loading ? "Refreshing…" : "Refresh teams"}
          </button>
          {canJoin && (
            <button className="primary" onClick={onCreate}>
              <Plus size={17} aria-hidden="true" />
              Create team
            </button>
          )}
        </div>
      </div>
      <div className="teams-discovery-body">
        <div className="teams-discovery-toolbar">
          <div role="group" aria-label="Filter teams" className="teams-filter">
            {filters.map((f) => (
              <button
                key={f.id}
                type="button"
                aria-pressed={filter === f.id}
                onClick={() => choose(f.id)}
              >
                {f.label}
                {loaded && (
                  <span aria-label={`${counts[f.id]} teams`}>
                    {counts[f.id]}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="teams-search">
            <label className="sr-only" htmlFor={`${id}-search`}>
              Search teams
            </label>
            <Search size={17} aria-hidden="true" />
            <input
              ref={search}
              id={`${id}-search`}
              type="search"
              placeholder="Search teams"
              maxLength={160}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
            />
            {query && (
              <button
                type="button"
                className="icon-button"
                aria-label="Clear team search"
                onClick={() => {
                  setQuery("");
                  setPage(0);
                  search.current?.focus();
                }}
              >
                <X size={16} />
              </button>
            )}
          </div>
        </div>
        <p className="teams-permission-note">
          {role === "guest"
            ? "An administrator must add guests to teams. Already a member? Open a team to see your channels."
            : "Joining a team gives you access to its standard channels. Private and shared channels use separate membership."}
        </p>
        {notice && (
          <p role="status" className="teams-notice">
            {notice}
          </p>
        )}
        {error && (
          <div role="alert" className="teams-load-error">
            <strong>Teams couldn’t be refreshed.</strong>
            <p>{error}</p>
            {loaded && (
              <p>
                The last loaded directory is shown. Refresh to check the latest
                membership.
              </p>
            )}
            <button
              className="secondary"
              disabled={loading}
              onClick={() => void load()}
            >
              Try again
            </button>
          </div>
        )}
        {loading && !loaded ? (
          <div className="teams-loading" role="status">
            <Users size={25} aria-hidden="true" />
            <p>Loading your teams…</p>
          </div>
        ) : (
          loaded && (
            <>
              <p role="status" className="teams-result-count">
                {matching.length
                  ? `${matching.length} ${matching.length === 1 ? "team" : "teams"}${query.trim() ? ` matching “${query.trim()}”` : ""}${matching.length > 12 ? ` · Page ${currentPage + 1} of ${Math.ceil(matching.length / 12)}` : ""}`
                  : ""}
              </p>
              {visible.length ? (
                <div className="teams-discovery-grid">
                  {visible.map((t) => {
                    const channel =
                        channels.find(
                          (c) =>
                            c.team_id === t.id &&
                            c.kind === "standard" &&
                            !c.archived,
                        ) ??
                        channels.find((c) => c.team_id === t.id && !c.archived),
                      busy = Boolean(pending[t.id]);
                    return (
                      <article
                        className="card team-discovery-card"
                        key={t.id}
                        aria-labelledby={`${id}-${t.id}`}
                        aria-busy={busy}
                      >
                        <div className="team-card-identity">
                          <div
                            className="team-discovery-emblem"
                            aria-hidden="true"
                          >
                            {t.name
                              .trim()
                              .split(/\s+/)
                              .slice(0, 2)
                              .map((w) => Array.from(w)[0])
                              .join("")
                              .toLocaleUpperCase()}
                          </div>
                          <div>
                            <h2 id={`${id}-${t.id}`}>{t.name}</h2>
                            <span
                              className={`team-membership-badge ${t.archived ? "is-archived" : t.joined ? "is-joined" : ""}`}
                            >
                              {t.archived ? (
                                <Archive size={13} aria-hidden="true" />
                              ) : t.joined ? (
                                <Check size={13} aria-hidden="true" />
                              ) : (
                                <Users size={13} aria-hidden="true" />
                              )}
                              {t.archived
                                ? "Archived"
                                : t.joined
                                  ? "Joined"
                                  : "Open team"}
                            </span>
                          </div>
                        </div>
                        <p className="team-card-description">
                          {t.archived
                            ? "This team and its channels are archived."
                            : t.joined
                              ? channel
                                ? "You’re a member of this team."
                                : "You’re a member. No channels are available in this team yet."
                              : role === "guest"
                                ? "Ask a workspace administrator to add you."
                                : "Join to collaborate in this team’s standard channels."}
                        </p>
                        <div className="team-primary-actions">
                          {!t.joined ? (
                            <button
                              className="primary"
                              disabled={busy || t.archived || !canJoin}
                              onClick={() => void change(t, "join")}
                            >
                              <Plus size={16} aria-hidden="true" />
                              {pending[t.id] === "join"
                                ? "Joining…"
                                : "Join team"}
                            </button>
                          ) : (
                            <>
                              {!t.archived && channel && (
                                <button
                                  className="primary"
                                  onClick={() => onOpenChannel(channel.id)}
                                >
                                  <ArrowRight size={16} aria-hidden="true" />
                                  Open team
                                </button>
                              )}
                              <button
                                className="secondary team-leave"
                                disabled={
                                  busy || t.archived || role === "guest"
                                }
                                onClick={() => void change(t, "leave")}
                              >
                                <LogOut size={15} aria-hidden="true" />
                                {pending[t.id] === "leave"
                                  ? "Leaving…"
                                  : "Leave team"}
                              </button>
                            </>
                          )}
                        </div>
                        {(t.joined || admin) && (
                          <div className="team-management-actions">
                            {t.joined && admin && (
                              <button
                                className="secondary"
                                aria-expanded={members === t.id}
                                aria-controls={
                                  members === t.id
                                    ? `${id}-${t.id}-members`
                                    : undefined
                                }
                                disabled={busy}
                                onClick={() => {
                                  setMembers(members === t.id ? null : t.id);
                                  setOwnership(null);
                                }}
                              >
                                <Users size={15} aria-hidden="true" />
                                {members === t.id
                                  ? "Hide team members"
                                  : "Manage team members"}
                                <ChevronDown size={13} aria-hidden="true" />
                              </button>
                            )}
                            {t.joined && (
                              <button
                                className="secondary"
                                aria-expanded={ownership === t.id}
                                aria-controls={
                                  ownership === t.id
                                    ? `${id}-${t.id}-ownership`
                                    : undefined
                                }
                                disabled={busy}
                                onClick={() => {
                                  setOwnership(
                                    ownership === t.id ? null : t.id,
                                  );
                                  setMembers(null);
                                }}
                              >
                                {ownership === t.id
                                  ? "Hide ownership"
                                  : "Manage team ownership"}
                                <ChevronDown size={13} aria-hidden="true" />
                              </button>
                            )}
                            {admin && (
                              <button
                                className="secondary"
                                disabled={busy}
                                onClick={() =>
                                  t.archived
                                    ? void change(t, "restore")
                                    : setArchive(archive === t.id ? null : t.id)
                                }
                              >
                                <Archive size={14} aria-hidden="true" />
                                {pending[t.id] === "restore"
                                  ? "Restoring…"
                                  : t.archived
                                    ? "Restore"
                                    : "Archive"}
                              </button>
                            )}
                          </div>
                        )}
                        {errors[t.id] && (
                          <div className="teams-card-error" role="alert">
                            <p>{errors[t.id]}</p>
                            <button
                              className="secondary"
                              onClick={() =>
                                setErrors((v) => ({ ...v, [t.id]: "" }))
                              }
                            >
                              Dismiss error
                            </button>
                          </div>
                        )}
                        {archive === t.id && (
                          <div
                            className="teams-archive-confirm"
                            role="group"
                            aria-label={`Archive ${t.name}`}
                          >
                            <p>
                              Archive <strong>{t.name}</strong>? Its channels
                              will also be archived.
                            </p>
                            <button
                              className="secondary"
                              disabled={busy}
                              onClick={() => void change(t, "archive")}
                            >
                              {pending[t.id] === "archive"
                                ? "Archiving…"
                                : "Confirm archive"}
                            </button>
                            <button
                              className="secondary"
                              disabled={busy}
                              onClick={() => setArchive(null)}
                            >
                              Cancel archive
                            </button>
                          </div>
                        )}
                        {members === t.id && t.joined && admin && (
                          <div
                            className="teams-management-panel"
                            id={`${id}-${t.id}-members`}
                          >
                            <TeamMembers
                              org={org}
                              team={t.id}
                              people={people}
                              userId={userId}
                              onChanged={onChanged}
                            />
                          </div>
                        )}
                        {ownership === t.id && t.joined && (
                          <div
                            className="teams-management-panel"
                            id={`${id}-${t.id}-ownership`}
                          >
                            <TeamOwnership
                              org={org}
                              team={t.id}
                              onChanged={onChanged}
                            />
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="teams-empty">
                  <Users size={32} aria-hidden="true" />
                  <h2>
                    {query.trim()
                      ? "No teams match your search"
                      : filter === "joined"
                        ? "You haven’t joined a team yet"
                        : filter === "discover"
                          ? "You’re all caught up"
                          : filter === "archived"
                            ? "No archived teams"
                            : "A space for your next team"}
                  </h2>
                  <p>
                    {query.trim()
                      ? "Try another team name or clear your search."
                      : filter === "joined"
                        ? "Explore the directory to find a team to join."
                        : filter === "discover"
                          ? "You belong to all active teams in this workspace."
                          : filter === "archived"
                            ? "Archived teams will appear here."
                            : "Create a team to bring people and conversations together."}
                  </p>
                  {query || filter !== "all" ? (
                    <button className="secondary" onClick={reset}>
                      Show all teams
                    </button>
                  ) : canJoin ? (
                    <button className="primary" onClick={onCreate}>
                      <Plus size={16} aria-hidden="true" />
                      Create team
                    </button>
                  ) : (
                    <p>Ask a workspace administrator to add you to a team.</p>
                  )}
                </div>
              )}
              {matching.length > 12 && (
                <nav className="teams-pagination" aria-label="Team pages">
                  <button
                    className="secondary"
                    disabled={currentPage === 0}
                    onClick={() => setPage(currentPage - 1)}
                  >
                    Previous teams
                  </button>
                  <span>
                    Page {currentPage + 1} of {Math.ceil(matching.length / 12)}
                  </span>
                  <button
                    className="secondary"
                    disabled={(currentPage + 1) * 12 >= matching.length}
                    onClick={() => setPage(currentPage + 1)}
                  >
                    Next teams
                  </button>
                </nav>
              )}
            </>
          )
        )}
      </div>
    </section>
  );
}
