import type { RankedPullRequest, RankedQueue } from "@alden/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Api, ApiError, type CloneInfo, type Session } from "./api";
import { MemoryView } from "./components/MemoryView";
import { isLearnedReason, prKey, QueueView, type Reaction } from "./components/QueueView";
import { type Choices, initialChoices, ReviewOptions, toRequest } from "./components/ReviewOptions";
import { ReviewPane } from "./components/ReviewPane";
import { SettingsView } from "./components/SettingsView";
import { SignInCard } from "./components/SignIn";
import { StateCard } from "./components/StateCard";
import { StatsView } from "./components/StatsView";
import { TelemetryCard } from "./components/TelemetryCard";
import { TopBar } from "./components/TopBar";
import { useFeedback } from "./feedback";
import { fetchedAgo, waitingSince } from "./format";
import { useReviews } from "./reviews";
import { navigate, useRoute } from "./router";

/** Messages worth showing as they are: the server words them for a person. */
const messageOf = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong.");

/**
 * `choseFolder`: the desktop app just restarted Alden in a folder you picked, so the queue starts on that repo, and
 * says where callers now come from.
 */
export function App({ api, choseFolder = false }: { api: Api | undefined; choseFolder?: boolean }) {
  const route = useRoute();
  const [session, setSession] = useState<Session>();
  const [fatal, setFatal] = useState<string>();
  const [queue, setQueue] = useState<RankedQueue>();
  const [queueError, setQueueError] = useState<string>();
  const [queueLoading, setQueueLoading] = useState(false);
  const [repoFilter, setRepoFilter] = useState("");
  const [choices, setChoices] = useState<Choices>();
  const [reactions, setReactions] = useState<Record<string, Reaction | undefined>>({});
  const [reactError, setReactError] = useState<string>();
  const [reactNotes, setReactNotes] = useState<Record<string, string | undefined>>({});
  const [folderNote, setFolderNote] = useState<FolderNote>();

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

  // Once, after the desktop app restarted Alden in a folder you chose: show that repo's PRs, and say so.
  const folderShown = useRef(false);
  useEffect(() => {
    if (!choseFolder || !session || folderShown.current) return;
    folderShown.current = true;
    const repo = session.repo?.repos[0];
    if (repo) setRepoFilter(repo);
    setFolderNote({ root: session.repo?.root ?? session.cwd, repo });
  }, [choseFolder, session]);
  const reviews = useReviews(api, loadSession);
  const feedbackFor = useFeedback(api, session?.repo?.repos[0] ?? null);

  const loadQueue = useCallback(
    (refresh: boolean, cached = false) => {
      if (!api) return;
      setQueueLoading(true);
      setQueueError(undefined);
      (async () => {
        let next = await api.queue({ refresh, cached });
        setQueue(next);
        // An old queue shows at once, with its age, while the current one loads.
        if (cached && fetchedAgo(next.fetchedAt)) {
          next = await api.queue();
          setQueue(next);
        }
      })()
        .catch((error: unknown) => setQueueError(messageOf(error)))
        .finally(() => setQueueLoading(false));
    },
    [api],
  );

  useEffect(() => loadQueue(false, true), [loadQueue]);

  // In the desktop app, which briefings are ready from the background: checked with the queue and every minute.
  const [ready, setReady] = useState<Set<string>>(new Set());
  const desktop = session?.desktop === true;
  useEffect(() => {
    if (!api || !desktop || !queue) return;
    const check = () =>
      api.preparedList().then(
        (items) => setReady(new Set(items.map((i) => i.pr.toLowerCase()))),
        () => {},
      );
    check();
    const timer = setInterval(check, 60_000);
    return () => clearInterval(timer);
  }, [api, desktop, queue]);

  const react = useCallback(
    (key: string, reaction: Reaction) => {
      if (!api) return;
      const previous = reactions[key];
      const next = previous === reaction ? undefined : reaction;
      // A dismissal that's already saved (the PR came back from the server as dismissed) is undone with "clear".
      const savedDismissed = queue?.dismissed?.some((r) => prKey(r.pr) === key);
      setReactions((all) => ({ ...all, [key]: savedDismissed ? undefined : next }));
      setReactError(undefined);
      setReactNotes(({ [key]: _, ...rest }) => rest);
      api.react(key, next ?? "clear").then(
        (saved) => {
          if (savedDismissed) loadQueue(false);
          const progress = (saved as { progress?: unknown } | null)?.progress;
          if (typeof progress === "string") setReactNotes((all) => ({ ...all, [key]: progress }));
        },
        (error: unknown) => {
          setReactions((all) => ({ ...all, [key]: previous }));
          setReactError(`Couldn't save that reaction: ${messageOf(error)}`);
        },
      );
    },
    [api, reactions, queue, loadQueue],
  );

  const all = [...(queue?.needsYou ?? []), ...(queue?.fastTrack ?? [])];
  const visible = all.filter((r) => !repoFilter || r.pr.repo === repoFilter);
  const current = route.view === "queue" ? route.pr : undefined;
  useQueueKeys({
    active: route.view === "queue",
    order: visible.map((r) => ({ repo: r.pr.repo, number: r.pr.number, url: r.pr.url })),
    current,
    onBrief: (key) => reviews.start(key, { pr: key, ...toRequest(choices ?? initialChoices(session), session) }),
    onReact: react,
    onRefresh: () => loadQueue(true),
  });

  if (!api || fatal === "expired") {
    return (
      <StateCard
        tone="dashed"
        glyph="?"
        title="Open Alden from its link"
        body="This page needs the session key in the link alden ui printed. Run it again if you've closed it."
        command="alden ui"
      />
    );
  }
  if (fatal) {
    return <StateCard tone="bad" glyph="✕" title="Alden couldn't start" body={fatal} />;
  }

  const selected = current ? `${current.repo}#${current.number}` : undefined;
  const queueCount = queue ? queue.needsYou.length + queue.fastTrack.length : undefined;
  const choicesNow = choices ?? initialChoices(session);

  return (
    <div className="app">
      <TopBar session={session} route={route} queueCount={queueCount} />
      {route.view === "queue" && (
        <div className={`workspace${current ? " has-detail" : ""}`}>
          <aside className="side" aria-label="Your review queue">
            <TelemetryCard api={api} />
            {folderNote && (
              <FolderNotice
                note={folderNote}
                filtered={repoFilter !== "" && repoFilter === folderNote.repo}
                onShowAll={() => {
                  setRepoFilter("");
                  setFolderNote(undefined);
                }}
              />
            )}
            <QueueView
              queue={queue}
              error={queueError ?? reactError}
              loading={queueLoading}
              repoFilter={repoFilter}
              onRepoFilter={setRepoFilter}
              onRefresh={() => loadQueue(true)}
              selected={selected}
              signedOut={session !== undefined && (session.user === null || "error" in session.user)}
              signIn={
                api && session ? (
                  <SignInCard
                    api={api}
                    session={session}
                    onSignedIn={() => {
                      loadSession();
                      loadQueue(true);
                    }}
                  />
                ) : undefined
              }
              reactions={reactions}
              reactionNotes={reactNotes}
              onReact={react}
              ready={ready}
              scope={session?.queueScope}
            />
          </aside>
          <main className="main-pane detail">
            {current ? (
              <PrPane
                prRef={current}
                row={all.find((r) => r.pr.repo === current.repo && r.pr.number === current.number)}
                session={session}
                choices={choicesNow}
                onChoices={setChoices}
                reviews={reviews}
                feedbackFor={feedbackFor}
                api={desktop ? api : undefined}
                cloneOf={api.clone}
              />
            ) : (
              <p className="faint" style={{ margin: "auto", padding: "120px 0", fontSize: 13 }}>
                Briefings show here. Pick a PR, or press <kbd>j</kbd>.
              </p>
            )}
          </main>
        </div>
      )}
      {route.view === "local" && (
        <div className="workspace has-detail">
          <aside className="side" aria-label="Working copies">
            <div className="list-head">
              <h2 className="label">Working copy</h2>
            </div>
            {session?.repo ? (
              <div className="side-item" aria-current="true">
                <span className="name">{session.repo.repos[0] ?? session.repo.root.split("/").at(-1)}</span>
                <span className="sub">{session.repo.root}</span>
              </div>
            ) : (
              <p className="side-note muted small">alden ui isn't running in a git repo.</p>
            )}
            <p className="note-box side-note">
              Alden reads <code>git diff HEAD</code> plus untracked files. Nothing leaves your machine except the model
              call.
            </p>
          </aside>
          <main className="main-pane">
            <ReviewPane
              crumbs={<span>{session?.repo?.root ?? "no repo"}</span>}
              title={`Your uncommitted changes${session?.repo?.repos[0] ? ` in ${session.repo.repos[0].split("/")[1]}` : ""}`}
              why={
                reviews.runs.local?.briefing
                  ? {
                      label: "Since your last commit",
                      items: [
                        `${reviews.runs.local.briefing.summary.files} files`,
                        `+${reviews.runs.local.briefing.summary.additions} −${reviews.runs.local.briefing.summary.deletions}`,
                      ],
                    }
                  : undefined
              }
              run={reviews.runs.local}
              feedbackFor={feedbackFor}
              request={toRequest(choicesNow, session)}
              onStart={(request) => reviews.start("local", request)}
              onCancel={() => reviews.cancel("local")}
              controls={<ReviewOptions session={session} choices={choicesNow} onChange={setChoices} />}
              emptyHint="Review your uncommitted changes (staged, unstaged and untracked) before you open a PR."
              perReviewUsd={session?.budget.perReviewUsd}
            />
          </main>
        </div>
      )}
      {route.view === "memory" &&
        (session ? <MemoryView api={api} session={session} /> : <StateCard tone="spin" title="Loading…" live />)}
      {route.view === "stats" && (
        <div className="page">
          {session ? <StatsView api={api} session={session} /> : <StateCard tone="spin" title="Loading…" live />}
        </div>
      )}
      {route.view === "settings" && (
        <div className="page">
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
            <StateCard tone="spin" title="Loading…" live />
          )}
        </div>
      )}
    </div>
  );
}

