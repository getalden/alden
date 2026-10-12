// @vitest-environment jsdom
import type { LocalSetupEvent, ModelSetupState } from "@alden/schema";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api, Session } from "../api";
import { localOptions, ModelSetupDialog } from "./ModelSetup";
import { ReviewOptions } from "./ReviewOptions";

afterEach(cleanup);

const KEY = `sk-ant-api03-${"k".repeat(40)}`;

function state(overrides: Partial<ModelSetupState> = {}): ModelSetupState {
  return {
    current: { provider: "anthropic", model: "claude-sonnet-5", available: false, reason: "No key" },
    key: null,
    ollama: { reachable: false, url: "http://localhost:11434", version: null, models: [], reason: "not running" },
    memoryGb: 24,
    recommendation: {
      model: "qwen2.5-coder:14b",
      download: "9 GB",
      why: "fits 16 to 32 GB of memory",
      installed: false,
    },
    ...overrides,
  };
}

const running = state({
  ollama: {
    reachable: true,
    url: "http://localhost:11434",
    version: "0.12.3",
    models: [{ name: "llama3.2:3b", sizeBytes: 2_000_000_000, parameterSize: "3.2B" }],
    reason: null,
  },
});

function setup(api: Partial<Api>, desktop = false) {
  const onClose = vi.fn();
  const onReady = vi.fn();
  render(<ModelSetupDialog api={api as Api} desktop={desktop} onClose={onClose} onReady={onReady} />);
  return { onClose, onReady };
}

