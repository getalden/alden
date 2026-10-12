import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { type Api, ApiError, type ModelGroup, type ModelsState, type Session, type ToneState } from "../api";
import { formatUsd } from "../format";
import { type Choices, effortSupported, Switch } from "./ReviewOptions";

type TuneApi = Pick<Api, "models" | "setModel" | "tone" | "setTone" | "ask" | "setConfig">;

/** The tones there are until the server lists its own: how Alden writes the comments it drafts. */
export const DEFAULT_TONES = [
  { id: "terse", label: "Terse", hint: "one line, no reasoning" },
  { id: "concise", label: "Concise", hint: "the usual" },
  { id: "detailed", label: "Detailed", hint: "why, impact and a fix" },
  { id: "teaching", label: "Teaching", hint: "for newer teammates" },
];

/** How effort reads in the popover: Alden's efforts, low to max, with xhigh between high and max. */
const EFFORT_LABEL: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-high",
  max: "Max",
};
export const effortLabel = (effort: string) => EFFORT_LABEL[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);

/** "claude-sonnet-5" → "sonnet-5": the model's name the way the age line shows it. */
export const shortModel = (id: string) => id.replace(/^claude-/, "");

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "openai-compatible": "Local",
  ollama: "Local",
  bedrock: "Bedrock",
  vertex: "Vertex",
};
const providerLabel = (provider: string) => PROVIDER_LABEL[provider] ?? provider;

/** "sonnet-5 · medium", "checks only", "no model": what the next briefing uses, on the age line. */
export function modelLine(session: Session, choices: Choices): string {
  if (!session.model.available) return "no model";
  if (!choices.llm) return "checks only";
  const model = shortModel(session.aliases[choices.model] ?? choices.model);
  const effort = effortSupported(session, choices.model) ? choices.effort || session.model.effort : null;
  return effort ? `${model} · ${effort}` : model;
}

/**
 * The models to pick from when this Alden has no `/api/models` (or it failed): the configured provider's, from the
 * session, as the toolbar offered them before.
 */
export function fallbackModels(session: Session): ModelsState {
  const models =
    session.model.provider === "openai-compatible"
      ? [session.model.name]
      : [...new Set([session.model.name, ...Object.keys(session.aliases)])];
  const via =
    session.model.provider === "openai-compatible"
      ? "local server"
      : session.model.key?.source === "env"
        ? "env var"
        : session.model.key
          ? "your key"
          : "no key";
  return {
    current: { provider: session.model.provider, model: session.model.name },
    groups: [
      {
        provider: session.model.provider,
        label: providerLabel(session.model.provider),
        via,
        available: session.model.available,
        items: models.map((m) => ({
          id: m,
          note: m === session.model.name ? "default" : (session.aliases[m] ?? undefined),
        })),
      },
    ],
  };
}

/**
 * The model line on the age line ("sonnet-5 · medium ▾") and its Tune popover: the model, how Alden writes, effort,
 * callers, the per-brief cap, and a question for the model about this PR. The model comes from `GET /api/models` when
 * the server has it (picking one saves it), else from the session (picking one is for this window, as before).
 */
