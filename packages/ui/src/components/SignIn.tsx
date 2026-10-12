import { useEffect, useState } from "react";
import type { Api, Session, SignInState } from "../api";
import { StateCard } from "./StateCard";

/**
 * What failed, when a session is still signed out after you said you'd signed in: GitHub rejected the token, the
 * keychain refused to answer (an unsigned copy of the app can't read it), or there's no sign-in anywhere.
 */
export function signInFailure(session: Session): string | undefined {
  if (session.user && "login" in session.user) return undefined;
  if (session.user && "error" in session.user) return `GitHub rejected the sign-in: ${session.user.error}`;
  const problem = session.signIn?.problem;
  if (problem?.kind === "keychain") {
    return `The keychain didn't let Alden read your sign-in (${problem.detail}). An unsigned copy of Alden.app, such as a development build, can't read it: quit this one and open Alden from your Applications folder, or allow Alden when macOS asks.`;
  }
  return "Alden still finds no GitHub sign-in: none stored, no ALDEN_GITHUB_TOKEN, and the GitHub CLI isn't signed in. Run alden auth login in a terminal first, or sign in with GitHub here.";
}

/**
 * The device flow from the UI, for the sign-in card and the first run: start it (GitHub's page opens with the code on
 * screen), hear when it's done, switch to the GitHub CLI's sign-in, or look again after a terminal sign-in.
 */
export function useDeviceSignIn(api: Api, onSignedIn: () => void) {
  const [flow, setFlow] = useState<SignInState>({ state: "idle" });
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);

  // While a code is out, ask the server how it's going; it hears from GitHub.
  useEffect(() => {
    if (flow.state !== "waiting") return;
    const timer = setInterval(() => {
      api.signInStatus().then(
        (next) => {
          setFlow(next);
          if (next.state === "done") onSignedIn();
        },
        () => {},
      );
    }, 2_000);
    return () => clearInterval(timer);
  }, [api, flow.state, onSignedIn]);

  const start = () => {
    setError(undefined);
    api.startSignIn().then(
      (next) => {
        setFlow(next);
        // Open GitHub's page straight away: one less click, and the code is on screen to type.
        if (next.state === "waiting") void api.openSignIn();
      },
      (e: Error) => setError(e.message),
    );
  };
  // Signed in elsewhere (a terminal): look again, and say what failed rather than showing the same card.
  const check = () => {
    setError(undefined);
    setChecking(true);
    api
      .session()
      .then(
        (next) => {
          const failure = signInFailure(next);
          if (failure) setError(failure);
          else onSignedIn();
        },
        (e: Error) => setError(e.message),
      )
      .finally(() => setChecking(false));
  };
  const useGh = () => {
    setError(undefined);
    api.useGitHubCli().then(
      (result) => ("error" in result ? setError(result.error) : onSignedIn()),
      (e: Error) => setError(e.message),
    );
  };
  const copy = () => {
    if (flow.state !== "waiting") return;
    navigator.clipboard?.writeText(flow.userCode).then(
      () => setCopied(true),
      () => {},
    );
  };
  return { flow, error, copied, checking, start, check, useGh, copy };
}

/**
 * Signing in to GitHub without a terminal: the same device flow as `alden auth login --device`, with the code shown
 * here and GitHub's page opened for you. Or, when the GitHub CLI is signed in, switching to its sign-in.
 */
export function SignInCard({ api, session, onSignedIn }: { api: Api; session: Session; onSignedIn: () => void }) {
  const { flow, error, copied, checking, start, check, useGh, copy } = useDeviceSignIn(api, onSignedIn);
  const rejected = session.user && "error" in session.user ? session.user.error : undefined;
  const canUseGh = session.signIn?.gitHubCli === true && session.signIn.source !== "gh";
  const keychain = session.signIn?.problem?.kind === "keychain" ? signInFailure(session) : undefined;

  if (flow.state === "waiting") {
    return (
      <StateCard
        tone="solid"
        glyph="GH"
        title="Enter this code on GitHub"
        body={
          <>
            <p className="signin-code mono">
              <span className="visually-hidden">Your one-time code: </span>
              {flow.userCode}
            </p>
            <p>GitHub's page opened in your browser. Enter the code there and approve Alden; this updates by itself.</p>
          </>
        }
        action={
          <button type="button" className="btn primary" onClick={copy}>
            {copied ? "Copied" : "Copy code"}
          </button>
        }
        alternative={
          <button type="button" className="btn quiet" onClick={() => void api.openSignIn()}>
            Open GitHub again
          </button>
        }
        live
      />
    );
  }

  return (
    <StateCard
      tone={rejected ? "warn" : "solid"}
      glyph={rejected ? "!" : "GH"}
      title={rejected ? "Sign in to GitHub again" : "Sign in to GitHub"}
      body={
        <>
          <p>
            {rejected
              ? "GitHub no longer accepts the sign-in Alden saved; it may have been revoked."
              : "Alden uses your own GitHub sign-in to read the PRs waiting on you. It posts only the reviews you send."}
          </p>
          {keychain && !error && <p className="error-text">{keychain}</p>}
          {flow.state === "failed" && <p className="error-text">{flow.message}</p>}
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <p className="faint small">
            Or in a terminal: <code>alden auth login</code>, then{" "}
            <button type="button" className="link-button small" onClick={check} disabled={checking}>
              {checking ? "checking…" : "I've signed in"}
            </button>
          </p>
        </>
      }
      action={
        <button type="button" className="btn primary" onClick={start}>
          Sign in with GitHub
        </button>
      }
      alternative={
        canUseGh ? (
          <button type="button" className="btn quiet" onClick={useGh}>
            Use my GitHub CLI sign-in
          </button>
        ) : undefined
      }
    />
  );
}