describe("ModelSetupDialog", () => {
  it("offers a key, then a local model, then checks only, and ends with Alden Cloud", async () => {
    setup({ modelSetup: vi.fn(async () => state()) });
    const text = screen.getByRole("dialog").textContent ?? "";
    const at = ["Paste an API key", "Use a local model", "Checks only", "Alden Cloud (beta)"].map((t) =>
      text.indexOf(t),
    );
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    expect(screen.getByText(/one tiny request \(a fraction of a cent\)/)).toBeTruthy();
    const cloud = screen.getByText("Alden Cloud (beta)") as HTMLAnchorElement;
    expect(cloud.href).toBe("https://getalden.dev/cloud");
    expect(screen.getByRole("link", { name: "console.anthropic.com" }).getAttribute("href")).toBe(
      "https://console.anthropic.com/settings/keys",
    );
    expect(screen.getByRole("link", { name: "platform.openai.com" }).getAttribute("href")).toBe(
      "https://platform.openai.com/api-keys",
    );
  });

  it("tests and stores a key, then says no restart is needed", async () => {
    const testModelKey = vi.fn(async () => ({ ok: true as const, key: { source: "alden" as const, where: "x" } }));
    const { onReady } = setup({ modelSetup: vi.fn(async () => state()), testModelKey });
    fireEvent.change(screen.getByPlaceholderText("sk-ant-… or sk-…"), { target: { value: KEY } });
    fireEvent.click(screen.getByText("Check and store"));
    await waitFor(() => expect(screen.getByText(/Briefings now ask Claude/)).toBeTruthy());
    expect(testModelKey).toHaveBeenCalledWith(KEY, false);
    expect(screen.getByText(/No restart needed/)).toBeTruthy();
    fireEvent.click(screen.getByText("Done"));
    expect(onReady).toHaveBeenCalled();
  });

  it("says why a key failed, and offers to store it unchecked only when Anthropic couldn't be reached", async () => {
    const testModelKey = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: "invalid", message: "Anthropic didn't accept that key." })
      .mockResolvedValueOnce({ ok: false, reason: "network", message: "Couldn't reach api.anthropic.com." })
      .mockResolvedValueOnce({ ok: true, key: { source: "env", where: "ANTHROPIC_API_KEY" } });
    setup({ modelSetup: vi.fn(async () => state()), testModelKey });
    fireEvent.change(screen.getByPlaceholderText("sk-ant-… or sk-…"), { target: { value: KEY } });
    fireEvent.click(screen.getByText("Check and store"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("didn't accept"));
    expect(screen.queryByText("Store without checking")).toBeNull();
    fireEvent.click(screen.getByText("Check and store"));
    await waitFor(() => expect(screen.getByText("Store without checking")).toBeTruthy());
    fireEvent.click(screen.getByText("Store without checking"));
    await waitFor(() => expect(screen.getByText(/ANTHROPIC_API_KEY is set where Alden runs/)).toBeTruthy());
    expect(testModelKey).toHaveBeenLastCalledWith(KEY, true);
  });

  it("detects an OpenAI key as you paste it, and says OpenAI's models answer now", async () => {
    const openai = `sk-proj-${"o".repeat(48)}`;
    const testModelKey = vi.fn(async () => ({
      ok: true as const,
      provider: "openai" as const,
      key: { source: "alden" as const, where: "x" },
    }));
    setup({ modelSetup: vi.fn(async () => state()), testModelKey });
    expect(screen.getByRole("status", { name: "Anthropic or OpenAI" })).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("sk-ant-… or sk-…"), { target: { value: openai } });
    expect(screen.getByRole("status", { name: "OpenAI key" })).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("sk-ant-… or sk-…"), { target: { value: KEY } });
    expect(screen.getByRole("status", { name: "Anthropic key" })).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("sk-ant-… or sk-…"), { target: { value: openai } });
    fireEvent.click(screen.getByText("Check and store"));
    await waitFor(() => expect(screen.getByText(/Your OpenAI key works.*OpenAI's models/)).toBeTruthy());
    expect(testModelKey).toHaveBeenCalledWith(openai, false);
  });

  it("says how to get Ollama when it isn't running, and looks again", async () => {
    const modelSetup = vi.fn(async () => state());
    setup({ modelSetup });
    fireEvent.click(screen.getByText("Use a local model"));
    await waitFor(() => expect(screen.getByText(/isn't running at/)).toBeTruthy());
    expect(screen.getByText(/Local models flag less than Claude/)).toBeTruthy();
    fireEvent.click(screen.getByText("Look again"));
    await waitFor(() => expect(modelSetup).toHaveBeenCalledTimes(2));
  });

  it("downloads the recommended model with progress, then uses it", async () => {
    let finish: (model: string) => void = () => {};
    const setUpLocalModel = vi.fn((model: string, onEvent: (e: LocalSetupEvent) => void) => {
      onEvent({ type: "progress", status: "pulling 6a07", completed: 4_500_000_000, total: 9_000_000_000 });
      return new Promise<string>((resolve) => {
        finish = () => resolve(model);
      });
    });
    setup({ modelSetup: vi.fn(async () => running), setUpLocalModel } as unknown as Partial<Api>);
    fireEvent.click(screen.getByText("Use a local model"));
    await waitFor(() => expect(screen.getByText("Download and use")).toBeTruthy());
    fireEvent.click(screen.getByText("Download and use"));
    await waitFor(() => expect(screen.getByText(/50% of 9.0 GB/)).toBeTruthy());
    expect(setUpLocalModel.mock.calls[0]?.[0]).toBe("qwen2.5-coder:14b");
    finish("qwen2.5-coder:14b");
    await waitFor(() => expect(screen.getByText(/Briefings now use qwen2.5-coder:14b on Ollama/)).toBeTruthy());
  });

  it("opens its links through the server in the desktop app", async () => {
    const openSetupPage = vi.fn(async () => ({ opened: "cloud" }));
    setup({ modelSetup: vi.fn(async () => state()), openSetupPage }, true);
    fireEvent.click(screen.getByText("Alden Cloud (beta)"));
    expect(openSetupPage).toHaveBeenCalledWith("cloud");
  });

  it("closes for checks only", async () => {
    const { onClose } = setup({ modelSetup: vi.fn(async () => state()) });
    fireEvent.click(screen.getByText("Use checks only"));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("localOptions", () => {
  it("puts the recommended model first, to download unless it's pulled, then what Ollama has", () => {
    expect(localOptions(running).map((o) => [o.model, o.pull])).toEqual([
      ["qwen2.5-coder:14b", true],
      ["llama3.2:3b", false],
    ]);
    const pulled = state({
      ollama: { ...running.ollama, models: [{ name: "qwen2.5-coder:14b", sizeBytes: 9e9, parameterSize: null }] },
      recommendation: { ...running.recommendation, installed: true },
    });
    expect(localOptions(pulled)).toEqual([
      { model: "qwen2.5-coder:14b", pull: false, label: "qwen2.5-coder:14b · recommended" },
    ]);
  });
});

describe("ReviewOptions without a model", () => {
  it("offers to set one up instead of a disabled toggle", () => {
    const onSetUpModel = vi.fn();
    const session = {
      model: { provider: "anthropic", name: "sonnet", id: "claude-sonnet-5", effort: null, available: false },
      aliases: { sonnet: "claude-sonnet-5" },
      efforts: ["low"],
      budget: { perReviewUsd: 0.5, dailyUsd: 10, spentToday: 0 },
    } as unknown as Session;
    const choices = { llm: false, model: "sonnet", effort: "", graph: true };
    render(<ReviewOptions session={session} choices={choices} onChange={() => {}} onSetUpModel={onSetUpModel} />);
    fireEvent.click(screen.getByText("Set up a model"));
    expect(onSetUpModel).toHaveBeenCalled();
    expect(screen.queryByText("No model set up")).toBeNull();
  });
});
