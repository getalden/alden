import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { Api, Memory, MemoryEntry, MemoryRepo, MemorySource, Session } from "../api";
import { plural } from "../format";
import { Switch } from "./ReviewOptions";
import { StateCard } from "./StateCard";

const ago = (iso: string) => {
  if (!iso) return "nothing yet";
  const hours = (Date.now() - Date.parse(iso)) / 3_600_000;
  if (hours < 1) return "changed just now";
  if (hours < 24) return `changed ${Math.round(hours)}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "changed yesterday" : days < 14 ? `changed ${days}d ago` : `changed ${Math.round(days / 7)}w ago`;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const since = (iso: string) => {
  const d = new Date(iso);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
};

/** How many of a learned item's sources to list before "and N more". */
const SOURCES_SHOWN = 3;

const FROM: Record<MemorySource["kind"], [withPr: string, without: string]> = {
  review: ["from your review of", "from a review you sent"],
  reaction: ["from your reaction to", "from a reaction in your queue"],
  outcome: ["from how it went with", "from how a PR turned out"],
  open: ["from opening", "from a PR you opened"],
};

/** Where a learned item came from, newest first: "from your review of acme/shop#412, Oct 8", then "and 4 more". */
export function MemorySources({ sources }: { sources: MemorySource[] | undefined }) {
  if (!sources || sources.length === 0) return null;
  const newest = [...sources].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const more = newest.length - SOURCES_SHOWN;
  return (
    <ul className="mem-sources visually-plain" aria-label="Where it came from">
      {newest.slice(0, SOURCES_SHOWN).map((source, i) => {
        const [withPr, without] = FROM[source.kind] ?? FROM.review;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: two sources can share a PR, kind and time.
          <li key={i}>
            {source.pr ? `${withPr} ${source.pr}` : without}, {since(source.at)}
          </li>
        );
      })}
      {more > 0 && <li>and {more} more</li>}
    </ul>
  );
}

/**
 * What Alden knows about you, per repo: what you look for and what you skip, each with where it came from and what it
 * changes. Notes can be edited; anything can be forgotten (and the forget undone); learning can be paused.
 */
export function MemoryView({ api, session }: { api: Api; session: Session }) {
  const [repos, setRepos] = useState<MemoryRepo[]>();
  const [repo, setRepo] = useState<string | undefined>(session.repo?.repos[0]?.toLowerCase());
  const [memory, setMemory] = useState<Memory>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [forgotten, setForgotten] = useState<Record<string, MemoryEntry>>({});
  const [editing, setEditing] = useState<{ id: string; text: string }>();
  const [note, setNote] = useState("");
  const [confirmAll, setConfirmAll] = useState(false);

  const loadRepos = useCallback(() => {
    api.memoryRepos().then(
      (list) => {
        setRepos(list);
        setRepo((current) => current ?? list[0]?.repo);
      },
      (e: Error) => setError(e.message),
    );
  }, [api]);
  useEffect(loadRepos, [loadRepos]);

  useEffect(() => {
    if (!repo) return;
    setError(undefined);
    setForgotten({});
    setEditing(undefined);
    setConfirmAll(false);
    api.memory(repo).then(setMemory, (e: Error) => {
      setMemory(undefined);
      setError(e.message);
    });
  }, [api, repo]);

  async function act(run: () => Promise<Memory>) {
    setBusy(true);
    setError(undefined);
    try {
      setMemory(await run());
      loadRepos();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const forget = async (item: MemoryEntry) => {
    if (await act(() => api.forgetMemory(item.id, repo))) setForgotten((f) => ({ ...f, [item.id]: item }));
  };
  const undo = async (item: MemoryEntry) => {
    if (await act(() => api.changeMemory({ action: "restore", id: item.id }, repo))) {
      setForgotten(({ [item.id]: _, ...rest }) => rest);
    }
  };
  const save = async () => {
    if (!editing) return;
    if (await act(() => api.changeMemory({ action: "edit", id: editing.id, text: editing.text }, repo))) {
      setEditing(undefined);
    }
  };
  async function add(event: FormEvent) {
    event.preventDefault();
    if (await act(() => api.addMemory(note, repo))) setNote("");
  }

  // Forgotten items stay in place (struck through, with Undo) until you leave the repo.
  const live = memory?.items ?? [];
  const shown = [...live, ...Object.values(forgotten).filter((f) => !live.some((i) => i.id === f.id))];
  const groups = [
    { key: "look", title: "What you look for", sub: "ranked higher, shown in Needs your eyes" },
    { key: "skip", title: "What you skip", sub: "ranked lower, or left out of Needs your eyes" },
  ] as const;

  return (
    <div className="workspace has-detail">
      <aside className="side" aria-label="Repos">
        <div className="list-head">
          <h2 className="label">Repos · {repos?.length ?? "…"}</h2>
        </div>
        {repos?.map((r) => (
          <button
            key={r.repo}
            type="button"
            className="side-item"
            aria-current={r.repo === repo ? "true" : undefined}
            onClick={() => setRepo(r.repo)}
          >
            <span className="name">{r.repo}</span>
            <span className="faint mono small">{r.items}</span>
            <span className="sub">
              {r.paused ? "paused · " : ""}
              {ago(r.lastChange)}
            </span>
          </button>
        ))}
        {repos?.length === 0 && (
          <p className="side-note muted small">Nothing yet. Start alden ui in a clone, or react to a briefing.</p>
        )}
        <p className="note-box side-note">
          Everything here lives in <code>{memory?.path ?? "~/.alden/alden.db"}</code> on this machine. Only your notes
          go to the model, with each review of their repo.
        </p>
      </aside>
      <main className="main-pane">
        {!repo ? (
          <StateCard
            tone="dashed"
            glyph="?"
            title="No repo yet"
            body="Alden keeps what it learns per repo. Start alden ui inside a clone, or react to a few briefings."
          />
        ) : (
          <>
            <header className="mem-head">
              <span className="faint mono small">{memory?.path ?? ""}</span>
              <h1 className="brief-title">What Alden knows about you in {repo}</h1>
              <p className="muted" style={{ maxWidth: 640 }}>
                These decide how this repo's PRs rank in your queue and what makes it into Needs your eyes. Each one
                shows where it came from, and you can change or forget any of them.
              </p>
            </header>
            <div className="mem-tools">
              <Switch
                on={!(memory?.paused ?? false)}
                label={memory?.paused ? "Learning paused" : "Learning from your reactions"}
                disabled={!memory || busy}
                onChange={(on) => act(() => api.changeMemory({ action: "learning", on }, repo))}
              />
              <span className="faint mono small">
                {memory?.paused
                  ? "reactions are saved but not applied; notes still apply"
                  : "applied from the next briefing"}
              </span>
              <span className="end">
                {confirmAll ? (
                  <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span className="small muted">Forget {plural(live.length, "item")}?</span>
                    <button
                      type="button"
                      className="btn sm"
                      disabled={busy}
                      onClick={async () => {
                        if (await act(() => api.changeMemory({ action: "forget-all" }, repo))) setConfirmAll(false);
                      }}
                    >
                      Forget all
                    </button>
                    <button type="button" className="btn sm quiet" onClick={() => setConfirmAll(false)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn sm"
                    disabled={busy || live.length === 0}
                    onClick={() => setConfirmAll(true)}
                  >
                    Forget everything in this repo
                  </button>
                )}
              </span>
            </div>
            <div className="mem-body">
              {error && <p className="banner error">{error}</p>}
              {memory && shown.length === 0 && (
                <p className="muted">
                  Nothing yet. After three one-sided reactions to a kind of flag, or three PRs of one kind opened ahead
                  of their rank or marked useful, it shows up here. Or tell Alden something below.
                </p>
              )}
              {groups.map((group) => {
                const items = shown.filter((i) => i.group === group.key);
                if (items.length === 0) return null;
                return (
                  <section key={group.key} className="section" aria-labelledby={`mem-${group.key}`}>
                    <div className="section-head">
                      <h2 className="h2" id={`mem-${group.key}`}>
                        {group.title}
                      </h2>
                      <span className="faint mono small">{group.sub}</span>
                    </div>
                    <ul className="card mem-list visually-plain">
                      {items.map((item) => {
                        const gone = !!forgotten[item.id];
                        const isEditing = editing?.id === item.id;
                        return (
                          <li key={item.id} className={`mem-item${gone ? " gone" : ""}${isEditing ? " editing" : ""}`}>
                            <div className="what">
                              {isEditing ? (
                                <input
                                  className="input"
                                  aria-label="Edit note"
                                  value={editing.text}
                                  maxLength={500}
                                  // biome-ignore lint/a11y/noAutofocus: the user just asked to edit this
                                  autoFocus
                                  onChange={(e) => setEditing({ id: item.id, text: e.target.value })}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") save();
                                    if (e.key === "Escape") setEditing(undefined);
                                  }}
                                />
                              ) : (
                                <span className="text">{item.text}</span>
                              )}
                              <span className="effect">
                                {gone ? "Forgotten. Alden stops using this from the next briefing." : item.effect}
                              </span>
                              <span className="meta">
                                <span className={`kind${item.source === "you" ? " said" : ""}`}>
                                  {item.source === "you" ? "you said" : "learned"}
                                </span>
                                <span>
                                  {item.source === "you"
                                    ? `Added ${since(item.since)}`
                                    : `${item.evidence} · since ${since(item.since)}`}
                                </span>
                                {item.examples !== undefined && <span>· {plural(item.examples, "example")}</span>}
                                {item.confirmed !== undefined && <span>· confirmed {item.confirmed}×</span>}
                              </span>
                              {item.source === "learned" && <MemorySources sources={item.sources} />}
                              {!gone && item.excluded && item.excluded.length > 0 && (
                                <span className="meta">
                                  {item.excluded.map((path) => (
                                    <button
                                      key={path}
                                      type="button"
                                      className="btn xs quiet"
                                      disabled={busy}
                                      aria-label={`Apply this note under ${path} again`}
                                      onClick={() =>
                                        act(() => api.changeMemory({ action: "include", id: item.id, path }, repo))
                                      }
                                    >
                                      Apply under {path} again
                                    </button>
                                  ))}
                                </span>
                              )}
                            </div>
                            <div className="acts">
                              {isEditing ? (
                                <button type="button" className="btn sm primary" disabled={busy} onClick={save}>
                                  Save
                                </button>
                              ) : (
                                item.kind === "note" &&
                                !gone && (
                                  <button
                                    type="button"
                                    className="btn sm"
                                    onClick={() => setEditing({ id: item.id, text: item.text })}
                                  >
                                    Edit
                                  </button>
                                )
                              )}
                              <button
                                type="button"
                                className="btn sm"
                                style={gone ? { color: "var(--acc)", borderColor: "var(--acc)" } : undefined}
                                disabled={busy}
                                aria-label={`${gone ? "Undo forgetting" : "Forget"}: ${item.text}`}
                                onClick={() => (gone ? undo(item) : forget(item))}
                              >
                                {gone ? "Undo" : "Forget"}
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                );
              })}
              <section
                className="section"
                aria-labelledby="tell"
                style={{ paddingTop: 12, borderTop: "1px solid var(--line)" }}
              >
                <div>
                  <h2 className="h3" id="tell">
                    Tell Alden something
                  </h2>
                  <p className="muted small">
                    Write it the way you'd tell a colleague. It shows up above as "you said", and the model gets it with
                    every review of {repo}.
                  </p>
                </div>
                <form className="tell" onSubmit={add}>
                  <input
                    className="input"
                    aria-label="New note"
                    placeholder="Always flag changes to middleware.ts"
                    maxLength={500}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                  <button type="submit" className="btn" disabled={busy || !note.trim()}>
                    Remember
                  </button>
                </form>
              </section>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
