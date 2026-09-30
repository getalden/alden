import type { RankedPullRequest, RankedQueue } from "@alden/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Api, ApiError, type Session } from "./api";
import { QueueView } from "./components/QueueView";
import { type Choices, initialChoices, ReviewOptions, toRequest } from "./components/ReviewOptions";
import { ReviewPane } from "./components/ReviewPane";
import { SettingsView } from "./components/SettingsView";
import { TopBar } from "./components/TopBar";
import { useReviews } from "./reviews";
import { navigate, useRoute } from "./router";

/** Messages worth showing as they are: the server words them for a person. */
const messageOf = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong.");

export function App({ api }: { api: Api | undefined }) {
  const route = useRoute();
  const [session, setSession] = useState<Session>();
  const [fatal, setFatal] = useState<string>();
  const [queue, setQueue] = useState<RankedQueue>();
  const [queueError, setQueueError] = useState<string>();
  const [queueLoading, setQueueLoading] = useState(false);
  const [repoFilter, setRepoFilter] = useState("");
  const [choices, setChoices] = useState<Choices>();

  const loadSession = useCallback(() => {
    if (!api) return;
    api
      .session()
      .then((next) => {
        setSession(next);
        // The first session sets the picker; later ones (after a review or a settings change) only refresh the budget.
        setChoices((current) => current ?? initialChoices(next));
      })
      .catch((error: unknown) =>
        setFatal(error instanceof ApiError && error.status === 401 ? "expired" : messageOf(error)),
      );
  }, [api]);

  useEffect(loadSession, [loadSession]);
  const reviews = useReviews(api, loadSession);

  const loadQueue = useCallback(
    (refresh: boolean) => {
      if (!api) return;
      setQueueLoading(true);
      setQueueError(undefined);
      api
        .queue(refresh)
        .then(setQueue)
        .catch((error: unknown) => setQueueError(messageOf(error)))
        .finally(() => setQueueLoading(false));
    },
    [api],
  );

  useEffect(() => loadQueue(false), [loadQueue]);

  const visible = [...(queue?.needsYou ?? []), ...(queue?.fastTrack ?? [])].filter(
    (r) => !repoFilter || r.pr.repo === repoFilter,
  );
  useQueueKeys({
    active: route.view === "queue",
    order: visible.map((r) => ({ repo: r.pr.repo, number: r.pr.number, url: r.pr.url })),
    current: route.view === "queue" ? route.pr : undefined,
    onBrief: (key) => reviews.start(key, { pr: key, ...toRequest(choices ?? initialChoices(session), session) }),
  });

  if (!api || fatal === "expired") {
    return (
      <div className="state">
        <h2>Open Alden from its link</h2>
        <p>
          This page needs the session key in the link <code>alden ui</code> printed. Run it again if you've closed it:
        </p>
        <pre>alden ui</pre>
      </div>
    );
  }
  if (fatal) {
    return (
      <div className="state">
        <h2>Alden couldn't start</h2>
        <p>{fatal}</p>
      </div>
    );
  }

  const selected = route.view === "queue" && route.pr ? `${route.pr.repo}#${route.pr.number}` : undefined;
  const showDetail = route.view === "queue" && route.pr !== undefined;

  return (
    <div className="app">
      <TopBar session={session} route={route} />
      <main className={`main${route.view !== "queue" ? " single" : ""}${showDetail ? " has-detail" : ""}`}>
        {route.view === "queue" && (
          <>
            <div className="pane list">
              <QueueView
                queue={queue}
                error={queueError}
                loading={queueLoading}
                repoFilter={repoFilter}
                onRepoFilter={setRepoFilter}
                onRefresh={() => loadQueue(true)}
                selected={selected}
                signedOut={session !== undefined && session.user === null}
              />
            </div>
            <div className="pane detail">
              {route.pr ? (
                <PrPane
                  prRef={route.pr}
                  row={[...(queue?.needsYou ?? []), ...(queue?.fastTrack ?? [])].find(
                    (r) => r.pr.repo === route.pr?.repo && r.pr.number === route.pr?.number,
                  )}
                  session={session}
                  choices={choices ?? initialChoices(session)}
                  onChoices={setChoices}
                  reviews={reviews}
                />
              ) : (
                <div className="state">
                  <h2>Pick a PR</h2>
                  <p>Its briefing shows here: where to look, what Alden checked, and who calls the changed code.</p>
                </div>
              )}
            </div>
          </>
        )}
        {route.view === "local" && (
          <div className="pane">
            <ReviewPane
              title="My changes"
              subtitle={
                session?.repo ? (
                  <span className="mono">{session.repo.root}</span>
                ) : (
                  "alden ui isn't running in a git repo, so there are no local changes to review."
                )
              }
              run={reviews.runs.local}
              request={toRequest(choices ?? initialChoices(session), session)}
              onStart={(request) => reviews.start("local", request)}
              onCancel={() => reviews.cancel("local")}
              controls={
                <ReviewOptions session={session} choices={choices ?? initialChoices(session)} onChange={setChoices} />
              }
              emptyHint="Review your uncommitted changes (staged, unstaged and untracked) before you open a PR."
            />
          </div>
        )}
        {route.view === "settings" && (
          <div className="pane">
            {session ? (
              <SettingsView
                api={api}
                session={session}
                onSaved={() => {
                  setChoices(undefined);
                  loadSession();
                }}
              />
            ) : (
              <p className="state">Loading…</p>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function PrPane(props: {
  prRef: { repo: string; number: number };
  row: RankedPullRequest | undefined;
  session: Session | undefined;
  choices: Choices;
  onChoices: (choices: Choices) => void;
  reviews: ReturnType<typeof useReviews>;
}) {
  const { prRef, row, reviews } = props;
  const key = `${prRef.repo}#${prRef.number}`;
  const pr = row?.pr;
  return (
    <ReviewPane
      title={pr?.title ?? key}
      subtitle={
        <>
          <a href={pr?.url ?? `https://github.com/${prRef.repo}/pull/${prRef.number}`} target="_blank" rel="noreferrer">
            <span className="mono">{key}</span> on GitHub
          </a>
          {pr && (
            <>
              {" · "}
              {pr.author ? `@${pr.author}` : "ghost"} · <span className="mono">{pr.baseRef}</span> ←{" "}
              <span className="mono">{pr.headRef}</span>
            </>
          )}
        </>
      }
      row={row}
      backToQueue
      note={
        props.choices.graph && props.session && !props.session.repo?.repos.includes(prRef.repo.toLowerCase()) ? (
          <>
            Callers need a clone of <span className="mono">{prRef.repo}</span>: start <code>alden ui</code> inside one
            to see who calls the changed code.
          </>
        ) : undefined
      }
      run={reviews.runs[key]}
      request={{ pr: key, ...toRequest(props.choices, props.session) }}
      onStart={(request) => reviews.start(key, request)}
      onCancel={() => reviews.cancel(key)}
      controls={<ReviewOptions session={props.session} choices={props.choices} onChange={props.onChoices} />}
      emptyHint="Alden fetches the PR, finds who calls the code it changes (from a clone of the repo), runs its checks, and asks the model if one is set up."
    />
  );
}

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName));

/**
 * The queue from the keyboard: j/k (or the arrows) move between PRs and open each briefing, o opens the PR on GitHub,
 * b briefs you on it.
 */
function useQueueKeys(options: {
  active: boolean;
  order: { repo: string; number: number; url: string }[];
  current: { repo: string; number: number } | undefined;
  onBrief: (key: string) => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const { active, order, current, onBrief } = latest.current;
      if (!active || event.metaKey || event.ctrlKey || event.altKey || typing(event.target) || order.length === 0)
        return;
      const index = current ? order.findIndex((p) => p.repo === current.repo && p.number === current.number) : -1;
      const go = (i: number) => {
        const pr = order[Math.max(0, Math.min(order.length - 1, i))];
        if (!pr) return;
        navigate({ view: "queue", pr: { repo: pr.repo, number: pr.number } });
        document.querySelector(`[data-pr="${pr.repo}#${pr.number}"]`)?.scrollIntoView({ block: "nearest" });
      };
      const here = order[index];
      switch (event.key) {
        case "j":
        case "ArrowDown":
          go(index + 1);
          break;
        case "k":
        case "ArrowUp":
          go(index === -1 ? 0 : index - 1);
          break;
        case "o":
          if (here) window.open(here.url, "_blank", "noopener,noreferrer");
          break;
        case "b":
          if (here) onBrief(`${here.repo}#${here.number}`);
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
