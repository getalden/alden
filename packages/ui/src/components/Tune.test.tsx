// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ModelsState, type Session } from "../api";
import type { Choices } from "./ReviewOptions";
import { fallbackModels, modelLine, Tune } from "./Tune";

afterEach(cleanup);

const session = {
  model: {
    provider: "anthropic",
    name: "sonnet",
    id: "claude-sonnet-5",
    effort: "medium",
    supportsEffort: true,
    available: true,
    key: { source: "alden", where: "the key you stored" },
  },
  aliases: { sonnet: "claude-sonnet-5", opus: "claude-opus-5", haiku: "claude-haiku-4-5" },
  efforts: ["low", "medium", "high", "xhigh", "max"],
  budget: { perReviewUsd: 0.5, dailyUsd: 5, spentToday: 1.84 },
} as unknown as Session;

const MODELS: ModelsState = {
  current: { provider: "anthropic", model: "claude-sonnet-5" },
  groups: [
    {
      provider: "anthropic",
      label: "Anthropic",
      via: "your key",
      available: true,
      items: [
        { id: "claude-sonnet-5", note: "fast" },
        { id: "claude-opus-5", note: "deepest" },
      ],
    },
    { provider: "openai", label: "OpenAI", via: "no key", available: false, items: [{ id: "gpt-5", note: "deep" }] },
    { provider: "ollama", label: "Local", via: "Ollama", available: true, items: [{ id: "qwen2.5-coder:32b" }] },
  ],
};

function fakeApi(overrides: Record<string, unknown> = {}) {
  return {
    models: vi.fn(async () => MODELS),
    setModel: vi.fn(async (choice: { provider: string; model: string }) => ({ ...MODELS, current: choice })),
    tone: vi.fn(async (repo?: string) => ({ tone: "concise", repo: repo ?? null })),
    setTone: vi.fn(async (tone: string) => ({ tone })),
    ask: vi.fn(async () => ({ text: "", costUsd: null as number | null, model: "" })),
    setConfig: vi.fn(async () => ({})),
    ...overrides,
  };
}

const initial: Choices = { llm: true, model: "sonnet", effort: "medium", graph: true };

/** Tune with its choices kept, as the app keeps them. */
function Harness(props: { api: ReturnType<typeof fakeApi>; onSessionChange?: () => void; session?: Session }) {
  const [choices, setChoices] = useState(initial);
  return (
    <Tune
      session={props.session ?? session}
      choices={choices}
      onChoices={setChoices}
      api={props.api as never}
      pr="acme/api#7"
      repo="acme/api"
      onSetUpModel={() => {}}
      onSessionChange={props.onSessionChange}
    />
  );
}

const open = () => fireEvent.click(screen.getByRole("button", { name: /▾$/ }));

describe("the model line", () => {
  it("says what the next briefing uses", () => {
    expect(modelLine(session, initial)).toBe("sonnet-5 · medium");
    expect(modelLine(session, { ...initial, effort: "" })).toBe("sonnet-5 · medium");
    expect(modelLine(session, { ...initial, model: "haiku" })).toBe("haiku-4-5");
    expect(modelLine(session, { ...initial, llm: false })).toBe("checks only");
    expect(modelLine({ ...session, model: { ...session.model, available: false } }, initial)).toBe("no model");
  });

  it("falls back to the session's models when the server can't list them", () => {
    const fallback = fallbackModels(session);
    expect(fallback.groups.map((g) => [g.label, g.via])).toEqual([["Anthropic", "your key"]]);
    expect(fallback.groups[0]?.items.map((i) => [i.id, i.note])).toEqual([
      ["sonnet", "default"],
      ["opus", "claude-opus-5"],
      ["haiku", "claude-haiku-4-5"],
    ]);
  });
});

