import type { ModelSetupState, RankedPullRequest, RankedQueue } from "@alden/schema";
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { Api, Session, SetupPage } from "../api";
import { formatWait } from "../format";
import { Mark } from "./Mark";
import { KeyKindIndicator, LocalStep, PageLink, useKeyTest } from "./ModelSetup";
import { signInFailure, useDeviceSignIn } from "./SignIn";
import "./first-run.css";

/**
 * The first run, from the v3 design's "02 First run": sign in, pick how Alden thinks, land in a ranked queue. Each
 * step fits one screen and says what Alden can see. Shown when there's no GitHub sign-in yet, and from Settings →
 * "Run setup again". The terminal's `alden`, signed out, asks the same in the same order.
 */

export type FirstRunStep = 1 | 2 | 3;

/** What GitHub is asked for, truthfully: Alden's device flow asks for the repo and read:org scopes. */
export const SIGN_IN_FOOTNOTE = "asks for repo and read:org · revoke anytime";

export function FirstRun(props: {
  api: Api;
  session: Session;
  /** The queue as the app loaded it, for the last step. */
  queue: RankedQueue | undefined;
  queueLoading: boolean;
  queueError?: string | undefined;
  /** Where to start: 1 when signed out, 2 when run again from Settings. */
  start?: FirstRunStep;
  /** Signed in: the app reloads the session and the queue. */
  onSignedIn: () => void;
  /** A model was set up: the app reloads the session. */
  onModelReady: () => void;
  /** "Open the queue", or skipped. */
  onClose: () => void;
}) {
  const { api, session, onClose } = props;
  const signedIn = session.user !== null && "login" in session.user;
  const [step, setStep] = useState<FirstRunStep>(props.start ?? (signedIn ? 2 : 1));
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialog.current?.focus();
  }, []);

  const onSignedIn = props.onSignedIn;
  const signedInNow = useCallback(() => {
    onSignedIn();
    setStep(2);
  }, [onSignedIn]);

  return (
    <div className="first-run">
      <div
        ref={dialog}
        className="first-run-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="first-run-title"
        tabIndex={-1}
        data-step={step}
      >
        <div className="first-run-top">
          <StepIndicator step={step} />
          {step < 3 && (
            <button type="button" className="first-run-skip" onClick={onClose}>
              Skip setup
            </button>
          )}
        </div>
        {step === 1 && <SignInStep api={api} session={session} onSignedIn={signedInNow} />}
        {step === 2 && (
          <ModelStep
            api={api}
            desktop={session.desktop === true}
            onModelReady={props.onModelReady}
            onNext={() => setStep(3)}
          />
        )}
        {step === 3 && (
          <QueueStep
            session={session}
            queue={props.queue}
            loading={props.queueLoading}
            error={props.queueError}
            onOpen={onClose}
          />
        )}
      </div>
    </div>
  );
}

const STEPS = ["Sign in", "Model", "Queue"] as const;

/** "1 Sign in  2 Model  3 Queue", the current step lit, the ones before it ticked. */
export function StepIndicator({ step }: { step: FirstRunStep }) {
  return (
    <ol className="first-run-steps" aria-label="Setup steps">
      {STEPS.map((name, i) => {
        const n = i + 1;
        const done = n < step;
        return (
          <li key={name} aria-current={n === step ? "step" : undefined} className={n === step ? "current" : undefined}>
            {done ? (
              <>
                <span aria-hidden="true">✓</span> {name}
                <span className="visually-hidden"> (done)</span>
              </>
            ) : (
              `${n} ${name}`
            )}
          </li>
        );
      })}
    </ol>
  );
}