export function Tune(props: {
  session: Session | undefined;
  choices: Choices;
  onChoices: (choices: Choices) => void;
  api?: TuneApi | undefined;
  /** The PR the popover is about ("owner/repo#12"), for Ask. Without one there's no Ask. */
  pr?: string | undefined;
  /** The repo whose tone shows ("owner/repo"); the default tone without one. */
  repo?: string | undefined;
  onSetUpModel?: (() => void) | undefined;
  /** After a change saved to the config (the model, the cap): read the session again. */
  onSessionChange?: (() => void) | undefined;
}) {
  const { session } = props;
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const wrapper = useRef<HTMLSpanElement>(null);
  const id = useId();
  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  }, []);

  // A click anywhere else closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, close]);

  if (!session) return null;
  return (
    <span className="tune" ref={wrapper}>
      <button
        ref={trigger}
        type="button"
        className={`model-line${open ? " on" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? `${id}tune` : undefined}
        title="Tune this briefing: model, tone, effort, callers, cap"
        onClick={() => (open ? close() : setOpen(true))}
      >
        {modelLine(session, props.choices)} ▾
      </button>
      {open && <TunePopover {...props} session={session} id={`${id}tune`} onClose={close} />}
    </span>
  );
}

function TunePopover(props: {
  id: string;
  session: Session;
  choices: Choices;
  onChoices: (choices: Choices) => void;
  api?: TuneApi | undefined;
  pr?: string | undefined;
  repo?: string | undefined;
  onSetUpModel?: (() => void) | undefined;
  onSessionChange?: (() => void) | undefined;
  onClose: (refocus?: boolean) => void;
}) {
  const { session, choices, onChoices, api } = props;
  const dialog = useRef<HTMLDivElement>(null);
  const modelOn = choices.llm && session.model.available;
  const canEffort = effortSupported(session, choices.model);
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>("button, input, select")?.focus();
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    // Keys in the popover stay in it: s, d, g and the rest mean other things on the page.
    if (event.key !== "Tab") event.nativeEvent.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
    }
  };

  return (
    <div
      ref={dialog}
      id={props.id}
      className="tune-popover"
      role="dialog"
      aria-label="Tune this briefing"
      onKeyDown={onKeyDown}
    >
      <div className="tune-head">
        <span>Tune this briefing</span>
        <button type="button" className="esc" onClick={() => props.onClose()} aria-label="Close">
          esc
        </button>
      </div>
      <ModelRow {...props} onProblem={setProblem} />
      {api && <ToneRow api={api} repo={props.repo} onProblem={setProblem} />}
      {session.efforts.length > 0 && (
        <div className="tune-field column">
          <span className="tune-label" id={`${props.id}effort`}>
            Effort
          </span>
          {/* biome-ignore lint/a11y/useSemanticElements: a fieldset can't stretch its buttons (see Segmented). */}
          <div
            className="tune-seg"
            role="group"
            aria-labelledby={`${props.id}effort`}
            title={
              canEffort
                ? "How hard the model thinks: more effort, more time and cost"
                : "This model doesn't take an effort setting"
            }
            style={{ gridTemplateColumns: `repeat(${session.efforts.length}, minmax(0, 1fr))` }}
          >
            {session.efforts.map((e) => (
              <button
                key={e}
                type="button"
                aria-pressed={canEffort && (choices.effort || session.model.effort) === e}
                disabled={!modelOn || !canEffort}
                onClick={() => onChoices({ ...choices, effort: choices.effort === e ? "" : e })}
              >
                {effortLabel(e)}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="tune-field">
        <span className="tune-label" id={`${props.id}callers`}>
          Read callers outside the diff
        </span>
        <Switch
          on={choices.graph}
          label=""
          labelledBy={`${props.id}callers`}
          title="Find who calls the changed code. PRs need a clone of their repo."
          onChange={(graph) => onChoices({ ...choices, graph })}
        />
      </div>
      <CapRow {...props} onProblem={setProblem} />
      {problem && (
        <p className="tune-problem error-text" role="alert">
          {problem}
        </p>
      )}
      {props.pr && api && session.model.available && <Ask api={api} pr={props.pr} />}
      {props.pr && !session.model.available && <p className="tune-note">Ask about this PR once a model is set up.</p>}
    </div>
  );
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong.");

/** The Model row and its picker, grouped by provider. */
function ModelRow(props: {
  id: string;
  session: Session;
  choices: Choices;
  onChoices: (choices: Choices) => void;
  api?: TuneApi | undefined;
  onSetUpModel?: (() => void) | undefined;
  onSessionChange?: (() => void) | undefined;
  onProblem: (problem: string | undefined) => void;
}) {
  const { session, choices, onChoices, api, onProblem } = props;
  const [state, setState] = useState<{ models: ModelsState; saved: boolean }>();
  const [open, setOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let live = true;
    const fallback = () => {
      if (live) setState({ models: fallbackModels(session), saved: false });
    };
    if (!api) fallback();
    else
      api.models().then((models) => {
        if (live) setState({ models, saved: true });
      }, fallback);
    return () => {
      live = false;
    };
  }, [api, session]);

  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>('[aria-checked="true"], [role="menuitemradio"]')?.focus();
  }, [open]);

  if (!session.model.available && props.onSetUpModel && state && !state.models.groups.some((g) => g.available)) {
    return (
      <div className="tune-field">
        <span className="tune-label">Model</span>
        <button type="button" className="tune-pick" onClick={props.onSetUpModel}>
          Set up a model
        </button>
      </div>
    );
  }

  const models = state?.models;
  const current = models?.current;
  const group = models?.groups.find((g) => g.provider === current?.provider) ?? models?.groups[0];
  const shown = shortModel(session.aliases[choices.model] ?? choices.model);

  const pick = async (g: ModelGroup, model: string) => {
    setOpen(false);
    button.current?.focus();
    onProblem(undefined);
    if (!state?.saved || !api) {
      onChoices({ ...choices, llm: true, model });
      return;
    }
    try {
      const next = await api.setModel({ provider: g.provider, model });
      setState({ models: next, saved: true });
      onChoices({ ...choices, llm: true, model });
      props.onSessionChange?.();
    } catch (error) {
      onProblem(`Couldn't switch the model: ${messageOf(error)}`);
    }
  };
  const isCurrent = (g: ModelGroup, model: string) =>
    choices.llm &&
    (state?.saved
      ? current?.provider === g.provider && current.model === model
      : model === choices.model || session.aliases[model] === choices.model);

  const onListKey = (event: ReactKeyboardEvent) => {
    const items = [...(list.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]:not(:disabled)') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => items[(i + items.length) % items.length]?.focus();
    if (event.key === "ArrowDown") go(at + 1);
    else if (event.key === "ArrowUp") go(at - 1);
    else if (event.key === "Escape") {
      // Closes the list, not the popover.
      event.stopPropagation();
      setOpen(false);
      button.current?.focus();
    } else return;
    event.preventDefault();
  };

  return (
    <div className="tune-field">
      <span className="tune-label">Model</span>
      <button
        ref={button}
        type="button"
        className="tune-pick"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Model: ${choices.llm ? shown : "checks only"}`}
        onClick={() => setOpen((v) => !v)}
      >
        {choices.llm ? (
          <>
            <span className="prov">{group?.label ?? providerLabel(session.model.provider)}</span>
            {shown}
          </>
        ) : (
          "checks only"
        )}{" "}
        ▾
      </button>
      {open && models && (
        <div ref={list} className="model-list" role="menu" aria-label="Models" onKeyDown={onListKey}>
          {models.groups.map((g) => (
            // biome-ignore lint/a11y/useSemanticElements: a group inside a menu, which a fieldset can't be.
            <div key={g.provider} role="group" aria-label={g.label}>
              <div className="model-group">
                <span>{g.label}</span>
                <span className="via">{g.via}</span>
              </div>
              {g.items.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isCurrent(g, m.id)}
                  disabled={!g.available}
                  tabIndex={-1}
                  onClick={() => void pick(g, m.id)}
                >
                  <span>{state?.saved ? m.id : shortModel(session.aliases[m.id] ?? m.id)}</span>
                  {m.note && <span className="note">{m.note}</span>}
                </button>
              ))}
            </div>
          ))}
          {/* biome-ignore lint/a11y/useSemanticElements: a group inside a menu, which a fieldset can't be. */}
          <div role="group" aria-label="Without a model">
            <button
              type="button"
              role="menuitemradio"
              aria-checked={!choices.llm}
              tabIndex={-1}
              onClick={() => {
                setOpen(false);
                button.current?.focus();
                onChoices({ ...choices, llm: false });
              }}
            >
              <span>Checks only</span>
              <span className="note">no model call</span>
            </button>
          </div>
          <div className="model-foot">
            Keys live in Settings
            {props.onSetUpModel && (
              <>
                {" · "}
                <button type="button" className="link-button" onClick={props.onSetUpModel}>
                  Add a key
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** "Alden writes": the tone of the comments Alden drafts in this repo. Hidden when the server doesn't know tones. */
function ToneRow(props: { api: TuneApi; repo?: string | undefined; onProblem: (problem: string | undefined) => void }) {
  const { api, repo, onProblem } = props;
  const [tone, setTone] = useState<ToneState>();
  const id = useId();
  useEffect(() => {
    let live = true;
    setTone(undefined);
    api.tone(repo).then(
      (found) => {
        if (live) setTone(found);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [api, repo]);
  if (!tone) return null;
  const tones = tone.tones?.length ? tone.tones : DEFAULT_TONES;
  const options = tones.some((t) => t.id === tone.tone)
    ? tones
    : [...tones, { id: tone.tone, label: tone.tone, hint: undefined }];
  const hint = options.find((t) => t.id === tone.tone)?.hint;
  return (
    <div className="tune-field">
      <label className="tune-label" htmlFor={`${id}tone`} title={hint}>
        Alden writes
      </label>
      <select
        id={`${id}tone`}
        className="tune-select"
        value={tone.tone}
        onChange={(event) => {
          const next = event.target.value;
          const was = tone;
          setTone({ ...tone, tone: next });
          onProblem(undefined);
          api.setTone(next, repo).then(
            (saved) => setTone((now) => ({ ...saved, tones: saved.tones ?? now?.tones })),
            (error: unknown) => {
              setTone(was);
              onProblem(`Couldn't change the tone: ${messageOf(error)}`);
            },
          );
        }}
      >
        {options.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** "Stop at $0.50 per brief": the per-briefing cap, saved to your config (`budget.perReviewUsd`). */
function CapRow(props: {
  session: Session;
  api?: TuneApi | undefined;
  onSessionChange?: (() => void) | undefined;
  onProblem: (problem: string | undefined) => void;
}) {
  const { session, api, onProblem } = props;
  const saved = session.budget.perReviewUsd;
  const [value, setValue] = useState(saved.toFixed(2));
  const id = useId();
  useEffect(() => setValue(saved.toFixed(2)), [saved]);
  const save = () => {
    const usd = Number(value);
    if (!api || value.trim() === "" || usd === saved) return setValue(saved.toFixed(2));
    if (!(usd > 0)) {
      onProblem("The cap is a dollar amount above zero.");
      return setValue(saved.toFixed(2));
    }
    onProblem(undefined);
    api.setConfig("budget.perReviewUsd", String(usd)).then(
      () => props.onSessionChange?.(),
      (error: unknown) => {
        setValue(saved.toFixed(2));
        onProblem(`Couldn't save the cap: ${messageOf(error)}`);
      },
    );
  };
  return (
    <div className="tune-field">
      <label className="tune-label" htmlFor={`${id}cap`}>
        Stop at
      </label>
      <span className="tune-cap">
        $
        <input
          id={`${id}cap`}
          type="text"
          inputMode="decimal"
          value={value}
          disabled={!api}
          size={Math.max(3, value.length)}
          onChange={(event) => setValue(event.target.value.replace(/[^\d.]/g, ""))}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              save();
            }
          }}
          title={`${formatUsd(Math.max(0, session.budget.dailyUsd - session.budget.spentToday))} left of today's ${formatUsd(session.budget.dailyUsd)}`}
        />{" "}
        per brief
      </span>
    </div>
  );
}

