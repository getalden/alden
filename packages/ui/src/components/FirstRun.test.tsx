// @vitest-environment jsdom
import type { ModelSetupState, RankedPullRequest, RankedQueue } from "@alden/schema";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api, Session } from "../api";
import { FirstRun, firstRowMeta, SIGN_IN_FOOTNOTE } from "./FirstRun";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const session = (over: Partial<Session> = {}) =>
  ({
    version: "0",
    cwd: "/",
    repo: null,
    user: null,
    signIn: { source: null, gitHubCli: false, problem: { kind: "none" } },
    model: {
      provider: "anthropic",
      name: "sonnet",
      id: "claude-sonnet-5",
      effort: null,
      supportsEffort: true,
      available: false,
    },
    aliases: {},
    efforts: [],
    budget: { perReviewUsd: 0.5, dailyUsd: 10, spentToday: 0 },
    ...over,
  }) as Session;

const setupState = (available = false): ModelSetupState => ({
  current: { provider: "anthropic", model: "claude-sonnet-5", available, reason: available ? null : "No key" },
  key: null,
  openaiKey: null,
  ollama: { reachable: false, url: "http://localhost:11434", version: null, models: [], reason: "not running" },
  memoryGb: 16,
  recommendation: { model: "qwen2.5-coder:14b", download: "9 GB", why: "fits", installed: false },
});

const row = (n: number, title: string): RankedPullRequest =>
  ({
    pr: {
      repo: `acme/orders-api`,
      number: n,
      title,
      author: "li",
      url: `https://github.com/acme/orders-api/pull/${n}`,
      request: { requestedAt: null },
    },
    waitingHours: 2,
  }) as unknown as RankedPullRequest;

const queue = (n: number) =>
  ({
    needsYou: Array.from({ length: n }, (_, i) => row(480 + i, `PR ${i + 1}`)),
    fastTrack: [],
  }) as unknown as RankedQueue;

function show(api: Partial<Api>, over: Partial<Parameters<typeof FirstRun>[0]> = {}) {
  const props = {
    api: api as Api,
    session: session(),
    queue: undefined,
    queueLoading: false,
    onSignedIn: vi.fn(),
    onModelReady: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  const view = render(<FirstRun {...props} />);
  return { ...props, rerender: (more: Partial<typeof props>) => view.rerender(<FirstRun {...props} {...more} />) };
}

describe("FirstRun", () => {
  it("starts at sign in, says truthfully what GitHub is asked for, and moves on once GitHub approves", async () => {
    vi.useFakeTimers();
    const signInStatus = vi.fn(async () => ({ state: "done" as const, login: "sam" }));
    const api = {
      startSignIn: vi.fn(async () => ({
        state: "waiting" as const,
        userCode: "ABCD-1234",
        verificationUri: "https://github.com/login/device",
        expiresAt: "",
      })),
      openSignIn: vi.fn(async () => ({ state: "waiting" as const }) as never),
      signInStatus,
      modelSetup: vi.fn(async () => setupState()),
    };
    const { onSignedIn } = show(api);
    expect(screen.getByRole("dialog").textContent).toContain("Start with the reviews waiting on you.");
    expect(screen.getByText(SIGN_IN_FOOTNOTE)).toBeTruthy();
    expect(SIGN_IN_FOOTNOTE).toContain("repo and read:org");
    expect(screen.getByText("1 Sign in").getAttribute("aria-current")).toBe("step");

    await act(async () => {
      fireEvent.click(screen.getByText("Continue with GitHub"));
    });
    expect(screen.getByText("ABCD-1234")).toBeTruthy();
    expect(api.openSignIn).toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(onSignedIn).toHaveBeenCalled();
    expect(screen.getByText("How should Alden think?")).toBeTruthy();
    expect(screen.getByText("2 Model").getAttribute("aria-current")).toBe("step");
  });

  it("tests a pasted key on Continue, and goes on to the queue when it works", async () => {
    const testModelKey = vi.fn(async () => ({ ok: true as const, provider: "openai" as const, key: null }));
    const { onModelReady } = show(
      { modelSetup: vi.fn(async () => setupState()), testModelKey },
      { session: session({ user: { login: "sam", source: "alden" } }) },
    );
    const next = screen.getByText("Continue") as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    const key = `sk-proj-${"o".repeat(48)}`;
    fireEvent.change(screen.getByLabelText("API key, Anthropic or OpenAI"), { target: { value: key } });
    expect(screen.getByRole("status", { name: "OpenAI key" })).toBeTruthy();
    fireEvent.click(next);
    await waitFor(() => expect(screen.getByText("Open the queue")).toBeTruthy());
    expect(testModelKey).toHaveBeenCalledWith(key, false);
    expect(onModelReady).toHaveBeenCalled();
  });

  it("says why a key failed and stays on the step", async () => {
    const testModelKey = vi.fn(async () => ({ ok: false as const, reason: "invalid" as const, message: "Nope." }));
    show(
      { modelSetup: vi.fn(async () => setupState()), testModelKey },
      { session: session({ user: { login: "sam", source: "alden" } }) },
    );
    fireEvent.change(screen.getByLabelText("API key, Anthropic or OpenAI"), { target: { value: "sk-ant-x" } });
    fireEvent.click(screen.getByText("Continue"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Nope."));
    expect(screen.getByText("How should Alden think?")).toBeTruthy();
  });

  it("lets you go on with checks only, and links Alden Cloud", async () => {
    show(
      { modelSetup: vi.fn(async () => setupState()) },
      { session: session({ user: { login: "sam", source: "alden" } }), start: 2 },
    );
    expect((screen.getByText("join the list") as HTMLAnchorElement).href).toBe("https://getalden.dev/cloud");
    fireEvent.click(screen.getByText("Checks only"));
    fireEvent.click(screen.getByText("Continue"));
    expect(screen.getByText("3 Queue").getAttribute("aria-current")).toBe("step");
  });

  it("shows how many PRs wait, the top four, and that the desktop app is briefing the top ones", async () => {
    const { onClose } = show(
      { modelSetup: vi.fn(async () => setupState(true)) },
      {
        session: session({
          user: { login: "sam", source: "alden" },
          desktop: true,
          background: { enabled: true, model: false, prepare: 3 },
        }),
        queue: queue(23),
      },
    );
    await waitFor(() => expect(screen.getByText(/Continue keeps it/)).toBeTruthy());
    fireEvent.click(screen.getByText("Continue"));
    expect(screen.getByText("23 PRs are waiting on you.")).toBeTruthy();
    expect(screen.getAllByRole("listitem").filter((li) => li.textContent?.startsWith("PR "))).toHaveLength(4);
    expect(screen.getByText("briefing the top 3…")).toBeTruthy();
    fireEvent.click(screen.getByText("Open the queue"));
    expect(onClose).toHaveBeenCalled();
  });

  it("can be skipped", () => {
    const { onClose } = show({});
    fireEvent.click(screen.getByText("Skip setup"));
    expect(onClose).toHaveBeenCalled();
  });

  it("reads each row as the design does", () => {
    expect(firstRowMeta(row(488, "x"))).toBe("orders-api #488 · li · 2h");
  });
});
