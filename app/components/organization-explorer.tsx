"use client";
/* eslint-disable react-hooks/set-state-in-effect -- Resource changes withdraw obsolete directory snapshots. */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Focus,
  Home,
  MessageSquare,
  Phone,
  RefreshCw,
  Search,
  Video,
} from "lucide-react";
import { api } from "@/lib/contracts";
import {
  reportingPath,
  type OrganizationContext,
  type OrganizationPage,
  type OrganizationPerson,
} from "@/lib/organization";
import { Avatar } from "./primitives";
import { ProfileTrigger, useProfileActions } from "./profile-popovers";
import { presenceStates } from "./presence-provider";
type Cursor = OrganizationPage["nextCursor"];
function useResource<T>(url: string | null, epoch = 0, poll = 0) {
  const [state, setState] = useState<{
    url: string | null;
    data: T | null;
    error: string;
    loading: boolean;
  }>({ url: null, data: null, error: "", loading: false });
  useEffect(() => {
    const c = new AbortController();
    let pending = false,
      initial = true;
    if (!url) {
      setState({ url: null, data: null, error: "", loading: false });
      return;
    }
    const load = async () => {
      if (pending) return;
      pending = true;
      if (initial)
        setState((old) => ({
          url,
          data: old.url === url ? old.data : null,
          error: "",
          loading: true,
        }));
      try {
        const data = await api<T>(
          url,
          "GET",
          undefined,
          AbortSignal.any([c.signal, AbortSignal.timeout(8000)]),
        );
        if (!c.signal.aborted)
          setState({ url, data, error: "", loading: false });
      } catch (e) {
        if (!c.signal.aborted)
          setState({
            url,
            data: null,
            error: e instanceof Error ? e.message : "Directory unavailable",
            loading: false,
          });
      } finally {
        pending = false;
        initial = false;
      }
    };
    void load();
    const timer = poll
      ? setInterval(() => {
          if (document.visibilityState === "visible") void load();
        }, poll)
      : null;
    const visible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      c.abort();
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [url, epoch, poll]);
  return state.url === url
    ? state
    : { url, data: null, error: "", loading: Boolean(url) };
}
export function EmployeeCard({
  person: p,
  label,
  selected = false,
  onSelect,
}: {
  person: OrganizationPerson;
  label: string;
  selected?: boolean;
  onSelect: (id: string) => void;
}) {
  const actions = useProfileActions(),
    [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    heading = useId();
  async function act(fn: () => Promise<void>) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Communication action unavailable",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <article
      className={`org-employee-card ${selected ? "is-selected" : ""}`}
      aria-labelledby={heading}
    >
      <div className="org-employee-identity">
        <ProfileTrigger userId={p.id} name={p.name}>
          <Avatar name={p.name} />
        </ProfileTrigger>
        <div className="org-employee-info">
          <span className="org-relation-label">{label}</span>
          <h3 id={heading}>
            <button
              type="button"
              aria-label={`View organization for ${p.name}`}
              aria-current={selected ? "true" : undefined}
              onClick={() => onSelect(p.id)}
            >
              {p.name}
            </button>
          </h3>
          {p.title ? (
            <p>{p.title}</p>
          ) : (
            <p className="org-muted">Job title not provided</p>
          )}
          {p.department && <p>{p.department}</p>}
          {p.organizationalUnit && <p>{p.organizationalUnit}</p>}
          {p.workLocation && <small>{p.workLocation}</small>}
        </div>
      </div>
      <div className="org-employee-status">
        <span className="org-presence" data-state={p.presence}>
          <i aria-hidden="true" />
          {presenceStates[p.presence as keyof typeof presenceStates] ??
            "Presence unavailable"}
        </span>
        <span>
          {p.directReportCount} visible direct{" "}
          {p.directReportCount === 1 ? "report" : "reports"}
        </span>
      </div>
      <div className="org-contact-actions" aria-label={`Contact ${p.name}`}>
        <ProfileTrigger userId={p.id} name={p.name}>
          View profile
        </ProfileTrigger>
        {p.id !== actions.userId && (
          <>
            <button
              className="secondary"
              title={`Message ${p.name}`}
              aria-label={`Message ${p.name}`}
              disabled={pending}
              onClick={() => void act(() => actions.message(p.id))}
            >
              <MessageSquare size={15} />
              <span>Message</span>
            </button>
            <button
              className="secondary"
              title={`Audio call ${p.name}`}
              aria-label={`Audio call ${p.name}`}
              disabled={pending}
              onClick={() => void act(() => actions.call("audio", p.id))}
            >
              <Phone size={15} />
              <span>Audio call</span>
            </button>
            <button
              className="secondary"
              title={`Video call ${p.name}`}
              aria-label={`Video call ${p.name}`}
              disabled={pending}
              onClick={() => void act(() => actions.call("video", p.id))}
            >
              <Video size={15} />
              <span>Video call</span>
            </button>
          </>
        )}
      </div>
      {pending && <p role="status">Opening conversation…</p>}
      {error && <p role="alert">{error}</p>}
    </article>
  );
}
function EmployeeList({
  org,
  parent,
  kind,
  ancestors,
  depth = 0,
  epoch,
  onSelect,
}: {
  org: string;
  parent: OrganizationPerson;
  kind: "reports" | "peers";
  ancestors: string[];
  depth?: number;
  epoch: number;
  onSelect: (id: string) => void;
}) {
  const [cursors, setCursors] = useState<Cursor[]>([null]),
    [page, setPage] = useState(0),
    [expanded, setExpanded] = useState<string[]>([]),
    [retry, setRetry] = useState(0);
  const cursor = cursors[page],
    q = new URLSearchParams({ limit: "20" });
  if (cursor) {
    q.set("afterName", cursor.name);
    q.set("afterId", cursor.id);
  }
  const resource = useResource<OrganizationPage>(
    `/organizations/${org}/organization/people/${parent.id}/${kind}?${q}`,
    epoch + retry,
  );
  return (
    <div
      className={`org-employee-list org-depth-${depth}`}
      aria-label={`${kind === "reports" ? "Direct reports" : "Peers"} of ${parent.name}`}
    >
      {resource.loading && (
        <p className="org-inline-state" role="status">
          Loading {kind === "reports" ? "direct reports" : "peers"} for{" "}
          {parent.name}…
        </p>
      )}
      {resource.error && (
        <div role="alert" className="org-inline-state">
          <p>{resource.error}</p>
          <button className="secondary" onClick={() => setRetry((n) => n + 1)}>
            Retry {kind === "reports" ? "direct reports" : "peers"}
          </button>
        </div>
      )}
      {resource.data?.people.length === 0 && !resource.loading && (
        <p className="org-inline-state">
          {kind === "reports"
            ? "No visible direct reports recorded."
            : "No visible peers recorded for this manager."}
          {page > 0 && " This page may have changed; return to the first page."}
        </p>
      )}
      {resource.data && (
        <>
          <ul className="org-report-cards">
            {resource.data.people.map((p) => {
              const circular = ancestors.includes(p.id),
                open = expanded.includes(p.id);
              return (
                <li key={p.id}>
                  {circular ? (
                    <div className="org-data-warning">
                      <p>
                        Circular reporting relationship: {p.name} already
                        appears in this branch. Expansion stops here.
                      </p>
                      <button
                        className="secondary"
                        onClick={() => onSelect(p.id)}
                      >
                        View {p.name}
                      </button>
                    </div>
                  ) : (
                    <>
                      <EmployeeCard
                        person={p}
                        label={
                          kind === "peers"
                            ? "Peer · same manager"
                            : "Direct report"
                        }
                        onSelect={onSelect}
                      />
                      {p.directReportCount > 0 &&
                        (depth < 5 ? (
                          <button
                            className="org-expand"
                            aria-expanded={open}
                            onClick={() =>
                              setExpanded((old) =>
                                open
                                  ? old.filter((id) => id !== p.id)
                                  : [...old, p.id],
                              )
                            }
                          >
                            {open ? (
                              <ChevronDown size={16} />
                            ) : (
                              <ChevronRight size={16} />
                            )}{" "}
                            {open ? "Collapse" : "Expand"} reports for {p.name}
                          </button>
                        ) : (
                          <button
                            className="org-expand"
                            onClick={() => onSelect(p.id)}
                          >
                            View next level for {p.name}
                          </button>
                        ))}
                      {open && depth < 5 && (
                        <EmployeeList
                          org={org}
                          parent={p}
                          kind="reports"
                          ancestors={[...ancestors, p.id]}
                          depth={depth + 1}
                          epoch={epoch}
                          onSelect={onSelect}
                        />
                      )}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          <nav
            className="org-pagination"
            aria-label={`${kind === "reports" ? "Direct reports" : "Peers"} pages for ${parent.name}`}
          >
            <button
              className="secondary"
              disabled={page === 0 || resource.loading}
              onClick={() => setPage((n) => n - 1)}
            >
              Previous
            </button>
            <span>
              Page {page + 1} · {resource.data.people.length} shown
            </span>
            <button
              className="secondary"
              disabled={!resource.data.nextCursor || resource.loading}
              onClick={() => {
                if (resource.data?.nextCursor) {
                  setCursors((old) => [
                    ...old.slice(0, page + 1),
                    resource.data!.nextCursor,
                  ]);
                  setPage((n) => n + 1);
                }
              }}
            >
              Next
            </button>
            {page > 0 && (
              <button
                className="secondary"
                onClick={() => {
                  setPage(0);
                  setCursors([null]);
                }}
              >
                First page
              </button>
            )}
          </nav>
        </>
      )}
    </div>
  );
}
type SearchOptions = { q: string; department: string; roots: boolean };
function EmployeeSearch({
  org,
  options,
  onOptions,
  onSelect,
}: {
  org: string;
  options: SearchOptions;
  onOptions: (options: SearchOptions) => void;
  onSelect: (id: string) => void;
}) {
  const [debounced, setDebounced] = useState(options.q),
    [cursors, setCursors] = useState<Cursor[]>([null]),
    [page, setPage] = useState(0),
    [attempt, setAttempt] = useState(0);
  const departmentList = useId();
  useEffect(() => {
    const t = setTimeout(() => setDebounced(options.q), 250);
    return () => clearTimeout(t);
  }, [options.q]);
  const departments = useResource<{ departments: string[] }>(
      `/organizations/${org}/organization/departments`,
    ),
    cursor = cursors[page],
    q = new URLSearchParams({
      q: debounced,
      department: options.department,
      roots: String(options.roots),
      limit: "20",
    });
  if (cursor) {
    q.set("afterName", cursor.name);
    q.set("afterId", cursor.id);
  }
  const searching = Boolean(debounced || options.department || options.roots),
    resource = useResource<OrganizationPage>(
      searching ? `/organizations/${org}/organization/people?${q}` : null,
      attempt,
      15000,
    ),
    settled = options.q === debounced;
  const change = (value: SearchOptions) => {
    setPage(0);
    setCursors([null]);
    onOptions(value);
  };
  return (
    <section className="org-directory-search" aria-label="Employee search">
      <div className="org-search-fields">
        <label>
          <span>Name, title or department</span>
          <span className="org-search-input">
            <Search size={17} />
            <input
              className="org-find-input"
              aria-label="Find employees"
              type="search"
              maxLength={160}
              value={options.q}
              onChange={(e) => change({ ...options, q: e.target.value })}
              placeholder="Find a colleague"
            />
          </span>
        </label>
        <label>
          Department (exact name)
          <input
            list={departmentList}
            maxLength={160}
            value={options.department}
            onChange={(e) => change({ ...options, department: e.target.value })}
            placeholder="Any department"
          />
          <datalist id={departmentList}>
            {departments.data?.departments.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
        </label>
        <label className="check-label">
          <input
            type="checkbox"
            checked={options.roots}
            onChange={(e) => change({ ...options, roots: e.target.checked })}
          />
          Recorded top-level leaders
        </label>
      </div>
      <p className="org-muted">
        Only authorized active employees are searchable. Leaders require an
        explicit root assignment; missing managers are not treated as roots.
      </p>
      {departments.error && (
        <p role="status">
          Department suggestions unavailable. You can still type a department
          name.
        </p>
      )}
      {!searching && !options.q && (
        <p>Enter a name, title or department to find an employee.</p>
      )}
      {(!settled || resource.loading) && (
        <p role="status">Searching employees…</p>
      )}
      {resource.error && (
        <div role="alert">
          <p>{resource.error}</p>
          <button
            className="secondary"
            onClick={() => setAttempt((x) => x + 1)}
          >
            Retry employee search
          </button>
        </div>
      )}
      {settled && resource.data && (
        <>
          {resource.data.people.length ? (
            <ul className="org-search-results">
              {resource.data.people.map((p) => (
                <li key={p.id}>
                  <button
                    onClick={() => onSelect(p.id)}
                    aria-label={`Select employee ${p.name}`}
                  >
                    <Avatar name={p.name} small />
                    <span>
                      <strong>{p.name}</strong>
                      <small>
                        {[
                          p.title,
                          p.department,
                          p.organizationalUnit,
                          p.workLocation,
                        ]
                          .filter(Boolean)
                          .join(" · ") || "Profile details not supplied"}
                      </small>
                      <small>{p.email}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p role="status">No matching authorized employees found.</p>
          )}
          <nav className="org-pagination" aria-label="Employee search pages">
            <button
              className="secondary"
              disabled={page === 0 || resource.loading}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous results
            </button>
            <span>Page {page + 1}</span>
            <button
              className="secondary"
              disabled={!resource.data.nextCursor || resource.loading}
              onClick={() => {
                if (resource.data?.nextCursor) {
                  setCursors((old) => [
                    ...old.slice(0, page + 1),
                    resource.data!.nextCursor,
                  ]);
                  setPage((p) => p + 1);
                }
              }}
            >
              Next results
            </button>
          </nav>
        </>
      )}
    </section>
  );
}
const storedNavigation = z.object({
  selected: z.uuid(),
  back: z.array(z.uuid()).max(40),
  forward: z.array(z.uuid()).max(40),
  handled: z.string().max(100),
});
export function OrganizationExplorer({
  org,
  userId,
  intent,
}: {
  org: string;
  userId: string;
  intent: { id: string; key: string } | null;
}) {
  const [navigation, setNavigation] = useState({
      selected: userId,
      back: [] as string[],
      forward: [] as string[],
      handled: "",
    }),
    [ready, setReady] = useState(false),
    [attempt, setAttempt] = useState(0),
    [epoch, setEpoch] = useState(0),
    [peersOpen, setPeersOpen] = useState(false),
    [listView, setListView] = useState(false),
    [searchOpen, setSearchOpen] = useState(false),
    [searchOptions, setSearchOptions] = useState<SearchOptions>({
      q: "",
      department: "",
      roots: false,
    }),
    [allPath, setAllPath] = useState(false);
  const storage = `organization-view:${org}:${userId}`,
    selected = useRef<HTMLDivElement>(null),
    lastSnapshot = useRef<OrganizationContext | null>(null),
    keyboardNavigation = useRef(true);
  useEffect(() => {
    try {
      const p = storedNavigation.safeParse(
        JSON.parse(sessionStorage.getItem(storage) || "null"),
      );
      if (p.success) setNavigation(p.data);
    } catch {}
    setReady(true);
  }, [storage]);
  useEffect(() => {
    if (ready && intent && intent.key !== navigation.handled) {
      setNavigation((old) => ({
        ...old,
        selected: intent.id,
        back:
          old.selected === intent.id
            ? old.back
            : [...old.back, old.selected].slice(-40),
        forward: [],
        handled: intent.key,
      }));
    }
  }, [ready, intent, navigation.handled]);
  useEffect(() => {
    if (ready)
      try {
        sessionStorage.setItem(storage, JSON.stringify(navigation));
      } catch {}
  }, [ready, storage, navigation]);
  const resource = useResource<OrganizationContext>(
      ready
        ? `/organizations/${org}/organization/people/${navigation.selected}`
        : null,
      attempt,
      15000,
    ),
    context =
      resource.data?.person.id === navigation.selected ? resource.data : null;
  useEffect(() => {
    if (context && context !== lastSnapshot.current) {
      lastSnapshot.current = context;
      setEpoch((n) => n + 1);
      if (keyboardNavigation.current) {
        selected.current?.focus({ preventScroll: true });
        keyboardNavigation.current = false;
      }
    }
  }, [context]);
  const choose = useCallback((id: string) => {
    setNavigation((old) =>
      old.selected === id
        ? old
        : {
            ...old,
            selected: id,
            back: [...old.back, old.selected].slice(-40),
            forward: [],
          },
    );
    setAllPath(false);
  }, []);
  function selectPerson(id: string) {
    if(id===navigation.selected){selected.current?.focus({preventScroll:true});setSearchOpen(false);return;}
    keyboardNavigation.current = true;
    choose(id);
    setSearchOpen(false);
  }
  function back() {
    setNavigation((old) =>
      old.back.length
        ? {
            ...old,
            selected: old.back.at(-1)!,
            back: old.back.slice(0, -1),
            forward: [old.selected, ...old.forward].slice(0, 40),
          }
        : old,
    );
    keyboardNavigation.current = true;
  }
  function forward() {
    setNavigation((old) =>
      old.forward.length
        ? {
            ...old,
            selected: old.forward[0],
            forward: old.forward.slice(1),
            back: [...old.back, old.selected].slice(-40),
          }
        : old,
    );
    keyboardNavigation.current = true;
  }
  const path = context
    ? reportingPath(context.person.id, context.chain, context.chainStatus)
    : null;
  return (
    <div className={`org-explorer ${listView ? "org-list-view" : ""}`}>
      <header className="page-heading">
        <div>
          <span className="eyebrow">PEOPLE & REPORTING LINES</span>
          <h1>Organization</h1>
          <p>
            Explore employment reporting relationships. Chat teams and workspace
            roles are separate.
          </p>
        </div>
        <div className="org-view-actions">
          <button className="secondary" onClick={() => selectPerson(userId)}>
            <Home size={16} />
            Back to me
          </button>
          <button
            className="secondary"
            disabled={!context}
            onClick={() =>
              selected.current?.scrollIntoView({
                block: "center",
                inline: "nearest",
                behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
                  .matches
                  ? "auto"
                  : "smooth",
              })
            }
          >
            <Focus size={16} />
            Center selected employee
          </button>
          <button
            className="secondary"
            disabled={resource.loading}
            onClick={() => setAttempt((n) => n + 1)}
          >
            <RefreshCw size={16} />
            Refresh organization
          </button>
        </div>
      </header>
      <div className="org-content">
        <div className="org-navigation">
          <div>
            <button
              className="secondary"
              aria-label="Previous employee"
              disabled={!navigation.back.length}
              onClick={back}
            >
              <ArrowLeft size={16} />
              Back
            </button>
            <button
              className="secondary"
              aria-label="Next employee"
              disabled={!navigation.forward.length}
              onClick={forward}
            >
              <ArrowRight size={16} />
              Forward
            </button>
          </div>
          <button
            className="secondary"
            aria-pressed={listView}
            onClick={() => setListView((v) => !v)}
          >
            {listView ? "Chart view" : "Accessible list view"}
          </button>
        </div>
        <details
          className="org-search-disclosure"
          open={searchOpen}
          onToggle={(e) => setSearchOpen(e.currentTarget.open)}
        >
          <summary>
            <Search size={17} />
            Find a colleague
          </summary>
          {searchOpen && (
            <EmployeeSearch
              org={org}
              options={searchOptions}
              onOptions={setSearchOptions}
              onSelect={selectPerson}
            />
          )}
        </details>
        <p className="org-permission-note">
          Counts and relationships include only profiles you may view.
          Restricted or inactive relationships are not expanded.
        </p>
        {resource.loading && !context && (
          <p role="status" className="org-inline-state">
            Loading reporting context…
          </p>
        )}
        {resource.error && (
          <div role="alert" className="org-data-warning">
            <h2>Organization information unavailable</h2>
            <p>{resource.error}</p>
            <p>
              Your selection is preserved. Refresh to retry or search for
              another employee.
            </p>
            <button
              className="secondary"
              onClick={() => setAttempt((n) => n + 1)}
            >
              Retry organization
            </button>
          </div>
        )}
        {context && path && (
          <>
            <nav aria-label="Reporting path" className="org-breadcrumbs">
              <ol>
                {(allPath ? path.chain : path.chain.slice(-4)).map((p) => (
                  <li key={p.id}>
                    <button onClick={() => selectPerson(p.id)}>{p.name}</button>
                    <ChevronRight size={14} aria-hidden="true" />
                  </li>
                ))}
                <li aria-current="page">{context.person.name}</li>
              </ol>
              {path.chain.length > 4 && (
                <button
                  className="secondary"
                  aria-expanded={allPath}
                  onClick={() => setAllPath((v) => !v)}
                >
                  {allPath ? "Shorten path" : "Show earlier managers"}
                </button>
              )}
            </nav>
            {path.status !== "complete" && (
              <p className="org-data-warning" role="status">
                {path.status === "cycle"
                  ? "Circular reporting data detected. The path stops at the repeated employee; no assignments have been changed."
                  : path.status === "truncated"
                    ? "The reporting path is limited to 20 managers. Select the earliest manager to continue upward."
                    : path.status === "unavailable"
                      ? "Part of the manager path is unavailable or restricted. It has not been skipped or attached to another leader."
                      : "Some manager assignments have not been supplied. Missing assignments are not top-level leaders."}
              </p>
            )}
            <div className="org-focused-layout">
              <section
                className="org-focus-stack"
                aria-label="Selected employee and manager"
              >
                <h2 className="org-section-heading">Reports to</h2>
                {context.manager ? (
                  <EmployeeCard
                    person={context.manager}
                    label="Manager"
                    onSelect={selectPerson}
                  />
                ) : (
                  <p className="org-manager-empty">
                    {context.managerState === "root"
                      ? "Recorded top-level leader · no primary manager."
                      : context.managerState === "unavailable"
                        ? "Manager profile unavailable or restricted."
                        : "No primary manager assignment has been supplied."}
                  </p>
                )}
                <div className="org-report-connector" aria-hidden="true" />
                <div
                  ref={selected}
                  className="org-selected-focus"
                  tabIndex={-1}
                  aria-label={`Selected employee: ${context.person.name}`}
                >
                  <EmployeeCard
                    person={context.person}
                    label="Selected employee"
                    selected
                    onSelect={selectPerson}
                  />
                </div>
                <div className="org-context-tools">
                  <button
                    className="secondary"
                    aria-expanded={peersOpen}
                    disabled={context.managerState !== "assigned"}
                    onClick={() => setPeersOpen((v) => !v)}
                  >
                    {peersOpen ? "Hide peers" : "Show peers"}
                  </button>
                  {context.managerState !== "assigned" && (
                    <small>Peers require an assigned, visible manager.</small>
                  )}
                </div>
                <p className="org-source-status" role="status">
                  {context.person.updatedAt
                    ? `Directory record updated ${new Date(context.person.updatedAt).toLocaleString()}.`
                    : "Reporting details have not been supplied for this employee."}{" "}
                  {context.person.sourceLabel &&
                    `Source: ${context.person.sourceLabel}.`}{" "}
                  Loaded {new Date(context.loadedAt).toLocaleTimeString()}.
                  Refreshes while visible.
                </p>
              </section>
              {peersOpen && context.managerState === "assigned" && (
                <section
                  className="org-peers"
                  aria-labelledby="org-peers-heading"
                >
                  <h2 id="org-peers-heading">Peers</h2>
                  <p>Colleagues with the same recorded primary manager.</p>
                  <EmployeeList
                    key={`peers:${context.person.id}`}
                    org={org}
                    parent={context.person}
                    kind="peers"
                    ancestors={[context.person.id]}
                    epoch={epoch}
                    onSelect={selectPerson}
                  />
                </section>
              )}
            </div>
            <section
              className="org-reports"
              aria-labelledby="org-reports-heading"
            >
              <h2 id="org-reports-heading">
                Direct reports{" "}
                <span>{context.person.directReportCount} visible</span>
              </h2>
              <EmployeeList
                key={`reports:${context.person.id}`}
                org={org}
                parent={context.person}
                kind="reports"
                ancestors={[...path.chain.map((p) => p.id), context.person.id]}
                epoch={epoch}
                onSelect={selectPerson}
              />
            </section>
          </>
        )}
      </div>
    </div>
  );
}