function SignInStep(props: { api: Api; session: Session; onSignedIn: () => void }) {
  const { api, session } = props;
  const { flow, error, copied, checking, start, check, useGh, copy } = useDeviceSignIn(api, props.onSignedIn);
  const canUseGh = session.signIn?.gitHubCli === true && session.signIn.source !== "gh";
  const keychain = session.signIn?.problem?.kind === "keychain" ? signInFailure(session) : undefined;

  if (flow.state === "waiting") {
    return (
      <div className="first-run-center" aria-live="polite">
        <Mark size={40} />
        <h2 className="first-run-hero" id="first-run-title">
          Enter this code on GitHub.
        </h2>
        <p className="first-run-code mono">
          <span className="visually-hidden">Your one-time code: </span>
          {flow.userCode}
        </p>
        <p className="first-run-body">
          GitHub's page opened in your browser. Enter the code there and approve Alden; this moves on by itself.
        </p>
        <button type="button" className="first-run-cta" onClick={copy}>
          {copied ? "Copied" : "Copy code"}
        </button>
        <button type="button" className="first-run-link" onClick={() => void api.openSignIn()}>
          Open GitHub again
        </button>
      </div>
    );
  }

  return (
    <div className="first-run-center">
      <Mark size={40} />
      <h2 className="first-run-hero" id="first-run-title">
        Start with the reviews waiting on you.
      </h2>
      <p className="first-run-body">
        Alden reads PRs where you or your team were asked to review. Your code stays on this machine.
      </p>
      {keychain && !error && <p className="error-text small">{keychain}</p>}
      {flow.state === "failed" && <p className="error-text small">{flow.message}</p>}
      {error && (
        <p className="error-text small" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="first-run-cta" onClick={start}>
        Continue with GitHub
      </button>
      <span className="first-run-foot">{SIGN_IN_FOOTNOTE}</span>
      <span className="first-run-alt">
        {canUseGh && (
          <>
            <button type="button" className="first-run-link" onClick={useGh}>
              Use my GitHub CLI sign-in
            </button>
            {" · "}
          </>
        )}
        Signed in with <code>alden auth login</code>?{" "}
        <button type="button" className="first-run-link" onClick={check} disabled={checking}>
          {checking ? "checking…" : "Look again"}
        </button>
      </span>
    </div>
  );
}

type ModelOption = "key" | "local" | "checks";

function ModelStep(props: { api: Api; desktop: boolean; onModelReady: () => void; onNext: () => void }) {
  const { api, desktop, onModelReady, onNext } = props;
  const [state, setState] = useState<ModelSetupState>();
  const [loadError, setLoadError] = useState<string>();
  const [option, setOption] = useState<ModelOption>("key");
  const [ready, setReady] = useState<string>();
  const load = useCallback(() => {
    setLoadError(undefined);
    api.modelSetup().then(setState, (e: Error) => setLoadError(e.message));
  }, [api]);
  useEffect(load, [load]);

  const keyTest = useKeyTest(api, (result) => {
    onModelReady();
    setReady(result.provider === "openai" ? "Your OpenAI key works." : "Your Anthropic key works.");
    onNext();
  });
  const link = (page: SetupPage, text: ReactNode) => (
    <PageLink api={api} desktop={desktop} page={page}>
      {text}
    </PageLink>
  );
  const already = state?.current.available ? state.current : undefined;
  const typed = keyTest.key.trim() !== "";
  // Continue checks a pasted key; with none, it keeps the model there is, or moves on (local and checks only).
  const cont = (event?: FormEvent) => {
    event?.preventDefault();
    if (option === "key" && typed) keyTest.submit(false);
    else onNext();
  };
  const canContinue = !keyTest.busy && (option !== "key" || typed || already !== undefined);

  return (
    <form className="first-run-model" onSubmit={cont}>
      <h2 className="first-run-title" id="first-run-title">
        How should Alden think?
      </h2>
      {already && (
        <p className="first-run-note" role="status">
          Alden uses <span className="mono">{already.model}</span> now. Continue keeps it.
        </p>
      )}
      {loadError && <p className="error-text small">{loadError}</p>}
      {ready && <p className="visually-hidden">{ready}</p>}
      <div className="first-run-options">
        <ModelCard
          id="key"
          option={option}
          onPick={setOption}
          title="Your API key"
          aside={<KeyKindIndicator kind={keyTest.kind} />}
        >
          {option === "key" ? (
            <>
              <input
                className="first-run-input mono"
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-label="API key, Anthropic or OpenAI"
                placeholder="sk-ant-… or sk-…"
                value={keyTest.key}
                onChange={(e) => keyTest.setKey(e.target.value)}
              />
              <span className="first-run-help">
                Paste either kind and Alden detects it. Stored in your keychain, calls go straight to the provider. Get
                one at {link("keys", "Anthropic")} or {link("openaiKeys", "OpenAI")}.
              </span>
              {keyTest.failure && (
                <span className="error-text small" role="alert">
                  {keyTest.failure.message}
                  {keyTest.unreachable && (
                    <>
                      {" "}
                      <button type="button" className="first-run-link" onClick={() => keyTest.submit(true)}>
                        Store without checking
                      </button>
                    </>
                  )}
                </span>
              )}
            </>
          ) : null}
        </ModelCard>
        <ModelCard
          id="local"
          option={option}
          onPick={setOption}
          title="A local model through Ollama"
          sub="Nothing leaves your machine. Slower briefs."
        >
          {option === "local" ? (
            <LocalStep
              api={api}
              state={state}
              link={link}
              onLook={load}
              onDone={() => {
                onModelReady();
                onNext();
              }}
            />
          ) : null}
        </ModelCard>
        <ModelCard
          id="checks"
          option={option}
          onPick={setOption}
          title="Checks only"
          sub="Ranking and checks without a model. Add one later."
        />
      </div>
      <div className="first-run-actions">
        <span className="first-run-cloud">Alden Cloud (beta) · {link("cloud", "join the list")}</span>
        <button type="submit" className="first-run-next" disabled={!canContinue}>
          {keyTest.busy ? "Checking…" : "Continue"}
        </button>
      </div>
    </form>
  );
}

function ModelCard(props: {
  id: ModelOption;
  option: ModelOption;
  onPick: (option: ModelOption) => void;
  title: string;
  sub?: string;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  const on = props.option === props.id;
  return (
    <div className={`first-run-option${on ? " on" : ""}`}>
      <div className="first-run-option-head">
        <button
          type="button"
          aria-pressed={on}
          className="first-run-option-pick"
          onClick={() => props.onPick(props.id)}
        >
          <span className="first-run-option-title">{props.title}</span>
          {props.sub && <span className="first-run-option-sub">{props.sub}</span>}
        </button>
        {props.aside}
      </div>
      {props.children}
    </div>
  );
}

/** "orders-api #488 · li · 40m", as the design's first-queue rows read. */
export function firstRowMeta(row: RankedPullRequest): string {
  const name = row.pr.repo.split("/")[1] ?? row.pr.repo;
  return `${name} #${row.pr.number} · ${row.pr.author ?? "ghost"} · ${formatWait(row.waitingHours)}`;
}

function QueueStep(props: {
  session: Session;
  queue: RankedQueue | undefined;
  loading: boolean;
  error: string | undefined;
  onOpen: () => void;
}) {
  const { queue, session } = props;
  const rows = queue ? [...queue.needsYou, ...queue.fastTrack] : [];
  const n = rows.length;
  // The desktop app briefs the top PRs in the background, when that's on.
  const prepare = session.background?.prepare ?? 3;
  const briefing = session.desktop === true && session.background?.enabled !== false && prepare > 0 && n > 0;
  const title = !queue
    ? "Finding the reviews waiting on you…"
    : n === 0
      ? "Nothing is waiting on you."
      : `${n} PR${n === 1 ? " is" : "s are"} waiting on you.`;
  return (
    <div className="first-run-queue">
      <div className="first-run-head">
        <h2 className="first-run-title" id="first-run-title" aria-live="polite">
          {title}
        </h2>
        <p className="first-run-body">
          {n === 0 && queue
            ? "Alden will rank new review requests here as they come in."
            : "Ranked by what usually needs a reviewer first. React to rows and Alden adjusts to you."}
        </p>
      </div>
      {props.error && !queue && <p className="error-text small">{props.error}</p>}
      {n > 0 && (
        <ul className="first-run-rows" aria-label="Top of your queue">
          {rows.slice(0, 4).map((row) => (
            <li key={`${row.pr.repo}#${row.pr.number}`}>
              <span className="first-run-row-title">{row.pr.title}</span>
              <span className="first-run-row-meta mono">{firstRowMeta(row)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="first-run-actions">
        <span className="first-run-foot">
          {props.loading && !queue
            ? "loading your queue…"
            : briefing
              ? `briefing the top ${Math.min(prepare, n)}…`
              : ""}
        </span>
        <button type="button" className="first-run-next" onClick={props.onOpen}>
          Open the queue
        </button>
      </div>
    </div>
  );
}
