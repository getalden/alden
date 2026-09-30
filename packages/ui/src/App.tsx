import type { RankedPullRequest, RankedQueue } from "@alden/schema";
import { useCallback, useEffect, useState } from "react";
import { type Api, ApiError, type Session } from "./api";
import { QueueView } from "./components/QueueView";
import { ReviewPane } from "./components/ReviewPane";
import { TopBar } from "./components/TopBar";
import { useReviews } from "./reviews";
import { useRoute } from "./router";

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
  const reviews = useReviews(api);

  useEffect(() => {
    if (!api) return;
    api
      .session()
      .then(setSession)
      .catch((error: unknown) =>
        setFatal(error instanceof ApiError && error.status === 401 ? "expired" : messageOf(error)),
      );
  }, [api]);

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
              />
            </div>
            <div className="pane detail">
              {route.pr ? (
                <PrPane
                  prRef={route.pr}
                  row={[...(queue?.needsYou ?? []), ...(queue?.fastTrack ?? [])].find(
                    (r) => r.pr.repo === route.pr?.repo && r.pr.number === route.pr?.number,
                  )}
                  modelAvailable={session?.model.available ?? false}
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
              request={{ llm: session?.model.available ?? false, graph: true }}
              onStart={(request) => reviews.start("local", request)}
              onCancel={() => reviews.cancel("local")}
              controls={null}
              emptyHint="Review your uncommitted changes (staged, unstaged and untracked) before you open a PR."
            />
          </div>
        )}
        {route.view === "settings" && <div className="pane" />}
      </main>
    </div>
  );
}

function PrPane(props: {
  prRef: { repo: string; number: number };
  row: RankedPullRequest | undefined;
  modelAvailable: boolean;
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
      run={reviews.runs[key]}
      request={{ pr: key, llm: props.modelAvailable, graph: true }}
      onStart={(request) => reviews.start(key, request)}
      onCancel={() => reviews.cancel(key)}
      controls={null}
      emptyHint="Alden fetches the PR, finds who calls the code it changes (from a clone of the repo), runs its checks, and asks the model if one is set up."
    />
  );
}