interface FolderNote {
  root: string;
  repo: string | undefined;
}

/** After choosing a folder in the desktop app: where callers come from now, and the way back to every repo. */
export function FolderNotice(props: { note: FolderNote; filtered: boolean; onShowAll: () => void }) {
  const { root, repo } = props.note;
  return (
    <p className="banner side-note" role="status">
      {repo ? (
        <>
          Callers now come from <code>{root}</code>. {props.filtered ? <>Showing {repo} only. </> : null}
        </>
      ) : (
        <>
          Alden now runs in <code>{root}</code>, which isn't a clone of a GitHub repo, so callers come from the clones
          Alden knows.{" "}
        </>
      )}
      <button type="button" className="link-button small" onClick={props.onShowAll}>
        {props.filtered ? "Show all repos" : "OK"}
      </button>
    </p>
  );
}

function PrPane(props: {
  prRef: { repo: string; number: number };
  row: RankedPullRequest | undefined;
  session: Session | undefined;
  choices: Choices;
  onChoices: (choices: Choices) => void;
  reviews: ReturnType<typeof useReviews>;
  feedbackFor: ReturnType<typeof useFeedback>;
  /** Only in the desktop app: where briefings prepared in the background come from. */
  api?: Api | undefined;
  /** The local clone a repo's callers come from (here, one Alden saw before, or one under clones.folders). */
  cloneOf?: (repo: string) => Promise<CloneInfo>;
}) {
  const { prRef, row, reviews, session, api, cloneOf } = props;
  const key = `${prRef.repo}#${prRef.number}`;
  const pr = row?.pr;
  const hasRun = reviews.runs[key] !== undefined;
  const request = { pr: key, ...toRequest(props.choices, session) };
  const requestRef = useRef(request);
  requestRef.current = request;
  const { seed } = reviews;
  // A briefing the desktop app prepared while you were away shows at once.
  useEffect(() => {
    if (!api || hasRun) return;
    let live = true;
    api.prepared(key).then(
      (found) => {
        if (live && found) seed(key, found.briefing, found.at, requestRef.current);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [api, key, hasRun, seed]);
  const [clone, setClone] = useState<CloneInfo>();
  useEffect(() => {
    if (!cloneOf) return;
    let live = true;
    setClone(undefined);
    cloneOf(prRef.repo).then(
      (found) => {
        if (live) setClone(found);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [cloneOf, prRef.repo]);
  const elsewhere = clone?.path && clone.path !== session?.repo?.root ? clone.path : undefined;
  const noClone = props.choices.graph && session && clone !== undefined && clone.path === null;
  return (
    <ReviewPane
      crumbs={
        <>
          <a href={pr?.url ?? `https://github.com/${prRef.repo}/pull/${prRef.number}`} target="_blank" rel="noreferrer">
            {prRef.repo} #{prRef.number} ↗
          </a>
          {pr && (
            <span>
              {pr.author ?? "ghost"}:{pr.headRef} → {pr.baseRef}
            </span>
          )}
        </>
      }
      title={pr?.title ?? key}
      why={
        row
          ? {
              label: "In your queue because",
              // The wait reads the same as on the queue row: one time, since you were asked.
              items: row.reasons
                .filter((r) => !isLearnedReason(r))
                .map((r) => (/^waiting \d/.test(r) ? `waiting ${waitingSince(row)}` : r))
                .map((r) => r.charAt(0).toUpperCase() + r.slice(1)),
            }
          : undefined
      }
      backToQueue
      notice={
        noClone ? (
          <>
            No local clone of <strong>{prRef.repo}</strong> found, so Alden can't find callers. The briefing still runs
            on the diff alone. To find callers, run Alden once in a clone of it, or tell Alden where your clones live:{" "}
            <code>alden config set clones.folders ~/src</code>.
          </>
        ) : props.choices.graph && elsewhere ? (
          <>
            Callers come from your clone in <code>{elsewhere}</code>.
          </>
        ) : undefined
      }
      run={reviews.runs[key]}
      request={request}
      onStart={(request) => reviews.start(key, request)}
      onCancel={() => reviews.cancel(key)}
      controls={<ReviewOptions session={session} choices={props.choices} onChange={props.onChoices} />}
      emptyHint="Alden fetches the PR, finds who calls the code it changes (from a clone of the repo), runs its checks, and asks the model if one is set up."
      feedbackFor={props.feedbackFor}
      perReviewUsd={session?.budget.perReviewUsd}
    />
  );
}

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName));

/**
 * The queue from the keyboard: j/k (or the arrows) move between PRs and open each briefing, o opens the PR on GitHub,
 * b briefs you on it, + − x react to it, r refreshes, Esc goes back to the list (narrow windows).
 */
function useQueueKeys(options: {
  active: boolean;
  order: { repo: string; number: number; url: string }[];
  current: { repo: string; number: number } | undefined;
  onBrief: (key: string) => void;
  onReact: (key: string, reaction: Reaction) => void;
  onRefresh: () => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const { active, order, current, onBrief, onReact, onRefresh } = latest.current;
      if (!active || event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
      const index = current ? order.findIndex((p) => p.repo === current.repo && p.number === current.number) : -1;
      const go = (i: number) => {
        const pr = order[Math.max(0, Math.min(order.length - 1, i))];
        if (!pr) return;
        navigate({ view: "queue", pr: { repo: pr.repo, number: pr.number } });
        document.querySelector(`[data-pr="${pr.repo}#${pr.number}"]`)?.scrollIntoView({ block: "nearest" });
      };
      const here = order[index];
      const key = here ? `${here.repo}#${here.number}` : undefined;
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
          if (key) onBrief(key);
          break;
        case "+":
        case "=":
          if (key) onReact(key, "up");
          break;
        case "-":
          if (key) onReact(key, "down");
          break;
        case "x":
          if (key) onReact(key, "dismiss");
          break;
        case "r":
          onRefresh();
          break;
        case "Escape":
          // Narrow windows show one pane at a time: Esc goes back to the list. (Wide, Esc stops a running review.)
          if (!current || window.innerWidth >= 960) return;
          navigate({ view: "queue" });
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
