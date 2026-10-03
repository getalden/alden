import { useEffect, useState } from "react";
import type { Api, Session, SignInState } from "../api";
import { StateCard } from "./StateCard";

/**
 * Signing in to GitHub without a terminal: the same device flow as `alden auth login --device`, with the code shown
 * here and GitHub's page opened for you. Or, when the GitHub CLI is signed in, switching to its sign-in.
 */
export function SignInCard({ api, session, onSignedIn }: { api: Api; session: Session; onSignedIn: () => void }) {
  const [flow, setFlow] = useState<SignInState>({ state: "idle" });
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const rejected = session.user && "error" in session.user ? session.user.error : undefined;
  const canUseGh = session.signIn?.gitHubCli === true && session.signIn.source !== "gh";

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
  const useGh = () => {
    setError(undefined);
    api.useGitHubCli().then(
      (result) => ("error" in result ? setError(result.error) : onSignedIn()),
      (e: Error) => setError(e.message),
    );
  };

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
          <button
            type="button"
            className="btn primary"
            onClick={() =>
              navigator.clipboard?.writeText(flow.userCode).then(
                () => setCopied(true),
                () => {},
              )
            }
          >
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
              : "Alden uses your own GitHub sign-in to read the PRs waiting on you. It posts nothing."}
          </p>
          {flow.state === "failed" && <p className="error-text">{flow.message}</p>}
          {error && <p className="error-text">{error}</p>}
          <p className="faint small">
            Or in a terminal: <code>alden auth login</code>
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
