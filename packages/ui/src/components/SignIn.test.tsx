// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api, Session } from "../api";
import { SignInCard, signInFailure } from "./SignIn";

afterEach(cleanup);

const session = (overrides: Partial<Session>) => ({ user: null, ...overrides }) as Session;

describe("SignInCard", () => {
  it("says a saved sign-in was rejected, and offers the GitHub CLI's", async () => {
    const useGitHubCli = vi.fn(async () => ({ login: "sam" }));
    const onSignedIn = vi.fn();
    render(
      <SignInCard
        api={{ useGitHubCli } as unknown as Api}
        session={session({ user: { error: "rejected" }, signIn: { source: "alden", gitHubCli: true } })}
        onSignedIn={onSignedIn}
      />,
    );
    expect(screen.getByText("Sign in to GitHub again")).toBeTruthy();
    fireEvent.click(screen.getByText("Use my GitHub CLI sign-in"));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
  });

  it("shows the code, opens GitHub, and finishes when the server hears back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = {
      startSignIn: vi.fn(async () => ({
        state: "waiting",
        userCode: "ABCD-1234",
        verificationUri: "https://github.com/login/device",
        expiresAt: "",
      })),
      openSignIn: vi.fn(async () => ({ state: "waiting" })),
      signInStatus: vi.fn(async () => ({ state: "done", login: "sam" })),
    } as unknown as Api;
    const onSignedIn = vi.fn();
    render(
      <SignInCard
        api={api}
        session={session({ signIn: { source: null, gitHubCli: false } })}
        onSignedIn={onSignedIn}
      />,
    );
    expect(screen.queryByText("Use my GitHub CLI sign-in")).toBeNull();
    fireEvent.click(screen.getByText("Sign in with GitHub"));
    await waitFor(() => expect(screen.getByText(/ABCD-1234/)).toBeTruthy());
    expect(api.openSignIn).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_100);
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
    vi.useRealTimers();
  });

  it("says what failed when you've signed in but Alden still can't see it", async () => {
    const keychain = session({
      signIn: { source: null, gitHubCli: false, problem: { kind: "keychain", detail: "denied" } },
    });
    const api = { session: vi.fn(async () => keychain) } as unknown as Api;
    const onSignedIn = vi.fn();
    render(
      <SignInCard
        api={api}
        session={session({ signIn: { source: null, gitHubCli: false } })}
        onSignedIn={onSignedIn}
      />,
    );
    fireEvent.click(screen.getByText("I've signed in"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/keychain.*denied.*Applications/));
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("finishes when the session is signed in, and words each failure", async () => {
    const api = { session: vi.fn(async () => session({ user: { login: "sam", source: "alden" } })) } as unknown as Api;
    const onSignedIn = vi.fn();
    render(<SignInCard api={api} session={session({})} onSignedIn={onSignedIn} />);
    fireEvent.click(screen.getByText("I've signed in"));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
    expect(signInFailure(session({ user: { error: "Bad credentials" } }))).toMatch(/rejected.*Bad credentials/);
    expect(signInFailure(session({ signIn: { source: null, gitHubCli: false, problem: { kind: "none" } } }))).toMatch(
      /no GitHub sign-in/,
    );
  });
});
