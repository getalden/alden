import type { MemoryItem } from "@alden/schema";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { Api, Memory, Session } from "../api";

/**
 * What Alden knows about you in a repo: your own notes, and what it learned from your feedback and the PRs you open
 * first. Each item says what it was learned from and what it changes, and any of them can be forgotten.
 */
export function MemoryView({ api, session }: { api: Api; session: Session }) {
  const [repo, setRepo] = useState(session.repo?.repos[0] ?? "");
  const [memory, setMemory] = useState<Memory>();
  const [error, setError] = useState<string>();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!repo) return;
    setError(undefined);
    api.memory(repo).then(setMemory, (e: Error) => {
      setMemory(undefined);
      setError(e.message);
    });
  }, [api, repo]);

  useEffect(load, [load]);

  async function act(run: () => Promise<Memory>) {
    setBusy(true);
    setError(undefined);
    try {
      setMemory(await run());
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    if (await act(() => api.addMemory(note, repo))) setNote("");
  }

  const notes = memory?.items.filter((i) => i.source === "you") ?? [];
  const learned = memory?.items.filter((i) => i.source === "learned") ?? [];

  return (
    <section className="settings memory" aria-labelledby="memory-title">
      <h1 id="memory-title">What Alden knows about you</h1>
      <p className="muted small">
        Alden learns from the flags you agree with or mark not needed, and from the PRs you open ahead of their rank. It
        shows everything it uses here, and nothing leaves your machine.
      </p>

      <label className="memory-repo">
        <span className="muted small">Repo</span>
        <input
          value={repo}
          onChange={(e) => setRepo(e.target.value.trim())}
          onBlur={load}
          placeholder="owner/name"
          aria-label="Repo"
          className="mono"
        />
      </label>

      {error && <p className="error-text">{error}</p>}

      <div className="card">
        <h2>Your notes</h2>
        <p className="muted small">The model gets these with every review of {repo || "this repo"}.</p>
        <MemoryList
          items={notes}
          empty="No notes yet."
          onForget={(id) => act(() => api.forgetMemory(id, repo))}
          busy={busy}
        />
        <form className="memory-add" onSubmit={add}>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder="e.g. Money is in cents, never floats"
            aria-label="New note"
          />
          <button type="submit" className="btn primary" disabled={busy || !note.trim() || !repo}>
            Add note
          </button>
        </form>
      </div>

      <div className="card">
        <h2>Learned from your feedback</h2>
        <MemoryList
          items={learned}
          empty="Nothing yet. After three one-sided verdicts on a check, or three PRs of one kind opened ahead of their rank, it shows up here."
          onForget={(id) => act(() => api.forgetMemory(id, repo))}
          busy={busy}
        />
      </div>
    </section>
  );
}

function MemoryList(props: { items: MemoryItem[]; empty: string; onForget: (id: string) => void; busy: boolean }) {
  if (props.items.length === 0) return <p className="muted small">{props.empty}</p>;
  return (
    <ul className="memory-list">
      {props.items.map((item) => (
        <li key={item.id}>
          <div>
            <div>{item.text}</div>
            <div className="faint small">
              {[item.evidence, item.effect, `since ${item.since.slice(0, 10)}`].filter(Boolean).join(" · ")}
            </div>
          </div>
          <button
            type="button"
            className="btn small"
            disabled={props.busy}
            onClick={() => props.onForget(item.id)}
            aria-label={`Forget: ${item.text}`}
          >
            Forget
          </button>
        </li>
      ))}
    </ul>
  );
}
