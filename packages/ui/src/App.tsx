import type { RankedQueue } from "@alden/schema";
import { useCallback, useEffect, useState } from "react";
import { type Api, ApiError, type Session } from "./api";
import { QueueView } from "./components/QueueView";
import { TopBar } from "./components/TopBar";
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
                <div className="state">
                  <h2>
                    {route.pr.repo}#{route.pr.number}
                  </h2>
                  <p>The briefing view arrives next.</p>
                </div>
              ) : (
                <div className="state">
                  <h2>Pick a PR</h2>
                  <p>Its briefing shows here: where to look, what Alden checked, and who calls the changed code.</p>
                </div>
              )}
            </div>
          </>
        )}
        {route.view !== "queue" && <div className="pane" />}
      </main>
    </div>
  );
}