type Answer =
  | { state: "asking"; question: string; text: string }
  | { state: "done"; question: string; text: string; costUsd: number | null; model: string }
  | { state: "error"; question: string; text: string; message: string };

/** "Ask the model about this PR…": one question, the answer streamed in below it, and what it cost. */
function Ask({ api, pr }: { api: TuneApi; pr: string }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<Answer>();
  const abort = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => abort.current?.abort(), []);

  const ask = () => {
    const q = question.trim();
    if (!q || answer?.state === "asking") return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setAnswer({ state: "asking", question: q, text: "" });
    setQuestion("");
    api
      .ask({ pr, question: q }, (text) => setAnswer({ state: "asking", question: q, text }), controller.signal)
      .then(
        (done) => {
          if (!controller.signal.aborted) setAnswer({ state: "done", question: q, ...done });
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          setAnswer((was) => ({
            state: "error",
            question: q,
            text: was?.text ?? "",
            message:
              error instanceof ApiError && error.status === 404
                ? "This Alden can't answer questions yet."
                : messageOf(error),
          }));
        },
      );
  };
  const stop = () => {
    abort.current?.abort();
    setAnswer((was) => (was ? { state: "error", question: was.question, text: was.text, message: "Stopped." } : was));
  };

  let footer: ReactNode = null;
  if (answer?.state === "asking") {
    footer = (
      <>
        <span>answering…</span>
        <button type="button" className="link-button" onClick={stop}>
          Stop
        </button>
      </>
    );
  } else if (answer?.state === "done") {
    footer = (
      <span>
        {shortModel(answer.model)}
        {answer.costUsd !== null ? ` · ${formatUsd(answer.costUsd)}` : ""}
      </span>
    );
  }

  return (
    <div className="ask">
      <input
        className="ask-input"
        type="text"
        placeholder="Ask the model about this PR…"
        aria-label="Ask the model about this PR"
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            ask();
          }
        }}
      />
      {answer && (
        <div className="ask-answer" aria-live="polite" aria-busy={answer.state === "asking"}>
          <span className="ask-q">{answer.question}</span>
          {answer.text && <p className="ask-text">{answer.text}</p>}
          {answer.state === "error" && (
            <p className={answer.message === "Stopped." ? "faint" : "error-text"} role="alert">
              {answer.message}
            </p>
          )}
          {footer && <div className="ask-foot">{footer}</div>}
        </div>
      )}
    </div>
  );
}