describe("Tune", () => {
  it("picks a model by provider, saves it, and reads the session again", async () => {
    const api = fakeApi();
    const onSessionChange = vi.fn();
    render(<Harness api={api} onSessionChange={onSessionChange} />);
    expect(screen.getByRole("button", { name: "sonnet-5 · medium ▾" })).toBeTruthy();
    open();
    const dialog = screen.getByRole("dialog", { name: "Tune this briefing" });
    const pick = await within(dialog).findByRole("button", { name: "Model: sonnet-5" });
    expect(pick.textContent).toBe("Anthropicsonnet-5 ▾");
    fireEvent.click(pick);
    const list = screen.getByRole("menu", { name: "Models" });
    expect(
      within(list)
        .getAllByRole("group")
        .map((g) => g.getAttribute("aria-label")),
    ).toEqual(["Anthropic", "OpenAI", "Local", "Without a model"]);
    expect(
      within(list)
        .getByRole("menuitemradio", { name: /claude-sonnet-5/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    // A provider without a key can't be picked.
    expect((within(list).getByRole("menuitemradio", { name: /gpt-5/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(list).getByRole("menuitemradio", { name: /claude-opus-5/ }));
    await waitFor(() => expect(onSessionChange).toHaveBeenCalledTimes(1));
    expect(api.setModel).toHaveBeenCalledWith({ provider: "anthropic", model: "claude-opus-5" });
    expect(screen.getByRole("button", { name: "opus-5 · medium ▾" })).toBeTruthy();

    // Checks only turns the model off for this window.
    fireEvent.click(within(dialog).getByRole("button", { name: /^Model:/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Checks only/ }));
    expect(screen.getByRole("button", { name: "checks only ▾" })).toBeTruthy();
  });

  it("keeps a picked model for the window when the server has no model list", async () => {
    const api = fakeApi({
      models: vi.fn(async () => {
        throw new ApiError(404, "No such endpoint: GET /api/models");
      }),
    });
    render(<Harness api={api} />);
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Model: sonnet-5" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^haiku-4-5/ }));
    expect(api.setModel).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "haiku-4-5 ▾" })).toBeTruthy();
  });

  it("changes the tone, effort (xhigh included), callers and the cap", async () => {
    const api = fakeApi();
    const onSessionChange = vi.fn();
    render(<Harness api={api} onSessionChange={onSessionChange} />);
    open();
    const tone = (await screen.findByRole("combobox", { name: "Alden writes" })) as HTMLSelectElement;
    expect(api.tone).toHaveBeenCalledWith("acme/api");
    expect(tone.value).toBe("concise");
    expect([...tone.options].map((o) => o.text)).toEqual(["Terse", "Concise", "Detailed", "Teaching"]);
    fireEvent.change(tone, { target: { value: "teaching" } });
    await waitFor(() => expect(api.setTone).toHaveBeenCalledWith("teaching", "acme/api"));

    const effort = screen.getByRole("group", { name: "Effort" });
    expect(
      within(effort)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Low", "Medium", "High", "X-high", "Max"]);
    fireEvent.click(within(effort).getByRole("button", { name: "X-high" }));
    expect(screen.getByRole("button", { name: "sonnet-5 · xhigh ▾" })).toBeTruthy();

    const callers = screen.getByRole("switch", { name: "Read callers outside the diff" });
    expect(callers.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(callers);
    expect(callers.getAttribute("aria-checked")).toBe("false");

    const cap = screen.getByRole("textbox", { name: "Stop at" }) as HTMLInputElement;
    expect(cap.value).toBe("0.50");
    fireEvent.change(cap, { target: { value: "0.75" } });
    fireEvent.keyDown(cap, { key: "Enter" });
    await waitFor(() => expect(onSessionChange).toHaveBeenCalledTimes(1));
    expect(api.setConfig).toHaveBeenCalledWith("budget.perReviewUsd", "0.75");
  });

  it("hides the tone when the server has none", async () => {
    const api = fakeApi({
      tone: vi.fn(async () => {
        throw new ApiError(404, "No such endpoint");
      }),
    });
    render(<Harness api={api} />);
    open();
    await screen.findByRole("button", { name: "Model: sonnet-5" });
    expect(screen.queryByRole("combobox", { name: "Alden writes" })).toBeNull();
  });

  it("asks the model about the PR, streams the answer in, and says what it cost", async () => {
    let finish: (value: { text: string; costUsd: number | null; model: string }) => void = () => {};
    const ask = vi.fn(
      (_: { pr: string; question: string }, onText: (text: string) => void) =>
        new Promise<{ text: string; costUsd: number | null; model: string }>((resolve) => {
          onText("The retry ");
          finish = resolve;
        }),
    );
    render(<Harness api={fakeApi({ ask })} />);
    open();
    const input = screen.getByRole("textbox", { name: "Ask the model about this PR" });
    fireEvent.change(input, { target: { value: "Is the backoff capped?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(ask).toHaveBeenCalledWith(
      { pr: "acme/api#7", question: "Is the backoff capped?" },
      expect.any(Function),
      expect.anything(),
    );
    expect(screen.getByText("Is the backoff capped?")).toBeTruthy();
    await screen.findByText("The retry");
    expect(screen.getByText("answering…")).toBeTruthy();
    await act(async () => finish({ text: "The retry has no ceiling.", costUsd: 0.0042, model: "claude-sonnet-5" }));
    expect(screen.getByText("The retry has no ceiling.")).toBeTruthy();
    expect(screen.getByText("sonnet-5 · $0.0042")).toBeTruthy();

    // Esc closes it, and focus goes back to the model line.
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "sonnet-5 · medium ▾" }));
  });

  it("says when the model can't answer", async () => {
    const ask = vi.fn(async () => {
      throw new ApiError(402, "Over today's cap.");
    });
    render(<Harness api={fakeApi({ ask })} />);
    open();
    const input = screen.getByRole("textbox", { name: "Ask the model about this PR" });
    fireEvent.change(input, { target: { value: "Why?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect((await screen.findByRole("alert")).textContent).toBe("Over today's cap.");
  });

  it("closes when you click elsewhere", () => {
    render(
      <>
        <button type="button">elsewhere</button>
        <Harness api={fakeApi()} />
      </>,
    );
    open();
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole("button", { name: "elsewhere" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
